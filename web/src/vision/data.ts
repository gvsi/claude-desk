/**
 * What the vision pages show, in the signed boards' words (the "Run 2 · vision" boards,
 * N-R2-Vision-*): a fictional city permits office, Rivera Plumbing's team Desk, a returning visitor
 * signed in with a Claude account, and the app on a phone. Fixed data only: no page reads anything
 * from the API. Rivera's own facts come from the design system's Rivera fixtures, as the first
 * visit's still preview of Today does.
 *
 * Fees, dates, statuses and bookings sit only in fact cards, never in Claude's words, as on every
 * Desk.
 */
import type { DecisionState } from '../api/contracts.ts';
import { cardBlock, proseBlock, rivera } from '../ds/fixtures/index.ts';
import type { CopyLanguage, FactCardProps, NavCount, NavKey, PhoneTab, ReceiptSource, SidebarHrefs, StatusTone } from '../ds/index.ts';

/** Where each vision page lives. Today's "Things to try" leads to the city office. */
export const VISION_PATHS = {
  cityOffice: '/vision/city-office',
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
  /** The Desk's word for the people it serves: "Residents", "Teammates". */
  peopleLabel: string;
  counts: { conversations?: NavCount; safety?: NavCount };
  /** The Answering switch's line: whom Claude answers, under whose rules. */
  answeringDescription: string;
}

// ---------------------------------------------------------------------------------------------
// The city office (N-R2-Vision-CityOffice): Meridian Bay Permits, a fictional city permits office.

export const CITY_OWNER: VisionOwner = {
  business: 'Meridian Bay Permits',
  owner: { name: 'Nadia Price', status: 'Permit Center supervisor' },
  desks: [{ id: 'desk-meridian-permits', name: 'Permit Center' }],
  currentDeskId: 'desk-meridian-permits',
  current: 'today',
  peopleLabel: 'Residents',
  counts: { conversations: { n: 9, label: '9 live conversations' }, safety: { n: 4, label: '4 attempts stopped today' } },
  answeringDescription: 'Claude answers under the City’s rules',
};

export const CITY_TODAY_HEADER = {
  greeting: 'Good morning, Nadia',
  presence: 'Nine residents are talking to the Desk right now.',
  /** The Desk's public link, on a domain kept for examples. */
  link: 'desk.example/meridian-bay-permits',
} as const;

export const CITY_LIVE_NOW = {
  title: 'Live now',
  count: { n: 9, label: '9 live' },
  seeAll: 'See all in Conversations',
} as const;

/** One live conversation on the city's Today. */
export interface CityLiveRow {
  name: string;
  level: 'Verified' | 'Public';
  about: string;
  /** Claude's words: they lead into the card and state no fee, date or status. */
  reply: string;
  language: CopyLanguage;
  fact?: FactCardProps;
  receipt: VisionReceipt;
  /** The one thing the supervisor can do from the row. */
  action?: string;
}

/**
 * Live now, in the board's words: who, their level, what about, Claude's words, the fact and the
 * receipt. Marcus Bell's reply leads into his card ("Here’s where your kitchen remodel stands."),
 * so the permit's status stays in the card.
 */
export const CITY_LIVE: readonly CityLiveRow[] = [
  {
    name: 'Marcus Bell',
    level: 'Verified',
    about: 'Permit status, 3 min',
    reply: 'Here’s where your kitchen remodel stands.',
    language: 'en',
    fact: {
      label: 'Permit status',
      icon: 'document',
      title: 'Plan check passed',
      lines: ['Kitchen remodel, permit B-2026-0412', 'Fee due before issue: $1,286'],
    },
    receipt: { source: decided('executed'), plain: 'Code sent to the email on the application. His own file, so I opened it.' },
  },
  {
    name: 'Visitor in Eastshore',
    level: 'Public',
    about: 'Program deadline, in Spanish',
    reply: 'Esta es la fecha límite del programa.',
    language: 'es',
    fact: {
      label: 'Fecha límite',
      icon: 'clock',
      title: 'Programa de refuerzo sísmico',
      lines: ['Cierra el 15 de diciembre, 5:00 pm'],
      language: 'es',
    },
    receipt: { source: CHECKED, plain: 'From the published program page. Sent in Spanish.' },
  },
  {
    name: 'Visitor',
    level: 'Public',
    about: 'Asked about a neighbor’s permit',
    reply: 'Plans and applicant details go only to the applicant. Here’s what’s public.',
    language: 'en',
    fact: { label: 'Public record', icon: 'document', title: 'Permit B-2026-0377', lines: ['Status: issued'] },
    receipt: { source: decided('refused'), plain: 'Not the applicant, so only public record fields. The file stayed closed.' },
  },
  {
    name: 'Joan Park',
    level: 'Verified',
    about: 'Eligibility, waiting 4 min',
    reply: 'Whether your garage conversion is exempt is a plan checker’s decision. I’ve asked one to join.',
    language: 'en',
    receipt: { source: decided('held'), plain: 'Held for a person: exemptions are a staff decision.' },
    action: 'Assign staff',
  },
];

