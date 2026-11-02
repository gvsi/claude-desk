import type { StreamState } from '../api/stream.ts';

/**
 * Whether the chat shows Claude's writing dots: while the stream says Claude is writing, and from the
 * visitor's Send until the stream says what came of that turn, so a slow connection never looks
 * stuck. The early dots need a chat that can be written in, no error, and a stream that hasn't given
 * up: once it stops reconnecting, no event for the turn can come, and the dots would only stand
 * beside the unreachable notice.
 */
export function showsWritingLine(s: {
  writing: boolean;
  ready: boolean;
  error: string | null;
  connection: StreamState;
  turnPending: boolean;
}): boolean {
  return s.writing || (s.ready && s.error === null && s.connection !== 'closed' && s.turnPending);
}
