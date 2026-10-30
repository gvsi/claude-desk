// Auto-invariant: nothing the auto set (B, F and A) allows moves more than
// AUTO_MONEY_HARD_CAP_CENTS ($500) in one action. It doesn't read
// owner_approved, so it holds only if every auto permit on a money tool keeps
// the compiler's amount cap on its own; the baseline's auto_money_cap keeps it
// in every auto evaluation as well.
permit (principal, action, resource);

forbid (principal, action in [Action::"effect:charge", Action::"effect:pay_out"], resource)
unless { context has amount_cents && context.amount_cents <= 50000 };
