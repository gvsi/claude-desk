"""The violations a rewrite can fix (master plan, "Reply check and visitor-visible text").

A first draft of Claude's blocked only for these kinds is never shown: the API sends Claude the
violations and checks one rewrite. A second block, or any other kind of violation, is shown: as
its checked cards when only the prose failed (`PROSE_ONLY`), otherwise as the handoff clause. The
API reads this set to decide whether to ask for the rewrite, and the kernel to decide whether a
blocked draft is one the visitor will see (`CheckReplyRequest.final`), so the two can't disagree.

`PROSE_ONLY` names the failures of Claude's own words: a shown verdict failing only for these keeps
the draft's checked cards, without the prose, and a handoff clause after them if Claude drafted
one; any other kind shows the handoff clause. The kernel, the fake kernel and the tier 1 reply
rows all read it. Plain data, importing only the contracts.
"""

from typing import get_args

from desk.contracts import Violation

REWRITABLE: frozenset[str] = frozenset({"number_in_prose", "promise_word", "soft_promise", "unknown_fact",
                                        "stale_fact", "unentitled_fact", "uncertain_language",
                                        "check_unavailable"})

PROSE_ONLY: frozenset[str] = frozenset({"number_in_prose", "promise_word", "soft_promise", "uncertain_language",
                                        "check_unavailable"})

_KINDS = set(get_args(Violation.model_fields["kind"].annotation))
if not REWRITABLE <= _KINDS:
    raise RuntimeError("every rewritable kind is a violation kind")
if not PROSE_ONLY <= _KINDS:
    raise RuntimeError("every prose-only kind is a violation kind")
