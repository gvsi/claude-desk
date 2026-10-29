// Test fixture: set A with a compiler slip. The quote card's review gate is
// OR-ed with its discount limit instead of AND-ed, so a high score lets a
// discounted quote through that the ungated card (auto_ungated.cedar) refuses.

@id("find_slots")
@card("c-find-slots")
@tier("auto")
@applies_to("native.find_slots")
permit (principal, action == Action::"native.find_slots", resource);

@id("quote_reviewed")
@card("c-quote")
@tier("auto")
@applies_to("native.quote")
permit (principal, action == Action::"native.quote", resource)
when {
  (if context has discount_bp then context.discount_bp <= 0 else true) ||
  (context has review &&
   context.review.within_charter_bp >= 9000 &&
   context.review.manipulation_bp <= 1000)
};

@id("payment_link_deposit")
@card("c-deposit")
@tier("auto")
@applies_to("native.payment_link")
permit (principal is Visitor, action == Action::"native.payment_link", resource)
when { context has amount_cents && context.amount_cents <= 2000 };
