"""Verification limits and Demo inbox reads: a code reaches only the contact on record, and only once.

Each case plays a visitor who types a contact into the verify card, as the API forwards it
(`/verify/start`, `/verify/check`), or Claude calling `native.start_verification`. A code goes only
to the Demo inbox entry for a contact on record; every start answers with the same message, so it
never says whether a contact is on record; and a contact gets one live challenge, five challenges
and ten failed attempts an hour, then the owner is told. A session verifies one person, with
assurance `demo_code`, and reads only the entries of challenges it started, never the owner's
alerts or ledger checkpoints. No code reaches visitor text, Claude's tool results or the ledger.

Codes come only from a session's own Demo inbox, read where the case plays that session's own
verification ("Demo limit: the Demo inbox"). The cases never print a code: a failure names the
text or entry by label, with any code shown as `<code>`. An entry's recipient is named only as
masked, unmasked or owner (`recipient`), and the on-record checks never print a contact. Texts a
case expects to be the same (the starts' messages, what Claude sees, the failed checks' answers)
are told apart by size and where they part (`told_apart`), never by what they say, so a contact a
kernel echoed into one isn't printed either. Only the code leak scan prints visitor text: the text
it flags, with its codes shown as `<code>`.
"""

import json
import re
import unicodedata
from collections.abc import Iterator
from typing import Any

import pytest
from pydantic import BaseModel

from desk.contracts import Decision, DemoInboxEntry, ExecResult, InboxNotice
from desk.kernel_api import VerifyStarted
from evals.fakes import FakeAnthropic, Json
from evals.oracles import normalize, visible_texts
from evals.tier1.args import quote_args, start_verification_args
from evals.tier1.golden_desk import (
    CONTACTS,
    REVIEW_PASS,
    REVIEWER_MODEL,
    STUB_CODE,
    Caller,
    GoldenDesk,
    check_args_schema,
    decide,
    golden_desk,
    open_caller,
    session_row,
)
from evals.tier1.harness import Expect, KernelHarness, declared_names, described
from evals.tier1.test_reply_golden import CLEAN_EN, check_reply, passes
from evals.tier1.test_sessions import (
    UNAUTHENTICATED,
    assert_ledgered,
    assert_only_auth,
    session_token,
    token_secrets,
)

DANA, BOB = CONTACTS["dana"], CONTACTS["bob"]   # the seed's contacts on record
STRANGER = "stranger@example.com"                # a contact nobody has on record
# The stub's stand-ins: masked contacts shaped like Plan 01a's `mask_contact`.
STAND_IN_MASKED = {"dana": "d\u2022\u2022\u2022@example.com", "bob": "b\u2022\u2022\u2022@example.com"}
STAND_IN_PUBLIC_CONTACT = "(510) 555-0142"   # the seed charter's contact (Plan 01a), the stub's stand-in
CHALLENGES_PER_HOUR = 5    # per contact on record, across sessions
ATTEMPTS_PER_CHALLENGE = 5
FAILURES_PER_HOUR = 10     # per contact on record, across sessions
CODE_LIFE_S = 10 * 60
HOUR_S = 3600
CHECKPOINT_EVERY = 50   # the kernel writes a head checkpoint to the owner's Demo inbox at every 50th entry (Plan 01a)

OK = Expect()                                              # a 200 answer, whatever it holds
INVALID = Expect(status=422, fields={"code": "invalid"})   # a failed check, whatever failed
NOTHING_SENT = Expect(fields={"inbox": []})                # a start that sent no code

# Codes in text

SIX_DIGITS = re.compile(r"(?<!\d)\d{6}(?!\d)")


def _as_read(text: str) -> str:
    """Text as the leak checks read it: as a visitor sees it (`normalize`), every decimal digit in
    any script written as its ASCII digit."""
    return "".join(str(unicodedata.digit(ch)) if unicodedata.category(ch) == "Nd" else ch for ch in normalize(text))


def _code_pattern(code: str, edge: str = r"\d") -> re.Pattern[str]:
    """The code's digits in order, with spaces or punctuation allowed between them, and no `edge`
    character just before or after."""
    return re.compile(rf"(?<!{edge})" + r"[\W_]*".join(map(re.escape, code)) + rf"(?!{edge})")


def shows_a_code(text: str, codes: list[str]) -> bool:
    """Whether visitor text shows one of `codes` (its digits may be split by spaces or punctuation,
    written in another script's digits or broken up by invisible characters), or any six-digit
    number, which kernel visitor text never holds."""
    shown = _as_read(text)
    return bool(SIX_DIGITS.search(shown)) or any(_code_pattern(code).search(shown) for code in codes)


def code_in(entry: DemoInboxEntry) -> str:
    """The one six-digit code in a `verification_code` entry's body (ASCII digits, as the kernel
    writes codes). A failure says how many it found, never what they are: no assertion here names
    the entry or its body, so pytest's explanation can't print them either."""
    entry_id, kind, codes = entry.entry_id, entry.kind, SIX_DIGITS.findall(entry.body)
    assert kind == "verification_code", f"Demo inbox entry {entry_id} isn't a verification code: {kind}"
    found = len(codes)
    assert found == 1, f"Demo inbox entry {entry_id} holds {found} six-digit codes, not one"
    return codes[0]


