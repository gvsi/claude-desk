/**
 * The vision pages the "Run 2 · vision" boards draw (N-R2-Vision-*), composed from the components
 * and tokens for the `Boards/Vision, *` stories only, as `parts.tsx` composes the other pages. The web
 * app (plan 04, Task 17) builds the same pages from the same components: the vision bar over each,
 * every fact in a `FactCard`, the phones in `PhoneFrame`, and Luis's access in `AccessPanel`. The
 * data here is the boards' own sample data: Rivera Plumbing's team, Dana's visit, the phone apps,
 * and Marcus Bell on Meridian Bay Permits' public page, a fictional city permits office.
 */
import type { ReactNode } from 'react';
import { fn } from 'storybook/test';

import type { DecisionState, PublicDesk } from '../../api/contracts.ts';
import { AccessPanel } from '../components/AccessPanel/AccessPanel.tsx';
import { AppShell } from '../components/AppShell/AppShell.tsx';
import { ApprovalCard } from '../components/ApprovalCard/ApprovalCard.tsx';
import { Button } from '../components/Button/Button.tsx';
import { ClaudeMessage } from '../components/ClaudeMessage/ClaudeMessage.tsx';
import { Composer } from '../components/Composer/Composer.tsx';
import { ConceptFooter } from '../components/ConceptFooter/ConceptFooter.tsx';
import { FactCard, type FactCardProps } from '../components/FactCard/FactCard.tsx';
import { MarginReceipt } from '../components/MarginReceipt/MarginReceipt.tsx';
import type { ReceiptSource } from '../components/MarginReceipt/receiptTone.ts';
import type { CopyLanguage } from '../components/Notice/errorCopy.ts';
import { PageHeader } from '../components/PageHeader/PageHeader.tsx';
import { PhoneFrame, PhoneTabBar } from '../components/PhoneFrame/PhoneFrame.tsx';
import { Pill } from '../components/Pill/Pill.tsx';
import { PublicShell } from '../components/PublicShell/PublicShell.tsx';
import { Sidebar, initialsOf, type NavCount, type NavKey } from '../components/Sidebar/Sidebar.tsx';
import { StatusDot, type StatusTone } from '../components/StatusDot/StatusDot.tsx';
import { SuggestionChips } from '../components/SuggestionChips/SuggestionChips.tsx';
import { SystemLine } from '../components/SystemLine/SystemLine.tsx';
import { Transcript } from '../components/Transcript/Transcript.tsx';
import { TranscriptRow } from '../components/TranscriptRow/TranscriptRow.tsx';
import { VisionBar } from '../components/VisionBar/VisionBar.tsx';
import { VisitorMessage } from '../components/VisitorMessage/VisitorMessage.tsx';
import { cardBlock, meridian, proseBlock, rivera } from '../fixtures/index.ts';
import { MAIN_LINE, OWNER_HREFS, brandOf } from './parts.tsx';

import './vision.css';

/** Where every vision page's "Back to Vision" goes in the stories: the Vision article. */
export const VISION_BACK_HREF = '#vision';

/** The receipts' sources, by what each reports: a checked reply, or an action in its state. */
const CHECKED: ReceiptSource = { kind: 'reply', handoff: false };
const decided = (state: DecisionState): ReceiptSource => ({ kind: 'decision', state });

// ---------------------------------------------------------------------------------------------
// The owner app under the vision bar

interface VisionOwnerFrameProps {
  business: string;
  owner: { name: string; status: string };
  desks: { id: string; name: string }[];
  currentDeskId: string;
  current: NavKey;
  peopleLabel: string;
  counts: { conversations?: NavCount; safety?: NavCount };
  answeringDescription: string;
  children: ReactNode;
}

