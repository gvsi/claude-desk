"""Owner explanations shared by live decisions and hypothetical policy probes."""

# Refusals use the approvable evaluation, where owner_approved is true. auto_money_cap
# can hold an automatic payment but never decides a refusal, so it has no entry here.
BASELINE_RULE_PLAIN: dict[str, str] = {
    "same_copy": "It reached into another copy of the Desk, which is never allowed.",
    "private_data_record_owner":
        "Private records go only to the verified person they belong to, so it was refused.",
    "recipient_owner_or_verified_contact":
        "Messages go only to you or to a verified contact on record, so it was refused.",
    "no_agent_pay_out": "An agent can never be paid money out, so it was refused.",
    "agent_charge_within_mandate": "It was more than this agent's signed limit allows, so it was refused.",
    "money_has_amount": "A payment needs an amount above zero and within the platform's limit, so it was refused.",
}