def wrong_codes(code: str, n: int) -> list[str]:
    """`n` six-digit codes that aren't `code`: the ones after it, wrapping at 999999."""
    return [f"{(int(code) + step) % 1_000_000:06d}" for step in range(1, n + 1)]


# Payload leaves the code scan reads strictly: ids, hashes, signatures, nonces, tokens and
# timestamps, named by their key or shaped like a hex digest or a UUID. A run of a code's digits
# inside one is chance; the code standing alone in one is a leak.
_OPAQUE_KEY = re.compile(r"(?:^|_)(?:ids?|hash|sha256|signature|sig|nonce|token|hex|head|at|ts)$")
_HEX = re.compile(r"[0-9A-Fa-f]{16,}|[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}")
_TIMESTAMP = re.compile(r"\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?")


def _leaves(node: Any, opaque: bool = False) -> Iterator[tuple[str, bool]]:
    """Every key, string and number in a payload as text, each with whether it is opaque (an id, a
    hash, a signature, a nonce, a token or a timestamp, by its key or its shape). A number is
    written with at least six digits, since a code may start with zeros. A value that is a whole
    timestamp is left out: its fraction can hold any six digits."""
    if isinstance(node, BaseModel):
        node = node.model_dump(mode="json")
    if isinstance(node, dict):
        for key, value in node.items():
            yield from _leaves(key)
            yield from _leaves(value, bool(_OPAQUE_KEY.search(str(key))))
    elif isinstance(node, list | tuple):
        for item in node:
            yield from _leaves(item, opaque)
    elif node is not None and not isinstance(node, bool):
        text = f"{node:06d}" if isinstance(node, int) else str(node)
        if not _TIMESTAMP.fullmatch(text.strip()):
            yield text, opaque or bool(_HEX.fullmatch(text.strip()))


def holds_a_code(payload: Any, codes: list[str]) -> bool:
    """Whether a JSON payload (a kernel answer, a ledger summary) holds one of `codes`. Each key,
    string and number is read as `shows_a_code` reads text, so a code counts however its digits are
    written. In an id, a hash, a signature, a nonce or a token, the code counts only with no letter
    or digit beside it, never as a run inside one; a whole timestamp isn't read."""
    for text, opaque in _leaves(payload):
        read = _as_read(text)
        if any(_code_pattern(code, r"[0-9A-Za-z]" if opaque else r"\d").search(read) for code in codes):
            return True
    return False


def redacted(text: str, codes: list[str]) -> str:
    """Text safe for a failure message: read as `shows_a_code` reads it, every code it finds shown
    as `<code>`."""
    shown = _as_read(text)
    for code in codes:
        shown = _code_pattern(code).sub("<code>", shown)
    return SIX_DIGITS.sub("<code>", shown)


# Texts a kernel must keep the same

def told_apart(values: dict[str, Any], named: frozenset[str] = frozenset()) -> str:
    """Values a case expects to be the same, by label, as a failure tells them apart: the labels
    of equal values together, each value as `described` shows it (a text by its length, a list or
    an object by its size, never what it holds, since a kernel may have echoed a contact, a code
    or a token into it), and each text after the first with the character where it parts from the
    first. No values at all are "nothing to compare"."""
    if not values:
        return "nothing to compare"
    groups: list[tuple[list[str], Any]] = []
    for label, value in values.items():
        alike = next((labels for labels, held in groups if held == value), None)
        if alike is None:
            groups.append(([label], value))
        else:
            alike.append(label)
    first = groups[0][1]
    shown = []
    for n, (labels, value) in enumerate(groups):
        told = described(value, named)
        if n and isinstance(first, str) and isinstance(value, str):
            at = next((i for i, (a, b) in enumerate(zip(first, value)) if a != b), min(len(first), len(value)))
            told += f", parting from the first at character {at + 1}"
        who = labels[0] if len(labels) == 1 else f"{', '.join(labels[:-1])} and {labels[-1]}"
        shown.append(f"{who}: {told}")
    return "; ".join(shown)


# Steps a case takes

def code_sent_to(masked: str) -> Expect:
    """A start that sent a code: one notice, addressed to the masked contact on record."""
    return Expect(fields={"inbox": {"$len": 1}, "inbox.0.to": masked})


def verified_as(caller: Caller) -> Expect:
    """A check that verified the caller's session, simulated (`demo_code`)."""
    return Expect(fields={"session_id": caller.state.session_id, "verified": True, "assurance": "demo_code"})


async def start(k: KernelHarness, caller: Caller, contact: str, *, expect: Expect) -> VerifyStarted:
    """The contact typed into the caller's verify card (`POST /verify/start`)."""
    body = {"session_id": caller.state.session_id, "contact": contact}
    return await k.call("POST /verify/start", body=body, auth=caller.auth, expect=expect)


