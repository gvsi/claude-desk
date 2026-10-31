/**
 * The vision pages the "Run 2 · vision" boards draw (N-R2-Vision-*), composed from the components
 * and tokens for the `Boards/Vision, *` stories only, as `parts.tsx` composes the other pages. The web
 * app (plan 04, Task 17) builds the same pages from the same components: the vision bar over each,
 * every fact in a `FactCard`, the phones in `PhoneFrame`, and Luis's access in `AccessPanel`. The
 * data here is the boards' own sample data: a fictional city office and Rivera Plumbing's team.
 */
import type { ReactNode } from 'react';
import { fn } from 'storybook/test';

import type { DecisionState } from '../../api/contracts.ts';
import { AccessPanel } from '../components/AccessPanel/AccessPanel.tsx';
import { AppShell } from '../components/AppShell/AppShell.tsx';
import { ApprovalCard } from '../components/ApprovalCard/ApprovalCard.tsx';
import { Button } from '../components/Button/Button.tsx';
import { Card } from '../components/Card/Card.tsx';
import { ClaudeMessage } from '../components/ClaudeMessage/ClaudeMessage.tsx';
import { Composer } from '../components/Composer/Composer.tsx';
import { ConceptFooter } from '../components/ConceptFooter/ConceptFooter.tsx';
import { FactCard, type FactCardProps } from '../components/FactCard/FactCard.tsx';
import { Greeting } from '../components/Greeting/Greeting.tsx';
import { MarginReceipt } from '../components/MarginReceipt/MarginReceipt.tsx';
import type { ReceiptSource } from '../components/MarginReceipt/receiptTone.ts';
import type { CopyLanguage } from '../components/Notice/errorCopy.ts';
import { PageHeader } from '../components/PageHeader/PageHeader.tsx';
import { PhoneFrame, PhoneTabBar } from '../components/PhoneFrame/PhoneFrame.tsx';
import { Pill } from '../components/Pill/Pill.tsx';
import { PublicShell } from '../components/PublicShell/PublicShell.tsx';
import { SectionHeader } from '../components/SectionHeader/SectionHeader.tsx';
import { Sidebar, initialsOf, type NavCount, type NavKey } from '../components/Sidebar/Sidebar.tsx';
import { StatusDot, type StatusTone } from '../components/StatusDot/StatusDot.tsx';
import { SystemLine } from '../components/SystemLine/SystemLine.tsx';
import { TextLink } from '../components/TextLink/TextLink.tsx';
import { Transcript } from '../components/Transcript/Transcript.tsx';
import { TranscriptRow } from '../components/TranscriptRow/TranscriptRow.tsx';
import { VisionBar } from '../components/VisionBar/VisionBar.tsx';
import { VisitorMessage } from '../components/VisitorMessage/VisitorMessage.tsx';
import { cardBlock, proseBlock, rivera } from '../fixtures/index.ts';
import { Icon } from '../icons/index.tsx';
import { MAIN_LINE, OWNER_HREFS, brandOf } from './parts.tsx';

import './vision.css';

/** Where every vision page's "Back to your Desk" goes in the stories: the owner's Today. */
export const VISION_BACK_HREF = '#today';

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
// The city office (N-R2-Vision-CityOffice): Meridian Bay Permits, a fictional city permits office.

export interface CityLiveRow {
  name: string;
  level: 'Verified' | 'Public';
  about: string;
  reply: string;
  language: CopyLanguage;
  fact?: FactCardProps;
  receipt: { source: ReceiptSource; plain: string };
  /** The one thing the supervisor can do from the row. */
  action?: string;
}

