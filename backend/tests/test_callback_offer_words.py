"""The call-back offer the kernel shows in place of the handoff card is the API's signed offer, word
for word, in each language, though the kernel keeps its own copy rather than import the API."""

import pytest

from desk.api.prompts import STATUS_LINES
from desk.contracts import RenderedBlock
from desk.kernel_service import render, reply_check


def test_the_offer_has_the_same_languages_in_the_kernel_and_the_api():
    assert set(STATUS_LINES["offer_callback"]) == set(render.MESSAGES) == {"en", "es"}


@pytest.mark.parametrize("language", ["en", "es"])
def test_the_kernels_call_back_offer_is_the_apis_signed_offer(language):
    signed = STATUS_LINES["offer_callback"][language]
    assert render.status("offer_callback", language) == signed
    assert reply_check.call_back_offer(language) == RenderedBlock(kind="prose", text=signed)


@pytest.mark.parametrize("language", ["en", "es"])
def test_the_kernels_status_line_is_the_apis_signed_check_status_line(language):
    """The line a reply blocked only for its prose shows while a held request awaits the owner is the API's signed
    `STATUS_LINES["check_status"]`, word for word."""
    signed = STATUS_LINES["check_status"][language]
    assert set(STATUS_LINES["check_status"]) == set(render.MESSAGES)
    assert render.status("check_status", language) == signed
    assert reply_check.status_line(language) == RenderedBlock(kind="prose", text=signed)