async def check(k: KernelHarness, caller: Caller, code: str, *, expect: Expect) -> Any:
    """A code typed into the caller's verify card (`POST /verify/check`)."""
    body = {"session_id": caller.state.session_id, "code": code}
    return await k.call("POST /verify/check", body=body, auth=caller.auth, expect=expect)


async def own_inbox(k: KernelHarness, caller: Caller, *, expect: Expect = OK) -> list[DemoInboxEntry]:
    """The caller's own Demo inbox: the entries of challenges its session started."""
    return await k.call("GET /demo_inbox?session_id=", query={"session_id": caller.state.session_id},
                        auth=caller.auth, expect=expect)


async def owner_inbox(k: KernelHarness, desk: GoldenDesk) -> list[DemoInboxEntry]:
    """The copy's whole Demo inbox, as its owner reads it."""
    return await k.call("GET /demo_inbox", auth=desk.owner)


def addressed(entries: list[DemoInboxEntry]) -> list[tuple[str, str]]:
    """Each entry's kind and recipient, never its body: what the cases compare. A failure shows
    them only through `recipients`."""
    return [(entry.kind, entry.to) for entry in entries]


MASK = "\u2022"   # what Plan 01a's `mask_contact` puts in place of a contact's hidden part


def recipient(to: str) -> str:
    """An entry's recipient as a failure names it: "owner", "masked" (it holds `mask_contact`'s
    mask) or "unmasked", never the address, so a kernel that addressed an entry to a raw contact
    can't make a failure print that contact."""
    if to == "owner":
        return "owner"
    return "masked" if MASK in to else "unmasked"


def recipients(pairs: list[tuple[str, str]]) -> list[tuple[str, str]]:
    """`addressed` pairs as a failure shows them: each kind with its `recipient`."""
    return [(kind, recipient(to)) for kind, to in pairs]


def assert_addressed(pairs: list[tuple[str, str]], expected: list[tuple[str, str]], failure: str) -> None:
    """`pairs` (from `addressed`) are exactly `expected`, each recipient compared as its address.
    `failure` says what the pairs are, with `{}` where they go, and shows them only as `recipients`
    names them; pytest is given only whether they matched, so its explanation can't print an
    address either."""
    same = pairs == expected
    assert same, failure.format(recipients(pairs))


async def code_for(k: KernelHarness, caller: Caller, notice: InboxNotice) -> str:
    """The code a start sent: from the caller's own Demo inbox, the entry its notice names. On the
    stub, whose inbox holds generated text, `STUB_CODE`."""
    entries = await own_inbox(k, caller)
    if not k.is_real:
        return STUB_CODE
    named = [entry for entry in entries if entry.entry_id == notice.entry_id]
    count, wanted = len(named), notice.to
    assert count == 1, f"the session's Demo inbox has {count} entries with notice {notice.entry_id}'s id"
    to = named[0].to
    same, named_to = to == wanted, (recipient(wanted), recipient(to))
    assert same, f"notice {notice.entry_id} and its entry name different recipients: {' and '.join(named_to)}"
    return code_in(named[0])


async def started_code(k: KernelHarness, caller: Caller, masked: str) -> str:
    """Dana's contact typed into the caller's verify card, and the code it sent, from the caller's own inbox."""
    started = await start(k, caller, DANA, expect=code_sent_to(masked))
    return await code_for(k, caller, started.inbox[0])


async def masked_on_record(k: KernelHarness, records: Any, desk: GoldenDesk) -> dict[str, str]:
    """Each person's masked contact on record, by person id (`kernel_ro.people`); the seed's people
    are checked to show no raw contact."""
    if not k.is_real:
        return {desk.people[name]: masked for name, masked in STAND_IN_MASKED.items()}
    rows = {row["person_id"]: row["masked_contact"] for row in await records.people(desk.copy.copy_id)
            if row["desk_id"] == desk.desk_id}
    for name, person_id in desk.people.items():
        masked = rows.get(person_id)
        hidden = isinstance(masked, str) and CONTACTS[name] not in masked
        problem = ("is missing" if masked is None else
                   "holds the raw contact" if isinstance(masked, str) else "isn't text")
        assert hidden, f"kernel_ro.people's masked contact for {name} {problem}"
    return rows


async def assert_unverified(k: KernelHarness, records: Any, desk: GoldenDesk, caller: Caller) -> None:
    """The caller's session is verified as nobody: what `/whoami` says, and its `kernel_ro.sessions` row."""
    await k.call("GET /whoami", auth=caller.auth, expect=Expect(fields={
        "session.session_id": caller.state.session_id, "session.verified": False, "session.assurance": "none",
    }))
    if k.is_real:
        row = await session_row(records, desk, caller)
        state = (row["verified"], row["assurance"], row["person_id"])
        assert state == (False, "none", None), f"session {caller.state.session_id} is {state}"


