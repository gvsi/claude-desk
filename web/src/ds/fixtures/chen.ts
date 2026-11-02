// Chen & Co. CPA: Linda Chen's practice, the second business in the switcher, and the board where
// Raj Patel confirms it's him with a code before Claude releases his tax return. Linda asks to see
// every booking before it's made, so a visitor's first consultation waits for her answer.

import type {
  CardBlock,
  Decision,
  DecisionState,
  DemoInboxEntry,
  EvMessage,
  InboxNotice,
  PublicDesk,
  RuleCard,
  SessionState,
  StatusEvent,
  VerifyStarted,
} from '../../api/contracts';
import type { Bilingual, ConversationFixture, DemoInboxFixture, ProseBlock } from './index';
import type { ConnectorView } from '../components/ConnectorName/ConnectorName';
import type { ConnectorPickerProps } from '../components/ConnectorPicker/ConnectorPicker';
import type { ConnectorOfferCardProps } from '../components/ConnectorOfferCard/ConnectorOfferCard';
import type { ReviewToolView } from '../components/ConnectorReview/ConnectorReview';
import type { ConnectorSectionProps } from '../components/ConnectorSection/ConnectorSection';
import type { RuleWord } from '../components/RuleRow/RuleRow';
import { executedLine } from './receipts';
import { cardBlock, placeholderHex, proseBlock } from './rivera';

const OWNER = 'Linda Chen';
const DESK_ID = 'desk-chen-main';
/** The same demo copy as Turner Plumbing's: one owner with two businesses. */
const COPY_ID = 'copy-demo-7f3a';

const business = {
  name: 'Chen & Co. CPA',
  deskName: 'Main line',
  ownerName: OWNER,
  slug: 'chen-co-cpa-m4p8z1',
  brand: { primary: '#24364F', accent: '#A8873A' },
} as const;

const people = {
  raj: { personId: 'per-raj', name: 'Raj Patel', maskedContact: '•••• 0142' },
} as const;

const cards = {
  hours: {
    en: cardBlock('hours', { fact_id: 'charter:hours', title: 'Monday to Friday, 9:00 am to 4:00 pm' }),
    es: cardBlock('hours', { fact_id: 'charter:hours', title: 'De lunes a viernes, de 9:00 a 16:00' }),
  },
  contact: {
    en: cardBlock('contact', { fact_id: 'charter:contact', title: '(415) 555-0118' }),
    es: cardBlock('contact', { fact_id: 'charter:contact', title: '(415) 555-0118' }),
  },
  policy: {
    en: cardBlock('policy', {
      fact_id: 'charter:policy:services',
      title: 'Tax and bookkeeping for families and small businesses in San Francisco.',
    }),
    es: cardBlock('policy', {
      fact_id: 'charter:policy:services',
      title: 'Tax and bookkeeping for families and small businesses in San Francisco.',
    }),
  },
  verify_prompt: {
    en: cardBlock('verify_prompt', { fact_id: null, title: "I'll send a code to the contact on record." }),
    es: cardBlock('verify_prompt', { fact_id: null, title: 'Enviaré un código al contacto registrado.' }),
  },
  document_link: {
    en: cardBlock('document_link', {
      fact_id: 'document_link:DL-880',
      title: '2025 tax return, federal and California',
      href: '/api/d/Rk7pQ2',
    }),
    es: cardBlock('document_link', {
      fact_id: 'document_link:DL-880',
      title: '2025 tax return, federal and California',
      href: '/api/d/Rk7pQ2',
    }),
  },
} satisfies Record<string, Bilingual<CardBlock>>;

const proseBlocks = {
  verifyFirst: {
    en: proseBlock("I can send that after you confirm it's you."),
    es: proseBlock('Puedo enviarlo cuando confirmes que eres tú.'),
  },
  documentReady: {
    en: proseBlock("Thanks, Raj. Here's your return."),
    es: proseBlock('Gracias, Raj. Aquí tienes tu declaración.'),
  },
} satisfies Record<string, Bilingual<ProseBlock>>;

const blocks = { ...cards, prose: proseBlocks };

