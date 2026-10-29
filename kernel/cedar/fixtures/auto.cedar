// Test fixture: set A, the auto permits a compiler would emit for three cards.

// c-find-slots: anyone may look for open slots.
@id("find_slots")
@card("c-find-slots")
@tier("auto")
@applies_to("native.find_slots")
permit (principal, action == Action::"native.find_slots", resource);

// c-quote: anyone may get a quote with no discount, if the reviewer agrees.
@id("quote_reviewed")
@card("c-quote")
@tier("auto")
@applies_to("native.quote")
permit (principal, action == Action::"native.quote", resource)
when { if context has discount_bp then context.discount_bp <= 0 else true }
when {
  context has review &&
  context.review.within_charter_bp >= 9000 &&
  context.review.manipulation_bp <= 1000
};

// c-deposit: visitors may get a payment link for a deposit of up to $20.
@id("payment_link_deposit")
@card("c-deposit")
@tier("auto")
@applies_to("native.payment_link")
permit (principal is Visitor, action == Action::"native.payment_link", resource)
when { context has amount_cents && context.amount_cents <= 2000 };
