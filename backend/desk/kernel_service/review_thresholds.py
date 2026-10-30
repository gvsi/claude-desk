"""The reviewer's thresholds, per effect, for review-gated auto cards.

The compiler writes a gated card's gate as `context.review.within_charter_bp >= K_min &&
context.review.manipulation_bp <= K_max`, with `thresholds_for` the strictest row across the
tool's effects. A gate only ever narrows an auto card (the `review_only_narrows` proof), so these
numbers decide how often Claude asks the owner, never what it may do beyond the cards.

The lines between the calibration markers belong to the calibration run (`calibrate --write`
rewrites exactly them in a reviewed commit, with `make proofs`); each assignment there stands
alone. `INITIAL_THRESHOLDS` stays outside as the floor that run checks `charge` and `pay_out`
against.
"""

from collections.abc import Iterable

from desk.contracts import Effect, ReviewThresholds

# Conservative starting values: the more an effect can cost, the surer the reviewer must be.
INITIAL_THRESHOLDS: dict[Effect, ReviewThresholds] = {
    "read": ReviewThresholds(min_within_charter_bp=7000, max_manipulation_bp=3000),
    "change": ReviewThresholds(min_within_charter_bp=7500, max_manipulation_bp=2500),
    "send_message": ReviewThresholds(min_within_charter_bp=8000, max_manipulation_bp=2000),
    "private_data": ReviewThresholds(min_within_charter_bp=8500, max_manipulation_bp=1500),
    "charge": ReviewThresholds(min_within_charter_bp=9000, max_manipulation_bp=1000),
    "pay_out": ReviewThresholds(min_within_charter_bp=9500, max_manipulation_bp=500),
}

# calibration: begin
REVIEW_THRESHOLDS_VERSION = 1
THRESHOLDS: dict[Effect, ReviewThresholds] = {
    "read": ReviewThresholds(min_within_charter_bp=7000, max_manipulation_bp=3000),
    "change": ReviewThresholds(min_within_charter_bp=7500, max_manipulation_bp=2500),
    "send_message": ReviewThresholds(min_within_charter_bp=8000, max_manipulation_bp=2000),
    "private_data": ReviewThresholds(min_within_charter_bp=8500, max_manipulation_bp=1500),
    "charge": ReviewThresholds(min_within_charter_bp=9000, max_manipulation_bp=1000),
    "pay_out": ReviewThresholds(min_within_charter_bp=9500, max_manipulation_bp=500),
}
CALIBRATION = None
# calibration: end


def thresholds_for(effects: Iterable[Effect]) -> ReviewThresholds:
    """The strictest thresholds across `effects`: the highest `min_within_charter_bp` and the
    lowest `max_manipulation_bp`, each taken on its own. No effects, or an unknown one, raises:
    a gate is never written without a threshold."""
    rows = [THRESHOLDS[effect] for effect in effects]
    if not rows:
        raise ValueError("thresholds_for needs at least one effect")
    return ReviewThresholds(min_within_charter_bp=max(row.min_within_charter_bp for row in rows),
                            max_manipulation_bp=min(row.max_manipulation_bp for row in rows))
