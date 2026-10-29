// Test fixture: a forbid whose condition overflows for amounts of 923 cents and
// up. Cedar skips a policy whose condition errors, so if the kernel trusted
// Cedar's decision this forbid would fail open exactly where it overflows.
@id("overflowing_amount_check")
@card("baseline")
@tier("baseline")
@applies_to("effect:charge")
forbid (principal, action in Action::"effect:charge", resource)
when { context has amount_cents && context.amount_cents * 10000000000000000 < 0 };
