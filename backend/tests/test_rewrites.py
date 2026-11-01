"""The shared reply-check kind sets in `desk.rewrites`, which the kernel, the API, the fake kernel
and the tier 1 reply rows all read, so none of them keeps a copy that could drift."""

from typing import get_args

from desk.contracts import Violation
from desk.rewrites import PROSE_ONLY, REWRITABLE

KINDS = set(get_args(Violation.model_fields["kind"].annotation))


def test_prose_only_kinds_are_the_failures_of_claudes_own_words():
    """A failure only of these keeps the draft's checked cards and drops the prose."""
    assert PROSE_ONLY == {"number_in_prose", "promise_word", "soft_promise", "uncertain_language", "check_unavailable"}
    assert PROSE_ONLY <= KINDS


def test_no_card_refusal_or_immediate_handoff_kind_keeps_cards():
    """A refused clause, a canary, a paused session or positive evidence of another language always
    shows the handoff clause alone."""
    assert not PROSE_ONLY & {"unknown_fact", "stale_fact", "unentitled_fact", "canary", "unsupported_language",
                             "session_paused"}


def test_prose_only_and_rewritable_differ_only_where_the_contract_says():
    """Every prose-only kind gets one rewrite, a soft-check outage too (the owner's ruling of
    2026-11-01: the final check makes its own try); the rewritable kinds beyond the prose-only ones
    are the clause refusals, which hand off."""
    assert PROSE_ONLY <= REWRITABLE
    assert REWRITABLE - PROSE_ONLY == {"unknown_fact", "stale_fact", "unentitled_fact"}