/** Live now, in the board's words: who, their level, what about, Claude's words, the fact and the receipt. */
export const CITY_LIVE: readonly CityLiveRow[] = [
  {
    name: 'Marcus Bell',
    level: 'Verified',
    about: 'Permit status, 3 min',
    reply: 'Your kitchen remodel passed plan check. Here’s where it stands.',
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
const CITY_ALWAYS_ON = [
  {
    title: 'No legal or financial determinations without a qualified person',
    detail: 'Eligibility, exemptions, fee waivers and code readings go to staff.',
  },
  { title: 'Files only to the applicant', detail: 'Codes go to the contact on the application, never one typed into chat.' },
  { title: 'No promised outcomes', detail: 'Status and published dates only, in cards, never an approval or an outcome.' },
] as const;

const CITY_TODAY = [
  '214 questions answered in 6 languages',
  '38 applicants verified for their own files',
  '7 handed to staff',
  '0 determinations made without a person',
] as const;

/** One live conversation on the city's Today: a row, not a card, so its fact card never sits in a card. */
function CityLiveItem({ row }: { row: CityLiveRow }) {
  return (
    <li className="board-vision-live__item">
      <div className="board-vision-live__head">
        <span className="cd-type-control" data-copy="user">
          {row.name}
        </span>
        <Pill>{row.level}</Pill>
        <span className="board-quiet cd-type-meta">{row.about}</span>
      </div>
      <Reply text={row.reply} language={row.language} />
      {row.fact ? <FactCard {...row.fact} /> : null}
      <MarginReceipt source={row.receipt.source} plain={row.receipt.plain} ledgerSeq={0} />
      {row.action ? (
        <div className="board-vision-live__action">
          <Button variant="secondary" onClick={fn()}>
            {row.action}
          </Button>
        </div>
      ) : null}
    </li>
  );
}

/** Today on the city's Desk, for its Permit Center supervisor. */
export function CityOfficeToday() {
  return (
    <VisionOwnerFrame
      business="Meridian Bay Permits"
      owner={{ name: 'Nadia Price', status: 'Permit Center supervisor' }}
      desks={[{ id: 'desk-meridian-permits', name: 'Permit Center' }]}
      currentDeskId="desk-meridian-permits"
      current="today"
      peopleLabel="Residents"
      counts={{ conversations: { n: 9, label: '9 live conversations' }, safety: { n: 4, label: '4 attempts stopped today' } }}
      answeringDescription="Claude answers under the City’s rules"
    >
      <div className="board-filled-page board-vision-page">
        <Greeting
          text="Good morning, Nadia"
          presence={{ line: 'Nine residents are talking to the Desk right now.', people: [] }}
          link={{ label: 'desk.example/meridian-bay-permits', onCopy: fn() }}
        />
        <div className="board-vision-city">
          <section className="board-vision-city__live" aria-labelledby="board-vision-live-now">
            <SectionHeader
              id="board-vision-live-now"
              title="Live now"
              count={{ n: 9, label: '9 live' }}
              caption={<TextLink href="#conversations">See all in Conversations</TextLink>}
            />
            <ul role="list" className="board-vision-live">
              {CITY_LIVE.map((row) => (
                <CityLiveItem key={row.name} row={row} />
              ))}
            </ul>
          </section>
          <div className="board-vision-city__side">
            <Card as="section" label="Always on" padding={16}>
              <h2 className="cd-type-section board-vision-city__title">Always on</h2>
              <p className="board-quiet cd-type-caption board-vision-city__caption">Can’t be switched off</p>
              <ul role="list" className="board-vision-always">
                {CITY_ALWAYS_ON.map((line) => (
                  <li key={line.title} className="board-vision-always__item">
                    <Icon name="lock" size={14} className="board-vision-always__lock" />
                    <span>
                      <span className="cd-type-control board-vision-always__title">{line.title}</span>
                      <span className="board-quiet cd-type-meta board-vision-always__detail">{line.detail}</span>
                    </span>
                  </li>
                ))}
              </ul>
              <p className="board-quiet cd-type-caption board-vision-always__also">
                Also always on: says it’s an AI, and logs every conversation for City records.
              </p>
            </Card>
            <Card as="section" label="Today so far" padding={16}>
              <h2 className="cd-type-section board-vision-city__title">Today so far</h2>
              <ul role="list" className="board-vision-today">
                {CITY_TODAY.map((line) => (
                  <li key={line} className="cd-type-meta">
                    {line}
                  </li>
                ))}
              </ul>
            </Card>
          </div>
        </div>
        <ConceptFooter />
      </div>
    </VisionOwnerFrame>
  );
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

/** The day's line under the page. */
export const TEAM_TODAY = 'Today: 12 team conversations, 9 answered from job records, 3 documents shared, 1 payroll request declined.';

/** A teammate's turn and Claude's answer with its card and receipt, as the board draws them. */
function TeamTurn({ asked, reply, fact, receipt }: { asked: string; reply: string; fact?: FactCardProps; receipt: { source: ReceiptSource; plain: string } }) {
  return (
    <>
      <TranscriptRow>
        <VisitorMessage text={asked} />
      </TranscriptRow>
      <TranscriptRow margin={<MarginReceipt source={receipt.source} plain={receipt.plain} ledgerSeq={0} />}>
        <div className="board-vision-reply">
          <Reply text={reply} />
          {fact ? <FactCard {...fact} /> : null}
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
                reply="Here’s Ana’s history. The gate code is on today’s job card."
                fact={{
                  label: 'Customer history',
                  icon: 'document',
                  title: 'Ana Ruiz, customer since 2023',
                  lines: ['Water heater replaced, March 2024; under warranty until 2030', 'Kitchen drain cleared, September 12; camera inspection declined'],
                }}
                receipt={{
                  source: CHECKED,
                  plain:
                    'From job records and her customer file. Luis is assigned to her 10:30 am visit, so the address and gate code are open to him.',
                }}
              />
              <TeamTurn
                asked="Send me the warranty in case it’s the tank."
                reply="Here it is."
                fact={{ label: 'Document, only for Luis', icon: 'document', title: 'Water heater warranty, Ana Ruiz' }}
                receipt={{ source: decided('executed'), plain: 'Warranty released to the assigned plumber. Logged on Ana’s file.' }}
              />
              <TeamTurn
                asked="Also, what did Ben make on the Harbor Street job last week?"
                reply="I can’t share pay. Payroll is open to Maria and Grace only. I can show your own logged hours for last week if that helps."
                receipt={{ source: decided('refused'), plain: 'Declined by team access: payroll is owner and office manager only. Nothing shared.' }}
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
 * Dana's visit as the board draws it. Owner decision, 2026-10-30: on a vision Desk a Claude account
 * counts as verified when its verified email matches the contact on record, with her consent asked
 * on each visit; the receipts say both.
 */
export const CLAUDE_ACCOUNT_TURNS = {
  ask: 'Your Claude account has a verified email. If it matches the contact Rivera Plumbing has on record for you, I can confirm it’s you without a code. Use it for this visit?',
  yes: 'Yes, use it',
  matched: 'Thanks, it matches. Welcome back, Dana. Last time we booked your drain clearing. How did it go?',
  matchedReceipt: 'Matched to Dana Whitfield: the Claude account’s verified email is her contact on record, and she agreed for this visit',
  invoice: 'All fixed, thanks. Can you send me the invoice?',
  sent: 'Glad to hear it. Here’s your invoice. You let me use your Claude account for this visit, so no code was needed.',
  releasedReceipt: 'Released to Dana Whitfield, matched by her Claude account with her consent for this visit',
  checked: 'Reply checked against Maria Rivera’s rules',
} as const;

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
      about={CLAUDE_ACCOUNT_ABOUT}
      composer={<Composer variant="visitor" label="Message Rivera Plumbing" placeholder="Message Rivera Plumbing" maxLength={2000} onSend={fn()} />}
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
          <ClaudeMessage blocks={[proseBlock(t.matched)]} language="en" ownerName={owner} />
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
          <ClaudeMessage
            blocks={[
              proseBlock(t.sent),
              cardBlock('document_link', { fact_id: 'document_link:DL-501', title: 'Invoice, drain clearing', href: '/api/d/9fK2mQ' }),
            ]}
            language="en"
            ownerName={owner}
          />
        </TranscriptRow>
      </Transcript>
    </PublicShell>
  );
}

// ---------------------------------------------------------------------------------------------
// The phone (N-R2-Vision-Phone): the owner's Today and a visitor's chat, as phone apps.

export const PHONE_HREFS = { today: '#today', chats: '#chats', rules: '#rules', safety: '#safety', more: '#more' } as const;

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
          <p className="board-quiet cd-type-caption">{rivera.business.name}</p>
          <h2 className="cd-type-greeting board-vision-phone__greeting">Good morning, Maria</h2>
        </div>
        <ApprovalCard decision={rivera.decisions.held} heldBy={rivera.ruleCards['rv-quote'].reason} waiting="Web chat, 2 min ago" onAnswer={fn()} />
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
            <div className="board-vision-reply">
              <Reply text="Maria will text you when she’s on her way." />
              <FactCard label="Booked" icon="clock" title="Tuesday, November 3" lines={['Arriving 2:00 pm to 4:00 pm', 'With Maria Rivera']} />
            </div>
          </TranscriptRow>
        </Transcript>
      </div>
      <div className="board-vision-phone__composer">
        <Composer variant="visitor" label="Message Rivera Plumbing" placeholder="Message Rivera Plumbing" maxLength={2000} onSend={fn()} />
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
