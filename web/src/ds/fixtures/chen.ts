// Chen & Co. CPA: Linda Chen's practice, the second business in the switcher, and the board where
// Raj Patel confirms it's him with a code before Claude releases his tax return.

import type {
  CardBlock,
  DecisionState,
  DemoInboxEntry,
  EvMessage,
  InboxNotice,
  PublicDesk,
  SessionState,
  StatusEvent,
  VerifyStarted,
} from '../../api/contracts';
import type { Bilingual, ConversationFixture, DemoInboxFixture, ProseBlock } from './index';
import { executedLine } from './receipts';
import { cardBlock, placeholderHex, proseBlock } from './rivera';

const OWNER = 'Linda Chen';
const DESK_ID = 'desk-chen-main';

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
} satisfies Record<string, SessionState>;

const plain = {
  reply_checked: "Reply checked against Linda Chen's rules",
} as const satisfies Partial<Record<DecisionState | 'reply_checked', string>>;

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
    agent_card: [],
  },
  es: {
    business_name: business.name,
    desk_name: business.deskName,
    owner_display_name: OWNER,
    brand: { ...business.brand },
    charter: [cards.hours.es, cards.contact.es, cards.policy.es],
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
  { entry_id: 'inbox-hold-chen', to: 'owner', preview: 'A request needs your answer' },
  { entry_id: 'inbox-checkpoint-chen', to: 'owner', preview: 'Ledger checkpoint' },
] satisfies InboxNotice[];

const entries = [
  {
    entry_id: 'inbox-code-raj',
    to: people.raj.maskedContact,
    kind: 'verification_code',
    body: "Your Chen & Co. CPA code is 482913. It expires in ten minutes. If you didn't ask for it, ignore this message.",
    created_at: '2026-10-30T21:14:02.551870Z',
  },
  {
    entry_id: 'inbox-hold-chen',
    to: 'owner',
    kind: 'alert',
    body: 'A request needs your answer. A visitor not on record asked for a tax return quote at 20% off, $360.00 instead of $450.00.',
    created_at: '2026-10-30T18:02:41.203114Z',
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
  },
] satisfies DemoInboxEntry[];

/** Linda's Demo inbox: Raj's code, a hold alert and a ledger checkpoint, newest first. */
const demoInbox = {
  notices,
  entries,
  ownerTimes: {
    'inbox-code-raj': '2:14 pm',
    'inbox-hold-chen': '11:02 am',
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
  verifyStarted,
  demoInbox,
};