/** The owner app on a vision Desk: the vision bar as the banner, the one sidebar, and a page that pads itself. */
function VisionOwnerFrame({ business, owner, desks, currentDeskId, current, peopleLabel, counts, answeringDescription, children }: VisionOwnerFrameProps) {
  return (
    <AppShell
      business={business}
      fill
      banner={<VisionBar backHref={VISION_BACK_HREF} />}
      sidebar={
        <Sidebar
          business={business}
          onSwitchBusiness={fn()}
          desks={desks}
          currentDeskId={currentDeskId}
          onSwitchDesk={fn()}
          current={current}
          hrefs={{ ...OWNER_HREFS, connectors: '#connectors' }}
          peopleLabel={peopleLabel}
          counts={counts}
          answering
          onAnsweringChange={fn()}
          answeringDescription={answeringDescription}
          owner={owner}
        />
      }
    >
      {children}
    </AppShell>
  );
}

/** Claude's words in a conversation, in serif, as a checked reply's prose block. */
function Reply({ text, language = 'en' }: { text: string; language?: CopyLanguage }) {
  return <ClaudeMessage blocks={[proseBlock(text)]} language={language} ownerName={rivera.business.ownerName} />;
}

// ---------------------------------------------------------------------------------------------
// The team Desk (N-R2-Vision-TeamDesk): Rivera Plumbing's team asking its own Desk.

export const TEAM = { id: 'desk-rivera-team', name: 'Team' };

/** The team, in the board's order: who, their role and today's count. "Everyone" first. */
export const TEAMMATES = [
  { name: 'Luis Ortega', line: 'Plumber, 5 today' },
  { name: 'Ben Carter', line: 'Plumber, 4 today' },
  { name: 'Grace Lee', line: 'Office manager, 3 today' },
] as const;

/** What Luis can and can't open, in the board's order. */
export const LUIS_ACCESS = {
  canOpen: ['Job cards', 'Customer history', 'Warranties', 'Photos'],
  cantOpen: ['Invoices', 'Payroll'],
} as const;

/**
 * Claude's words to Luis, in order. Owner's copy ruling, 2026-10-30, for invariant 2: the board's
 * "on today’s job card" and "your own logged hours for last week" put dates in Claude's words; the
 * visit's date and the week's dates are now in a job card and an hours card, and the words stay as
 * helpful.
 */
export const TEAM_REPLIES = [
  'Here’s Ana’s history. The gate code is on her job card.',
  'Here it is.',
  'I can’t share pay. Payroll is open to Maria and Grace only. Here are your own logged hours.',
] as const;

/** The day's line under the page. */
export const TEAM_TODAY = 'Today: 12 team conversations, 9 answered from job records, 3 documents shared, 1 payroll request declined.';

/** A teammate's turn and Claude's answer with its card and receipt, as the board draws them. */
function TeamTurn({ asked, reply, facts = [], receipts }: { asked: string; reply: string; facts?: readonly FactCardProps[]; receipts: readonly { source: ReceiptSource; plain: string }[] }) {
  return (
    <>
      <TranscriptRow>
        <VisitorMessage text={asked} />
      </TranscriptRow>
      <TranscriptRow margin={receipts.map((receipt) => <MarginReceipt key={receipt.plain} source={receipt.source} plain={receipt.plain} ledgerSeq={0} />)}>
        <div className="board-vision-reply">
          <Reply text={reply} />
          {facts.map((fact) => (
            <FactCard key={fact.label} {...fact} />
          ))}
        </div>
      </TranscriptRow>
    </>
  );
}

