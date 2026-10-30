/**
 * The greeting's presence: one line about who is talking to the Desk right now, and a glyph for
 * each of them. The owner's own chat as a customer is the owner, so it is neither counted nor drawn.
 */
import type { ConversationSummary } from '../../api/views.ts';
import type { GreetingProps, PresenceGlyph } from '../../ds/index.ts';
import { presenceLine } from '../../lib/format.ts';

export function greetingPresence(live: readonly ConversationSummary[]): NonNullable<GreetingProps['presence']> {
  const people: PresenceGlyph[] = live.filter((s) => !s.owner_preview).map((s) => ({ kind: s.kind === 'agent' ? 'agent' : 'person' }));
  return { line: presenceLine(live), people };
}