const sessions = {
  /** Raj after confirming with a demo code (simulated verification). */
  raj: { session_id: 'ses-raj-web', kind: 'visitor', verified: true, assurance: 'demo_code', mode: 'ai', generation: 1 },
  /** A visitor not on record, unverified, asking for a first consultation. */
  public: { session_id: 'ses-chen-visitor', kind: 'visitor', verified: false, assurance: 'none', mode: 'ai', generation: 1 },
} satisfies Record<string, SessionState>;

const plain = {
  reply_checked: "Reply checked against Linda Chen's rules",
  held: 'Waiting for Linda Chen to approve',
} as const satisfies Partial<Record<DecisionState | 'reply_checked', string>>;

function rule(fields: Pick<RuleCard, 'card_id' | 'applies_to' | 'mode' | 'who' | 'reason'>): RuleCard {
  return {
    person_id: null,
    agent_key_id: null,
    max_amount_cents: null,
    max_discount_bp: 0,
    hours: null,
    review: false,
    is_default: false,
    ...fields,
  };
}

/**
 * Linda's cards: every booking waits for her answer, whoever asks; quotes are automatic at list
 * price (a discount holds for her); clients get their own documents once they confirm it's them.
 * The preset's always-auto cards (open times, leads, callbacks, verification) are not repeated.
 */
const ruleCards = {
  'cc-consult': rule({
    card_id: 'cc-consult',
    applies_to: 'native.book',
    mode: 'ask',
    who: 'anyone',
    reason: 'Bookings wait for your answer.',
  }),
  'cc-quote': rule({
    card_id: 'cc-quote',
    applies_to: 'native.quote',
    mode: 'auto',
    who: 'anyone',
    reason: 'Quotes from your price list, at list price.',
  }),
  'cc-docs': rule({
    card_id: 'cc-docs',
    applies_to: 'native.release_document',
    mode: 'auto',
    who: 'record_owner',
    reason: "Clients get their own documents after confirming it's them.",
  }),
} satisfies Record<string, RuleCard>;

const word = (field: RuleWord['field'], text: string): RuleWord => ({ field, text });

/** Each card's words as the web app's `ruleWords` renders what it enforces. */
const ruleWords = {
  'cc-consult': [word('who', 'Anyone')],
  'cc-quote': [word('who', 'Anyone'), word('limits', 'No discounts')],
  'cc-docs': [word('who', "The record's owner, verified")],
} satisfies Record<keyof typeof ruleCards, RuleWord[]>;

const connectorViews = {
  quotes: {
    id: 'quotes',
    name: 'Quotes',
    icon: 'quotes',
    description: 'Prices work from your price list.',
    source: { kind: 'built_in' },
  },
  bookings: {
    id: 'bookings',
    name: 'Bookings',
    icon: 'bookings',
    description: 'Finds open times and books consultations.',
    source: { kind: 'built_in' },
  },
  leads: {
    id: 'leads',
    name: 'Leads and callbacks',
    icon: 'leads',
    description: "Saves visitors’ details and asks you to call back.",
    source: { kind: 'built_in' },
  },
  verification: {
    id: 'verification',
    name: 'Verification',
    icon: 'verification',
    description: 'Confirms a client is who they say.',
    source: { kind: 'built_in' },
  },
  documents: {
    id: 'documents',
    name: 'Documents',
    icon: 'documents',
    description: "Sends clients their own documents after they confirm it’s them.",
    source: { kind: 'built_in' },
  },
  /** Not on Chen & Co.'s Desk yet: the built-in connector Linda adds in the add-a-connector example. */
  payments: {
    id: 'payments',
    name: 'Payments',
    icon: 'payments',
    description: 'Lets clients pay an invoice from a one-time link. Test payments, no money moves.',
    source: { kind: 'built_in' },
  },
} satisfies Record<string, ConnectorView>;

type HubSection = Pick<ConnectorSectionProps, 'connector' | 'href' | 'tools'>;