/** Conversations on Rivera Plumbing's team Desk, Luis's open, with what he can open beside it. */
export function TeamDeskConversations() {
  return (
    <VisionOwnerFrame
      business={rivera.business.name}
      owner={{ name: rivera.business.ownerName, status: 'Available for chats' }}
      desks={[MAIN_LINE, TEAM]}
      currentDeskId={TEAM.id}
      current="conversations"
      peopleLabel="Teammates"
      counts={{ conversations: { n: 12, label: '12 team conversations today' }, safety: { n: 1, label: '1 attempt stopped today' } }}
      answeringDescription="Claude answers your team under your rules"
    >
      <div className="board-filled-page board-vision-page board-vision-team">
        <div>
          <PageHeader
            title="Conversations"
            actions={
              <Button variant="secondary" onClick={fn()}>
                Add a teammate
              </Button>
            }
          />
          <p className="board-quiet cd-type-meta board-vision-team__lead">
            Your team asks this Desk for job context, customer history and documents. Each person sees only what their access allows.
          </p>
        </div>
        <div className="board-vision-team__columns">
          <nav aria-label="Teammates" className="board-vision-team__people">
            <a href="#everyone" className="board-vision-team__person">
              <span>
                <span className="cd-type-control board-vision-team__name">Everyone</span>
                <span className="board-quiet cd-type-caption board-vision-team__line">12 conversations today</span>
              </span>
            </a>
            {TEAMMATES.map((person, index) => (
              <a
                key={person.name}
                href={`#teammate-${index}`}
                className="board-vision-team__person"
                {...(index === 0 ? { 'aria-current': 'page' as const } : {})}
              >
                <span className="board-vision-team__avatar cd-type-count" aria-hidden="true">
                  {initialsOf(person.name)}
                </span>
                <span>
                  <span className="cd-type-control board-vision-team__name" data-copy="user">
                    {person.name}
                  </span>
                  <span className="board-quiet cd-type-caption board-vision-team__line">{person.line}</span>
                </span>
              </a>
            ))}
          </nav>
          <section className="board-vision-team__chat" aria-labelledby="board-vision-luis">
            <div className="board-vision-team__head">
              <h2 id="board-vision-luis" className="cd-type-section" data-copy="user">
                Luis Ortega
              </h2>
              <Pill>Teammate</Pill>
              <span className="board-quiet cd-type-meta">In Slack, from the van, 9:42 am</span>
              <span className="board-vision-team__actions">
                <Button variant="secondary" onClick={fn()}>
                  Whisper
                </Button>
                <Button variant="secondary" onClick={fn()}>
                  Take over
                </Button>
              </span>
            </div>
            <Transcript label="Conversation with Luis Ortega">
              <TeamTurn
                asked="Heading to Ana Ruiz in Eastshore. What’s the history there?"
                reply={TEAM_REPLIES[0]}
                facts={[
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
                ]}
                receipts={[
                  {
                    source: CHECKED,
                    // A receipt states no time: the visit's time is on the Job card.
                    plain: 'From job records and her customer file. Luis is assigned to her visit, so the address and gate code are open to him.',
                  },
                ]}
              />
              <TeamTurn
                asked="Send me the warranty in case it’s the tank."
                reply={TEAM_REPLIES[1]}
                facts={[{ label: 'Document, only for Luis', icon: 'document', title: 'Water heater warranty, Ana Ruiz' }]}
                // "Warranty" is a promise word to the kernel's prose check; the card names the document.
                receipts={[{ source: decided('executed'), plain: 'Document released to the assigned plumber. Logged on Ana’s file.' }]}
              />
              <TeamTurn
                asked="Also, what did Ben make on the Harbor Street job last week?"
                reply={TEAM_REPLIES[2]}
                facts={[{ label: 'Your logged hours', icon: 'clock', title: 'Monday, October 19 to Friday, October 23', lines: ['38.5 hours over 5 days'] }]}
                receipts={[
                  { source: decided('refused'), plain: 'Declined by team access: payroll is owner and office manager only. No pay was shared.' },
                  { source: CHECKED, plain: 'Luis’s own hours, from his time records.' },
                ]}
              />
            </Transcript>
          </section>
          <div className="board-vision-team__access">
            <AccessPanel name="Luis" canOpen={LUIS_ACCESS.canOpen} cantOpen={LUIS_ACCESS.cantOpen} onEditAccess={fn()} />
          </div>
        </div>
        <div className="board-vision-team__foot">
          <p className="board-quiet cd-type-caption">{TEAM_TODAY}</p>
          <ConceptFooter />
        </div>
      </div>
    </VisionOwnerFrame>
  );
}

