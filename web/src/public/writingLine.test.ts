import { describe, expect, it } from 'vitest';

import { showsWritingLine } from './writingLine.ts';

describe('showsWritingLine', () => {
  const sent = { writing: false, ready: true, error: null, connection: 'open', turnPending: true } as const;

  it('shows from Send while the turn waits for its first event', () => {
    expect(showsWritingLine(sent)).toBe(true);
    // Reconnecting: the turn's events can still come once the stream is back.
    expect(showsWritingLine({ ...sent, connection: 'reconnecting' })).toBe(true);
  });

  it('stops once the stream has given up, before any event came', () => {
    // An accepted send whose turn said nothing, then the stream stopped reconnecting: no event can
    // come now, so Claude's dots don't stay beside the unreachable notice.
    expect(showsWritingLine({ ...sent, connection: 'closed' })).toBe(false);
  });

  it('stops for an error, a chat that can not be written in, or no turn waiting', () => {
    expect(showsWritingLine({ ...sent, error: 'rate_limited' })).toBe(false);
    expect(showsWritingLine({ ...sent, ready: false })).toBe(false);
    expect(showsWritingLine({ ...sent, turnPending: false })).toBe(false);
  });

  it('follows the stream once Claude is writing', () => {
    expect(showsWritingLine({ ...sent, writing: true, turnPending: false })).toBe(true);
    expect(showsWritingLine({ ...sent, writing: true, turnPending: false, connection: 'closed' })).toBe(true);
  });
});
