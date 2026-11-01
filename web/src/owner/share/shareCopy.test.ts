/**
 * The share kit's ready-made words: each names the Desk's public link and says that Claude, an AI,
 * answers there. They carry that link and nothing else: never a card's document link, which is
 * single use and must not be unfurled by a messaging app.
 */
import { describe, expect, it } from 'vitest';

import { SHARE_COPY, displayLink, spokenLink } from './shareCopy.ts';

const URL = 'https://desk.example/d/rivera';

describe('share copy', () => {
  it('voicemail_keeps_one_period_after_the_business_name', () => {
    const voicemail = SHARE_COPY('Chen & Co.', 'Linda', URL).find((block) => block.title === 'Voicemail');
    expect(voicemail?.text).toBe(
      'You’ve reached Chen & Co. For quotes and bookings, visit desk.example slash d slash rivera, where Claude, an AI, answers any time. For an emergency, leave a message and Linda will call you back.',
    );
  });

  it('share_copy_names_the_link_and_ai', () => {
    const blocks = SHARE_COPY('Rivera Plumbing', 'Maria Rivera', URL);
    expect(blocks.map((block) => block.title)).toEqual(['Google profile', 'Email signature', 'Voicemail']);
    const [google, email, voicemail] = blocks.map((block) => block.text) as [string, string, string];

    // The link as people type it in the written texts, and read out on the voicemail.
    expect(displayLink(URL)).toBe('desk.example/d/rivera');
    expect(spokenLink(URL)).toBe('desk.example slash d slash rivera');
    expect(google).toBe('Questions, quotes and bookings, any time: desk.example/d/rivera. Answered by Claude, an AI, under Maria Rivera’s rules.');
    expect(email).toBe('Ask Rivera Plumbing any time at desk.example/d/rivera (answered by Claude, an AI).');
    expect(voicemail).toBe(
      'You’ve reached Rivera Plumbing. For quotes and bookings, visit desk.example slash d slash rivera, where Claude, an AI, answers any time. For an emergency, leave a message and Maria Rivera will call you back.',
    );
    for (const text of [google, email, voicemail]) {
      expect(text).toContain('Claude, an AI');
      expect(text).not.toContain('/api/');
    }

    // Only the Desk's public link is ever shared: a document link, or anything else under the
    // API's paths, is refused rather than written into words someone pastes into a chat.
    for (const link of ['https://desk.example/api/d/tok-123', '/api/d/tok-123', 'https://desk.example/API/d/tok-123']) {
      expect(() => SHARE_COPY('Rivera Plumbing', 'Maria Rivera', link), link).toThrow();
    }
  });
});
