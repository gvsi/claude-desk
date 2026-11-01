/** The mock stand-in for the kernel's public-line scan, shared by writes and publication. */
const REFUSED = /\$\s*[-+]?(?:\d|\.\d)|\d\s*%|\b\d{1,2}(?:\s*(?:am|pm)\b|:\d{2}\b|\s+to\s+\d{1,2}\b)|\b(?:free|guarantee|promise|always|never)\b|\b\d+(?:\.\d+)?[\s-]*(?:minutes?|hours?|days?)\b/i;

export function publicLineRefused(text: string): boolean {
  return REFUSED.test(text);
}
