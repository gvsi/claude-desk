"""The verification cases' code checks, run without a kernel: finding a code in visitor text,
redacting it from failure messages, and reading one from a Demo inbox entry."""

from datetime import UTC, datetime

import pytest

from desk.contracts import DemoInboxEntry
from evals.tier1.test_verification import code_in, holds_a_code, redacted, shows_a_code, wrong_codes

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


def code_entry(body: str, kind: str = "verification_code") -> DemoInboxEntry:
    return DemoInboxEntry(entry_id="e-1", to="d\u2022\u2022\u2022@example.com", kind=kind, body=body,
                          created_at=datetime(2026, 11, 3, 18, tzinfo=UTC))


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
