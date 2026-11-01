"""The reply check's one model call fits inside the API's timeout for `POST /check_reply`."""

from desk.api import kernel_client
from desk.kernel_service import decisions


def test_one_soft_check_try_leaves_the_reply_check_headroom():
    """The owner's decision of 2026-10-31: one Sonnet try, with no recheck and no fallback, so the
    check's only model call can't outlast what the API gives the whole route. The try is 8 s and the
    route 12 s since 2026-11-01, after live checks timed out at 6 s.
    The rest is rendering, database reads and signing."""
    assert (decisions.SOFT_PROMISE_TIMEOUT_S, kernel_client.REPLY_CHECK_TIMEOUT_S) == (8.0, 12.0)
    assert kernel_client.REPLY_CHECK_TIMEOUT_S - decisions.SOFT_PROMISE_TIMEOUT_S >= 4.0