const hubSections = [
  {
    connector: connectorViews.quotes,
    href: '/connectors/quotes',
    tools: [
      {
        key: 'native.quote',
        name: 'Quote',
        description: 'Prices work from your price list. Changes something. Can be undone.',
        summary: 'Anyone · No discounts',
        mode: 'auto',
        status: 'enabled',
        href: '/connectors/quotes/quote',
      },
    ],
  },
  {
    connector: connectorViews.bookings,
    href: '/connectors/bookings',
    tools: [
      {
        key: 'native.find_slots',
        name: 'Find open times',
        description: "Reads the times you’re free. Changes nothing.",
        summary: 'Anyone',
        mode: 'auto',
        status: 'enabled',
        href: '/connectors/bookings/find-open-times',
      },
      {
        key: 'native.book',
        name: 'Book a consultation',
        description: 'Puts a consultation on your calendar. Can be undone.',
        summary: 'Anyone',
        mode: 'ask',
        status: 'enabled',
        href: '/connectors/bookings/book-a-consultation',
      },
    ],
  },
  {
    connector: connectorViews.leads,
    href: '/connectors/leads',
    tools: [
      {
        key: 'native.capture_lead',
        name: 'Save a lead',
        description: "Keeps a visitor’s details for you. Can be undone.",
        summary: 'Anyone',
        mode: 'auto',
        status: 'enabled',
        href: '/connectors/leads/save-a-lead',
      },
      {
        key: 'native.request_callback',
        name: 'Request a callback',
        description: 'Asks you to call someone back. Can be undone.',
        summary: 'Anyone',
        mode: 'auto',
        status: 'enabled',
        href: '/connectors/leads/request-a-callback',
      },
    ],
  },
  {
    connector: connectorViews.verification,
    href: '/connectors/verification',
    tools: [
      {
        key: 'native.start_verification',
        name: "Confirm it’s them",
        description: 'Sends a code to the contact on record.',
        summary: 'Always on',
        mode: 'auto',
        status: 'enabled',
        href: '/connectors/verification/confirm-its-them',
      },
    ],
  },
  {
    connector: connectorViews.documents,
    href: '/connectors/documents',
    tools: [
      {
        key: 'native.release_document',
        name: 'Share a document',
        description: "Sends clients their own documents. Touches private data. Can't be undone.",
        summary: "The record's owner, verified",
        mode: 'auto',
        status: 'enabled',
        href: '/connectors/documents/share-a-document',
      },
    ],
  },
] satisfies HubSection[];

/** Chen & Co. CPA's Rules hub: five built-in connectors, without Payments. */
const connectors = {
  views: connectorViews,
  summary: '5 built-in connectors · Version 3, checked against the always-on rules',
  sections: hubSections,
};

/** The apps Chen & Co. CPA could connect, as the picker words them (N-Conn-07b). Both are mocks. */
const appViews = {
  google_calendar: {
    id: 'google_calendar',
    name: 'Google Calendar',
    icon: 'google_calendar',
    description: "Will let Claude see when you're busy, never what the event is.",
    source: { kind: 'external', mock: true },
  },
  stripe: {
    id: 'stripe',
    name: 'Stripe',
    icon: 'stripe',
    description: "Your clients' charges and refunds, in test mode.",
    source: { kind: 'external', mock: true },
  },
} satisfies Record<string, ConnectorView>;

/**
 * "Add a connector" on Chen & Co. CPA's Connectors page: Payments to add, the four built-in connectors
 * it has, Google Calendar coming soon and Stripe to connect. Verification is never listed, since
 * every Desk has it.
 */
const picker = {
  business: business.name,
  builtIn: [
    { connector: connectorViews.payments, state: 'available' },
    { connector: connectorViews.quotes, state: 'added' },
    { connector: connectorViews.bookings, state: 'added' },
    { connector: connectorViews.leads, state: 'added' },
    { connector: connectorViews.documents, state: 'added' },
  ],
  external: [
    { connector: appViews.google_calendar, state: 'coming_soon' },
    { connector: appViews.stripe, state: 'available' },
  ],
  note: 'Google Calendar is coming soon in this demo. Until then, Claude offers the open times you set on Bookings.',
} satisfies Pick<ConnectorPickerProps, 'business' | 'builtIn' | 'external' | 'note'>;

/** The always-on rule that covers every tool that moves money, on every Desk. */
const noMoneyWithoutARule = { text: 'No money moves without your rule or a signed limit', mode: 'always_on' } as const;