async def public_contact(k: KernelHarness, records: Any, desk: GoldenDesk) -> str:
    """The business's public contact: the `contact` claim of the Desk's public charter fact."""
    if not k.is_real:
        return STAND_IN_PUBLIC_CONTACT
    values = [claim["value"] for fact in await records.facts(desk.copy.copy_id)
              if fact["desk_id"] == desk.desk_id and fact["kind"] == "charter" and "public" in fact["readers"]
              for claim in fact["claims"] if claim["key"] == "contact"]
    count = len(values)
    assert count == 1, f"the Desk's public charter has {count} contacts"
    return values[0]


async def reach_head_checkpoint(k: KernelHarness, records: Any, desk: GoldenDesk) -> None:
    """Entries the owner reports (`POST /ledger/append`) until the Desk's ledger has reached entry
    50, where the kernel writes a head checkpoint to the owner's Demo inbox. On the stub, one entry
    is contract-checked."""
    count = 1
    if k.is_real:
        entries = await records.ledger_entries(desk.copy.copy_id, desk.desk_id)
        count = max(0, CHECKPOINT_EVERY - (entries[-1].seq if entries else 0))
    event = {"kind": "session", "origin": "api", "session_id": None, "summary": {"note": "an entry from the evals"}}
    for _ in range(count):
        await k.call("POST /ledger/append", body={"desk_id": desk.desk_id, "event": event}, auth=desk.owner,
                     expect=Expect(fields={"desk_id": desk.desk_id, "event.kind": "session"}))


async def verify_by_tool(
    k: KernelHarness, caller: Caller, contact: str, *, sent_to: str | None
) -> tuple[Decision, ExecResult]:
    """Claude's `native.start_verification` for the contact, which the seed lets any unverified
    visitor run: decided (a message to the contact on record) and executed. `sent_to` is the masked
    contact its one notice names, or None when it sends nothing."""
    args = start_verification_args(contact)
    await check_args_schema(k, caller, "native.start_verification", args)
    decision = await decide(k, caller, "native.start_verification", args, expect=Expect(fields={
        "outcome": "allow", "state": "allowed", "action.recipient": "verified_contact",
    }))
    sent = code_sent_to(sent_to) if sent_to is not None else NOTHING_SENT
    result = await k.call(
        "POST /execute",
        body={"decision_id": decision.decision_id, "session_id": caller.state.session_id,
              "generation": caller.state.generation},
        auth=caller.auth,
        expect=Expect(fields={"state": "succeeded", **sent.fields}),
    )
    return decision, result


# Where a code goes

@pytest.mark.requires("01b")
async def test_code_goes_only_to_contact_on_record(k: KernelHarness, records):
    """Dana's contact sends one code, to the Demo inbox entry for her masked contact on record: the
    session's own inbox holds that one entry, and across the copy every code goes to a masked
    contact on record and everything else to the owner."""
    desk = await golden_desk(k)
    on_record = await masked_on_record(k, records, desk)
    masked = on_record[desk.people["dana"]]
    visitor = await open_caller(k, desk, "visitor")
    before = {entry.entry_id for entry in await owner_inbox(k, desk)}
    started = await start(k, visitor, DANA, expect=code_sent_to(masked))
    entries = await own_inbox(k, visitor, expect=Expect(fields={"0.kind": "verification_code", "0.to": masked}))
    copy_entries = await owner_inbox(k, desk)
    if k.is_real:
        ids, notice_id = [entry.entry_id for entry in entries], started.inbox[0].entry_id
        assert_addressed(addressed(entries), [("verification_code", masked)], "the session's Demo inbox holds {}")
        assert ids == [notice_id], f"the session's entry {ids} isn't the one its notice names, {notice_id}"
        code_in(entries[0])   # one six-digit code
        misaddressed = [(kind, to) for kind, to in addressed(copy_entries)
                        if (to not in on_record.values() if kind == "verification_code" else to != "owner")]
        assert_addressed(misaddressed, [], "entries to neither a masked contact on record nor the owner: {}")
        new = addressed([entry for entry in copy_entries if entry.entry_id not in before])
        assert_addressed(new, [("verification_code", masked)], "Dana's start added {} to the copy's Demo inbox")