/** The city's always-on lines: what can't be switched off on its Desk, and why. */
export const CITY_ALWAYS_ON = {
  title: 'Always on',
  caption: 'Can’t be switched off',
  lines: [
    {
      title: 'No legal or financial determinations without a qualified person',
      detail: 'Eligibility, exemptions, fee waivers and code readings go to staff.',
    },
    { title: 'Files only to the applicant', detail: 'Codes go to the contact on the application, never one typed into chat.' },
    { title: 'No promised outcomes', detail: 'Status and published dates only, in cards, never an approval or an outcome.' },
  ],
  also: 'Also always on: says it’s an AI, and logs every conversation for City records.',
} as const;

export const CITY_TODAY_SO_FAR = {
  title: 'Today so far',
  lines: [
    '214 questions answered in 6 languages',
    '38 applicants verified for their own files',
    '7 handed to staff',
    '0 determinations made without a person',
  ],
} as const;

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

/** A teammate's turn and Claude's answer, with its card and receipt. */
export interface TeamTurn {
  asked: string;
  reply: string;
  fact?: FactCardProps;
  receipt: VisionReceipt;
}

export const TEAM_TURNS: readonly TeamTurn[] = [
  {
    asked: 'Heading to Ana Ruiz in Eastshore. What’s the history there?',
    reply: 'Here’s Ana’s history. The gate code is on today’s job card.',
    fact: {
      label: 'Customer history',
      icon: 'document',
      title: 'Ana Ruiz, customer since 2023',
      lines: ['Water heater replaced, March 2024; under warranty until 2030', 'Kitchen drain cleared, September 12; camera inspection declined'],
    },
    receipt: {
      source: CHECKED,
      plain: 'From job records and her customer file. Luis is assigned to her 10:30 am visit, so the address and gate code are open to him.',
    },
  },
  {
    asked: 'Send me the warranty in case it’s the tank.',
    reply: 'Here it is.',
    fact: { label: 'Document, only for Luis', icon: 'document', title: 'Water heater warranty, Ana Ruiz' },
    receipt: { source: decided('executed'), plain: 'Warranty released to the assigned plumber. Logged on Ana’s file.' },
  },
  {
    asked: 'Also, what did Ben make on the Harbor Street job last week?',
    reply: 'I can’t share pay. Payroll is open to Maria and Grace only. I can show your own logged hours for last week if that helps.',
    receipt: { source: decided('refused'), plain: 'Declined by team access: payroll is owner and office manager only. Nothing shared.' },
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
 * say both.
 */
export const CLAUDE_ACCOUNT_TURNS = {
  signedIn: 'Signed in with your Claude account.',
  ask: 'Your Claude account has a verified email. If it matches the contact Rivera Plumbing has on record for you, I can confirm it’s you without a code. Use it for this visit?',
  yes: 'Yes, use it',
  matched: 'Thanks, it matches. Welcome back, Dana. Last time we booked your drain clearing. How did it go?',
  matchedReceipt: 'Matched to Dana Whitfield: the Claude account’s verified email is her contact on record, and she agreed for this visit',
  invoice: 'All fixed, thanks. Can you send me the invoice?',
  sent: 'Glad to hear it. Here’s your invoice. You let me use your Claude account for this visit, so no code was needed.',
  releasedReceipt: 'Released to Dana Whitfield, matched by her Claude account with her consent for this visit',
  checked: 'Reply checked against Maria Rivera’s rules',
} as const;

/** The message Claude sends with the invoice: its words, then the document card, only for her. */
export const CLAUDE_ACCOUNT_INVOICE = [proseBlock(CLAUDE_ACCOUNT_TURNS.sent), rivera.blocks.document_link.en];

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

/** A visitor's chat on a phone: the booking, confirmed only next to its card. */
export const PHONE_CHAT = {
  disclosureUnderName: 'Claude, an AI, answers for Maria Rivera',
  asked: 'Can someone come Tuesday afternoon?',
  reply: 'Maria will text you when she’s on her way.',
  booked: { label: 'Booked', icon: 'clock', title: 'Tuesday, November 3', lines: ['Arriving 2:00 pm to 4:00 pm', 'With Maria Rivera'] },
  receipt: { source: decided('executed'), plain: 'Booked on Maria Rivera’s calendar' },
  composer: 'Message Rivera Plumbing',
  disclosure: 'This chat is with Claude, an AI.',
} as const satisfies Record<string, unknown> & { booked: FactCardProps; receipt: VisionReceipt };

/** Claude's words as a checked reply's one prose block. */
export const proseOf = (text: string) => [proseBlock(text)];

export { cardBlock };
