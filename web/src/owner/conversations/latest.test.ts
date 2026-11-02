/**
 * The line beside a conversation's title: the task that got done when the newest thing in the chat
 * is the checked card of an action that ran; else, for a checked reply after an action that ran in
 * its turn, the kernel's line for that action; else the kernel's line for the newest thing.
 */
import { describe, expect, it } from 'vitest';

import type { EvMessage, RenderedBlock, StatusEvent } from '../../api/contracts.ts';
import type { OwnerTranscriptItem } from '../../api/views.ts';
import { rivera } from '../../ds/fixtures/index.ts';
import { latestOf } from './latest.ts';

const { blocks } = rivera;
const REPLY_CHECKED = "Reply checked against Mike Turner's rules";
/** The kernel's lines for actions that ran, as their receipts give them. */
const QUOTED = "Quoted from Mike Turner's price list";
const TIMES_READ = "Times read from Mike Turner's calendar";
const LINK_MADE = 'Payment link made for this quote';

/** One item of the chat, before it has its place. */
type Part = Omit<OwnerTranscriptItem, 'n' | 'created_at'>;

/** The chat's items, numbered in the order given. */
function chat(...parts: Part[]): OwnerTranscriptItem[] {
  return parts.map((part, i) => ({ ...part, n: i + 1, created_at: `2026-11-01T15:${String(i).padStart(2, '0')}:00Z` }));
}

/** Someone's own words: a visitor's message or an agent's signed request. */
function words(kind: 'visitor_text' | 'agent_text', text: string): Part {
  return { kind, text, event: null };
}

/** A decision's status, as the kernel signed it, with the owner's own line when it has one. */
function status(state: StatusEvent['state'], opts: { type?: StatusEvent['type']; plain?: string; ownerPlain?: string | null } = {}): Part {
  const { type = state === 'held' ? 'held' : 'receipt', plain = `The kernel's line for ${state}`, ownerPlain = null } = opts;
  const event = { type, decision_id: `dec-${state}`, state, visitor_plain: plain, ledger_seq: 1, signature: 'signed' } as StatusEvent;
  return { kind: 'status', text: null, event, owner_plain: ownerPlain };
}

/** A checked message shown in the chat: Claude's reply unless another author is given. */
function reply(shown: RenderedBlock[], fields: Partial<EvMessage> = {}): Part {
  const event: EvMessage = {
    type: 'message',
    message_id: 'msg-1',
    generation: 1,
    author: 'claude',
    language: 'en',
    handoff: false,
    blocks: shown,
    visitor_plain: REPLY_CHECKED,
    ledger_seq: 2,
    signature: 'signed',
    ...fields,
  };
  return { kind: 'delivered', text: null, event };
}