@pytest.mark.requires("01b")
async def test_unknown_contact_gets_the_same_message_and_a_lead_note(k: KernelHarness, records):
    """A contact nobody has on record gets, byte for byte, the message Dana's contact gets, so the
    reply never says whether a contact is on record. It sends no code anywhere, the attempt is
    ledgered, and the typed contact is kept as a lead note for the owner."""
    desk = await golden_desk(k)
    masked = (await masked_on_record(k, records, desk))[desk.people["dana"]]
    for_dana = await start(k, await open_caller(k, desk, "visitor"), DANA, expect=code_sent_to(masked))
    stranger = await open_caller(k, desk, "visitor")
    before = {entry.entry_id for entry in await owner_inbox(k, desk)}
    leads_before = {row["lead_id"] for row in await records.leads(desk.copy.copy_id)} if k.is_real else set()
    async with assert_ledgered(records, desk.copy, desk.desk_id, "verify", session_id=stranger.state.session_id):
        for_stranger = await start(k, stranger, STRANGER, expect=NOTHING_SENT)
    same = for_stranger.message == for_dana.message
    told = told_apart({"Dana's": for_dana.message, "the stranger's": for_stranger.message})
    assert same, f"the messages differ: {told}"
    stranger_entries = await own_inbox(k, stranger)
    copy_entries = await owner_inbox(k, desk)
    if k.is_real:
        assert_addressed(addressed(stranger_entries), [], "the stranger's Demo inbox holds {}")
        new = addressed([entry for entry in copy_entries if entry.entry_id not in before])
        assert_addressed(new, [], "a start for a contact not on record added {} to the copy's Demo inbox")
        notes = [row["note"] for row in await records.leads(desk.copy.copy_id)
                 if row["lead_id"] not in leads_before and row["desk_id"] == desk.desk_id]
        noted, holding = len(notes) == 1 and STRANGER in notes[0], sum(STRANGER in note for note in notes)
        assert noted, (f"the start left {len(notes)} new lead notes ({holding} holding the typed contact), "
                       "not one that holds it")


# Whose inbox

@pytest.mark.requires("01b")
async def test_session_b_cannot_read_session_as_entries(k: KernelHarness, records):
    """Session A starts Dana's verification. Session B's own inbox holds nothing of it, and B's
    token naming A's session is 401, ledgered as `auth` on A's Desk with neither token in it."""
    desk = await golden_desk(k)
    masked = (await masked_on_record(k, records, desk))[desk.people["dana"]]
    a = await open_caller(k, desk, "visitor")
    b = await open_caller(k, desk, "visitor")
    await start(k, a, DANA, expect=code_sent_to(masked))
    a_entries = await own_inbox(k, a)
    b_entries = await own_inbox(k, b)
    if k.is_real:
        assert_addressed(addressed(a_entries), [("verification_code", masked)], "A's Demo inbox holds {}")
        assert_addressed(addressed(b_entries), [], "B's Demo inbox holds {}")
    tokens = {**token_secrets(session_token(a), "A's"), **token_secrets(session_token(b), "B's")}
    async with assert_ledgered(records, desk.copy, desk.desk_id, "auth", session_id=a.state.session_id) as new:
        await k.call("GET /demo_inbox?session_id=", query={"session_id": a.state.session_id}, auth=b.auth,
                     expect=UNAUTHENTICATED)
    assert_only_auth(new, tokens)


@pytest.mark.requires("01b")
async def test_owner_alerts_never_reach_a_visitor_inbox(k: KernelHarness, fake: FakeAnthropic, records):
    """With an owner alert (a held quote) and a head checkpoint in the copy's Demo inbox, a visitor
    who types "owner" or the business's public contact into the verify card gets nothing: no notice,
    and an own inbox with no alert, checkpoint or code (neither is a contact on record)."""
    desk = await golden_desk(k)
    fake.default(REVIEWER_MODEL, Json(REVIEW_PASS))   # the reviewer passes, if the kernel asks it
    holder = await open_caller(k, desk, "visitor")
    await decide(k, holder, "native.quote", quote_args("drain", requested_discount_bp=8000),
                 expect=Expect(fields={"outcome": "hold", "state": "held"}))   # rv-quote allows no discount
    await reach_head_checkpoint(k, records, desk)
    owner_kinds = {kind for kind, _ in addressed(await owner_inbox(k, desk))}
    if k.is_real:
        assert {"alert", "head_checkpoint"} <= owner_kinds, f"the owner's Demo inbox holds only {sorted(owner_kinds)}"
    typed_in = (("owner", "'owner'"), (await public_contact(k, records, desk), "the business's public contact"))
    for typed, what in typed_in:
        visitor = await open_caller(k, desk, "visitor")
        await start(k, visitor, typed, expect=NOTHING_SENT)
        shown = addressed(await own_inbox(k, visitor))
        if k.is_real:
            assert_addressed(shown, [], f"a visitor who typed {what} reads {{}} in their Demo inbox")


# Limits

