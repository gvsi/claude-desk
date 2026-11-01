/**
 * The one status table for a conversation in a list, first match wins, and the name the owner
 * reads for who it is with.
 */
import { describe, expect, it } from 'vitest';

import type { ConversationSummary } from '../../api/views.ts';
import { attentionStatus, conversationStatus, whoLabel } from './status.ts';

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

describe('attentionStatus', () => {
  it('is_the_table_rows_that_ask_for_the_owner', () => {
    // The table's first four rows, in its order; what someone is never asks for the owner.
    const chat = summary({ display_name: 'Dana Whitfield' });
    expect(attentionStatus(chat, 1, true)).toEqual({ tone: 'held', text: 'Needs you' });
    expect(attentionStatus({ ...chat, mode: 'paused' }, 0, true)).toEqual({ tone: 'held', text: 'Paused after blocked attempts' });
    expect(attentionStatus(chat, 0, true)).toEqual({ tone: 'held', text: 'Wants you' });
    expect(attentionStatus({ ...chat, mode: 'owner' }, 0)).toEqual({ tone: 'info', text: "You're in this chat" });
    for (const fields of [{}, { owner_preview: true }, { kind: 'agent' }, { verified: true }] as const) {
      expect(attentionStatus({ ...chat, ...fields }, 0)).toBeNull();
    }
  });
});

describe('conversationStatus', () => {
  it('open_handoff_follows_held_requests_and_paused_chats', () => {
    const chat = summary({ display_name: 'Dana Whitfield' });
    expect(conversationStatus(chat, 0, true)).toEqual({ tone: 'held', text: 'Wants you' });
    expect(conversationStatus(chat, 1, true)).toEqual({ tone: 'held', text: 'Needs you' });
    expect(conversationStatus({ ...chat, mode: 'paused' }, 0, true)).toEqual({ tone: 'held', text: 'Paused after blocked attempts' });
    expect(conversationStatus({ ...chat, mode: 'paused' }, 1, true)).toEqual({ tone: 'held', text: 'Needs you' });
    for (const fields of [{ mode: 'owner' }, { owner_preview: true }, { kind: 'agent' }, { verified: true }] as const) {
      expect(conversationStatus({ ...chat, ...fields }, 0, true)).toEqual({ tone: 'held', text: 'Wants you' });
    }
    expect(conversationStatus(summary(), 0, true)).toEqual({ tone: 'held', text: 'Wants you' });
    expect(conversationStatus(summary(), 0, false)).toBeNull();
  });
  it('status_follows_the_table', () => {
    // Each row in order, and each one wins over every row after it.
    const everything = summary({ mode: 'owner', owner_preview: true, kind: 'agent', verified: true });
    expect(conversationStatus(everything, 1)).toEqual({ tone: 'held', text: 'Needs you' });
    expect(conversationStatus(everything, 0)).toEqual({ tone: 'info', text: "You're in this chat" });
    expect(conversationStatus({ ...everything, mode: 'paused' }, 0)).toEqual({ tone: 'held', text: 'Paused after blocked attempts' });
    expect(conversationStatus({ ...everything, mode: 'ai' }, 0)).toEqual({ tone: 'info', text: 'Your own preview' });
    const agent = { ...everything, mode: 'ai', owner_preview: false, display_name: "Alex Kim's assistant" } as const;
    expect(conversationStatus(agent, 0)).toEqual({ tone: 'info', text: 'Agent' });
    expect(conversationStatus(summary({ verified: true, display_name: 'Dana Whitfield' }), 0)).toEqual({ tone: 'handled', text: 'Verified customer' });
    expect(conversationStatus(summary({ display_name: 'Marcus Bell' }), 0)).toEqual({ tone: 'handled', text: 'Visitor' });

    // With no name, the name line already says what they are, so the status doesn't say it again;
    // what is happening in the chat still shows.
    expect(conversationStatus(summary(), 0)).toBeNull();
    expect(conversationStatus(summary({ display_name: '   ' }), 0)).toBeNull();
    expect(conversationStatus(summary({ kind: 'agent' }), 0)).toBeNull();
    expect(conversationStatus(summary({ verified: true }), 0)).toBeNull();
    expect(conversationStatus(summary(), 1)).toEqual({ tone: 'held', text: 'Needs you' });
    expect(conversationStatus(summary({ mode: 'owner' }), 0)).toEqual({ tone: 'info', text: "You're in this chat" });
    expect(conversationStatus(summary({ mode: 'paused' }), 0)).toEqual({ tone: 'held', text: 'Paused after blocked attempts' });

    // Who it is with: the preview by name, else their name as given, else what they are.
    expect(whoLabel(summary({ owner_preview: true, display_name: 'Maria Rivera' }))).toBe('Your preview');
    expect(whoLabel(summary({ display_name: 'Dana Whitfield', verified: true }))).toBe('Dana Whitfield');
    expect(whoLabel(summary({ kind: 'agent' }))).toBe('Agent');
    expect(whoLabel(summary({ verified: true }))).toBe('Verified customer');
    expect(whoLabel(summary())).toBe('Visitor');
    expect(whoLabel(summary({ display_name: '   ' }))).toBe('Visitor');
  });
});
