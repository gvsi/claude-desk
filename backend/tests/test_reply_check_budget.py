"""The reply check's one model call fits inside the API's timeout for `POST /check_reply`."""

from desk.api import kernel_client
from desk.kernel_service import decisions


def test_one_soft_check_try_leaves_the_reply_check_headroom():
    """The owner's decision of 2026-10-31: one Sonnet try of at most 6 s, with no recheck and no
    fallback, so the check's only model call can't outlast the 10 s the API gives the whole route.
    The rest is rendering, database reads and signing."""
    assert (decisions.SOFT_PROMISE_TIMEOUT_S, kernel_client.REPLY_CHECK_TIMEOUT_S) == (6.0, 10.0)
    assert kernel_client.REPLY_CHECK_TIMEOUT_S - decisions.SOFT_PROMISE_TIMEOUT_S >= 4.0
