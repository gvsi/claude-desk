// Always-invariant: an agent charges only within the mandate it holds for this
// Desk, which refuses an agent with no mandate or a charge with no amount and
// bounds the per-charge limit, the remaining total and expiry. The baseline
// forbid agent_charge_within_mandate enforces it word for word.
permit (principal, action, resource);

forbid (principal is Agent, action in Action::"effect:charge", resource)
unless {
  principal has mandate_remaining_cents &&
  context has amount_cents &&
  context.amount_cents <= principal.mandate_remaining_cents
};
