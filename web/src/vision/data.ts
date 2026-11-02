/**
 * Mirrors the design system's vision board stories word for word: `ds/boards/vision.tsx`, drawn by
 * `VisionCityOffice.stories.tsx`, `VisionTeamDesk.stories.tsx`, `VisionClaudeAccount.stories.tsx`
 * and `VisionPhone.stories.tsx`. Those import Storybook, so the app can't import them; change both
 * together.
 *
 * What the vision pages show, in the signed boards' words (the "Run 2 · vision" boards,
 * N-R2-Vision-*): a resident on a fictional city permits office's public Desk, Turner Plumbing's
 * team Desk, a returning visitor signed in with a Claude account, and the app on a phone. Fixed data
 * only: no page reads anything from the API. Turner's own facts and the city's public Desk come from
 * the design system's fixtures, as the first visit's still preview of Today does.
 *
 * Fees, dates, statuses, documents and bookings sit only in cards, never in Claude's words, as on
 * every Desk.
 */
import { VISION_ARTICLE } from '../about/links.ts';
import type { DecisionState, PublicDesk } from '../api/contracts.ts';
import { cardBlock, meridian, proseBlock, rivera } from '../ds/fixtures/index.ts';
import type { FactCardProps, NavCount, NavKey, PhoneTab, ReceiptSource, SidebarHrefs, StatusTone } from '../ds/index.ts';

/** Where each vision page lives (`paths.ts`). The Vision article's picture cards lead to each. */
export { VISION_PATHS } from './paths.ts';

/**
 * Where every vision page's "Back to Vision" goes: the Vision article under About this prototype,
 * which tells the story the four pages draw and links each of them.
 */
export const VISION_BACK_HREF = VISION_ARTICLE.route;

/** The receipts' sources, by what each reports: a checked reply, or an action in its state. */
const CHECKED: ReceiptSource = { kind: 'reply', handoff: false };
const decided = (state: DecisionState): ReceiptSource => ({ kind: 'decision', state });

/** A receipt under a message: what it reports on, and its line. */
export interface VisionReceipt {
  source: ReceiptSource;
  plain: string;
}

/**
 * The sidebar's rows on a vision Desk. The pages are pictures of a Desk the prototype doesn't run,
 * so each row stays on the page it is drawn on.
 */
export const VISION_SIDEBAR_HREFS: SidebarHrefs = {
  today: '#today',
  conversations: '#conversations',
  people: '#people',
  knowledge: '#knowledge',
  rules: '#rules',
  connectors: '#connectors',
  safety: '#safety',
  share: '#share',
  settings: '#settings',
};

/** The owner app around a vision Desk's page: whose Desk it is and what its sidebar shows. */
export interface VisionOwner {
  business: string;
  owner: { name: string; status: string };
  desks: { id: string; name: string }[];
  currentDeskId: string;
  current: NavKey;
  /** The Desk's word for the people it serves: "Teammates". */
  peopleLabel: string;
  counts: { conversations?: NavCount; safety?: NavCount };
  /** The Answering switch's line: whom Claude answers, under whose rules. */
  answeringDescription: string;
}

// ---------------------------------------------------------------------------------------------
// The city office (N-R2-Vision-CityOffice-Resident): a resident on a city permits office's public
// page. Meridian Bay Permits is fictional; no vision page names a real place or city office.

/**
 * The city's public Desk, the design system's `meridian.publicDesk.en`: its name and the Permit
 * Center, its colors, its charter (hours, who decides what needs a permit, and how to reach the
 * Permit Center), its open status, and who answers when Claude hands over ("Permit Center staff"),
 * as the board draws them.
 */
export const CITY_DESK: PublicDesk = meridian.publicDesk.en;

/**
 * Marcus Bell's visit, word for word as the board story writes it: his messages, Claude's words,
 * the line when he's verified and the receipts. Claude's words lead into the cards and state no
 * status, fee, date or time; the garage question is a plan checker's decision, so it is held for
 * staff. The garage reply says who it went to and where the answer comes, and its receipt is the
 * visitor's line for a hold, "Waiting for {owner} to approve": the hold's reason shows only on the
 * owner's screens.
 */
