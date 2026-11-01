// Meridian Bay Permits: the public Desk of the City of Meridian Bay's Permit Center, a fictional
// city permits office on the city office's vision page, where a resident asks about his permit. No
// vision page names a real city office, and its number is in 555-0100 to 555-0199, the range kept
// for fiction in every area code.

import type { PublicDesk } from '../../api/contracts';
import type { ConversationFixture } from './index';
import { cardBlock } from './rivera';

/** Who answers for the city when Claude hands over: "Ask for Permit Center staff". */
const OWNER = 'Permit Center staff';

const business = {
  name: 'Meridian Bay Permits',
  deskName: 'City of Meridian Bay, Permit Center',
  ownerName: OWNER,
  /** The header's field and the rule under it; the name and the tagline take the text tokens as their ink. */
  brand: { primary: '#2D3D4C', accent: '#6F8BA3' },
} as const;

/**
 * The city's public Desk as the page receives it (`PublicDesk`): its name and the Permit Center,
 * its colors, its charter (hours, who decides what needs a permit, and how to reach the Permit
 * Center) and the kernel's open status, as the board draws them. Two charter lines are a vision of
 * what the templates could carry, beyond what they render today: the hours card's "Inspections, …"
 * line (the kernel writes each window of the hours, unlabelled) and the contact card's second line
 * (the kernel writes the contact verbatim, as one line).
 */
const publicDesk = {
  en: {
    business_name: business.name,
    desk_name: business.deskName,
    owner_display_name: OWNER,
    brand: { ...business.brand },
    charter: [
      cardBlock('hours', {
        fact_id: 'charter:hours',
        title: 'Monday to Friday, 8:00 am to 4:30 pm',
        lines: ['Inspections, Monday to Friday, 8:00 am to 4:00 pm'],
      }),
      cardBlock('policy', { fact_id: 'charter:policy:decisions', title: 'Plan checkers decide what needs a permit and what’s exempt.' }),
      cardBlock('contact', { fact_id: 'charter:contact', title: '(415) 555-0186', lines: ['Permit Center, 250 Harbor Street'] }),
    ],
    starters: [],
    agent_card: [],
    // Friday, October 30, at 10:00 in the city's time zone: open until 4:30 pm.
    open_status: {
      open: true,
      until: '2026-10-30T16:30:00-07:00',
      opens_at: null,
      text: 'Open now, until 4:30 pm',
      as_of: '2026-10-30T10:00:00-07:00',
      refresh_at: '2026-10-30T16:30:00-07:00',
    },
  },
} satisfies { en: PublicDesk };

/** The city office: its business, its public Desk in English, and no recorded conversations. */
export const meridian = {
  business,
  publicDesk,
  conversations: {} as Record<string, ConversationFixture>,
};
