"""The violations a rewrite can fix (master plan, "Reply check and visitor-visible text").

A first draft of Claude's blocked only for these kinds is never shown: the API sends Claude the
violations and checks one rewrite, and only a second block, or any other kind of violation, shows
the visitor the handoff clause. The API reads this set to decide whether to ask for the rewrite,
and the kernel to decide whether a blocked draft's handoff clause is one the visitor will see
(`CheckReplyRequest.final`), so the two can't disagree. Plain data, importing only the contracts.
"""

from typing import get_args

from desk.contracts import Violation

REWRITABLE: frozenset[str] = frozenset({"number_in_prose", "promise_word", "soft_promise", "unknown_fact",
                                        "stale_fact", "unentitled_fact", "uncertain_language"})

if not REWRITABLE <= set(get_args(Violation.model_fields["kind"].annotation)):
    raise RuntimeError("every rewritable kind is a violation kind")
