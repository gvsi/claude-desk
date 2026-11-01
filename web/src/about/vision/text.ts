/**
 * The Vision article's words: the article itself and the four phone screens drawn inside it. The businesses and
 * people are fictional, and nothing here is live. On every screen a visitor or a member of the team reads, the
 * header says Claude, an AI, is answering; prices, dates, statuses, codes and documents sit in cards, never in
 * Claude's own words; and an outcome that was held or declined shows as a receipt under the message.
 */
import { VISION_PATHS } from '../../vision/paths.ts';
import { minutesToRead, wordCount } from '../readTime.ts';

/** One thing drawn in a chat, top to bottom. */
export type ChatPart =
  | { kind: 'visitor'; text: string }
  | { kind: 'claude'; text: string }
  /** A line from the Desk itself, centered: who was verified, how someone signed in. */
  | { kind: 'system'; text: string }
  | { kind: 'card'; label: string; head: string; lines: string[] }
  /** What happened, under the message it belongs to: done, held for a person, or declined. */
  | { kind: 'receipt'; tone: 'done' | 'held' | 'declined'; text: string }
  /** Two choices Claude offers, the first one primary. */
  | { kind: 'choices'; primary: string; other: string };

/** A chat with a Desk, under the business's header and the line that says Claude, an AI, is answering. */
export interface ChatScreen {
  kind: 'chat';
  /** What the screen shows, read in place of it. */
  label: string;
  /** The header's color: the City's or Turner Plumbing's. */
  field: 'city' | 'rivera';
  /** The header's initials, beside the name written out. */
  monogram: string;
  name: string;
  sub: string;
  /** The line under the name that says Claude, an AI, is answering. */
  ai: string;
  parts: ChatPart[];
  composer: string;
}

/** The owner's own app, open on Today: a request held for her answer, who's live now and the night's count. */
export interface OwnerScreen {
  kind: 'owner';
  label: string;
  business: string;
  greeting: string;
  held: { label: string; ask: string; rule: string; allow: string; deny: string };
  live: { label: string; lines: string[] };
  receipt: string;
  tabs: string[];
  /** The tab open now. */
  tab: string;
}

export type Screen = ChatScreen | OwnerScreen;

export const CITY: ChatScreen = {
  kind: 'chat',
  label:
    'A resident’s phone: the Meridian Bay Permit Center’s Desk shows his permit status in a card and hands a fee waiver to staff.',
  field: 'city',
  monogram: 'MB',
  name: 'Meridian Bay Permits',
  sub: 'Permit Center, after hours',
  ai: 'You’re chatting with Claude, an AI answering for the Permit Center.',
  parts: [
    { kind: 'visitor', text: 'Where’s my kitchen remodel permit at?' },
    { kind: 'system', text: 'Marcus Bell, verified by a code to his application email' },
    { kind: 'claude', text: 'Here’s where it stands.' },
    {
      kind: 'card',
      label: 'Permit status',
      head: 'Plan check passed',
      lines: ['Kitchen remodel, B-2026-0412', 'Fee due before issue: $1,286'],
    },
    { kind: 'receipt', tone: 'done', text: 'From the City’s records. His own file, so it opened.' },
    { kind: 'visitor', text: 'Can you waive the fee? Money’s tight.' },
    { kind: 'claude', text: 'Fee waivers are a staff decision, so I’ve asked one to follow up with you.' },
    { kind: 'receipt', tone: 'held', text: 'Held for a person: waivers are decided by staff.' },
  ],
  composer: 'Message the Permit Center',
};

export const TEAM: ChatScreen = {
  kind: 'chat',
  label: 'A plumber’s phone: the team Desk shows his job card with the gate code and declines to share a colleague’s pay.',
  field: 'rivera',
  monogram: 'T',
  name: 'Turner Plumbing team',
  sub: 'Luis Ortega, plumber',
  ai: 'Claude, an AI, answers the team under Mike’s rules.',
  parts: [
    { kind: 'visitor', text: 'Heading to Ana Ruiz in Eastshore. What’s the history there?' },
    { kind: 'claude', text: 'Here’s her job card. The gate code is on it.' },
    {
      kind: 'card',
      label: 'Job card',
      head: 'Friday, October 30, 10:30 am',
      lines: ['Ana Ruiz, Eastshore: water heater check', 'Gate code 2580, at the side gate'],
    },
    { kind: 'receipt', tone: 'done', text: 'Open to Luis: he’s assigned to this visit.' },
    { kind: 'visitor', text: 'What did Ben make on Harbor Street?' },
    { kind: 'claude', text: 'I can’t share pay. Payroll is open to Mike and Grace only.' },
    { kind: 'receipt', tone: 'declined', text: 'Declined by team access. No pay was shared.' },
  ],
  composer: 'Ask the team Desk',
};

