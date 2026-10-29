// Always-invariant (test fixture): private data goes only to the verified
// record owner. As a policy set: everything is allowed except a violation.
permit (principal, action, resource);

forbid (principal, action in Action::"effect:private_data", resource)
unless { principal.verified && context.record_owner_match };
