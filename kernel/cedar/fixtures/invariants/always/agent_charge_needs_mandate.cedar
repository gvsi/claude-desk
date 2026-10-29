// Always-invariant (test fixture): an agent charges only within the mandate it
// holds for this Desk, which also refuses an agent with no mandate or amount.
permit (principal, action, resource);

forbid (principal is Agent, action in Action::"effect:charge", resource)
unless {
  principal has mandate_remaining_cents &&
  context has amount_cents &&
  context.amount_cents <= principal.mandate_remaining_cents
};