export const ACCOUNT: ChatScreen = {
  kind: 'chat',
  label: 'A returning customer’s phone: she confirms it’s her with her Claude account, for this visit only, and her invoice opens.',
  field: 'rivera',
  monogram: 'T',
  name: 'Turner Plumbing',
  sub: 'Main line',
  ai: 'You’re chatting with Claude, an AI answering for Turner Plumbing.',
  parts: [
    { kind: 'system', text: 'Signed in with your Claude account' },
    {
      kind: 'claude',
      text: 'Your Claude account’s verified email matches the contact Turner Plumbing has for you. Use it to confirm it’s you, for this visit?',
    },
    { kind: 'choices', primary: 'Yes, for this visit', other: 'Send me a code' },
    { kind: 'visitor', text: 'Yes, for this visit' },
    { kind: 'claude', text: 'Welcome back, Dana. Here’s your invoice.' },
    { kind: 'card', label: 'Document, only for Dana', head: 'Invoice, drain clearing', lines: ['Tuesday, October 20'] },
    { kind: 'receipt', tone: 'done', text: 'Matched by her Claude account, with her consent for this visit.' },
  ],
  composer: 'Message Turner Plumbing',
};

export const OWNER: OwnerScreen = {
  kind: 'owner',
  label: 'The owner’s phone: a held discount request waits for his answer, with Allow this time and Deny this time.',
  business: 'Turner Plumbing',
  greeting: 'Good morning, Mike',
  held: {
    label: 'Waiting for your answer',
    ask: 'A visitor asked for 15% off a drain clearing: $153.00 instead of $180.00.',
    rule: 'Held by your rule: quotes at list price.',
    allow: 'Allow this time',
    deny: 'Deny this time',
  },
  live: { label: 'Live now', lines: ['Lucía Herrera, on your public page', 'Alex Kim’s assistant, booking a visit'] },
  receipt: 'Since last night: 6 answered, 1 booked, 1 attempt stopped.',
  tabs: ['Today', 'Chats', 'Rules', 'Safety'],
  tab: 'Today',
};

/** The four screens in the order the article shows them, which the cover band peeks at too. */
export const SCREENS: Screen[] = [CITY, TEAM, ACCOUNT, OWNER];

/** A screen in the article, its caption's lead and text, and the side its phone sits on at a laptop's width. */
export interface Figure {
  screen: Screen;
  side: 'left' | 'right';
  lead: string;
  caption: string;
}

/** A paragraph, or the pull quote. */
export type Passage = string | { quote: string };

export interface Section {
  heading: string;
  passages: Passage[];
  figure?: Figure;
}

/** The sections after the opening paragraphs, each with its screen but the last, which holds the pull quote. */
export const SECTIONS: Section[] = [
  {
    heading: 'A city office that answers after hours',
    passages: [
      'The Meridian Bay Permit Center closes at five. Residents’ questions don’t. A Desk for the center answers in the resident’s own language, opens an application once the resident proves it’s theirs, and quotes only the fees and dates the City has published.',
      'What it never does is decide. Whether a garage conversion is exempt, whether a fee can be waived, how a code applies: those go to a plan checker, by name, with the conversation attached. On a busy day that might be seven handoffs out of two hundred questions, and not one determination made without a person.',
    ],
    figure: {
      screen: CITY,
      side: 'left',
      lead: 'Marcus checks his remodel at 11 pm.',
      caption:
        'The status and the fee come from the City’s records, in a card. The code that opened his file went to the email on his application, and the waiver he asked for went to staff.',
    },
  },
  {
    heading: 'A Desk for the team, not just the customers',
    passages: [
      'Turner Plumbing has three plumbers and an office manager. They ask the questions customers do, from the van: what’s the history at this address, where’s the warranty, what’s the gate code. A team Desk answers from job records, and each person sees only what their role allows.',
      'Luis can open job cards and warranties for the visits he’s assigned. He can’t open payroll, and when he asks what Ben made last week, the Desk says so plainly and offers his own hours instead.',
    ],
    figure: {
      screen: TEAM,
      side: 'right',
      lead: 'Luis, between jobs.',
      caption: 'The gate code is on his job card because he’s assigned to the visit. Payroll stays closed, and the Desk says why.',
    },
  },
  {
    heading: 'Recognized, with your permission',
    passages: [
      'Today a returning customer proves who they are with a code sent to the contact on record. If they’ve signed in with a Claude account whose verified email matches that contact, the Desk can ask instead: use it, for this visit?',
      'Dana says yes and gets her invoice without a code. Turner Plumbing learns nothing about her account beyond the match, and the next visit asks again.',
    ],
    figure: {
      screen: ACCOUNT,
      side: 'left',
      lead: 'Dana comes back for her invoice.',
      caption: 'Her Claude account matches the contact Mike has on file. She agrees for this visit only, and the invoice opens.',
    },
  },
  {
    heading: 'In your pocket',
    passages: [
      'Mike doesn’t sit at a desk. His Desk’s requests reach his phone: a visitor asking for 15% off, a callback, an agent at its spending limit. He answers in one tap, and the answer applies only this time unless he makes it a rule.',
      'His customers get the same chat on their phones, with a card whenever something’s booked or quoted, and the same line at the top saying it’s Claude, an AI.',
    ],
    figure: {
      screen: OWNER,
      side: 'right',
      lead: 'A request waits for Mike.',
      caption: 'Allow or deny applies once. Making it a rule would apply it every time, and that stays his call.',
    },
  },
  {
    heading: 'What stays the same',
    passages: [
      'Every one of these keeps the rules the prototype keeps today. The Desk says it’s Claude, an AI. Prices, dates and statuses come only from records, in cards. Private details go only to people who prove who they are. Money moves only under the owner’s rules or a limit someone signed. Every attempt is logged.',
      { quote: 'The floor doesn’t move. The ceiling does.' },
      'What changes is how much a Desk can handle before it has to ask. As models get better at applying an owner’s policies to cases nobody wrote down, fewer requests need the owner, and the checks in code keep catching what a model alone would miss.',
    ],
  },
];

