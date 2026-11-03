"""Check the repository's Markdown docs.

    python -m desk_tools.check_docs [--final] [--root PATH]

Relative links across README.md, AGENTS.md and docs/**/*.md resolve inside the repository (anchors
are ignored). The shipped docs (SHIPPED_DOCS) hold no private reference: no `~/` path in a link target
or code; no /Users/ or /home/ path, run-ledger path or claude.ai artifact or share link anywhere; and
no term from the optional, git-ignored .local/docs-deny.txt (one per line, `#` comments, matched
ignoring case), read from the root or, in a git worktree, from the main checkout. With no list
found, the check says that private terms were not checked and still passes. The SVG images in
docs/images/, whose titles and labels are public text too, are scanned line by line for the same
references private anywhere and the same terms.
Each phrase in DISCLOSURES appears in every doc it names, ignoring case, line breaks and curly
apostrophes. The path to MVP's metric tables require a source for each row: an evals file, a pull
request, an estimate with its formula, or a paired final-pass placeholder. With --final, the shipped
docs also hold no placeholder: a value still to be measured
(`[measured: …]`) or a link the owner still has to give (`[owner: …]`).

Exit 0 when every check passes, 1 when any fails (each failure printed as `file:line: what`),
2 on a usage error.
"""

import argparse
import os
import re
import subprocess
from bisect import bisect_right
import sys
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import unquote

REPO = Path(__file__).resolve().parents[2]

# The docs a reader of the repository is pointed to. Plans, specs, reviews, research and spikes are
# the build's record: they quote placeholders and run paths, so only their links are checked.
SHIPPED_DOCS = (
    "README.md",
    "docs/threat-model.md",
    "docs/architecture-decisions.md",
    "docs/path-to-mvp.md",
    "docs/deploy.md",
    "docs/ci.md",
    "docs/evals.md",
    "docs/product-proposal.md",
    "docs/capability-prediction.md",
)

# Private anywhere in a shipped doc, and private in a link target or code (where a path is a path,
# not prose such as "the AWS CLI reads ~/.aws").
PRIVATE_ANYWHERE = (".plan-runs/", "claude.ai/artifact", "claude.ai/code/artifact", "claude.ai/share", "/Users/", "/home/")
PRIVATE_IN_PATHS = ("~/",)
# Links the project owner published on purpose: these exact URLs pass, and every other link to the same
# hosts stays private.
PUBLISHED = ("https://claude.ai/artifact/M46eP5Mtsoi15ruVMZ1uUx?sk=bbGjca_v34tZ2PPYoF0OVA",)   # the design canvas
DENY_LIST = ".local/docs-deny.txt"
IMAGES = "docs/images"   # its SVGs are scanned like the shipped docs, line by line

PLACEHOLDERS = ("[measured:", "[owner:")

# Each phrase a reader must find, and the shipped docs that must say it (case and line breaks aside).
DISCLOSURES: dict[str, tuple[str, ...]] = {
    "shows codes to whoever entered the contact": ("README.md", "docs/threat-model.md"),
    "does not establish possession of the contact": ("README.md", "docs/threat-model.md"),
    "whether a contact is on record": ("README.md", "docs/threat-model.md"),
    "cancel a contact's live challenge": ("README.md", "docs/threat-model.md"),
    "use up its hourly limit": ("README.md", "docs/threat-model.md"),
    "verification codes are simulated": ("README.md", "docs/threat-model.md"),
    "payments are mocked": ("README.md", "docs/threat-model.md"),
    "a buggy API process": ("docs/threat-model.md",),
    "out of the attacker's reach": ("docs/threat-model.md",),
}


@dataclass(frozen=True)
class Problem:
    path: str
    line: int
    message: str

    def __str__(self) -> str:
        return f"{self.path}:{self.line}: {self.message}" if self.line else f"{self.path}: {self.message}"


def linked_docs(root: Path) -> list[Path]:
    """The docs whose relative links must resolve."""
    docs = [root / name for name in ("README.md", "AGENTS.md") if (root / name).is_file()]
    if (root / "docs").is_dir():
        docs += sorted(path for path in (root / "docs").rglob("*.md") if path.is_file())
    return docs