/**
 * Reviewing Payments before it turns on (N-Conn-11b): each tool starts at Ask me first, and the
 * always-on money rule covers both.
 */
const paymentsReview = {
  tools: [
    {
      key: 'native.payment_link',
      name: 'Payment link',
      description: "Makes a one-time link to pay an invoice. Charges money. Can't be undone.",
      mode: 'ask',
      coveredBy: [noMoneyWithoutARule],
    },
    {
      key: 'native.charge_mandate',
      name: 'Charge within a signed limit',
      description: "Lets a visiting agent pay from its owner’s signed limit. Charges money. Can't be undone.",
      mode: 'ask',
      coveredBy: [noMoneyWithoutARule],
    },
  ],
} satisfies { tools: ReviewToolView[] };

/** Claude's card in Linda's Ask Claude panel (N-Conn-12-Chat): it leads into Payments' review. */
const paymentsOffer = {
  connector: connectorViews.payments,
  toolsLine: '2 tools · Payment link, Charge within a signed limit',
  coverage: 'Covered by your always-on rule: no money moves without your rule or a signed limit.',
  action: 'add',
} satisfies Omit<ConnectorOfferCardProps, 'onReview'>;

/** Claude's card when Linda asks for Google Calendar, which is coming soon in the demo. */
const calendarOffer = {
  connector: appViews.google_calendar,
  toolsLine: "1 tool · See when you're free",
  action: 'coming_soon',
} satisfies Omit<ConnectorOfferCardProps, 'onReview'>;

/**
 * A visitor not on record asks for a first consultation. Linda's ask card holds every booking, so
 * the tool itself is held and Deny always is offered; an unverified visitor has no person to scope
 * a rule to, so Allow only for this person isn't.
 */
const heldConsultation = {
  decision_id: 'dec-chen-consultation',
  session_id: sessions.public.session_id,
  call_id: 'call-chen-consultation',
  action: {
    action_id: 'act-chen-consultation',
    copy_id: COPY_ID,
    desk_id: DESK_ID,
    session_id: sessions.public.session_id,
    generation: 1,
    tool: 'native.book',
    effects: ['change'],
    args_sha256: placeholderHex('sha256:args:chen-consultation', 32),
    profile_sha256: placeholderHex('sha256:profile:native.book', 32),
    resource: { kind: 'slot', id: 'S-20261104-1100', owner_person_id: null },
    list_cents: null,
    discount_bp: null,
    amount_cents: null,
    recipient: null,
    starts_at: '2026-11-04T11:00:00-08:00',
  },
  outcome: 'hold',
  state: 'held',
  policy_version: 1,
  policy_ids: ['H.cc-consult'],
  card_ids: ['cc-consult'],
  review: null,
  reason_plain: 'A visitor not on record asked to book a first consultation on Wednesday, November 4 at 11:00 am.',
  owner_plain: null,
  visitor_plain: plain.held,
  answers: ['allow_once', 'deny_once', 'deny_always'],
  expires_at: '2026-10-31T18:12:09.774120Z',
  inbox: [{ entry_id: 'inbox-hold-consultation', to: 'owner', preview: 'A request needs your answer' }],
  ledger_seq: 81,
  signature: placeholderHex('signature:dec-chen-consultation:held', 64),
} satisfies Decision;

function message(id: string, blocksOfMessage: EvMessage['blocks'], ledgerSeq: number): EvMessage {
  return {
    type: 'message',
    message_id: id,
    generation: 1,
    author: 'claude',
    language: 'en',
    handoff: false,
    blocks: blocksOfMessage,
    visitor_plain: plain.reply_checked,
    ledger_seq: ledgerSeq,
    signature: placeholderHex(`signature:${id}`, 64),
  };
}

const releaseReceipt = {
  type: 'receipt',
  decision_id: 'dec-raj-return',
  state: 'executed',
  visitor_plain: executedLine('native.release_document', 'en', OWNER),
  ledger_seq: 74,
  signature: placeholderHex('signature:dec-raj-return:executed', 64),
} satisfies StatusEvent;