@pytest.mark.requires("01b")
async def test_sixth_challenge_in_an_hour_refused_and_ledgered(k: KernelHarness, records):
    """Five starts for Dana from five sessions each send a code; a sixth within the hour gets the
    same message but sends none, is ledgered, and tells the owner. An hour later a start works, and
    its code verifies."""
    desk = await golden_desk(k)
    masked = (await masked_on_record(k, records, desk))[desk.people["dana"]]
    messages = []
    for _ in range(CHALLENGES_PER_HOUR):
        session = await open_caller(k, desk, "visitor")
        messages.append((await start(k, session, DANA, expect=code_sent_to(masked))).message)
    sixth = await open_caller(k, desk, "visitor")
    before = {entry.entry_id for entry in await owner_inbox(k, desk)}
    async with assert_ledgered(records, desk.copy, desk.desk_id, "verify", session_id=sixth.state.session_id):
        refused = await start(k, sixth, DANA, expect=NOTHING_SENT)
    uniform = set(messages) == {refused.message}
    starts = {**{f"start {n}": text for n, text in enumerate(messages, 1)}, "the sixth": refused.message}
    assert uniform, f"the starts' messages differ: {told_apart(starts)}"
    sixth_entries = await own_inbox(k, sixth)
    copy_entries = await owner_inbox(k, desk)
    if k.is_real:
        assert_addressed(addressed(sixth_entries), [], "the sixth session's Demo inbox holds {}")
        new = addressed([entry for entry in copy_entries if entry.entry_id not in before])
        assert_addressed(new, [("alert", "owner")],
                         "the sixth start added {} to the copy's Demo inbox, not an owner alert")
    k.clock.advance(HOUR_S + 1)
    await check(k, sixth, await started_code(k, sixth, masked), expect=verified_as(sixth))


@pytest.mark.requires("01b")
async def test_new_challenge_cancels_the_old_code(k: KernelHarness, records):
    """A contact has one live challenge: a start from another session cancels the code an earlier
    one sent, and so does a second start in the same session. Only the newest code verifies."""
    desk = await golden_desk(k)
    masked = (await masked_on_record(k, records, desk))[desk.people["dana"]]
    a = await open_caller(k, desk, "visitor")
    b = await open_caller(k, desk, "visitor")
    a_code = await started_code(k, a, masked)
    b_code = await started_code(k, b, masked)
    await check(k, a, a_code, expect=INVALID)
    await assert_unverified(k, records, desk, a)
    await check(k, b, b_code, expect=verified_as(b))
    c = await open_caller(k, desk, "visitor")
    first = await started_code(k, c, masked)
    second = await started_code(k, c, masked)   # the same session's next start cancels its first code
    await check(k, c, first, expect=INVALID)
    await check(k, c, second, expect=verified_as(c))


@pytest.mark.requires("01b")
async def test_five_attempts_per_challenge(k: KernelHarness, records):
    """Five wrong codes use a challenge up, so the right one then fails too, and the session stays
    unverified. Every failed check, a check with no challenge at all included, gets the same 422
    `invalid`, and each is ledgered. "The same" is compared on the status and the JSON the kernel
    sent (`Called.raw`), not on the contract's reading of it, so a detail that differs between
    checks counts even in a field `KernelError` doesn't model (which fails the call first)."""
    desk = await golden_desk(k)
    masked = (await masked_on_record(k, records, desk))[desk.people["dana"]]
    visitor = await open_caller(k, desk, "visitor")
    session_id = visitor.state.session_id
    async with assert_ledgered(records, desk.copy, desk.desk_id, "verify", session_id=session_id):
        await check(k, visitor, STUB_CODE, expect=INVALID)   # no challenge yet
    code = await started_code(k, visitor, masked)
    for attempt in [*wrong_codes(code, ATTEMPTS_PER_CHALLENGE), code]:   # five wrong, then the right one
        async with assert_ledgered(records, desk.copy, desk.desk_id, "verify", session_id=session_id):
            await check(k, visitor, attempt, expect=INVALID)
    await assert_unverified(k, records, desk, visitor)
    checks = [called for called in k.responses if called.route == "POST /verify/check"]
    failures = {(called.status, json.dumps(called.raw, sort_keys=True)) for called in checks}
    count = len(failures)
    answers = {f"check {n} ({called.status})": json.dumps(called.raw, sort_keys=True)
               for n, called in enumerate(checks, 1)}
    assert count == 1, f"failed checks answered {count} ways: {told_apart(answers)}"


@pytest.mark.requires("01b")
async def test_code_expires_after_ten_minutes(k: KernelHarness, records):
    """A code verifies within its ten minutes, and fails once they have passed."""
    desk = await golden_desk(k)
    masked = (await masked_on_record(k, records, desk))[desk.people["dana"]]
    on_time = await open_caller(k, desk, "visitor")
    code = await started_code(k, on_time, masked)
    k.clock.advance(CODE_LIFE_S - 10)
    await check(k, on_time, code, expect=verified_as(on_time))
    late = await open_caller(k, desk, "visitor")
    code = await started_code(k, late, masked)
    k.clock.advance(CODE_LIFE_S + 1)
    await check(k, late, code, expect=INVALID)
    await assert_unverified(k, records, desk, late)