// ---------------------------------------------------------------------------------------------
// The Claude account (N-R2-Vision-ClaudeAccount): Dana, back on Rivera's public page, signed in.

/** The about column as the board draws it: hours, the service area and the phone. */
const CLAUDE_ACCOUNT_ABOUT = [rivera.blocks.hours.en, rivera.blocks.policy.en, rivera.blocks.contact.en];

/**
 * Dana's visit. Owner decision, 2026-10-30: on a vision Desk a Claude account counts as verified when
 * its verified email matches the contact on record, with her consent asked on each visit; the
 * receipts say both. Owner's copy ruling, 2026-10-30: her past visit is a booking card, not a
 * sentence ("Last time we booked your drain clearing."), and Claude only asks how it went.
 */
export const CLAUDE_ACCOUNT_TURNS = {
  ask: 'Your Claude account has a verified email. If it matches the contact Rivera Plumbing has on record for you, I can confirm it’s you without a code. Use it for this visit?',
  yes: 'Yes, use it',
  matched: 'Welcome back, Dana. How did the drain clearing go?',
  matchedReceipt: 'Matched to Dana Whitfield: the Claude account’s verified email is her contact on record, and she agreed for this visit',
  invoice: 'All fixed, thanks. Can you send me the invoice?',
  sent: 'Glad to hear it. Here’s your invoice. You let me use your Claude account for this visit, so no code was needed.',
  releasedReceipt: 'Released to Dana Whitfield, matched by her Claude account with her consent for this visit',
  checked: 'Reply checked against Maria Rivera’s rules',
} as const;

/**
 * Dana's last visit, the drain clearing, as the kernel renders a booking card (`render/en.py`): the
 * day, then "{start} to {end}" and "With {owner}", with no booking number.
 */
export const DANA_LAST_VISIT = cardBlock('booking_confirmed', {
  fact_id: 'booking:B-61',
  title: 'Tuesday, October 20',
  lines: ['10:00 am to 12:00 pm', 'With Maria Rivera'],
});

/** The visitor's booking on the phone, as the kernel renders a booking card. */
export const PHONE_BOOKING = cardBlock('booking_confirmed', {
  fact_id: 'booking:B-77',
  title: 'Tuesday, November 3',
  lines: ['2:00 pm to 4:00 pm', 'With Maria Rivera'],
});

/** Rivera Plumbing's public page, under the vision bar, for a returning visitor signed in with a Claude account. */
export function ClaudeAccountChat() {
  const t = CLAUDE_ACCOUNT_TURNS;
  const owner = rivera.business.ownerName;
  return (
    <PublicShell
      banner={<VisionBar backHref={VISION_BACK_HREF} />}
      brand={brandOf(rivera.publicDesk.en)}
      ownerName={owner}
      language="en"
      onAskForOwner={fn()}
      inertAsk
      about={CLAUDE_ACCOUNT_ABOUT}
      composer={<Composer variant="visitor" label="Message Rivera Plumbing" placeholder="Message Rivera Plumbing" maxLength={2000} onSend={fn()} inertSend />}
    >
      <Transcript label="Conversation with Rivera Plumbing">
        <SystemLine text="Signed in with your Claude account." />
        <TranscriptRow margin={<MarginReceipt source={CHECKED} plain={t.checked} ledgerSeq={40} />}>
          <ClaudeMessage blocks={[proseBlock(t.ask)]} language="en" ownerName={owner} />
        </TranscriptRow>
        <TranscriptRow>
          <VisitorMessage text={t.yes} />
        </TranscriptRow>
        <TranscriptRow
          margin={[
            <MarginReceipt key="matched" source={decided('executed')} plain={t.matchedReceipt} ledgerSeq={41} />,
            <MarginReceipt key="checked" source={CHECKED} plain={t.checked} ledgerSeq={42} />,
          ]}
        >
          <ClaudeMessage blocks={[proseBlock(t.matched), DANA_LAST_VISIT]} language="en" ownerName={owner} />
        </TranscriptRow>
        <TranscriptRow>
          <VisitorMessage text={t.invoice} />
        </TranscriptRow>
        <TranscriptRow
          margin={[
            <MarginReceipt key="checked" source={CHECKED} plain={t.checked} ledgerSeq={43} />,
            <MarginReceipt key="released" source={decided('executed')} plain={t.releasedReceipt} ledgerSeq={44} />,
          ]}
        >
          {/* A vision page makes no requests: the invoice card carries no link, and its Download goes nowhere. */}
          <ClaudeMessage
            blocks={[proseBlock(t.sent), cardBlock('document_link', { fact_id: 'document_link:DL-501', title: 'Invoice, drain clearing' })]}
            language="en"
            ownerName={owner}
            inertDownload
          />
        </TranscriptRow>
      </Transcript>
    </PublicShell>
  );
}

