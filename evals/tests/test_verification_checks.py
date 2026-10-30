"""The verification cases' code checks, run without a kernel: finding a code in visitor text,
redacting it from failure messages, reading one from a Demo inbox entry, and naming an entry's
recipient or a contact on record in a failure without its address."""

from collections.abc import Sequence
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest

from desk.contracts import DemoInboxEntry, InboxNotice
from evals.tier1.test_verification import (
    DANA,
    addressed,
    assert_addressed,
    code_for,
    code_in,
    holds_a_code,
    masked_on_record,
    redacted,
    shows_a_code,
    wrong_codes,
)

CODE = "482913"
# Built from code points, so no editor can normalize the characters away.
ARABIC_INDIC = "".join(chr(0x0660 + int(digit)) for digit in CODE)
FULL_WIDTH = "".join(chr(0xFF10 + int(digit)) for digit in CODE)
ZERO_WIDTH = CODE[:3] + chr(0x200B) + CODE[3:]
SOFT_HYPHEN_AND_WORD_JOINER = CODE[:2] + chr(0x00AD) + CODE[2:4] + chr(0x2060) + CODE[4:]
NBSP, NARROW_NBSP, BULLET = chr(0x00A0), chr(0x202F), chr(0x2022)


def test_a_code_split_by_spaces_or_punctuation_is_found():
    for text in ("Your code is 482913.", "Code: 4 8 2 9 1 3", "482-913", "48.29.13 is it"):
        assert shows_a_code(text, [CODE]), text


def test_a_code_in_other_digits_or_behind_invisible_characters_is_found():
    for text in (ARABIC_INDIC, " ".join(ARABIC_INDIC), FULL_WIDTH, ZERO_WIDTH, SOFT_HYPHEN_AND_WORD_JOINER):
        assert shows_a_code(text, [CODE]), ascii(text)


def test_any_six_digit_number_is_flagged_and_other_text_is_not():
    assert shows_a_code("Your reference is 120044.", [])
    assert shows_a_code(ZERO_WIDTH, [])   # a code the case never read, behind an invisible character
    for text in ("If that contact is on record, a code is on its way.", "Call (510) 555-0142", "It took 12345 tries",
                 "Si ese contacto está registrado, te enviamos un código."):
        assert not shows_a_code(text, [CODE, "105550"]), text


def test_redaction_hides_every_code_however_it_is_written():
    shown = redacted(f"Code 4 8 2 9 1 3, again {ZERO_WIDTH}, or 120044.", [CODE])
    assert shown == "Code <code>, again <code>, or <code>."


def test_a_payload_holds_a_code_however_it_is_written():
    payloads = (
        {"status": "requested", "note": f"code {CODE}"}, [{"lines": ["x", CODE]}],
        {"note": f"código:{NBSP}{CODE}"}, {"note": f"code{NARROW_NBSP}{CODE}"}, {"note": f"{BULLET}{CODE}"},
        {"note": f"Sent to your email.{CODE}"},   # after a sentence period
        {"note": ARABIC_INDIC}, {"note": FULL_WIDTH}, {"note": ZERO_WIDTH}, {"note": "4 8 2 9 1 3"},
        {"code": int(CODE)}, {CODE: True},
        {"ref_id": CODE}, {"challenge_id": f"verify:{CODE}"},   # an id that is the code, or ends with it
    )
    for payload in payloads:
        assert holds_a_code(payload, [CODE]), ascii(payload)
    assert holds_a_code({"code": 48291}, ["048291"])   # a number drops the leading zero


def test_a_code_inside_an_id_a_hash_or_a_timestamp_is_not_held():
    digest = "ab" + CODE + "c" * 56
    payloads = (
        {"id": f"ab{CODE}cd", "seq": int(CODE + "7")}, {"fact_ids": [f"f{CODE}a"]},
        {"expires_at": f"2026-11-03T18:00:00.{CODE}-08:00"},   # microseconds, by the key
        {"window": [f"2026-11-03T18:00:00.{CODE}Z"]},          # microseconds, by the shape
        {"prev_hash": digest, "summary": {"head": digest}},    # a hash, by the key
        [digest.upper(), f"0a1b2c3d-4e5f-6a7b-8c9d-ab{CODE}cdef"],   # a hash and a UUID, by the shape
        {"status": "requested"},
    )
    for payload in payloads:
        assert not holds_a_code(payload, [CODE]), payload


MASKED = "d\u2022\u2022\u2022@example.com"   # Dana's contact as Plan 01a's `mask_contact` shows it


def code_entry(body: str, kind: str = "verification_code", to: str = MASKED) -> DemoInboxEntry:
    return DemoInboxEntry(entry_id="e-1", to=to, kind=kind, body=body, created_at=datetime(2026, 11, 3, 18, tzinfo=UTC))


