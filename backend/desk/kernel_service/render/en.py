"""English: the visitor's status lines and the owner's alert previews.

`{owner}` is the business's `owner_display_name`. Status lines carry no digits, currency or
percentages: only clause cards rendered from facts do.
"""

STATUS: dict[str, str] = {
    "allowed": "Checked against {owner}'s rules",
    "held": "Waiting for {owner} to approve",
    "refused": "Not something I can do here",
    "approved": "{owner} approved this",
    "denied": "{owner} decided not to go ahead",
    "expired": "This request timed out",
    "cancelled": "Cancelled",
    "executed": "Done",
    "failed": "That didn't go through",
    "unknown": "Still confirming this",
    "refused_at_execution": "The rules changed, so this didn't go ahead",
    "reply_checked": "Reply checked against {owner}'s rules",
    "reply_handed_off": "Passed to {owner} to answer",
}

# Owner-only, in English: the preview line of a Demo inbox alert.
OWNER_PREVIEWS: dict[str, str] = {
    "approval": "A request needs your answer",
    "breaker": "A conversation was paused",
    "booking": "New booking",
}
