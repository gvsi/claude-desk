/** An example in the API's suggestion format, measured by the loading shapes. */
export const SUGGESTION_EXAMPLE = 'You approved 3 refund requests. Let me handle these?';

/** The Rules header and its loading shapes use the same signed subtitle. */
export const RULES_SUBTITLE = 'What Claude can do on this Desk, where each tool comes from, and your rules for it.';

/** The owner sees the proposed change before it applies. */
export const COMPOSER_HELPER = 'Claude shows you the change and example situations before anything applies.';

/** Rivera's fixed examples; a current held request may add its own question. */
export const RULES_CHIPS = ['Stop quoting on weekends', 'Quote water heater installs up to $600'] as const;

/** The connector list's summary, for the version the API names. */
export function rulesVersionLine(version: number): string {
  return `Version ${version} of your rules, checked against the always-on rules`;
}
