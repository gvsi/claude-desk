// Auto-invariant: nothing the auto set (B, F and A) allows moves more than
// AUTO_MONEY_HARD_CAP_CENTS ($10,000), the platform ceiling above every money
// cap, in one action, whatever cap a version holds.
permit (principal, action, resource);

forbid (principal, action in [Action::"effect:charge", Action::"effect:pay_out"], resource)
unless { context has amount_cents && context.amount_cents <= 1000000 };
