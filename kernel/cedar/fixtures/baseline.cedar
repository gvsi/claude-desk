// Test fixture: always-on forbids (set B) in the shape the kernel expects. The
// production baseline is kernel/cedar/baseline.cedar, owned by the kernel plan.

@id("private_data_record_owner")
@card("baseline")
@tier("baseline")
@applies_to("effect:private_data")
forbid (principal, action in Action::"effect:private_data", resource)
unless { principal.verified && context.record_owner_match };

@id("recipient_owner_or_verified_contact")
@card("baseline")
@tier("baseline")
@applies_to("effect:send_message")
forbid (principal, action in Action::"effect:send_message", resource)
unless {
  context has recipient &&
  (context.recipient == "owner" || context.recipient == "verified_contact")
};

@id("agent_charge_needs_mandate")
@card("baseline")
@tier("baseline")
@applies_to("effect:charge")
forbid (principal is Agent, action in Action::"effect:charge", resource)
unless {
  principal has mandate_remaining_cents &&
  context has amount_cents &&
  context.amount_cents <= principal.mandate_remaining_cents
};

@id("no_agent_pay_out")
@card("baseline")
@tier("baseline")
@applies_to("effect:pay_out")
forbid (principal is Agent, action in Action::"effect:pay_out", resource);