const conversations = {
  raj: {
    name: people.raj.name,
    session: sessions.raj,
    language: 'en',
    turns: [
      { kind: 'visitor', text: "Hi, it's Raj Patel. Can you send me my 2025 return?" },
      {
        kind: 'event',
        event: message('msg-raj-verify', [proseBlocks.verifyFirst.en, cards.verify_prompt.en], 71),
      },
      { kind: 'event', event: releaseReceipt },
      {
        kind: 'event',
        event: message('msg-raj-return', [proseBlocks.documentReady.en, cards.document_link.en], 75),
      },
    ],
  },
} satisfies Record<string, ConversationFixture>;

const publicDesk = {
  en: {
    business_name: business.name,
    desk_name: business.deskName,
    owner_display_name: OWNER,
    brand: { ...business.brand },
    charter: [cards.hours.en, cards.contact.en, cards.policy.en],
    starters: [],
    agent_card: [],
  },
  es: {
    business_name: business.name,
    desk_name: business.deskName,
    owner_display_name: OWNER,
    brand: { ...business.brand },
    charter: [cards.hours.es, cards.contact.es, cards.policy.es],
    starters: [],
    agent_card: [],
  },
} satisfies Bilingual<PublicDesk>;

const verifyStarted = {
  en: {
    message: "If that contact is on record, a code is on its way. Enter it below to confirm it's you.",
    inbox: [{ entry_id: 'inbox-code-raj', to: people.raj.maskedContact, preview: 'New verification code' }],
  },
  es: {
    message: 'Si ese contacto está registrado, te enviamos un código. Escríbelo abajo para confirmar que eres tú.',
    inbox: [{ entry_id: 'inbox-code-raj', to: people.raj.maskedContact, preview: 'Nuevo código de verificación' }],
  },
} satisfies Bilingual<VerifyStarted>;

const checkpointHead = placeholderHex('chen-ledger:50', 32);

const notices = [
  { entry_id: 'inbox-code-raj', to: people.raj.maskedContact, preview: 'New verification code' },
  { entry_id: 'inbox-hold-consultation', to: 'owner', preview: 'A request needs your answer' },
  { entry_id: 'inbox-checkpoint-chen', to: 'owner', preview: 'Ledger checkpoint' },
] satisfies InboxNotice[];

const entries = [
  {
    entry_id: 'inbox-code-raj',
    to: people.raj.maskedContact,
    kind: 'verification_code',
    body: "Your Chen & Co. CPA code is 482913. It expires in ten minutes. If you didn't ask for it, ignore this message.",
    created_at: '2026-10-30T21:14:02.551870Z',
    decision_id: null,
    title: null,
  },
  {
    // The held consultation's alert: the decision's reason_plain and its id, as the kernel pairs
    // them, written when the hold was made, 24 hours before it expires, and titled with the
    // alert's preview line, as the owner reads it.
    entry_id: 'inbox-hold-consultation',
    to: 'owner',
    kind: 'alert',
    body: heldConsultation.reason_plain,
    created_at: '2026-10-30T18:12:09.774120Z',
    decision_id: heldConsultation.decision_id,
    title: 'A request needs your answer',
  },
  {
    entry_id: 'inbox-checkpoint-chen',
    to: 'owner',
    kind: 'head_checkpoint',
    body: JSON.stringify({
      desk_id: DESK_ID,
      seq: 50,
      head: checkpointHead,
      signature: placeholderHex('signature:chen-ledger:50', 64),
      key_id: placeholderHex('chen-ledger-key-id', 8),
    }),
    created_at: '2026-10-30T16:30:00.004211Z',
    decision_id: null,
    title: null,
  },
] satisfies DemoInboxEntry[];

/** Linda's Demo inbox: Raj's code, the held consultation's alert and a ledger checkpoint, newest first. */
const demoInbox = {
  notices,
  entries,
  ownerTimes: {
    'inbox-code-raj': '2:14 pm',
    'inbox-hold-consultation': '11:12 am',
    'inbox-checkpoint-chen': '9:30 am',
  },
} satisfies DemoInboxFixture;

export const chen = {
  business,
  people,
  blocks,
  publicDesk,
  sessions,
  conversations,
  ruleCards,
  ruleWords,
  connectors,
  picker,
  paymentsReview,
  paymentsOffer,
  calendarOffer,
  heldConsultation,
  verifyStarted,
  demoInbox,
};
