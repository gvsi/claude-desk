"""Prompt examples against the real language detector, prose scan and full kernel reply check.

Pure white-box checks cover wording; full checks use genuine facts and tier 1's fake soft checker.
Neither measures live soft-check acceptance or task completion.
"""

import pytest

from desk.api import prompts
from evals.tier1.golden_desk import golden_desk, open_caller
from evals.tier1.test_reply_golden import ReplyRow, check_reply, cite_facts


RIVERA_NAMES = ("Rivera Plumbing", "Main line", "Maria Rivera")
RIVERA = prompts.DeskIdentity(business_name=RIVERA_NAMES[0], desk_name=RIVERA_NAMES[1],
                             owner_name=RIVERA_NAMES[2], kind="visitor")


@pytest.mark.requires("01a")
@pytest.mark.white_box
def test_voice_examples_read_as_english_and_scan_clean():
    from desk.kernel_service import lang, reply_check

    text = prompts.conversation_system(RIVERA)[0]["text"]
    for prose_parts, card_note in prompts.VOICE_EXAMPLES:
        for part in prose_parts:
            assert lang.detect(part) == "en", part
            assert reply_check.scan_prose(part, names=RIVERA_NAMES) == [], part
            assert part in text
        if card_note:
            assert f"({card_note})" in text
    assert prompts.VOICE_EXAMPLES[-1][0][-1].endswith(prompts.STATUS_LINES["offer_callback"]["en"])


@pytest.mark.requires("01a")
@pytest.mark.white_box
@pytest.mark.parametrize(("result", "language", "caption"), [
    (result, language, caption)
    for result, captions in prompts.REPLY_EXAMPLES.items()
    for language, caption in captions.items()
])
def test_prompt_captions_read_as_their_language_and_scan_clean(result, language, caption):
    from desk.kernel_service import lang, reply_check

    assert language in ("en", "es")
    assert lang.detect(caption) == language, result
    assert reply_check.scan_prose(caption, names=RIVERA_NAMES) == [], result
    assert caption in prompts.conversation_system(RIVERA)[0]["text"]


@pytest.mark.requires("01a")
@pytest.mark.white_box
@pytest.mark.parametrize("owner", ["Maria Rivera", "June Park"])
@pytest.mark.parametrize(("status", "language", "caption"), [
    (status, language, caption)
    for status, captions in prompts.STATUS_LINES.items()
    for language, caption in captions.items()
])
def test_status_lines_read_as_their_language_and_scan_clean(owner, status, language, caption):
    from desk.kernel_service import lang, reply_check

    names = (*RIVERA_NAMES[:2], owner)
    assert lang.detect(caption) == language, status
    assert reply_check.scan_prose(caption, names=names) == [], status
    identity = RIVERA.model_copy(update={"owner_name": owner})
    assert caption in prompts.conversation_system(identity)[0]["text"]


@pytest.mark.requires("01a")
@pytest.mark.white_box
@pytest.mark.parametrize(("prose", "names"), [
    ("I've asked June about this.", ()),
    ("Maria will call you back tomorrow.", RIVERA_NAMES),
])
def test_named_status_and_timing_controls_stay_blocked(prose, names):
    from desk.kernel_service import reply_check

    # June is also a reserved date word; no name exemption may hide that control.
    violations = reply_check.scan_prose(prose, names=names)
    assert "number_in_prose" in {violation.kind for violation in violations}
    if "June" in prose:
        named = reply_check.scan_prose(prose, names=(*RIVERA_NAMES[:2], "June Park"))
        assert "number_in_prose" in {violation.kind for violation in named}


@pytest.mark.requires("01a")
@pytest.mark.white_box
@pytest.mark.parametrize("reserved", ["$89", "Monday", "20%"])
@pytest.mark.parametrize("caption", [caption for captions in prompts.REPLY_EXAMPLES.values()
                                     for caption in captions.values()])
def test_reserved_values_stay_blocked_beside_every_caption(caption, reserved):
    from desk.kernel_service import reply_check

    violations = reply_check.scan_prose(f"{caption} {reserved}", names=RIVERA_NAMES)
    assert {violation.kind for violation in violations} == {"number_in_prose"}