/** A picture card: the top of an idea's phone, then the idea's name and one line, the whole card a link to its vision page. */
export interface PictureCard {
  screen: Screen;
  name: string;
  line: string;
  /** The idea's vision page, drawn as it would work. */
  href: string;
}

/** The section after "What stays the same": one card for each idea, in the article's order. */
export const PICTURE_CARDS = {
  heading: 'See each one up close',
  lead: 'Each idea has its own page, drawn as it would work.',
  cards: [
    { screen: CITY, name: 'A city office that answers after hours', line: 'Meridian Bay Permits, after five', href: VISION_PATHS.cityOffice },
    { screen: TEAM, name: 'A Desk for the team', line: 'Turner Plumbing’s plumbers, from the van', href: VISION_PATHS.teamDesk },
    { screen: ACCOUNT, name: 'Recognized, with your permission', line: 'Dana, signed in with her Claude account', href: VISION_PATHS.claudeAccount },
    { screen: OWNER, name: 'In your pocket', line: 'Mike’s requests on his phone', href: VISION_PATHS.phone },
  ] satisfies PictureCard[],
} as const;

/** The article around its sections: the meta line, the headline, the dek and its note, the opening, and the end. */
export const ARTICLE = {
  kicker: 'Vision',
  date: { text: 'October 30, 2026', iso: '2026-10-30' },
  title: 'A front desk that never closes',
  dek: 'Today a Desk answers for one plumber in Oakland. The same idea fits a city permit office, a team in the field, a customer who’s already signed in and an owner who’s never at a desk. Here’s what that could look like, and the rules that wouldn’t change.',
  note: 'Vision, not the prototype. Nothing on this page is live.',
  intro: [
    'Most of the questions a business gets are the same questions, asked at the wrong time. What does it cost? Can you come Tuesday? Where’s my invoice? Turner Plumbing’s Desk answers them at any hour, from Mike’s own price list and calendar, and asks him before it does anything his rules don’t cover.',
    'That shape isn’t special to plumbing. Anywhere a person answers the same questions under rules they already know, a Desk can take the first conversation and hand off the rest. Here are four places we think it goes next.',
  ],
  end: 'Vision, not in the prototype. Nothing on this page is live; the businesses and people are fictional.',
} as const;

/** Everything written on a screen, top to bottom, but its initials, which stand beside the name written out. */
export function screenText(screen: Screen): string[] {
  if (screen.kind === 'owner') {
    const { held, live } = screen;
    return [
      screen.business,
      screen.greeting,
      held.label,
      held.ask,
      held.rule,
      held.allow,
      held.deny,
      live.label,
      ...live.lines,
      screen.receipt,
      ...screen.tabs,
    ];
  }
  const parts = screen.parts.flatMap((part) => {
    switch (part.kind) {
      case 'card':
        return [part.label, part.head, ...part.lines];
      case 'choices':
        return [part.primary, part.other];
      default:
        return [part.text];
    }
  });
  return [screen.name, screen.sub, screen.ai, ...parts, screen.composer];
}

/**
 * The article's own text, as a reader meets it: the headline, the dek and its note, then each section with its
 * figure's caption, then the picture cards' heading, lead and words (their phones' tops are decoration).
 */
export function articleText(): string[] {
  const { title, dek, note, intro } = ARTICLE;
  const { heading, lead, cards } = PICTURE_CARDS;
  return [
    title,
    dek,
    note,
    ...intro,
    ...SECTIONS.flatMap(({ heading, passages, figure }) => [
      heading,
      ...passages.map((passage) => (typeof passage === 'string' ? passage : passage.quote)),
      ...(figure ? [figure.lead, figure.caption] : []),
    ]),
    heading,
    lead,
    ...cards.flatMap(({ name, line }) => [name, line]),
  ];
}

/**
 * The meta line's reading time: the article's own words and the words on its four screens, at the About pages'
 * speed (230 words a minute, `readTime.ts`), rounded. It is worked out from the text above when the article's code
 * loads, so a change to the words changes it.
 */
export const READ_MINUTES = minutesToRead(wordCount([...articleText(), ...SCREENS.flatMap(screenText)]));