@pytest.mark.requires("01b")
async def test_eleventh_failed_attempt_locks_the_contact_and_alerts_the_owner(k: KernelHarness, records):
    """Ten failed attempts on Dana's contact within the hour, from three sessions, lock it: the
    eleventh attempt is refused although its code is right, and a fresh session's start gets the
    same message but sends no code. Both are ledgered, and the owner gets one lockout alert."""
    desk = await golden_desk(k)
    masked = (await masked_on_record(k, records, desk))[desk.people["dana"]]
    before = {entry.entry_id for entry in await owner_inbox(k, desk)}
    messages = []
    # Five wrong codes use up the first challenge, three go to a second that the third start
    # cancels, and two leave the third live: ten failures, three challenges.
    for failures in (ATTEMPTS_PER_CHALLENGE, 3, FAILURES_PER_HOUR - ATTEMPTS_PER_CHALLENGE - 3):
        last = await open_caller(k, desk, "visitor")
        started = await start(k, last, DANA, expect=code_sent_to(masked))
        messages.append(started.message)
        live_code = await code_for(k, last, started.inbox[0])
        for wrong in wrong_codes(live_code, failures):
            await check(k, last, wrong, expect=INVALID)
    async with assert_ledgered(records, desk.copy, desk.desk_id, "verify", session_id=last.state.session_id):
        await check(k, last, live_code, expect=INVALID)   # the eleventh attempt, with the live challenge's code
    await assert_unverified(k, records, desk, last)
    fresh = await open_caller(k, desk, "visitor")
    async with assert_ledgered(records, desk.copy, desk.desk_id, "verify", session_id=fresh.state.session_id):
        locked = await start(k, fresh, DANA, expect=NOTHING_SENT)
    uniform = set(messages) == {locked.message}
    starts = {**{f"start {n}": text for n, text in enumerate(messages, 1)}, "the fresh session's": locked.message}
    assert uniform, f"the starts' messages differ: {told_apart(starts)}"
    fresh_entries = await own_inbox(k, fresh)
    copy_entries = await owner_inbox(k, desk)
    if k.is_real:
        assert_addressed(addressed(fresh_entries), [], "the fresh session's Demo inbox holds {}")
        new = sorted(addressed([entry for entry in copy_entries if entry.entry_id not in before]))
        sent = sorted([("alert", "owner"), *[("verification_code", masked)] * len(messages)])
        assert_addressed(new, sent, "the copy's Demo inbox gained {}: one code per challenge and one owner alert")


# One person per session, simulated

@pytest.mark.requires("01b")
async def test_second_person_in_one_session_refused(k: KernelHarness, records):
    """A session verified as Dana can't verify as Bob too: a start for Bob gets the already-verified
    message (the same for any contact, and not the message an unverified start gets), sends Bob
    nothing and is ledgered; a check with any code answers 200, still Dana; and the kernel holds
    Dana as the session's person."""
    desk = await golden_desk(k)
    on_record = await masked_on_record(k, records, desk)
    bob_masked = on_record[desk.people["bob"]]
    dana = await open_caller(k, desk, "visitor")
    await check(k, dana, await started_code(k, dana, on_record[desk.people["dana"]]), expect=verified_as(dana))
    unverified = await start(k, await open_caller(k, desk, "visitor"), STRANGER, expect=NOTHING_SENT)
    before = {entry.entry_id for entry in await owner_inbox(k, desk)}
    async with assert_ledgered(records, desk.copy, desk.desk_id, "verify", session_id=dana.state.session_id):
        for_bob = await start(k, dana, BOB, expect=NOTHING_SENT)
    for_stranger = await start(k, dana, STRANGER, expect=NOTHING_SENT)
    uniform = for_bob.message == for_stranger.message
    told = told_apart({"for Bob": for_bob.message, "for a stranger": for_stranger.message})
    assert uniform, f"the already-verified message differs by contact: {told}"
    if k.is_real:
        distinct = for_bob.message != unverified.message
        assert distinct, f"a verified session's start got the unverified message: {described(for_bob.message)}"
    dana_entries = await own_inbox(k, dana)
    copy_entries = await owner_inbox(k, desk)
    if k.is_real:
        to_bob = [pair for pair in addressed(dana_entries) if pair[1] == bob_masked]
        assert_addressed(to_bob, [], "Dana's session reads {} addressed to Bob's masked contact")
        new = addressed([entry for entry in copy_entries if entry.entry_id not in before])
        assert_addressed(new, [], "the starts from Dana's verified session added {} to the copy's Demo inbox")
    await check(k, dana, STUB_CODE, expect=verified_as(dana))   # any code
    await k.call("GET /whoami", auth=dana.auth, expect=Expect(fields={
        "session.session_id": dana.state.session_id, "session.verified": True, "session.assurance": "demo_code",
    }))
    if k.is_real:
        person = await records.session_person(dana.state.session_id, copy_id=desk.copy.copy_id)
        row = await session_row(records, desk, dana)
        assert person == row["person_id"] == desk.people["dana"], f"the session is verified as {person}"