@pytest.mark.requires("01a")
@pytest.mark.white_box
@pytest.mark.parametrize(("prose", "rule_id"), [
    ("Aquí están los horarios de la mañana.", "lex.es.date"),
    ("Here are the weekend times.", "lex.en.date"),
])
def test_day_words_stay_reserved(prose, rule_id):
    from desk.kernel_service import reply_check

    violations = reply_check.scan_prose(prose, names=RIVERA_NAMES)
    assert {violation.kind for violation in violations} == {"number_in_prose"}
    assert rule_id in {violation.rule_id for violation in violations}


@pytest.mark.requires("01a")
@pytest.mark.white_box
@pytest.mark.parametrize("prose", ["You're all set.", "Su cita está confirmada."])
def test_booking_claims_need_a_genuine_booking_card(prose):
    from desk.kernel_service import reply_check

    assert {violation.kind for violation in reply_check.scan_prose(prose, names=RIVERA_NAMES)} == {"promise_word"}
    assert reply_check.scan_prose(prose, names=RIVERA_NAMES, booking_card=True) == []


@pytest.mark.requires("01a")
@pytest.mark.white_box
def test_a_business_name_does_not_exempt_a_number_word():
    from desk.kernel_service import reply_check

    prose = "I'm Claude, an AI assistant for Five Star Plumbing."
    violations = reply_check.scan_prose(prose, names=("Five Star Plumbing", *RIVERA_NAMES))
    assert {violation.kind for violation in violations} == {"number_in_prose"}


@pytest.mark.requires("01a")
@pytest.mark.white_box
def test_the_terse_payment_caption_still_reads_as_unsupported():
    from desk.kernel_service import lang, reply_check

    prose = "Absolutely. Payment link below."
    assert reply_check.scan_prose(prose, names=RIVERA_NAMES) == []
    assert lang.detect(prose) not in ("en", "es")


@pytest.mark.requires("01a")
@pytest.mark.parametrize("row", [
    pytest.param(ReplyRow.model_validate(row), id=row["id"]) for row in [
        {"id": "quote-en", "requires": ["01a"],
         "prose": prompts.REPLY_EXAMPLES["Quote (quote with the returned quote fact)"]["en"],
         "clauses": [{"template": "quote", "fact": "own-quote"}],
         "expect": {"ok": True, "language": "en", "blocks": ["prose", "quote"]}},
        {"id": "quote-es", "requires": ["01a"],
         "prose": prompts.REPLY_EXAMPLES["Quote (quote with the returned quote fact)"]["es"],
         "clauses": [{"template": "quote", "fact": "own-quote"}],
         "expect": {"ok": True, "language": "es", "blocks": ["prose", "quote"]}},
        {"id": "booking-es", "requires": ["01a"], "prose": "Su cita está confirmada.",
         "clauses": [{"template": "booking_confirmed", "fact": "own-booking"}],
         "expect": {"ok": True, "language": "es", "blocks": ["prose", "booking_confirmed"]}},
        {"id": "booking-es-without-card", "requires": ["01a"], "prose": "Su cita está confirmada.",
         "clauses": [],
         "expect": {"ok": False, "language": "es", "violations": ["promise_word"], "blocks": ["prose"]}},
        {"id": "quote-amount", "requires": ["01a"],
         "prose": prompts.REPLY_EXAMPLES["Quote (quote with the returned quote fact)"]["en"] + " $89",
         "clauses": [{"template": "quote", "fact": "own-quote"}],
         "expect": {"ok": False, "violations": ["number_in_prose"], "blocks": ["quote"]}},
    ]
])
async def test_captions_through_full_reply_check(k, fake, records, row):
    desk = await golden_desk(k)
    caller = await open_caller(k, desk, "visitor")
    facts = await cite_facts(k, fake, records, desk, caller, row)
    verdict = await check_reply(
        k, caller, row.prose, row.draft_clauses(facts),
        expect=row.verdict_expect(caller.state.generation, facts),
    )
    if k.is_real:
        assert row.kind_mismatches(verdict) == []
