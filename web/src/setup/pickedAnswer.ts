import type { Choice } from '../api/views.ts';

/**
 * The owner's message the API writes from an answer's picks and typed words (`SetupAnswerBody.picks`):
 * the picked choices in the order the question lists them, joined by ", ", then the typed words, if
 * any, on a line of their own. One pick and no words reads as the choice itself. The page sends the
 * picks and the words, never this text; it shows it only while the answer is on its way, until the
 * API's own message replaces it. The mock API writes it the same way. It imports no screen code, so
 * the mock's dev server can load it.
 */
export function pickedAnswer(choices: readonly Choice[], picks: readonly string[], text: string): string {
  const picked = choices.filter((choice) => picks.includes(choice.text)).map((choice) => choice.text).join(', ');
  return [picked, text.trim()].filter((part) => part !== '').join('\n');
}