export const CITY_TURNS = {
  status: 'Hi, it’s Marcus Bell. What’s the status of my kitchen remodel permit?',
  verifyFirst: 'I can look that up after you confirm it’s you.',
  codeSent: 'Code sent to the email on the application',
  verified: 'Verified with a code sent to the email on the application',
  stands: 'Thanks, Marcus. Here’s where your kitchen remodel stands.',
  next: 'Here’s what comes next.',
  readFile: 'Read from your own permit file',
  inspector: 'When can an inspector come out?',
  times: 'These times are open on the inspection calendar. Which one works for you?',
  readCalendar: 'Times read from the inspection calendar',
  garage: 'One more thing. I’d like to turn my garage into a home office. Does that need a permit at all?',
  staffDecides: 'Whether your garage conversion needs a permit is a plan checker’s decision. I’ve asked Permit Center staff, and the answer will show up here.',
  waitingForStaff: 'Waiting for Permit Center staff to approve',
  checked: 'Reply checked against the City’s rules',
} as const;

/** The prompt before a code is sent, under the `verify_prompt` template: to the email on the application, the contact on record. */
export const CITY_VERIFY_PROMPT = cardBlock('verify_prompt', { fact_id: null, title: 'I’ll send a code to the email on the application.' });

/**
 * Marcus's permit, as fact cards: its status and the fee due (the fee is only ever here), then
 * what comes next. No reply card template covers a permit, so these are `FactCard`s.
 */
export const CITY_PERMIT = {
  status: {
    label: 'Permit status',
    icon: 'document',
    title: 'Plan check passed',
    lines: ['Kitchen remodel, permit B-2026-0412', 'Fee due before issue: $1,286'],
  },
  nextSteps: {
    label: 'Next steps',
    icon: 'rules',
    title: 'Pay the fee, then book the first inspection',
    lines: ['Pay online or at the Permit Center, 250 Harbor Street', 'First inspection: rough-in for electrical, plumbing and framing'],
  },
} as const satisfies Record<string, FactCardProps>;

/** The inspection calendar's open times for a rough-in, as the board lists them. */
const INSPECTION_SLOTS = [
  { option_id: 'S-20261104-0800', label: 'Wednesday, November 4, 8:00 am to 12:00 pm' },
  { option_id: 'S-20261105-1300', label: 'Thursday, November 5, 1:00 pm to 4:00 pm' },
  { option_id: 'S-20261109-0800', label: 'Monday, November 9, 8:00 am to 12:00 pm' },
];

/**
 * The open inspection times under the `booking_options` template, in the kernel's contract: a
 * `slots:` fact, and each time as a line and as an option, whose id is the slot id of its start,
 * that Marcus answers in the chat.
 */
export const CITY_INSPECTION_TIMES = cardBlock('booking_options', {
  fact_id: 'slots:B-2026-0412',
  title: 'Rough-in inspection',
  lines: ['Permit B-2026-0412, once the fee is paid', ...INSPECTION_SLOTS.map((slot) => slot.label)],
  options: INSPECTION_SLOTS,
});

/** What a resident might ask next, under the conversation. */
export const CITY_SUGGESTIONS = ['Book an inspection', 'Pay the fee', 'Talk to staff'] as const;

/** The receipts' sources on the city office page: a checked reply, a lookup that ran, a question held for staff. */
export const CITY_SOURCES = { checked: CHECKED, executed: decided('executed'), held: decided('held') } as const;

// ---------------------------------------------------------------------------------------------
// The team Desk (N-R2-Vision-TeamDesk): Turner Plumbing's team asking its own Desk.

export const TEAM_OWNER: VisionOwner = {
  business: rivera.business.name,
  owner: { name: rivera.business.ownerName, status: 'Available for chats' },
  desks: [
    { id: 'desk-rivera-main', name: rivera.business.deskName },
    { id: 'desk-rivera-team', name: 'Team' },
  ],
  currentDeskId: 'desk-rivera-team',
  current: 'conversations',
  peopleLabel: 'Teammates',
  counts: { conversations: { n: 12, label: '12 team conversations today' }, safety: { n: 1, label: '1 attempt stopped today' } },
  answeringDescription: 'Within your rules',
};

export const TEAM_HEADER = {
  title: 'Conversations',
  action: 'Add a teammate',
  lead: 'Your team asks this Desk for job context, customer history and documents. Each person sees only what their access allows.',
} as const;

/** The teammates column: "Everyone" first, then each teammate with their role and today's count. */
export const TEAM_EVERYONE = { name: 'Everyone', line: '12 conversations today' } as const;

export const TEAMMATES = [
  { name: 'Luis Ortega', line: 'Plumber, 5 today' },
  { name: 'Ben Carter', line: 'Plumber, 4 today' },
  { name: 'Grace Lee', line: 'Office manager, 3 today' },
] as const;

