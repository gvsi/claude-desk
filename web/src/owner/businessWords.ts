import type { DeskSummary } from '../api/views.ts';
import { RIVERA_SAMPLE_BUSINESS_NAME } from './useDesks.ts';

/** The fixed words the owner's pages show for a Desk's kind of business. */
export interface BusinessWords {
  /** Settings › Alerts: the heading over the alerts set for the business type, and its list's name. */
  alertsTitle: string;
  /** Settings › Alerts: what reaches the owner right away. */
  rightAway: string;
  /** Settings › Alerts: what waits for the morning briefing. */
  inBriefing: string;
  /** Knowledge: the sample "Questions Claude couldn’t answer", in order. */
  questions: readonly [string, string, string];
}

/**
 * Each business type's words (`DeskSummary.business_type`), as the project owner signed them on Nov 2.
 * `rivera` is the sample business, Turner Plumbing, which keeps its own.
 */
export const BUSINESS_WORDS: Readonly<Record<DeskSummary['business_type'], BusinessWords>> = {
  rivera: {
    alertsTitle: 'Set for a plumber',
    rightAway: 'Held requests, paused chats and emergencies',
    inBriefing: 'New leads, bookings and payments',
    questions: ['Do you install water softeners?', 'Can you come out on a Sunday for a burst pipe?', 'Do you take credit cards on site?'],
  },
  trade: {
    alertsTitle: 'Set for a trade business',
    rightAway: 'Held requests, paused chats and emergencies',
    inBriefing: 'New leads, bookings and payments',
    questions: ['Do you give free estimates?', 'Can you come out on a Sunday?', 'Do you take credit cards on site?'],
  },
  office: {
    alertsTitle: 'Set for a professional practice',
    rightAway: 'Held requests and paused chats',
    inBriefing: 'New clients, appointments and payments',
    questions: ['Do you work with clients in other states?', 'Can we meet in person instead of a call?', 'Do you take credit cards?'],
  },
  landlord: {
    alertsTitle: 'Set for a landlord',
    rightAway: 'Held requests, paused chats and maintenance requests',
    inBriefing: 'New applicants, viewings and payments',
    questions: ['Do you allow pets?', 'Is parking included?', 'Can I pay rent by card?'],
  },
  other: {
    alertsTitle: 'Set for your business',
    rightAway: 'Held requests and paused chats',
    inBriefing: 'New leads, bookings and payments',
    questions: ['Do you sell gift cards?', 'Is there parking nearby?', 'Do you take credit cards?'],
  },
};

/**
 * The words for `desk`. Every Desk of the sample business keeps Turner’s, as its other sample content
 * goes by the business. Any other Desk takes those of the business type setup stored for it.
 */
export function businessWords(desk: Pick<DeskSummary, 'business_name' | 'business_type'>): BusinessWords {
  return BUSINESS_WORDS[desk.business_name === RIVERA_SAMPLE_BUSINESS_NAME ? 'rivera' : desk.business_type];
}