_FENCE = re.compile(r"^[ \t]*(`{3,}(?!.*`)|~{3,})")   # at any indent, so a fence nested in a list item counts
_CODE_SPAN = re.compile(r"(?<!`)(`+)(?!`)((?:(?!\n[ \t]*\n).)+?)(?<!`)\1(?!`)", re.DOTALL)   # across lines, not paragraphs
# Markdown lets a link break across lines (at most one line break in each gap, never a blank line),
# so links are matched over the whole text, and each target's line comes from its offset.
_GAP = r"[ \t]*(?:\n[ \t]*)?"
_TEXT_CHAR = r"(?:(?!\n[ \t]*\n)[^\[\]\\]|\\.)"
_TARGET_CHAR = r"(?:[^\s()\\]|\\.)"
# Parentheses in a bare target must balance. GitHub allows any depth; `re` has no recursion, so the pattern
# nests three levels, more than any address has.
_BALANCED = _TARGET_CHAR
for _ in range(3):
    _BALANCED = rf"(?:{_TARGET_CHAR}|\({_BALANCED}*\))"
_BARE_TARGET = rf"{_BALANCED}+"
_INLINE_LINK = re.compile(   # [text](target "title") or ![alt](<target>); the target is group 1
    rf"!?\[(?:{_TEXT_CHAR}|\[{_TEXT_CHAR}*\])*\]"
    rf"\({_GAP}(<[^<>\n]*>|{_BARE_TARGET})(?:(?=\s){_GAP}(?:\"[^\"]*\"|'[^']*'|\([^)]*\)))?{_GAP}\)"
)
_REFERENCE_DEF = re.compile(rf"^ {{0,3}}\[[^\[\]]+\]:{_GAP}(<[^<>\n]*>|\S+)", re.MULTILINE)
_SCHEME = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.-]*:")


def _lines(text: str) -> Iterator[tuple[int, str, bool]]:
    """(line number, line, whether it is inside a fenced code block); fence lines themselves are skipped."""
    fence = None
    for number, line in enumerate(text.split("\n"), start=1):
        if fence is None:
            match = _FENCE.match(line)
            if match:
                fence = match.group(1)
                continue
            yield number, line, False
        elif line.strip().startswith(fence) and set(line.strip()) == {fence[0]}:
            fence = None
        else:
            yield number, line, True


def _split_fences(text: str) -> tuple[str, list[tuple[int, str]]]:
    """The text with fenced code blanked (every line break stays, so offsets keep their line), and each fenced line."""
    kept: dict[int, str] = {}
    fenced: list[tuple[int, str]] = []
    for number, line, in_fence in _lines(text):
        if in_fence:
            fenced.append((number, line))
        else:
            kept[number] = line
    return "\n".join(kept.get(number, "") for number in range(1, text.count("\n") + 2)), fenced


def _prose(text: str) -> str:
    """The text with fenced code and code spans blanked, line breaks kept."""
    return _CODE_SPAN.sub(lambda span: re.sub(r"[^\n]", " ", span.group(0)), _split_fences(text)[0])


def _line_of(text: str) -> Callable[[int], int]:
    starts = [0] + [match.end() for match in re.finditer("\n", text)]
    return lambda offset: bisect_right(starts, offset)


def code_segments(text: str) -> Iterator[tuple[int, str]]:
    """Each line of a code span or fenced code block, with its line number."""
    unfenced, fenced = _split_fences(text)
    line_of = _line_of(unfenced)
    spans = [(line_of(span.start(2)) + at, part)
             for span in _CODE_SPAN.finditer(unfenced) for at, part in enumerate(span.group(2).split("\n"))]
    yield from sorted(fenced + spans)


def link_targets(text: str) -> Iterator[tuple[int, str]]:
    """Each link target outside code, inline or in a reference definition, with the line it starts on."""
    prose = _prose(text)
    line_of = _line_of(prose)
    found = [(m.start(1), m.group(1)) for pattern in (_INLINE_LINK, _REFERENCE_DEF) for m in pattern.finditer(prose)]
    for offset, target in sorted(found):
        yield line_of(offset), target


def check_links(root: Path) -> list[Problem]:
    problems = []
    inside = root.resolve()
    for doc in linked_docs(root):
        for number, raw in link_targets(doc.read_text()):
            target = raw[1:-1] if raw.startswith("<") and raw.endswith(">") else raw
            if not target or target.startswith("#") or target.startswith("//") or _SCHEME.match(target):
                continue
            path = unquote(target.split("#", 1)[0].split("?", 1)[0])
            resolved = root / path.lstrip("/") if path.startswith("/") else doc.parent / path
            where = doc.relative_to(root).as_posix()
            if not resolved.resolve().is_relative_to(inside):   # it may exist here, but not in a clone
                problems.append(Problem(where, number, f"broken link {target} (it leaves the repository)"))
            elif not resolved.exists():
                problems.append(Problem(where, number, f"broken link {target}"))
    return problems