/** Luis's conversation: who, where he asked from, and what the owner can do. */
export const TEAM_CHAT = {
  name: 'Luis Ortega',
  level: 'Teammate',
  where: 'In Slack, from the van, 9:42 am',
  actions: ['Whisper', 'Take over'],
} as const;

/** A teammate's turn and Claude's answer, with its cards and receipts. */
export interface TeamTurn {
  asked: string;
  reply: string;
  facts: readonly FactCardProps[];
  receipts: readonly VisionReceipt[];
}

/**
 * Luis's conversation. Owner's copy ruling, 2026-10-30, for invariant 2: Claude's words state no
 * date, not even "today" or "last week"; the visit's date and time are in a job card and the week's
 * dates in an hours card beside them. The kernel's prose check reads the receipts too.
 */
export const TEAM_TURNS: readonly TeamTurn[] = [
  {
    asked: 'Heading to Ana Ruiz in Eastshore. What’s the history there?',
    reply: 'Here’s Ana’s history. The gate code is on her job card.',
    facts: [
      {
        label: 'Customer history',
        icon: 'document',
        title: 'Ana Ruiz, customer since 2023',
        lines: ['Water heater replaced, March 2024; under warranty until 2030', 'Kitchen drain cleared, September 12; camera inspection declined'],
      },
      {
        label: 'Job card',
        icon: 'calendar',
        title: 'Friday, October 30, 10:30 am',
        lines: ['Ana Ruiz, Eastshore: water heater check', 'Gate code 2580, at the side gate'],
      },
    ],
    receipts: [
      {
        source: CHECKED,
        // A receipt states no time either: the visit's time is on the Job card.
        plain: 'From job records and her customer file. Luis is assigned to her visit, so the address and gate code are open to him.',
      },
    ],
  },
  {
    asked: 'Send me the warranty in case it’s the tank.',
    reply: 'Here it is.',
    facts: [{ label: 'Document, only for Luis', icon: 'document', title: 'Water heater warranty, Ana Ruiz' }],
    // "Warranty" is a promise word to the kernel's prose check; the card names the document.
    receipts: [{ source: decided('executed'), plain: 'Document released to the assigned plumber. Logged on Ana’s file.' }],
  },
  {
    asked: 'Also, what did Ben make on the Harbor Street job last week?',
    reply: 'I can’t share pay. Payroll is open to Mike and Grace only. Here are your own logged hours.',
    facts: [{ label: 'Your logged hours', icon: 'clock', title: 'Monday, October 19 to Friday, October 23', lines: ['38.5 hours over 5 days'] }],
    receipts: [
      { source: decided('refused'), plain: 'Declined by team access: payroll is owner and office manager only. No pay was shared.' },
      { source: CHECKED, plain: 'Luis’s own hours, from his time records.' },
    ],
  },
];

/** What Luis can and can't open, in the board's order. */
export const LUIS_ACCESS = {
  name: 'Luis',
  canOpen: ['Job cards', 'Customer history', 'Warranties', 'Photos'],
  cantOpen: ['Invoices', 'Payroll'],
} as const;

/** The day's line under the page. */
export const TEAM_TODAY = 'Today: 12 team conversations, 9 answered from job records, 3 documents shared, 1 payroll request declined.';

// ---------------------------------------------------------------------------------------------
// The Claude account (N-R2-Vision-ClaudeAccount): Dana, back on Turner's public page, signed in.

/** Turner Plumbing's public page, as the kernel would serve it. */
export const RIVERA_PUBLIC_DESK = rivera.publicDesk.en;

/** The about column as the board draws it: hours, the service area and the phone, Turner's own facts. */
export const CLAUDE_ACCOUNT_ABOUT = [rivera.blocks.hours.en, rivera.blocks.policy.en, rivera.blocks.contact.en];

/**
 * Dana's visit as the board draws it. On a vision Desk a Claude account counts as verified when its
 * verified email matches the contact on record, with her consent asked on each visit; the receipts
 * say both. Owner's copy ruling, 2026-10-30, for invariant 2: her past visit is a booking card, not
 * a sentence, and Claude only asks how it went.
 */
