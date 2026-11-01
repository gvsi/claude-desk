/**
 * The share kit's ready-made words: each names the Desk's public link and says that Claude, an AI,
 * answers there. They carry that link and nothing else: never a card's document link, which is
 * single use and must not be unfurled by a messaging app.
 */
import { describe, expect, it } from 'vitest';

import type { ToolRow } from '../../api/views.ts';
import { SHARE_COPY, displayLink, spokenLink, urgentCallbackOn } from './shareCopy.ts';

const URL = 'https://desk.example/d/rivera';

/** A tool row as the Desk's rules list it, on unless said otherwise. */
function row(fields: Partial<ToolRow> & Pick<ToolRow, 'tool' | 'source'>): ToolRow {
  return {
    effects: ['change'], reversible: true, status: 'enabled', description_confirmed: '', definition_sha256: null,
    pending_definition_text: null, pending_sha256: null, review_reason: null, business: null, ...fields,
  };
}

/** Turner's urgent business tool, as the kernel seeds it: an emergency callback that alerts Mike at once. */
const URGENT = row({
  tool: 'desk.emergency-callback',
  source: 'business',
  business: {
    title: 'Emergency callback',
    description: 'Asks Mike to call back urgently about an emergency.',
    config: { block: 'urgent', urgent_when: 'A burst or leaking pipe, flooding, a sewage backup, or no water' },
  },
});
/** The callback every Desk has, which asks the owner to call back in the next open hour: not for emergencies. */
const CALLBACK = row({ tool: 'native.request_callback', source: 'native' });
/** A Desk's own intake job: on, but no callback. */
const INTAKE = row({
  tool: 'desk.new-client-intake',
  source: 'business',
  business: { title: 'New client intake', description: 'Asks a new client a few questions.', config: { block: 'intake', questions: ['Is this for you or for a business?'] } },
});

describe('share copy', () => {
  it('voicemail_keeps_one_period_after_the_business_name', () => {
    const voicemail = SHARE_COPY('Chen & Co.', 'Linda', URL, { urgentCallback: true }).find((block) => block.title === 'Voicemail');
    expect(voicemail?.text).toBe(
      'You’ve reached Chen & Co. For quotes and bookings, visit desk.example slash d slash rivera, where Claude, an AI, answers any time. For an emergency, leave a message and Linda will call you back.',
    );
  });

  it('voicemail_promises_an_emergency_callback_only_with_an_urgent_callback_tool', () => {
    // No tool for urgent callbacks (a CPA's Desk made in setup): the voicemail stops after the link,
    // and the other words are the same.
    const without = SHARE_COPY('Chen & Co.', 'Linda Chen', URL, { urgentCallback: false });
    const withIt = SHARE_COPY('Chen & Co.', 'Linda Chen', URL, { urgentCallback: true });
    expect(without.find((block) => block.title === 'Voicemail')?.text).toBe(
      'You’ve reached Chen & Co. For quotes and bookings, visit desk.example slash d slash rivera, where Claude, an AI, answers any time.',
    );
    expect(withIt.find((block) => block.title === 'Voicemail')?.text).toBe(
      'You’ve reached Chen & Co. For quotes and bookings, visit desk.example slash d slash rivera, where Claude, an AI, answers any time. For an emergency, leave a message and Linda Chen will call you back.',
    );
    expect(without.filter((block) => block.title !== 'Voicemail')).toEqual(withIt.filter((block) => block.title !== 'Voicemail'));
  });

  it('only_an_urgent_callback_tool_that_is_on_counts', () => {
    expect(urgentCallbackOn([CALLBACK, URGENT])).toBe(true);
    // A Desk made in setup has the everyday callback and its own jobs, but no urgent one.
    expect(urgentCallbackOn([CALLBACK, INTAKE])).toBe(false);
    expect(urgentCallbackOn([])).toBe(false);
    // The urgent tool counts only while it is on: not waiting for review, changed, delisted or off.
    for (const [status, review_reason] of [['needs_review', 'new'], ['needs_review', 'changed'], ['needs_review', 'delisted'], ['disabled', null]] as const) {
      expect(urgentCallbackOn([CALLBACK, { ...URGENT, status, review_reason }]), `${status} ${review_reason}`).toBe(false);
    }
    // Only a business tool built on the urgent block, with a definition the app can read.
    expect(urgentCallbackOn([{ ...URGENT, source: 'native' }])).toBe(false);
    expect(urgentCallbackOn([{ ...URGENT, business: null }])).toBe(false);
    expect(urgentCallbackOn([{ ...URGENT, business: { ...URGENT.business!, config: { block: 'urgent' } as never } }])).toBe(false);
  });

  it('share_copy_names_the_link_and_ai', () => {
    const blocks = SHARE_COPY('Turner Plumbing', 'Mike Turner', URL, { urgentCallback: true });
    expect(blocks.map((block) => block.title)).toEqual(['Google profile', 'Email signature', 'Voicemail']);
    const [google, email, voicemail] = blocks.map((block) => block.text) as [string, string, string];

    // The link as people type it in the written texts, and read out on the voicemail.
    expect(displayLink(URL)).toBe('desk.example/d/rivera');
    expect(spokenLink(URL)).toBe('desk.example slash d slash rivera');
    expect(google).toBe('Questions, quotes and bookings, any time: desk.example/d/rivera. Answered by Claude, an AI, under Mike Turner’s rules.');
    expect(email).toBe('Ask Turner Plumbing any time at desk.example/d/rivera (answered by Claude, an AI).');
    expect(voicemail).toBe(
      'You’ve reached Turner Plumbing. For quotes and bookings, visit desk.example slash d slash rivera, where Claude, an AI, answers any time. For an emergency, leave a message and Mike Turner will call you back.',
    );
    for (const text of [google, email, voicemail]) {
      expect(text).toContain('Claude, an AI');
      expect(text).not.toContain('/api/');
    }

    // Only the Desk's public link is ever shared: a document link, or anything else under the
    // API's paths, is refused rather than written into words someone pastes into a chat.
    for (const link of ['https://desk.example/api/d/tok-123', '/api/d/tok-123', 'https://desk.example/API/d/tok-123']) {
      expect(() => SHARE_COPY('Turner Plumbing', 'Mike Turner', link, { urgentCallback: true }), link).toThrow();
    }
  });
});
