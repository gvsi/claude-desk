// Always-invariant: private data goes only to the verified person the record
// belongs to. A proof spec set: everything is allowed but a violation, so a
// policy set implies it exactly when it never allows a violation. The baseline
// forbid private_data_record_owner enforces it word for word.
permit (principal, action, resource);

forbid (principal, action in Action::"effect:private_data", resource)
unless { principal.verified && context.record_owner_match };