export const CLAUDE_ACCOUNT_TURNS = {
  signedIn: 'Signed in with your Claude account.',
  ask: 'Your Claude account has a verified email. If it matches the contact Turner Plumbing has on record for you, I can confirm it’s you without a code. Use it for this visit?',
  yes: 'Yes, use it',
  matched: 'Welcome back, Dana. How did the drain clearing go?',
  matchedReceipt: 'Matched to Dana Whitfield: the Claude account’s verified email is her contact on record, and she agreed for this visit',
  invoice: 'All fixed, thanks. Can you send me the invoice?',
  sent: 'Glad to hear it. Here’s your invoice. You let me use your Claude account for this visit, so no code was needed.',
  releasedReceipt: 'Released to Dana Whitfield, matched by her Claude account with her consent for this visit',
  checked: 'Reply checked against Mike Turner’s rules',
} as const;

/**
 * Dana's last visit, the drain clearing, as the kernel renders a booking card: the day, then
 * "{start} to {end}" and "With {owner}", with no booking number.
 */
const DANA_LAST_VISIT = cardBlock('booking_confirmed', {
  fact_id: 'booking:B-61',
  title: 'Tuesday, October 20',
  lines: ['10:00 am to 12:00 pm', 'With Mike Turner'],
});

/** Claude's welcome back: its words, then her last visit's booking card. */
export const CLAUDE_ACCOUNT_WELCOME = [proseBlock(CLAUDE_ACCOUNT_TURNS.matched), DANA_LAST_VISIT];

/**
 * The message Claude sends with the invoice: its words, then the document card, only for her. A
 * vision page makes no requests, so the card carries no download path; the page draws its Download
 * going nowhere (`inertDownload`).
 */
export const CLAUDE_ACCOUNT_INVOICE = [
  proseBlock(CLAUDE_ACCOUNT_TURNS.sent),
  cardBlock('document_link', { fact_id: 'document_link:DL-501', title: 'Invoice, drain clearing' }),
];

/** The receipts' sources on the Claude account page. */
export const CLAUDE_ACCOUNT_SOURCES = { checked: CHECKED, matched: decided('executed'), released: decided('executed') } as const;

// ---------------------------------------------------------------------------------------------
// The phone (N-R2-Vision-Phone): the owner's Today and a visitor's chat, as phone apps.

export const PHONE_PAGE = {
  title: 'Claude Desk on a phone',
  lead: 'The owner’s Today and a visitor’s chat, as phone apps.',
  ownerCaption: 'Today, for the owner',
  visitorCaption: 'The public chat, for a visitor',
} as const;

/** The owner's tabs on the phone; More holds Connectors, Customers, Share and Settings. */
export const PHONE_TAB_HREFS: Record<PhoneTab, string> = { today: '#today', chats: '#chats', rules: '#rules', safety: '#safety', more: '#more' };

/** Today on the owner's phone: the greeting, the held quote, and who is talking to the Desk. */
export const PHONE_TODAY = {
  business: rivera.business.name,
  greeting: 'Good morning, Mike',
  held: rivera.decisions.held,
  heldBy: rivera.ruleCards['rv-quote'].reason,
  waiting: 'Web chat, 2 min ago',
  liveTitle: 'Live now',
  live: [
    { name: 'Lucía Herrera', kind: 'Visitor', tone: 'handled' },
    { name: 'Alex Kim’s assistant', kind: 'Agent', tone: 'info' },
  ] satisfies readonly { name: string; kind: string; tone: StatusTone }[],
} as const;

/** The visitor's booking on the phone, as the kernel renders a booking card: the day, when Mike arrives, and who. */
const PHONE_BOOKING = cardBlock('booking_confirmed', {
  fact_id: 'booking:B-77',
  title: 'Tuesday, November 3',
  lines: ['2:00 pm to 4:00 pm', 'With Mike Turner'],
});

/**
 * A visitor's chat on a phone: the booking, confirmed only next to its card. Owner's copy ruling,
 * 2026-10-30, for invariant 2: the booking is the kernel's booking card, which carries the day and
 * time, and Claude's words promise nothing it doesn't back.
 */
export const PHONE_CHAT = {
  disclosureUnderName: 'Claude, an AI, answers for Mike Turner',
  asked: 'Can someone come Tuesday afternoon?',
  /** Claude's words, then the booking card, as one message. */
  reply: [proseBlock('You’re all set. Here’s your visit.'), PHONE_BOOKING],
  receipt: { source: decided('executed'), plain: 'Booked on Mike Turner’s calendar' } satisfies VisionReceipt,
  composer: 'Message Turner Plumbing',
  disclosure: 'This chat is with Claude, an AI.',
} as const;

/** Claude's words as a checked reply's one prose block. */
export const proseOf = (text: string) => [proseBlock(text)];
