/** An API-format example for tests of a Desk with repeated owner approvals. */
export const SUGGESTION_EXAMPLE = 'You approved 3 refund requests. Let me handle these?';

/** The Rules header and its loading shapes use the same signed subtitle. */
export const RULES_SUBTITLE = 'What Claude can do on this Desk, where each tool comes from, and your rules for it.';

/** All rules' line under its subtitle: who "Checked by the reviewer" means, and that it can only hold. */
export const REVIEWER_LINE = 'The reviewer is a separate model that reads each request before it runs. It can only hold a request for your answer, never let one through.';

/** The owner sees the proposed change before it applies. */
export const COMPOSER_HELPER = 'Claude shows you the change and example situations before anything applies.';

/** Rivera's fixed examples; a current held request may add its own question. */
export const RULES_CHIPS = ['Stop quoting on weekends', 'Quote water heater installs up to $600'] as const;

/** The connector list's summary, for the version the API names. */
export function rulesVersionLine(version: number): string {
  return `Version ${version} of your rules, checked against the always-on rules`;
}
