// Auto-invariant: nothing the auto set (B, F and A) allows moves more than the
// money cap of the version being proved in one action. The kernel renders the
// cap into this text for each version (compiler.invariants), so every version is
// proved at its own cap. It doesn't read owner_approved or the context's cap, so
// it holds only if every auto permit on a money tool keeps the compiler's amount
// bound on its own; the baseline's auto_money_cap keeps it in every auto
// evaluation as well.
permit (principal, action, resource);

forbid (principal, action in [Action::"effect:charge", Action::"effect:pay_out"], resource)
unless { context has amount_cents && context.amount_cents <= {auto_money_cap_cents} };
