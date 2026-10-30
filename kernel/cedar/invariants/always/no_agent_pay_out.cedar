// Always-invariant: an agent never pays money out, whatever tools its schema
// gives it. The baseline forbid no_agent_pay_out enforces it word for word.
permit (principal, action, resource);

forbid (principal is Agent, action in Action::"effect:pay_out", resource);
