/**
 * The one status table for a conversation in a list, first match wins, and the name the owner
 * reads for who it is with.
 */
import { describe, expect, it } from 'vitest';

import type { ConversationSummary } from '../../api/views.ts';
import { conversationStatus, whoLabel } from './status.ts';

function summary(fields: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    session_id: 'ses-1',
    kind: 'visitor',
    display_name: null,
    verified: false,
    mode: 'ai',
    last_activity: '2026-10-30T17:00:00Z',
    outcome_counts: {},
    owner_preview: false,
    ...fields,
  };
}

describe('conversationStatus', () => {
  it('status_follows_the_table', () => {
    // Each row in order, and each one wins over every row after it.
    const everything = summary({ mode: 'owner', owner_preview: true, kind: 'agent', verified: true });
    expect(conversationStatus(everything, 1)).toEqual({ tone: 'held', text: 'Needs you' });
    expect(conversationStatus(everything, 0)).toEqual({ tone: 'info', text: "You're in this chat" });
    expect(conversationStatus({ ...everything, mode: 'paused' }, 0)).toEqual({ tone: 'held', text: 'Paused after blocked attempts' });
    expect(conversationStatus({ ...everything, mode: 'ai' }, 0)).toEqual({ tone: 'info', text: 'Your own preview' });
    expect(conversationStatus({ ...everything, mode: 'ai', owner_preview: false }, 0)).toEqual({ tone: 'info', text: 'Agent' });
    expect(conversationStatus(summary({ verified: true }), 0)).toEqual({ tone: 'handled', text: 'Verified customer' });
    expect(conversationStatus(summary(), 0)).toEqual({ tone: 'handled', text: 'Visitor' });

    // Who it is with: the preview by name, else their name as given, else what they are.
    expect(whoLabel(summary({ owner_preview: true, display_name: 'Maria Rivera' }))).toBe('Your preview');
    expect(whoLabel(summary({ display_name: 'Dana Whitfield', verified: true }))).toBe('Dana Whitfield');
    expect(whoLabel(summary({ kind: 'agent' }))).toBe('Agent');
    expect(whoLabel(summary({ verified: true }))).toBe('Verified customer');
    expect(whoLabel(summary())).toBe('Visitor');
    expect(whoLabel(summary({ display_name: '   ' }))).toBe('Visitor');
  });
});
