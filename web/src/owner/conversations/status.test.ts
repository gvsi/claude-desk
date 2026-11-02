/**
 * The one status table for a conversation in a list, first match wins, and the name the owner
 * reads for who it is with.
 */
import { describe, expect, it } from 'vitest';

import type { ConversationSummary } from '../../api/views.ts';
import { attentionStatus, conversationListStatus, conversationStatus, whoLabel } from './status.ts';

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
    expect(whoLabel(summary({ owner_preview: true, display_name: 'Mike Turner' }))).toBe('Your preview');
    expect(whoLabel(summary({ display_name: 'Dana Whitfield', verified: true }))).toBe('Dana Whitfield');
    expect(whoLabel(summary({ kind: 'agent' }))).toBe('Agent');
    expect(whoLabel(summary({ verified: true }))).toBe('Verified customer');
    expect(whoLabel(summary())).toBe('Visitor');
    expect(whoLabel(summary({ display_name: '   ' }))).toBe('Visitor');
  });
});


describe('conversationListStatus', () => {
  it.each([
    ['quoted', 'Quoted', 'handled'],
    ['turned_down', 'Turned down', 'info'],
    ['lead_captured', 'New lead', 'info'],
    ['owner_declined', 'You declined', 'info'],
    ['called_back', 'Mike called back', 'handled'],
    ['deposit_paid', 'Deposit paid', 'handled'],
    ['document_sent', 'Verified · Invoice sent', 'handled'],
    ['visit_booked', 'Booked', 'handled'],
  ] as const)('shows_a_visitors_%s_outcome', (latest_outcome, text, tone) => {
    const chat = summary({ latest_outcome, verified: true });
    expect(conversationListStatus(chat, 0, false, 'Mike')).toEqual({ text, tone });
    expect(conversationStatus(chat, 0)).toBeNull();
    const named = { ...chat, display_name: 'Dana Whitfield' };
    expect(conversationListStatus(named, 0, false, 'Mike')).toEqual({ text, tone });
    expect(conversationStatus(named, 0)).toEqual({ tone: 'handled', text: 'Verified customer' });
    expect(conversationListStatus(chat, 1, true, 'Mike')).toEqual({ tone: 'held', text: 'Needs you' });
    expect(conversationListStatus({ ...chat, mode: 'paused' }, 0, true, 'Mike'))
      .toEqual({ tone: 'held', text: 'Paused after blocked attempts' });
    expect(conversationListStatus(chat, 0, true, 'Mike')).toEqual({ tone: 'held', text: 'Wants you' });
    expect(conversationListStatus({ ...chat, mode: 'owner' }, 0, false, 'Mike'))
      .toEqual({ tone: 'info', text: "You're in this chat" });
    expect(conversationListStatus({ ...chat, owner_preview: true }, 0, false, 'Mike'))
      .toEqual({ tone: 'info', text: 'Your own preview' });
  });

  it('says_no_messages_yet_for_a_visitor_who_hasnt_written', () => {
    const silent = summary({ latest_visitor_text: null });
    expect(conversationListStatus(silent, 0, false, 'Mike')).toEqual({ tone: 'info', text: 'No messages yet' });
    expect(conversationListStatus({ ...silent, latest_visitor_text: '  ' }, 0, false, 'Mike')).toEqual({ tone: 'info', text: 'No messages yet' });
    expect(conversationListStatus({ ...silent, display_name: 'Dana Whitfield', verified: true }, 0, false, 'Mike'))
      .toEqual({ tone: 'info', text: 'No messages yet' });
    // An outcome, an attention status and the owner's preview still win; Today's line is unchanged.
    expect(conversationListStatus({ ...silent, latest_outcome: 'quoted' }, 0, false, 'Mike')).toEqual({ tone: 'handled', text: 'Quoted' });
    expect(conversationListStatus(silent, 0, true, 'Mike')).toEqual({ tone: 'held', text: 'Wants you' });
    expect(conversationListStatus({ ...silent, owner_preview: true }, 0, false, 'Mike')).toEqual({ tone: 'info', text: 'Your own preview' });
    expect(conversationStatus(silent, 0)).toBeNull();
    // A visitor who wrote, or a reply without the field, draws the row as before.
    expect(conversationListStatus(summary({ latest_visitor_text: 'Hi' }), 0, false, 'Mike')).toBeNull();
    expect(conversationListStatus(summary(), 0, false, 'Mike')).toBeNull();
    // Agents keep their own line.
    const agent = summary({ kind: 'agent', latest_visitor_text: null });
    expect(conversationListStatus(agent, 0, false, 'Mike')).toEqual(conversationStatus(agent, 0));
  });

  it('uses_the_supplied_owner_first_name_and_requires_verification_for_an_invoice', () => {
    expect(conversationListStatus(summary({ latest_outcome: 'called_back' }), 0, false, 'Giovanni'))
      .toEqual({ tone: 'handled', text: 'Giovanni called back' });
    for (const display_name of [null, 'Marcus Bell']) {
      const chat = summary({ display_name, latest_outcome: 'document_sent' });
      expect(conversationListStatus(chat, 0, false, 'Mike')).toEqual(conversationStatus(chat, 0));
    }
  });

  it.each([undefined, null, 'future_outcome', 'constructor'])('keeps_todays_line_for_%s', (code) => {
    for (const verified of [false, true]) {
      for (const display_name of [null, '   ', 'Dana Whitfield']) {
        const chat = summary({ verified, display_name, latest_outcome: code as ConversationSummary['latest_outcome'] });
        expect(conversationListStatus(chat, 0, false, 'Mike')).toEqual(conversationStatus(chat, 0));
      }
    }
  });

  it.each(['quoted', 'lead_captured', 'owner_declined', 'called_back', 'document_sent'] as const)(
    'keeps_agent_rows_unchanged_for_%s', (latest_outcome) => {
      const agent = summary({ kind: 'agent', display_name: "Alex Kim's assistant", latest_outcome });
      expect(conversationListStatus(agent, 0, false, 'Mike')).toEqual({ tone: 'info', text: 'Agent' });
    },
  );

  it.each([null, '   '])('shows_an_unnamed_agents_outcome_with_display_name_%s', (display_name) => {
    const agent = summary({ kind: 'agent', display_name });
    for (const [latest_outcome, words] of [
      ['visit_booked', 'Visit booked'], ['deposit_paid', 'Deposit paid'], ['turned_down', 'Turned down'],
    ] as const) {
      const done = { ...agent, latest_outcome };
      expect(conversationListStatus(done, 0)).toEqual({ tone: 'info', text: `Agent · ${words}` });
      expect(conversationStatus(done, 0)).toBeNull();
      expect(conversationListStatus(done, 1, true)?.text).toBe('Needs you');
      expect(conversationListStatus({ ...done, mode: 'paused' }, 0, true)?.text).toBe('Paused after blocked attempts');
      expect(conversationListStatus(done, 0, true)?.text).toBe('Wants you');
      expect(conversationListStatus({ ...done, mode: 'owner' }, 0)?.text).toBe("You're in this chat");
    }
    expect(conversationListStatus({ ...agent, latest_outcome: null }, 0)).toBeNull();
  });

  it('adds_confirmed_agent_outcomes_only_to_the_conversations_list', () => {
    const agent = summary({ kind: 'agent', display_name: "Alex Kim's assistant" });
    for (const [latest_outcome, words] of [
      ['visit_booked', 'Visit booked'], ['deposit_paid', 'Deposit paid'], ['turned_down', 'Turned down'],
    ] as const) {
      const done = { ...agent, latest_outcome };
      expect(conversationListStatus(done, 0)).toEqual({ tone: 'info', text: `Agent · ${words}` });
      expect(conversationStatus(done, 0)).toEqual({ tone: 'info', text: 'Agent' });
      expect(conversationListStatus(done, 1, true)?.text).toBe('Needs you');
      expect(conversationListStatus({ ...done, mode: 'paused' }, 0, true)?.text).toBe('Paused after blocked attempts');
      expect(conversationListStatus(done, 0, true)?.text).toBe('Wants you');
      expect(conversationListStatus({ ...done, mode: 'owner' }, 0)?.text).toBe("You're in this chat");
    }
    expect(conversationListStatus({ ...agent, latest_outcome: null }, 0)?.text).toBe('Agent');
  });
});
