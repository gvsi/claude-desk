"""Prompt examples against the real language detector and prose scan, with no database or model calls.

These white-box checks cover wording only, not fact entitlement, soft-check acceptance or task completion.
"""

import pytest

from desk.api import prompts


RIVERA_NAMES = ("Rivera Plumbing", "Main line", "Maria Rivera")
RIVERA = prompts.DeskIdentity(business_name=RIVERA_NAMES[0], desk_name=RIVERA_NAMES[1],
                             owner_name=RIVERA_NAMES[2], kind="visitor")


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
@pytest.mark.parametrize("reserved", ["$89", "Monday", "20%"])
@pytest.mark.parametrize("caption", [caption for captions in prompts.REPLY_EXAMPLES.values()
                                     for caption in captions.values()])
def test_reserved_values_stay_blocked_beside_every_caption(caption, reserved):
    from desk.kernel_service import reply_check

    violations = reply_check.scan_prose(f"{caption} {reserved}", names=RIVERA_NAMES)
    assert {violation.kind for violation in violations} == {"number_in_prose"}


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
    assert lang.detect(prose) == "other"
