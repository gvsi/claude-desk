/**
 * What the vision pages show, in the signed boards' words (the "Run 2 · vision" boards,
 * N-R2-Vision-*): Rivera Plumbing's team Desk, a returning visitor signed in with a Claude account,
 * and the app on a phone. Fixed data only: no page reads anything from the API. Rivera's own facts
 * come from the design system's Rivera fixtures, as the first visit's still preview of Today does.
 *
 * Dates, documents and bookings sit only in cards, never in Claude's words, as on every Desk.
 */
import type { DecisionState } from '../api/contracts.ts';
import { cardBlock, proseBlock, rivera } from '../ds/fixtures/index.ts';
import type { FactCardProps, NavCount, NavKey, PhoneTab, ReceiptSource, SidebarHrefs, StatusTone } from '../ds/index.ts';

/** Where each vision page lives. */
export const VISION_PATHS = {
  teamDesk: '/vision/team-desk',
  claudeAccount: '/vision/claude-account',
  phone: '/vision/phone',
} as const;

/**
 * Where every vision page's "Back to your Desk" goes: the app's entry, which opens a returning
 * owner's Today on the Desk they last had open (and the intro dialog for anyone without a copy).
 * A vision page reads nothing, so it can't name the owner's Desk itself.
 */
export const VISION_BACK_HREF = '/';

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
// The team Desk (N-R2-Vision-TeamDesk): Rivera Plumbing's team asking its own Desk.

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
  answeringDescription: 'Claude answers your team under your rules',
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
 * dates in an hours card beside them.
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
        plain: 'From job records and her customer file. Luis is assigned to her 10:30 am visit, so the address and gate code are open to him.',
      },
    ],
  },
  {
    asked: 'Send me the warranty in case it’s the tank.',
    reply: 'Here it is.',
    facts: [{ label: 'Document, only for Luis', icon: 'document', title: 'Water heater warranty, Ana Ruiz' }],
    receipts: [{ source: decided('executed'), plain: 'Warranty released to the assigned plumber. Logged on Ana’s file.' }],
  },
  {
    asked: 'Also, what did Ben make on the Harbor Street job last week?',
    reply: 'I can’t share pay. Payroll is open to Maria and Grace only. Here are your own logged hours.',
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
// The Claude account (N-R2-Vision-ClaudeAccount): Dana, back on Rivera's public page, signed in.

/** Rivera Plumbing's public page, as the kernel would serve it. */
export const RIVERA_PUBLIC_DESK = rivera.publicDesk.en;

/** The about column as the board draws it: hours, the service area and the phone, Rivera's own facts. */
export const CLAUDE_ACCOUNT_ABOUT = [rivera.blocks.hours.en, rivera.blocks.policy.en, rivera.blocks.contact.en];

/**
 * Dana's visit as the board draws it. On a vision Desk a Claude account counts as verified when its
 * verified email matches the contact on record, with her consent asked on each visit; the receipts
 * say both. Owner's copy ruling, 2026-10-30, for invariant 2: her past visit is a booking card, not
 * a sentence, and Claude only asks how it went.
 */
export const CLAUDE_ACCOUNT_TURNS = {
  signedIn: 'Signed in with your Claude account.',
  ask: 'Your Claude account has a verified email. If it matches the contact Rivera Plumbing has on record for you, I can confirm it’s you without a code. Use it for this visit?',
  yes: 'Yes, use it',
  matched: 'Welcome back, Dana. How did the drain clearing go?',
  matchedReceipt: 'Matched to Dana Whitfield: the Claude account’s verified email is her contact on record, and she agreed for this visit',
  invoice: 'All fixed, thanks. Can you send me the invoice?',
  sent: 'Glad to hear it. Here’s your invoice. You let me use your Claude account for this visit, so no code was needed.',
  releasedReceipt: 'Released to Dana Whitfield, matched by her Claude account with her consent for this visit',
  checked: 'Reply checked against Maria Rivera’s rules',
} as const;

/** Dana's last visit, as the kernel renders a booking card: its start, then the job, who and the booking. */
const DANA_LAST_VISIT = cardBlock('booking_confirmed', {
  fact_id: 'booking:B-61',
  title: 'Tuesday, October 20, 10:00 am',
  lines: ['Drain clearing', 'With Maria Rivera', 'Booking B-61'],
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
  greeting: 'Good morning, Maria',
  held: rivera.decisions.held,
  heldBy: rivera.ruleCards['rv-quote'].reason,
  waiting: 'Web chat, 2 min ago',
  liveTitle: 'Live now',
  live: [
    { name: 'Lucía Herrera', kind: 'Visitor', tone: 'handled' },
    { name: 'Alex Kim’s assistant', kind: 'Agent', tone: 'info' },
  ] satisfies readonly { name: string; kind: string; tone: StatusTone }[],
} as const;

/**
 * A visitor's chat on a phone: the booking, confirmed only next to its card. Owner's copy ruling,
 * 2026-10-30, for invariant 2: the booking is the kernel's booking card, which carries the day and
 * time, and Claude's words promise nothing it doesn't back.
 */
export const PHONE_CHAT = {
  disclosureUnderName: 'Claude, an AI, answers for Maria Rivera',
  asked: 'Can someone come Tuesday afternoon?',
  /** Claude's words, then the booking card, as one message. */
  reply: [proseBlock('You’re all set. Here’s your visit.'), rivera.blocks.booking_confirmed.en],
  receipt: { source: decided('executed'), plain: 'Booked on Maria Rivera’s calendar' } satisfies VisionReceipt,
  composer: 'Message Rivera Plumbing',
  disclosure: 'This chat is with Claude, an AI.',
} as const;

/** Claude's words as a checked reply's one prose block. */
export const proseOf = (text: string) => [proseBlock(text)];
