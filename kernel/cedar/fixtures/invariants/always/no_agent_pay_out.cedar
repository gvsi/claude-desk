// Always-invariant (test fixture): an agent never pays money out, whatever
// tools its schema gives it.
permit (principal, action, resource);

forbid (principal is Agent, action in Action::"effect:pay_out", resource);
