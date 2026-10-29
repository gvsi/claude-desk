// Auto-invariant (test fixture): nothing auto-allowed moves more than
// AUTO_MONEY_HARD_CAP_CENTS ($500) in one action.
permit (principal, action, resource);

forbid (principal, action in [Action::"effect:charge", Action::"effect:pay_out"], resource)
unless { context has amount_cents && context.amount_cents <= 50000 };
