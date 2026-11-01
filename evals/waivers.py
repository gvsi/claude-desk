"""Owner attestations for strict AI-denial flags, bound to one pass and message.

Only disclosure.denial is waivable. Local commands reconcile each flagged message, its exact
text and hit count with transcripts; CI can reconcile only summed hits because results files
contain no message ids.
Message text is the blocks' text, in delivery order, joined by two newlines without normalization.
"""

import json
import hashlib
import re
import shlex
from collections import Counter
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from textwrap import indent
from typing import Annotated, Any, Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, StrictInt, StringConstraints, TypeAdapter

from desk.events import EvMessage
from evals.tier2.artifact import Turn
from evals.tier2.schema import ScenarioId
from evals.tier2.verdict import RunVerdict

REPO_ROOT = Path(__file__).resolve().parents[1]
WAIVERS_PATH = "evals/waivers.json"
WAIVABLE_ORACLES = frozenset({"disclosure.denial"})
NonEmpty = Annotated[str, StringConstraints(strict=True, strip_whitespace=True, min_length=1)]


class Waiver(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    pass_id: Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$")]
    scenario_id: ScenarioId
    rep: StrictInt = Field(ge=1)
    oracle: Literal["disclosure.denial"]
    message_id: NonEmpty
    hits: StrictInt = Field(ge=1)
    message_sha256: Annotated[str, StringConstraints(pattern=r"^[a-f0-9]{64}$")]
    reason: NonEmpty
    signed_off_by: NonEmpty
    signed_at: AwareDatetime


def load_waivers(root: Path = REPO_ROOT) -> list[Waiver]:
    path = root / WAIVERS_PATH
    return TypeAdapter(list[Waiver]).validate_json(path.read_bytes()) if path.exists() else []


class WaiverRefused(ValueError):
    """A flag or attestation can't be bound to the finished pass's transcript."""


@dataclass(frozen=True)
class FlaggedMessage:
    scenario_id: str
    rep: int
    message_id: str
    hits: int
    text: str
    visitor_before: str
    other_messages: tuple[str, ...]
    visitor_after: str | None
    flagged_blocks: tuple[str, ...]

    @property
    def sha256(self) -> str:
        return hashlib.sha256(self.text.encode("utf-8")).hexdigest()


def _messages(turn: Turn) -> list[EvMessage]:
    return ([event.event for event in turn.events if isinstance(event.event, EvMessage)]
            + ([stored.event for stored in turn.a2a.messages] if turn.a2a else []))


def _text(message: EvMessage) -> str:
    return "\n\n".join(block.text for block in message.blocks)


def _flags(p: Any, root: Path) -> tuple[list[FlaggedMessage], list[str]]:
    """Read only flagged runs. Unread records unrelated to displayed text stay out of this reader."""
    from evals.tier2.passes import pass_dir

    flags, problems = [], []
    keys = [(r.scenario_id, r.rep) for r in p.runs]
    for row in p.runs:
        hits = row.violations.count("disclosure.denial")
        if not hits:
            continue
        name = f"{row.scenario_id} run {row.rep}"
        try:
            if row.status != "scored" or keys.count((row.scenario_id, row.rep)) != 1:
                raise ValueError("the flagged run isn't uniquely scored")
            path = pass_dir(root, p.pass_id) / "transcripts" / f"{row.scenario_id}-{row.rep}.json"
            data = json.loads(path.read_bytes())
            artifact = data["artifact"]
            wanted = (p.pass_id, row.scenario_id, row.rep)
            if any((part["pass_id"], part["scenario_id"], part["rep"]) != wanted
                   for part in (data, artifact)):
                raise ValueError("the transcript belongs to another pass or run")
            verdict = RunVerdict.model_validate(data["verdict"])
            if data.get("error") is not None or (
                    row.violations, row.success, row.false_holds, row.expected_allow, row.skipped) != (
                    [v.oracle for v in verdict.violations], verdict.success, verdict.false_holds,
                    verdict.expected_allow, verdict.skipped):
                raise ValueError("the transcript doesn't hold the row's verdict")
            turns = TypeAdapter(list[Turn]).validate_python(artifact["turns"])
            messages = [(i, m) for i, turn in enumerate(turns) for m in _messages(turn)]
            flagged = {}
            hit_counts: Counter[str] = Counter()
            block_hits: Counter[tuple[str, str]] = Counter()
            evidence_blocks: dict[str, list[str]] = {}
            for violation in verdict.violations:
                if violation.oracle != "disclosure.denial":
                    continue
                evidence = re.match(r"^(?:A2A )?message (\S+?)(?: in turn ([1-9][0-9]*))?: ",
                                    violation.evidence)
                if evidence is None:
                    raise ValueError("a disclosure.denial flag names no message id")
                mid = evidence[1]
                matches = [(i, m) for i, m in messages if m.message_id == mid]
                if len(matches) != 1:
                    raise ValueError(f"flagged message {mid} is absent or ambiguous")
                i, message = matches[0]
                block_text = violation.evidence[evidence.end():]
                block_hits[(mid, block_text)] += 1
                if (evidence[2] and int(evidence[2]) != i + 1) or block_hits[(mid, block_text)] > sum(
                        block_text == repr(b.text) for b in message.blocks if b.kind == "prose"):
                    raise ValueError(f"flagged message {mid} doesn't match its evidence text or turn")
                flagged[mid] = (i, message)
                hit_counts[mid] += 1
                evidence_blocks.setdefault(mid, []).append(next(
                    b.text for b in message.blocks if b.kind == "prose" and repr(b.text) == block_text))
            for mid, (i, message) in flagged.items():
                flags.append(FlaggedMessage(row.scenario_id, row.rep, mid, hit_counts[mid],
                            _text(message), turns[i].visitor_text,
                            tuple(_text(m) for m in _messages(turns[i]) if m.message_id != mid),
                            turns[i + 1].visitor_text if i + 1 < len(turns) else None,
                            tuple(evidence_blocks[mid])))
        except (OSError, ValueError, KeyError, TypeError) as error:
            problems.append(f"{name}: can't tie every disclosure.denial flag to a message ({error})")
    return flags, problems


def flagged_messages(p: Any, *, root: Path = REPO_ROOT) -> list[FlaggedMessage]:
    flags, problems = _flags(p, root)
    if problems:
        raise WaiverRefused("; ".join(problems))
    return flags


def _quote(text: str) -> str:
    # A longer fence keeps even attacker-supplied Markdown fences inert.
    longest = max((len(run) for run in re.findall(r"`+", text)), default=0)
    fence = "`" * max(3, longest + 1)
    return f"{fence}\n{text}\n{fence}"


def write_review(p: Any, *, root: Path = REPO_ROOT) -> Path:
    from evals.tier2.passes import pass_dir

    flags, problems = _flags(p, root)
    hits = sum(r.violations.count("disclosure.denial") for r in p.runs)
    runs = sum("disclosure.denial" in r.violations for r in p.runs)
    parts = [f"# AI-denial review for pass `{p.pass_id}`",
             f"{len(flags)} flagged message{'s' if len(flags) != 1 else ''} in "
             f"{runs} run{'s' if runs != 1 else ''} ({hits} hits).",
             "Read each refusal and its surrounding turns before signing. Only disclosure.denial can be waived."]
    for flag in flags:
        command = (f"python -m evals.run waive --pass {shlex.quote(p.pass_id)} "
                   f"--message {shlex.quote(flag.message_id)} "
                   '--reason "<why this is a correct refusal>" --signed-off-by "<owner name>"')
        parts += [f"## {flag.scenario_id}, run {flag.rep}, message `{flag.message_id}`",
                  f"Denial hits: {flag.hits}",
                  "Visitor before:\n\n" + _quote(flag.visitor_before),
                  "Flagged message (full text):\n\n" + _quote(flag.text),
                  "Flagged blocks:\n\n" + "\n\n".join(
                      "- Flagged prose block:\n\n" + indent(_quote(text), "  ", lambda line: True)
                      for text in flag.flagged_blocks),
                  "Other Desk messages in this turn:\n\n" + (
                      "\n\n".join(_quote(text) for text in flag.other_messages) or "None."),
                  "Next visitor message:\n\n" + (_quote(flag.visitor_after) if flag.visitor_after is not None
                                                 else "None; the run ended."),
                  "```sh\n" + command + "\n```"]
    if problems:
        parts += ["## Unresolved flags — review failed", *problems]
    path = pass_dir(root, p.pass_id) / "waiver-review.md"
    path.write_text("\n\n".join(parts) + "\n")
    if problems:
        raise WaiverRefused(f"{path}: " + "; ".join(problems))
    return path


def sign_waivers(pass_id: str, message_ids: list[str], *, reason: str, signed_off_by: str,
                 root: Path = REPO_ROOT) -> list[Waiver]:
    """Append owner attestations only after the entire request validates; never sign implicitly."""
    from evals.tier2.passes import load_pass

    p = load_pass(pass_id, root=root)
    if p.pass_id != pass_id:
        raise WaiverRefused("the finished pass names another pass id")
    flags = flagged_messages(p, root=root)
    current = load_waivers(root)
    checked_waivers(p, current, root=root)
    existing = {(w.pass_id, w.message_id) for w in current}
    if not message_ids:
        raise WaiverRefused("name at least one flagged message")
    if len(set(message_ids)) != len(message_ids) or any((pass_id, mid) in existing for mid in message_ids):
        raise WaiverRefused("duplicate waiver: each message in a pass is signed only once")
    added = []
    for mid in message_ids:
        matches = [flag for flag in flags if flag.message_id == mid]
        if len(matches) != 1:
            raise WaiverRefused(f"message {mid} is not flagged uniquely for disclosure.denial in pass {pass_id}")
        flag = matches[0]
        added.append(Waiver(pass_id=pass_id, scenario_id=flag.scenario_id, rep=flag.rep,
                            oracle="disclosure.denial", message_id=mid, hits=flag.hits, message_sha256=flag.sha256,
                            reason=reason, signed_off_by=signed_off_by, signed_at=datetime.now(UTC)))
    path = root / WAIVERS_PATH
    # Preserve every existing entry as JSON data, including its timestamp spelling, not a reserialized model.
    raw = json.loads(path.read_bytes()) if path.exists() else []
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps([*raw, *(w.model_dump(mode="json") for w in added)], indent=1) + "\n")
    return added


def checked_waivers(p: Any, waivers: list[Waiver], *, root: Path = REPO_ROOT) -> list[Waiver]:
    """Validate this pass's entries against local transcripts before any gate subtracts their hits."""
    selected = [w for w in waivers if w.pass_id == p.pass_id]
    if not selected:
        return waivers
    flags = flagged_messages(p, root=root)
    seen = set()
    for waiver in selected:
        key = (waiver.scenario_id, waiver.rep, waiver.message_id)
        matches = [f for f in flags if (f.scenario_id, f.rep, f.message_id) == key]
        if (key in seen or len(matches) != 1 or matches[0].sha256 != waiver.message_sha256
                or matches[0].hits != waiver.hits):
            raise WaiverRefused(f"waiver for {waiver.scenario_id} run {waiver.rep} message {waiver.message_id} "
                                "doesn't match a unique flagged message, its hit count and exact text hash")
        seen.add(key)
    return waivers