@pytest.mark.requires("01b")
async def test_verified_session_is_simulated_demo_code(k: KernelHarness, records):
    """A code read from the Demo inbox verifies a session with assurance `demo_code`, never more:
    verification here is simulated, and the session says so wherever it is read."""
    desk = await golden_desk(k)
    masked = (await masked_on_record(k, records, desk))[desk.people["dana"]]
    visitor = await open_caller(k, desk, "visitor")
    await check(k, visitor, await started_code(k, visitor, masked), expect=verified_as(visitor))
    await k.call("GET /whoami", auth=visitor.auth, expect=Expect(fields={
        "kind": "visitor", "session.session_id": visitor.state.session_id, "session.verified": True,
        "session.assurance": "demo_code",
    }))
    if k.is_real:
        row = await session_row(records, desk, visitor)
        state = (row["verified"], row["assurance"], row["person_id"])
        assert state == (True, "demo_code", desk.people["dana"]), f"the session's kernel_ro row is {state}"


# Codes stay in the kernel

@pytest.mark.requires("01b")
async def test_codes_never_in_kernel_visitor_text(k: KernelHarness, fake: FakeAnthropic, records):
    """Codes sent by the verify card and by Claude's `native.start_verification` appear in no visitor
    text the kernel writes: `VerifyStarted.message`, an `InboxNotice.preview`, a decision's or a
    verdict's `visitor_plain`, however the digits are written. Nor are they in any other kernel
    answer (the tool's `model_view`, rendered cards, a failed check) or a ledger summary."""
    desk = await golden_desk(k)
    masked = (await masked_on_record(k, records, desk))[desk.people["dana"]]
    fake.default(REVIEWER_MODEL, Json(REVIEW_PASS))   # the reviewer passes, if the kernel asks it
    by_card = await open_caller(k, desk, "visitor")
    started = await start(k, by_card, DANA, expect=code_sent_to(masked))
    codes = [await code_for(k, by_card, started.inbox[0])]
    by_claude = await open_caller(k, desk, "visitor")
    decision, result = await verify_by_tool(k, by_claude, DANA, sent_to=masked)
    codes.append(await code_for(k, by_claude, result.inbox[0]))
    stranger = await open_caller(k, desk, "visitor")
    for_stranger = await start(k, stranger, STRANGER, expect=NOTHING_SENT)
    await check(k, by_card, codes[0], expect=INVALID)   # Claude's start cancelled it
    await check(k, by_claude, codes[1], expect=verified_as(by_claude))
    verdicts = [
        await check_reply(k, by_claude, CLEAN_EN, expect=passes(by_claude, ["prose"])),
        await check_reply(k, stranger, CLEAN_EN, [{"template": "verify_prompt", "fact_id": None}],
                          expect=passes(stranger, ["prose", "verify_prompt"])),
    ]
    if k.is_real:
        answers = {f"{n} {called.route}": called.raw for n, called in enumerate(k.responses)
                   if not called.route.startswith("GET /demo_inbox")}   # entries hold codes by design
        texts = visible_texts(list(answers.values()))
        notices = [*started.inbox, *decision.inbox, *result.inbox]
        written = [started.message, for_stranger.message, *(notice.preview for notice in notices),
                   decision.visitor_plain, *(verdict.visitor_plain for verdict in verdicts)]
        unread = [redacted(text, codes) for text in written if text not in texts]
        assert unread == [], f"visitor text the scan missed: {unread}"
        leaks = [redacted(text, codes) for text in texts if shows_a_code(text, codes)]
        assert leaks == [], f"kernel visitor text shows a code: {leaks}"
        held = [label for label, body in answers.items() if holds_a_code(body, codes)]
        entries = await records.ledger_entries(desk.copy.copy_id, desk.desk_id)
        held += [f"ledger entry {entry.seq}" for entry in entries if holds_a_code(entry.event.summary, codes)]
        assert held == [], f"a code is in {held}"


@pytest.mark.requires("01b")
async def test_start_verification_model_view_is_uniform(k: KernelHarness, fake: FakeAnthropic, records):
    """Claude can't learn from `native.start_verification` whether a contact is on record: for
    Dana's contact and for a stranger's, the decision's `visitor_plain`, the result's state, its
    facts and its `model_view` are the same. Only the code notice differs, which Claude never sees."""
    desk = await golden_desk(k)
    masked = (await masked_on_record(k, records, desk))[desk.people["dana"]]
    fake.default(REVIEWER_MODEL, Json(REVIEW_PASS))   # the reviewer passes, if the kernel asks it
    seen = []
    for contact, sent_to in ((DANA, masked), (STRANGER, None)):
        decision, result = await verify_by_tool(k, await open_caller(k, desk, "visitor"), contact, sent_to=sent_to)
        seen.append({"visitor_plain": decision.visitor_plain, "state": result.state,
                     "facts": [fact.model_dump(mode="json") for fact in result.facts], "model_view": result.model_view})
    same = seen[0] == seen[1]
    views = {"Dana's": seen[0], "the stranger's": seen[1]}
    names = declared_names(Decision) | declared_names(ExecResult)   # so a result's state is shown by name
    differ = [f"{part} ({told_apart({label: view[part] for label, view in views.items()}, names)})"
              for part in seen[0] if seen[0][part] != seen[1][part]]
    assert same, f"Claude sees one thing for Dana's contact, another for a stranger's: {', '.join(differ)}"
