// Always-invariant (test fixture): messages go only to the owner or to a
// verified contact on record.
permit (principal, action, resource);

forbid (principal, action in Action::"effect:send_message", resource)
unless {
  context has recipient &&
  (context.recipient == "owner" || context.recipient == "verified_contact")
};