// ---------------------------------------------------------------------------------------------
// The phone (N-R2-Vision-Phone): the owner's Today and a visitor's chat, as phone apps.

export const PHONE_HREFS = { today: '#today', chats: '#chats', rules: '#rules', safety: '#safety', more: '#more' } as const;

/** Claude's words next to the visitor's booking card. */
export const PHONE_REPLY = 'You’re all set. Here’s your visit.';

/** Who is talking to the Desk, on the owner's phone: a person and another person's agent. */
const PHONE_LIVE: readonly { name: string; kind: string; tone: StatusTone }[] = [
  { name: 'Lucía Herrera', kind: 'Visitor', tone: 'handled' },
  { name: 'Alex Kim’s assistant', kind: 'Agent', tone: 'info' },
];

/** Today on the owner's phone: the greeting, the held quote and Live now, over the tab bar. */
function OwnerPhone() {
  return (
    <PhoneFrame caption="Today, for the owner">
      <div className="board-vision-phone__screen">
        <div>
          <p className="board-vision-phone__business board-quiet cd-type-caption">{rivera.business.name}</p>
          <h2 className="cd-type-greeting board-vision-phone__greeting">Good morning, Maria</h2>
        </div>
        {/* A vision page sends nothing: the answers keep their look and do nothing. */}
        <ApprovalCard
          decision={rivera.decisions.held}
          heldBy={rivera.ruleCards['rv-quote'].reason}
          waiting="Web chat, 2 min ago"
          onAnswer={fn()}
          inertAnswers
        />
        <section aria-labelledby="board-vision-phone-live">
          <h3 id="board-vision-phone-live" className="cd-type-control board-vision-phone__live-title">
            Live now
          </h3>
          <ul role="list" className="board-vision-phone__live">
            {PHONE_LIVE.map((row) => (
              <li key={row.name} className="board-vision-phone__live-row">
                <StatusDot tone={row.tone} />
                <span className="cd-type-control" data-copy="user">
                  {row.name}
                </span>
                <span className="board-quiet cd-type-caption board-vision-phone__kind">{row.kind}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
      <PhoneTabBar current="today" hrefs={PHONE_HREFS} />
    </PhoneFrame>
  );
}

/** A visitor's chat on a phone: the business's header, the booking and its card, and the composer. */
function VisitorPhone() {
  const brand = brandOf(rivera.publicDesk.en);
  return (
    <PhoneFrame caption="The public chat, for a visitor">
      <div className="board-vision-phone__brand" style={{ background: brand.field }}>
        <span className="board-vision-phone__monogram cd-type-control" aria-hidden="true">
          {brand.monogram}
        </span>
        <span>
          <span className="cd-type-control board-vision-phone__brand-name" data-copy="user">
            {brand.name}
          </span>
          <span className="board-quiet cd-type-caption board-vision-phone__brand-line">Claude, an AI, answers for Maria Rivera</span>
        </span>
      </div>
      <div className="board-vision-phone__chat">
        <Transcript label="Conversation with Rivera Plumbing">
          <TranscriptRow>
            <VisitorMessage text="Can someone come Tuesday afternoon?" />
          </TranscriptRow>
          <TranscriptRow margin={<MarginReceipt source={decided('executed')} plain="Booked on Maria Rivera’s calendar" ledgerSeq={0} />}>
            {/* Owner's copy ruling, 2026-10-30: the booking is the kernel's booking card, and Claude's
                words promise nothing it doesn't back (the board's "Maria will text you when she’s on her way."). */}
            <ClaudeMessage blocks={[proseBlock(PHONE_REPLY), PHONE_BOOKING]} language="en" ownerName={rivera.business.ownerName} />
          </TranscriptRow>
        </Transcript>
      </div>
      <div className="board-vision-phone__composer">
        <Composer variant="visitor" label="Message Rivera Plumbing" placeholder="Message Rivera Plumbing" maxLength={2000} onSend={fn()} inertSend />
        <p className="board-quiet cd-type-caption board-vision-phone__disclosure">This chat is with Claude, an AI.</p>
      </div>
    </PhoneFrame>
  );
}

/** Claude Desk on a phone: the two apps side by side under the vision bar. */
export function PhoneApps() {
  return (
    <div className="board-vision-phone-page">
      <VisionBar backHref={VISION_BACK_HREF} />
      <main className="board-vision-phone">
        <div className="board-vision-phone__head">
          <h1 className="cd-type-page-title">Claude Desk on a phone</h1>
          <p className="board-quiet cd-type-meta">The owner’s Today and a visitor’s chat, as phone apps.</p>
        </div>
        <div className="board-vision-phone__phones">
          <OwnerPhone />
          <VisitorPhone />
        </div>
        <ConceptFooter />
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// The city office (N-R2-Vision-CityOffice-Resident): a resident on a city permits office's public
// page. Meridian Bay Permits is fictional; no vision page names a real city office.

/** Who answers for the city when Claude hands over, as the page names them ("Ask for Permit Center staff"). */
const CITY_STAFF = meridian.business.ownerName;

/**
 * The city's public Desk, the fixtures' `meridian.publicDesk.en`: its name and the Permit Center,
 * its colors, its charter and its open status, as the board draws them (`meridian.ts` names the
 * charter's two vision lines).
 */
export const CITY_DESK: PublicDesk = meridian.publicDesk.en;

/**
 * Marcus Bell's visit, word for word as the board writes it: his messages, Claude's words, the
 * line when he's verified and the receipts. Claude's words lead into the cards and state no
 * status, fee, date or time (invariant 2); the garage question is a plan checker's decision, so it
 * is held for staff.
 *
 * By the owner's vision-copy ruling (follow the product's rules, keep the warmth), the garage
 * reply says who it went to and where the answer comes, and the held receipt is the kernel's
 * visitor line for a hold, "Waiting for {owner} to approve"; the hold's reason shows only on owner
 * screens. The system line and the other receipts are a vision of what the kernel's lines could
 * say, beyond what they say today: the app writes "Verified with a code", and the kernel's visitor
 * lines are "Reply checked against {owner}'s rules", "Verification started" and "Times read from
 * {owner}'s calendar". No tool reads a permit file ("Read from your own permit file").
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

/**
 * The prompt before a code is sent, under the `verify_prompt` template. Its words are a vision of
 * what the template could carry: the kernel writes "I'll send a code to the contact on record.",
 * and here the contact on record is the email on the application.
 */
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
 * The open inspection times under the `booking_options` template, in its contract: a `slots:` fact,
 * and each time as a line and as an option whose id is the slot id of its start. Its title
 * ("Rough-in inspection"), its permit line and its time ranges are a vision of what the template
 * could carry: the kernel writes "Times that are open" and one start time per slot.
 */
export const CITY_INSPECTION_TIMES = cardBlock('booking_options', {
  fact_id: 'slots:B-2026-0412',
  title: 'Rough-in inspection',
  lines: ['Permit B-2026-0412, once the fee is paid', ...INSPECTION_SLOTS.map((slot) => slot.label)],
  options: INSPECTION_SLOTS,
});

/** What a resident might ask next, under the conversation. */
export const CITY_SUGGESTIONS = ['Book an inspection', 'Pay the fee', 'Talk to staff'] as const;

/** Claude's words in the city's chat, as a checked reply's prose block. */
function CityReply({ text }: { text: string }) {
  return <ClaudeMessage blocks={[proseBlock(text)]} language="en" ownerName={CITY_STAFF} />;
}

/** The two receipts under each of Claude's answers: the reply's check, then what ran or waits. */
function cityReceipts(seq: number, source: ReceiptSource, plain: string) {
  return [
    <MarginReceipt key="checked" source={CHECKED} plain={CITY_TURNS.checked} ledgerSeq={seq} />,
    <MarginReceipt key="action" source={source} plain={plain} ledgerSeq={seq + 1} />,
  ];
}

/** Meridian Bay Permits' public page, under the vision bar, for a resident asking about his permit. */
export function CityOfficeChat() {
  const t = CITY_TURNS;
  return (
    <PublicShell
      banner={<VisionBar backHref={VISION_BACK_HREF} />}
      brand={brandOf(CITY_DESK)}
      ownerName={CITY_STAFF}
      language="en"
      openStatus={CITY_DESK.open_status}
      onAskForOwner={fn()}
      inertAsk
      about={CITY_DESK.charter}
      composer={
        <Composer variant="visitor" label="Message Meridian Bay Permits" placeholder="Message Meridian Bay Permits" maxLength={2000} onSend={fn()} inertSend />
      }
    >
      <Transcript label="Conversation with Meridian Bay Permits">
        <TranscriptRow>
          <VisitorMessage text={t.status} />
        </TranscriptRow>
        <TranscriptRow margin={cityReceipts(51, decided('executed'), t.codeSent)}>
          <ClaudeMessage blocks={[proseBlock(t.verifyFirst), CITY_VERIFY_PROMPT]} language="en" ownerName={CITY_STAFF} />
        </TranscriptRow>
        <SystemLine text={t.verified} />
        <TranscriptRow margin={cityReceipts(53, decided('executed'), t.readFile)}>
          {/* One answer, drawn as the board draws it: Claude's words lead into each fact card. The
              kernel delivers a reply as its prose, then its cards, so prose, card, prose, card in
              one reply is the board's vision. */}
          <div className="board-vision-city__answer">
            <CityReply text={t.stands} />
            <FactCard {...CITY_PERMIT.status} />
            <CityReply text={t.next} />
            <FactCard {...CITY_PERMIT.nextSteps} />
          </div>
        </TranscriptRow>
        <TranscriptRow>
          <VisitorMessage text={t.inspector} />
        </TranscriptRow>
        <TranscriptRow margin={cityReceipts(55, decided('executed'), t.readCalendar)}>
          <ClaudeMessage blocks={[proseBlock(t.times), CITY_INSPECTION_TIMES]} language="en" ownerName={CITY_STAFF} />
        </TranscriptRow>
        <TranscriptRow>
          <VisitorMessage text={t.garage} />
        </TranscriptRow>
        <TranscriptRow margin={cityReceipts(57, decided('held'), t.waitingForStaff)}>
          <CityReply text={t.staffDecides} />
        </TranscriptRow>
      </Transcript>
      {/* A vision page makes no requests: a suggestion goes nowhere, and its first pick says so. */}
      <div className="board-vision-city__suggestions">
        <SuggestionChips label="Try asking" suggestions={CITY_SUGGESTIONS} onPick={fn()} inertSuggestions />
      </div>
    </PublicShell>
  );
}
