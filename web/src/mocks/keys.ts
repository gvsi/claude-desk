/**
 * The client idempotency key the API requires on a start (`send_agent` and setup's start, plan 02b),
 * as the mock checks it: 1 to 128 characters, none of them a control character. A start with no key
 * (missing or null) is refused as a malformed one is.
 */
const CONTROL = /[\x00-\x1f\x7f]/;

/** A body's `idempotency_key`, or false when the API would refuse it (422): none, or not a key. */
export function idempotencyKeyOf(body: unknown): string | false {
  const key = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).idempotency_key : undefined;
  if (typeof key !== 'string') return false;
  const length = [...key].length;
  return length >= 1 && length <= 128 && !CONTROL.test(key) ? key : false;
}