def shipped_docs(root: Path) -> list[tuple[str, str]]:
    """(path, text) of each shipped doc in the tree; one not written yet is skipped here."""
    return [(name, (root / name).read_text()) for name in SHIPPED_DOCS if (root / name).is_file()]


def deny_list(root: Path) -> Path | None:
    """The root's .local/docs-deny.txt or, when it has none, the main checkout's: a git worktree has no .local/
    of its own, so the list beside the repository's common git directory is read. A git error means no list."""
    path = root / DENY_LIST
    if path.is_file():
        return path
    try:
        found = subprocess.run(["git", "-C", str(root), "rev-parse", "--path-format=absolute", "--git-common-dir"],
                               capture_output=True, text=True)
    except (OSError, subprocess.SubprocessError):
        return None
    common = found.stdout.strip()
    if found.returncode != 0 or not os.path.isabs(common):
        return None
    path = Path(common).parent / DENY_LIST
    return path if path.is_file() else None


def deny_terms(root: Path) -> list[tuple[int, str]]:
    path = deny_list(root)
    if path is None:
        return []
    terms = []
    for number, line in enumerate(path.read_text().splitlines(), start=1):
        term = line.strip()
        if term and not term.startswith("#"):
            terms.append((number, term.casefold()))
    return terms


def _private_anywhere(line: str, terms: list[tuple[int, str]]) -> set[str]:
    """What in the line is private wherever it appears: a PRIVATE_ANYWHERE pattern or a deny-list term."""
    for url in PUBLISHED:
        line = line.replace(url, "")
    folded = line.casefold()
    return ({p for p in PRIVATE_ANYWHERE if p in line}
            | {f"a term from {DENY_LIST}, line {at}" for at, term in terms if term in folded})


def check_private(root: Path) -> list[Problem]:
    problems = []
    terms = deny_terms(root)
    for name, text in shipped_docs(root):
        found = {number: _private_anywhere(line, terms) for number, line in enumerate(text.splitlines(), start=1)}
        paths = list(code_segments(text)) + list(link_targets(text))
        for number, segment in paths:
            found.setdefault(number, set()).update(f"{p} in a link or code" for p in PRIVATE_IN_PATHS if p in segment)
        for number in sorted(found):
            for what in sorted(found[number]):
                problems.append(Problem(name, number, f"private reference ({what})"))
    # A committed image's title, description and labels are public text too.
    for image in sorted((root / IMAGES).glob("*.svg")):
        name = image.relative_to(root).as_posix()
        for number, line in enumerate(image.read_text().splitlines(), start=1):
            problems += [Problem(name, number, f"private reference ({what})")
                         for what in sorted(_private_anywhere(line, terms))]
    return problems


def _normalized(text: str) -> str:
    return " ".join(text.replace("\u2019", "'").casefold().split())


def check_disclosures(root: Path) -> list[Problem]:
    problems = []
    required: dict[str, list[str]] = {}
    for phrase, paths in DISCLOSURES.items():
        for path in paths:
            required.setdefault(path, []).append(phrase)
    for path, phrases in required.items():
        doc = root / path
        if not doc.is_file():
            problems.append(Problem(path, 0, "missing (it must carry the required disclosures)"))
            continue
        text = _normalized(doc.read_text())
        problems += [Problem(path, 0, f'missing the disclosure "{p}"') for p in phrases if _normalized(p) not in text]
    return problems


def check_placeholders(root: Path) -> list[Problem]:
    problems = []
    for name, text in shipped_docs(root):
        for number, line in enumerate(text.splitlines(), start=1):
            problems += [Problem(name, number, f"placeholder {p}") for p in PLACEHOLDERS if p in line]
    return problems


def _mvp_source(root: Path, source: str) -> bool:
    if source.startswith("estimate:"):
        # Judge the formula itself, not a '+' or '-' in a linked file name.
        formula = source.removeprefix("estimate:").split(";", 1)[0].split("[", 1)[0]
        return "=" in formula and bool(re.search(r"[+×*/−-]", formula))
    for _, raw in link_targets(source):
        target = raw.strip("<>")
        if re.fullmatch(r"https://github\.com/[^/]+/[^/]+/pull/\d+(?:#[^\s]*)?", target):
            return True
        if _SCHEME.match(target) or target.startswith("//"):
            continue
        path = unquote(target.split("#", 1)[0].split("?", 1)[0])
        resolved = ((root / path.lstrip("/")) if path.startswith("/") else root / "docs" / path).resolve()
        if resolved.is_relative_to((root / "evals").resolve()) and resolved.is_file():
            return True
    return False


