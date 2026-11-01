/**
 * Since last night's one line, in Claude's voice, built by code from the briefing's counts and
 * nothing else: how many conversations, all inside the owner's rules, then what Claude did. It
 * names no price, date or person.
 */

/** The briefing's counts the line is built from. */
export interface NightCounts {
  conversations: number;
  bookings: number;
  answers: number;
  turned_down: number;
}

/** One to nine as words; 10 and up stay digits. */
const WORDS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'] as const;

/** `n` of a thing, in the singular for one: "one visit", "three visits", "10 visits". */
function counted(n: number, one: string, many: string): string {
  const number = Number.isInteger(n) && n >= 1 && n <= WORDS.length ? WORDS[n - 1] : String(n);
  return `${number} ${n === 1 ? one : many}`;
}

/** "a", "a and b", "a, b and c". */
function listed(parts: readonly string[]): string {
  const last = parts.at(-1) ?? '';
  return parts.length < 2 ? last : `${parts.slice(0, -1).join(', ')} and ${last}`;
}

/**
 * "3 conversations since last night, all inside your rules. I booked one visit, answered one
 * question and stopped one attempt.": each sentence left out when its counts are all zero, and null
 * when both are.
 */
export function sinceLastNightLine({ conversations, bookings, answers, turned_down: stopped }: NightCounts): string | null {
  const sentences: string[] = [];
  if (conversations === 1) sentences.push('1 conversation since last night, inside your rules.');
  else if (conversations > 0) sentences.push(`${conversations} conversations since last night, all inside your rules.`);
  const done = [
    bookings > 0 ? `booked ${counted(bookings, 'visit', 'visits')}` : null,
    answers > 0 ? `answered ${counted(answers, 'question', 'questions')}` : null,
    stopped > 0 ? `stopped ${counted(stopped, 'attempt', 'attempts')}` : null,
  ].filter((part): part is string => part !== null);
  if (done.length > 0) sentences.push(`I ${listed(done)}.`);
  return sentences.length > 0 ? sentences.join(' ') : null;
}
