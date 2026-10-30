// The always-on baseline (set B): forbids that hold in every decision, auto or
// owner-approved, whatever cards a Desk has. Owner rules can't switch them off.
//
// Each condition is guarded so it can't error (Cedar skips an erroring forbid)
// and passes strict validation: an optional attribute is read only behind `has`,
// in `&&` or `if ... then ... else`. The invariants in invariants/ restate four
// of these word for word, and the auto money cap over the auto set, so a proof
// at activation fails if any of them is weakened here.

// A session acts only on records of its own copy.
@id("same_copy")
@card("baseline")
@tier("baseline")
@applies_to("all")
forbid (principal, action, resource)
unless { principal.copy == resource.copy };

// Private data goes only to the verified person the record belongs to.
@id("private_data_record_owner")
@card("baseline")
@tier("baseline")
@applies_to("effect:private_data")
forbid (principal, action in Action::"effect:private_data", resource)
unless { principal.verified && context.record_owner_match };

// Messages go only to the owner or to the verified contact on record.
@id("recipient_owner_or_verified_contact")
@card("baseline")
@tier("baseline")
@applies_to("all")
forbid (principal, action, resource)
when {
  context has recipient &&
  context.recipient != "owner" &&
  context.recipient != "verified_contact"
};

// An agent never pays money out, whatever tools its schema gives it.
@id("no_agent_pay_out")
@card("baseline")
@tier("baseline")
@applies_to("effect:pay_out")
forbid (principal is Agent, action in Action::"effect:pay_out", resource);

// An agent charges only within the mandate it holds for this Desk, which also
// refuses an agent with no mandate or a charge with no amount.
@id("agent_charge_within_mandate")
@card("baseline")
@tier("baseline")
@applies_to("effect:charge")
forbid (principal is Agent, action in Action::"effect:charge", resource)
unless {
  principal has mandate_remaining_cents &&
  context has amount_cents &&
  context.amount_cents <= principal.mandate_remaining_cents
};

// Money always carries an amount above zero and at most $10,000.
@id("money_has_amount")
@card("baseline")
@tier("baseline")
@applies_to("effect:charge,effect:pay_out")
forbid (principal, action in [Action::"effect:charge", Action::"effect:pay_out"], resource)
unless {
  context has amount_cents &&
  context.amount_cents > 0 &&
  context.amount_cents <= 1000000
};

// Without the owner's approval, no action moves more than
// AUTO_MONEY_HARD_CAP_CENTS ($500).
@id("auto_money_cap")
@card("baseline")
@tier("baseline")
@applies_to("effect:charge,effect:pay_out")
forbid (principal, action in [Action::"effect:charge", Action::"effect:pay_out"], resource)
when {
  !context.owner_approved &&
  (if context has amount_cents then context.amount_cents > 50000 else true)
};