describe('latestOf', () => {
  it('a_booking_that_ran_reads_visit_booked_beside_its_booked_card', () => {
    const items = chat(
      words('agent_text', 'Book the first open time, please.'),
      status('executed'),
      reply([blocks.prose.details.en, blocks.booking_confirmed.en]),
    );
    expect(latestOf(items)).toBe('Visit booked');
  });

  it('a_deposit_that_was_paid_reads_deposit_paid', () => {
    // An agent's charge within its signed limit ran, and its charge card was shown.
    const charged = chat(
      words('agent_text', 'Charge the deposit to the signed limit.'),
      status('executed'),
      reply([blocks.prose.details.en, blocks.charge_confirmed.en]),
    );
    expect(latestOf(charged)).toBe('Deposit paid');
    // A visitor paid on the checkout: the kernel completed it, and its payment card is the Desk's own message.
    const paid = chat(words('visitor_text', 'Paid, thanks.'), reply([blocks.payment_confirmed.en], { author: 'desk' }));
    expect(latestOf(paid)).toBe('Deposit paid');
  });

  it('a_reply_after_an_action_that_ran_names_the_action', () => {
    // The kernel's own line for what ran, as its receipt gives it, not the check of the reply.
    const quoted = chat(words('visitor_text', 'How much to clear a drain?'), status('executed', { plain: QUOTED }), reply([blocks.prose.details.en, blocks.quote.en]));
    expect(latestOf(quoted)).toBe(QUOTED);
    const times = chat(words('agent_text', 'Which times are open this week?'), status('executed', { plain: TIMES_READ }), reply([blocks.booking_options.en]));
    expect(latestOf(times)).toBe(TIMES_READ);
    // In the kernel's own language for the chat.
    const cotizado = 'Cotizado con la lista de precios de Mike Turner';
    expect(latestOf(chat(words('visitor_text', '¿Cuánto cuesta?'), status('executed', { plain: cotizado }), reply([blocks.quote.en], { language: 'es' })))).toBe(cotizado);
    // A reply with no card after an action that ran names it too: the action is what happened.
    expect(latestOf(chat(words('visitor_text', 'Any times Tuesday?'), status('executed', { plain: TIMES_READ }), reply([blocks.prose.details.en])))).toBe(TIMES_READ);
    // Two actions in one turn: the one that ran last, just before the reply.
    expect(latestOf(chat(words('visitor_text', 'Quote it and send a link.'), status('executed', { plain: QUOTED }), status('executed', { plain: LINK_MADE }), reply([blocks.quote.en])))).toBe(LINK_MADE);
    // The check stopped the first draft and Claude rewrote it: still the action's line.
    const stopped: Part = { kind: 'stopped_draft', text: null, event: null };
    expect(latestOf(chat(words('visitor_text', 'How much?'), status('executed', { plain: QUOTED }), stopped, reply([blocks.quote.en])))).toBe(QUOTED);
    // A booking that ran keeps its own words beside its booked card, and its line without one.
    const booked = "Booked on Mike Turner's calendar";
    expect(latestOf(chat(words('visitor_text', 'Tuesday at 2.'), status('executed', { plain: booked }), reply([blocks.booking_confirmed.en])))).toBe('Visit booked');
    expect(latestOf(chat(words('visitor_text', 'Tuesday at 2.'), status('executed', { plain: booked }), reply([blocks.prose.details.en])))).toBe(booked);
  });

  it('only_an_action_that_ran_last_in_the_turn_names_the_reply', () => {
    // A hold, refusal or anything else not executed just before the reply: the kernel's line for the reply, as before.
    for (const state of ['held', 'refused', 'denied', 'approved', 'allowed', 'failed', 'unknown', 'expired', 'cancelled'] as const) {
      expect(latestOf(chat(words('visitor_text', 'How much?'), status(state), reply([blocks.quote.en]))), state).toBe(REPLY_CHECKED);
    }
    // A later hold in the same turn isn't hidden behind the action before it.
    expect(latestOf(chat(words('visitor_text', 'Quote it with 15% off.'), status('executed', { plain: QUOTED }), status('held'), reply([blocks.quote.en])))).toBe(REPLY_CHECKED);
    // What ran in an earlier turn isn't this reply's.
    expect(latestOf(chat(status('executed', { plain: QUOTED }), reply([blocks.quote.en]), words('visitor_text', 'Thanks!'), reply([blocks.prose.details.en])))).toBe(REPLY_CHECKED);
    // A reply that hands the chat to the owner is what happened last, whatever ran before it.
    expect(latestOf(chat(words('visitor_text', 'How much?'), status('executed', { plain: QUOTED }), reply([blocks.handoff.en], { visitor_plain: 'Handed to Mike Turner' })))).toBe('Handed to Mike Turner');
    expect(latestOf(chat(words('visitor_text', 'How much?'), status('executed', { plain: QUOTED }), reply([blocks.quote.en], { handoff: true, visitor_plain: 'Handed to a person' })))).toBe('Handed to a person');
    // The owner's own words after an action are the owner's, not the action's.
    expect(latestOf(chat(status('executed', { plain: QUOTED }), reply([blocks.owner_said.en], { author: 'owner', visitor_plain: 'Mike Turner wrote this' })))).toBe('Mike Turner wrote this');
  });

  it('a_task_done_stays_done_when_the_check_stopped_the_first_draft', () => {
    // The check stopped Claude's first draft of the turn's reply, and Claude rewrote it: the draft
    // the owner keeps sits between what ran and the checked reply, in the same turn.
    const stopped: Part = { kind: 'stopped_draft', text: null, event: null };
    const booked = reply([blocks.prose.details.en, blocks.booking_confirmed.en]);
    const charged = reply([blocks.prose.details.en, blocks.charge_confirmed.en]);
    expect(latestOf(chat(words('visitor_text', 'Tuesday at 2 works.'), status('executed'), stopped, booked))).toBe('Visit booked');
    expect(latestOf(chat(words('agent_text', 'Charge the deposit to the signed limit.'), status('executed'), stopped, charged))).toBe('Deposit paid');
    // A stopped draft is no action that ran: with nothing executed in the turn, the kernel's line stays.
    expect(latestOf(chat(words('visitor_text', 'Tuesday at 2 works.'), stopped, booked))).toBe(REPLY_CHECKED);
    expect(latestOf(chat(words('visitor_text', 'Tuesday at 2 works.'), status('held'), stopped, booked))).toBe(REPLY_CHECKED);
    expect(latestOf(chat(status('executed'), booked, words('visitor_text', 'Book another one.'), stopped, booked))).toBe(REPLY_CHECKED);
  });

  it('a_booking_held_refused_or_only_asked_for_is_not_done', () => {
    // Its card beside it or not, a booking that didn't run keeps the kernel's line.
    const booked = [blocks.prose.details.en, blocks.booking_confirmed.en];
    for (const state of ['held', 'refused', 'denied', 'approved', 'allowed', 'failed', 'unknown', 'expired', 'cancelled'] as const) {
      expect(latestOf(chat(words('visitor_text', 'Book Tuesday at 2.'), status(state), reply(booked))), state).toBe(REPLY_CHECKED);
    }
    // The agent asked for it, and nothing ran.
    expect(latestOf(chat(words('agent_text', 'Book the first open time, please.'), reply(booked)))).toBe(REPLY_CHECKED);
    // What ran in an earlier turn isn't this reply's.
    expect(latestOf(chat(status('executed'), reply(booked), words('visitor_text', 'Book another one.'), reply(booked)))).toBe(REPLY_CHECKED);
    // A payment card is the kernel's record of a paid checkout only as the Desk's own message.
    expect(latestOf(chat(words('visitor_text', 'Did it go through?'), reply([blocks.payment_confirmed.en])))).toBe(REPLY_CHECKED);
  });

  it('a_later_hold_refusal_or_handoff_takes_over', () => {
    const booking = [words('visitor_text', 'Tuesday at 2 works.'), status('executed'), reply([blocks.prose.details.en, blocks.booking_confirmed.en])];
    const later = (...parts: Part[]) => latestOf(chat(...booking, words('visitor_text', 'Can you also take 15% off?'), ...parts));
    expect(later(status('held', { plain: 'Waiting for Mike Turner' }))).toBe('Waiting for Mike Turner');
    expect(later(status('refused', { plain: 'Not allowed by Mike Turner’s rules' }))).toBe('Not allowed by Mike Turner’s rules');
    // A refusal at execution keeps the owner's own line for it.
    const ownerPlain = "Your rules changed before this ran, so it wasn't done.";
    expect(later(status('refused_at_execution', { type: 'resolved', ownerPlain }))).toBe(ownerPlain);
    // Claude handed the chat to Mike with the handoff card, or the check handed its reply to him.
    expect(later(reply([blocks.handoff.en], { visitor_plain: 'Handed to Mike Turner' }))).toBe('Handed to Mike Turner');
    expect(later(reply([blocks.prose.details.en], { handoff: true, visitor_plain: 'Handed to a person' }))).toBe('Handed to a person');
    // A reply that hands the chat to Mike isn't a task done, even beside the booked card.
    const handedOver = reply([blocks.booking_confirmed.en, blocks.handoff.en]);
    expect(latestOf(chat(words('visitor_text', 'Tuesday at 2 works.'), status('executed'), handedOver))).toBe(REPLY_CHECKED);
    const blocked = reply([blocks.booking_confirmed.en], { handoff: true, visitor_plain: 'Handed to a person' });
    expect(latestOf(chat(words('visitor_text', 'Tuesday at 2 works.'), status('executed'), blocked))).toBe('Handed to a person');
  });

  it('any_other_last_event_keeps_the_kernels_line', () => {
    const booking = [words('visitor_text', 'Tuesday at 2 works.'), status('executed'), reply([blocks.prose.details.en, blocks.booking_confirmed.en])];
    // What happened after the booking is what happened last: a plain reply, a quote, a status with no reply yet, the owner's own words.
    expect(latestOf(chat(...booking, words('visitor_text', 'Thanks!'), reply([blocks.prose.details.en])))).toBe(REPLY_CHECKED);
    expect(latestOf(chat(...booking, words('visitor_text', 'And a drain clearing?'), status('executed', { plain: QUOTED }), reply([blocks.quote.en])))).toBe(QUOTED);
    expect(latestOf(chat(...booking, words('visitor_text', 'Any later times?'), status('executed', { plain: 'Checked the open times' })))).toBe('Checked the open times');
    expect(latestOf(chat(...booking, reply([blocks.owner_said.en], { author: 'owner', visitor_plain: 'Mike Turner wrote this' })))).toBe('Mike Turner wrote this');
    // A refusal at execution with no owner's line keeps the kernel's.
    expect(latestOf(chat(...booking, status('refused_at_execution', { type: 'resolved', plain: 'Not done' })))).toBe('Not done');
    // Where the owner joined or left, and the visitor's words, carry no line of the kernel's: they are passed over.
    const joined: Part = { kind: 'owner_joined', text: null, event: { type: 'owner_joined', name: 'Mike Turner' } };
    const left: Part = { kind: 'owner_left', text: null, event: { type: 'owner_left' } };
    expect(latestOf(chat(...booking, joined, left, words('visitor_text', 'See you then.')))).toBe('Visit booked');
    // A chat with nothing of the kernel's yet has no line.
    expect(latestOf(chat(words('visitor_text', 'Hello?')))).toBeNull();
    expect(latestOf([])).toBeNull();
  });
});