def test_the_code_is_read_from_one_entry_and_never_printed():
    assert code_in(code_entry(f"Your Rivera Plumbing code is {CODE}. It expires in ten minutes.")) == CODE
    for body, kind in ((f"Codes {CODE} and 111222", "verification_code"), ("No code here", "verification_code"),
                       (f"Your code is {CODE}", "alert")):
        with pytest.raises(AssertionError) as failure:
            code_in(code_entry(body, kind))
        assert CODE not in str(failure.value) and "111222" not in str(failure.value)


def test_wrong_codes_are_six_digits_and_never_the_code():
    assert wrong_codes("999998", 3) == ["999999", "000000", "000001"]
    assert CODE not in wrong_codes(CODE, 10) and len(set(wrong_codes(CODE, 10))) == 10


class StandIn:
    """A kernel target and its records as the verification cases read them: a Demo inbox holding
    `entries`, and `kernel_ro.people` holding `people`."""

    is_real = True

    def __init__(self, entries: Sequence[DemoInboxEntry] = (), people: Sequence[dict] = ()) -> None:
        self.entries, self.rows = list(entries), list(people)

    async def call(self, route: str, **_) -> list[DemoInboxEntry]:
        assert route == "GET /demo_inbox?session_id=", route
        return self.entries

    async def people(self, copy_id: str) -> list[dict]:
        return self.rows


async def test_a_raw_contact_in_an_entry_or_on_record_is_never_printed():
    """A kernel that put a raw contact where a masked one belongs fails the case's checks naming
    the recipient as masked, unmasked or owner, never by its address: an entry addressed to Dana's
    raw contact although its notice named her masked one, and a `kernel_ro.people` row that shows
    her contact unmasked (or is missing)."""
    caller = SimpleNamespace(state=SimpleNamespace(session_id="s-1"), auth=None)
    notice = InboxNotice(entry_id="e-1", to=MASKED, preview="A code is on its way.")
    entry = code_entry(f"Your code is {CODE}", to=DANA)
    with pytest.raises(AssertionError) as failure:
        await code_for(StandIn([entry]), caller, notice)
    shown = str(failure.value)
    assert shown.splitlines()[0] == "notice e-1 and its entry name different recipients: masked and unmasked", shown
    assert "@" not in shown and CODE not in shown, shown
    desk = SimpleNamespace(copy=SimpleNamespace(copy_id="c-1"), desk_id="d-1", people={"dana": "p-1", "bob": "p-2"})
    rows = [{"person_id": "p-1", "desk_id": "d-1", "masked_contact": f"Dana <{DANA}>"},
            {"person_id": "p-2", "desk_id": "d-1", "masked_contact": "b\u2022\u2022\u2022@example.com"}]
    for people, problem in ((rows, "holds the raw contact"), (rows[1:], "is missing")):
        records = StandIn(people=people)
        with pytest.raises(AssertionError) as failure:
            await masked_on_record(records, records, desk)
        shown = str(failure.value)
        assert shown.splitlines()[0] == f"kernel_ro.people's masked contact for dana {problem}", shown
        assert "@" not in shown, shown


def test_an_entry_to_a_raw_contact_fails_without_printing_it():
    """The Demo inbox checks compare each entry's kind and exact recipient, and a failure names
    each recipient as masked, unmasked or owner: an entry a kernel addressed to Dana's raw contact
    fails showing ("verification_code", "unmasked"), never the contact, in the message or in
    pytest's explanation of it. The comparison is still exact: her masked contact passes, and
    another masked contact, the owner or a second entry fails."""
    to_dana = [("verification_code", MASKED)]
    entries = [code_entry(f"Your code is {CODE}", to=DANA), code_entry("A lead came in.", kind="alert", to="owner")]
    with pytest.raises(AssertionError) as failure:
        assert_addressed(addressed(entries), to_dana, "the session's Demo inbox holds {}")
    shown = str(failure.value)
    assert shown.splitlines()[0] == (
        "the session's Demo inbox holds [('verification_code', 'unmasked'), ('alert', 'owner')]"), shown
    assert "@" not in shown and CODE not in shown, shown
    assert_addressed(addressed([code_entry("A code is on its way.")]), to_dana, "{}")
    for wrong in ("b\u2022\u2022\u2022@example.com", "owner"):
        with pytest.raises(AssertionError):
            assert_addressed(addressed([code_entry("A code is on its way.", to=wrong)]), to_dana, "{}")
    with pytest.raises(AssertionError):
        assert_addressed(addressed([code_entry("A code is on its way.")] * 2), to_dana, "{}")
