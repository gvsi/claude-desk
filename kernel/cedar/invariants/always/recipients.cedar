// Always-invariant: an action that names a recipient sends only to the owner or
// to the verified contact on record. The baseline forbid
// recipient_owner_or_verified_contact enforces it word for word.
permit (principal, action, resource);

forbid (principal, action, resource)
when {
  context has recipient &&
  context.recipient != "owner" &&
  context.recipient != "verified_contact"
};