def _table_cells(line: str) -> list[str] | None:
    """Split at pipes outside code spans and escapes, or return None if there are none."""
    line = line.strip()
    masked = _CODE_SPAN.sub(lambda span: " " * len(span.group(0)), line)
    pipes = [match.start() for match in re.finditer(r"\\.|\|", masked) if match.group(0) == "|"]
    if not pipes:
        return None
    bounds = [-1, *pipes, len(line)]
    cells = [line[left + 1:right].strip() for left, right in zip(bounds, bounds[1:])]
    if pipes and pipes[0] == 0:
        cells = cells[1:]
    if pipes and pipes[-1] == len(line) - 1:
        cells = cells[:-1]
    return cells


def check_mvp_number_sources(root: Path) -> list[Problem]:
    """Every metric row needs its own source, even when the row contains no digits yet."""
    name = "docs/path-to-mvp.md"
    doc = root / name
    if not doc.is_file():
        return []  # The section test requires the real document; temp trees may leave it out.
    metric_sections = {"Architecture", "Model integration", "Scaling and what breaks first",
                       "Latency and cost per conversation"}
    problems = []
    section, header, candidate = "", None, None
    for number, line, in_fence in _lines(doc.read_text()):
        if in_fence:
            header, candidate = None, None
            continue
        if line.startswith("## "):
            section, header, candidate = line[3:].strip(), None, None
            continue
        if section not in metric_sections or not line.strip():
            header, candidate = None, None
            continue
        cells = _table_cells(line)
        delimiter = cells is not None and all(re.fullmatch(r":?-+:?", cell) for cell in cells)
        if cells is None or (not delimiter and re.match(r"^\s*(?:#{1,6}(?:\s|$)|>|[-*+]\s|\d+[.)]\s)", line)):
            header, candidate = None, None
            continue
        if header is None:
            # A table starts only when a header is followed by a matching delimiter row.
            if (candidate is not None and len(cells) == len(candidate[1])
                    and (len(cells) > 1 or line.lstrip().startswith("|"))
                    and delimiter):
                header = [cell.casefold() for cell in candidate[1]]
                if "source" not in header:
                    problems.append(Problem(name, candidate[0], "metric table needs a source column"))
                candidate = None
            else:
                candidate = number, cells
            continue
        if "source" not in header:
            continue
        if len(cells) != len(header):
            problems.append(Problem(name, number, "metric row must have a cell for every column, including source"))
            continue
        source = cells[header.index("source")]
        pending = any("[measured:" in cell for cell in cells)
        if pending:
            valid = (source == "[measured: source, final held-out pass]"
                     and "value" in header
                     and re.fullmatch(r"\[measured: [^\[\]\n]+, final held-out pass\]",
                                      cells[header.index("value")]))
        else:
            valid = _mvp_source(root, source)
        if not valid:
            problems.append(Problem(name, number, "metric row needs an evals file or pull request source, "
                                    "an estimate: formula, or paired final held-out pass placeholders"))
    return problems


def check(root: Path, final: bool = False) -> list[Problem]:
    problems = check_links(root) + check_private(root) + check_disclosures(root) + check_mvp_number_sources(root)
    if final:
        problems += check_placeholders(root)
    return problems


def main(argv: list[str] | None = None, out: Callable[[str], None] = print) -> int:
    parser = argparse.ArgumentParser(prog="python -m desk_tools.check_docs", description=__doc__.split("\n\n")[0])
    parser.add_argument("--final", action="store_true", help="also refuse placeholders in the shipped docs")
    parser.add_argument("--root", type=Path, default=REPO, help="the repository root (default: this checkout)")
    args = parser.parse_args(argv)
    root = args.root.resolve()
    if deny_list(root) is None:
        out(f"docs-check: no deny list ({DENY_LIST}), private terms not checked")
    problems = check(root, final=args.final)
    for problem in problems:
        out(f"docs-check: {problem}")
    if problems:
        out(f"docs-check: {len(problems)} problem{'s' if len(problems) != 1 else ''}")
        return 1
    out("docs-check: ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
