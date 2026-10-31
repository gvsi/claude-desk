/**
 * The client idempotency key the API takes on a start (`send_agent` and setup's start, #124), as the
 * mock checks it: 1 to 128 characters, none of them a control character, or no key at all.
 */
const CONTROL = /[\x00-\x1f\x7f]/;

/** A body's `idempotency_key`: null when it sends none, or false when the API would refuse it (422). */
export function idempotencyKeyOf(body: unknown): string | null | false {
  const key = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).idempotency_key : undefined;
  if (key === undefined || key === null) return null;
  if (typeof key !== 'string') return false;
  const length = [...key].length;
  return length >= 1 && length <= 128 && !CONTROL.test(key) ? key : false;
}
