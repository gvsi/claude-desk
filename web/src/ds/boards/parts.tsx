/**
 * Page-level parts the boards draw that no design system component draws, because the web app
 * (plan 04) owns those pages: the owner app's frame for Turner Plumbing, Today's things to try,
 * its "Last 7 days" column and briefing, and the conversation page's columns. They are composed
 * here from the components and tokens, only for the `Boards/*` stories, and exported nowhere else.
 */
import { useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import { fn } from 'storybook/test';

import { SIDEBAR_ABOUT } from '../../owner/sidebarAbout.ts';

import type { Effect, EvMessage, PublicDesk, RenderedBlock, RuleCard, StatusEvent, ToolName } from '../../api/contracts.ts';
import { AlwaysOnList } from '../components/AlwaysOnList/AlwaysOnList.tsx';
import { Breadcrumb } from '../components/Breadcrumb/Breadcrumb.tsx';
import { Composer } from '../components/Composer/Composer.tsx';
import { DetailList, type DetailItem } from '../components/DetailList/DetailList.tsx';
import { SubNav, type SubNavItem } from '../components/SubNav/SubNav.tsx';
import { Switch } from '../components/Switch/Switch.tsx';
import { ChannelList } from '../components/ChannelList/ChannelList.tsx';
import { ConnectorDirectory, type ConnectorDirectoryProps } from '../components/ConnectorDirectory/ConnectorDirectory.tsx';
import { ConnectorList } from '../components/ConnectorList/ConnectorList.tsx';
import { ConnectorSection, type ConnectorSectionProps } from '../components/ConnectorSection/ConnectorSection.tsx';
import type { RuleRowProps } from '../components/RuleRow/RuleRow.tsx';
import { SuggestionChips } from '../components/SuggestionChips/SuggestionChips.tsx';
import { rulesForTool } from '../components/ToolRulesCard/toolRules.ts';
import { AgentMessage } from '../components/AgentMessage/AgentMessage.tsx';
import { ApprovalCard } from '../components/ApprovalCard/ApprovalCard.tsx';
import { ClaudeMessage } from '../components/ClaudeMessage/ClaudeMessage.tsx';
import { ConceptFooter } from '../components/ConceptFooter/ConceptFooter.tsx';
import { DisclosureLine } from '../components/DisclosureLine/DisclosureLine.tsx';
import { Mark, Wordmark } from '../components/Mark/Mark.tsx';
import { Greeting } from '../components/Greeting/Greeting.tsx';
import { SectionHeader } from '../components/SectionHeader/SectionHeader.tsx';
import { MarginNote } from '../components/MarginNote/MarginNote.tsx';
import { MarginReceipt } from '../components/MarginReceipt/MarginReceipt.tsx';
import { receiptFromEvent } from '../components/MarginReceipt/receiptTone.ts';
import { PersonMessage } from '../components/PersonMessage/PersonMessage.tsx';
import { RecordedHistoryLink } from '../components/RecordedHistoryLink/RecordedHistoryLink.tsx';
import { SystemLine } from '../components/SystemLine/SystemLine.tsx';
import { TranscriptRow } from '../components/TranscriptRow/TranscriptRow.tsx';
import { VisitorMessage } from '../components/VisitorMessage/VisitorMessage.tsx';
import { Whisper } from '../components/Whisper/Whisper.tsx';
import type { TranscriptTurn } from '../fixtures/index.ts';

import { AppShell, AppShellOnly } from '../components/AppShell/AppShell.tsx';
import { Button } from '../components/Button/Button.tsx';
import { Card } from '../components/Card/Card.tsx';
import { ChainStatus } from '../components/ChainStatus/ChainStatus.tsx';
import { Chip } from '../components/Chip/Chip.tsx';
import { PageHeader } from '../components/PageHeader/PageHeader.tsx';
import { Pill } from '../components/Pill/Pill.tsx';
import { SegmentedControl } from '../components/SegmentedControl/SegmentedControl.tsx';
import { ConversationListItem } from '../components/ConversationListItem/ConversationListItem.tsx';
import { PublicBrandHeader } from '../components/PublicShell/PublicBrandHeader.tsx';
import type { PublicBrand, PublicOpenStatus } from '../components/PublicShell/PublicShell.tsx';
import { ReviewerBar } from '../components/ReviewerBar/ReviewerBar.tsx';
import { Sidebar, initialsOf, type NavCount, type NavKey, type SidebarHrefs } from '../components/Sidebar/Sidebar.tsx';
import { StatusDot, StatusLabel, type StatusTone } from '../components/StatusDot/StatusDot.tsx';
import { TextLink } from '../components/TextLink/TextLink.tsx';
import { chen, placeholderHex, rivera } from '../fixtures/index.ts';
import { Icon, type IconName } from '../icons/index.tsx';

import './boards.css';

/**
 * Where the sidebar's rows go: in-page anchors, so nothing leaves the story. No Connectors href, so
 * no Connectors row: the boards drawn before that page (Run 1 and the recorded history) draw seven
 * pages, as the web app's first run will. A board that draws Connectors adds its href.
 */
export const OWNER_HREFS = {
  today: '#today',
  conversations: '#conversations',
  people: '#customers',
  knowledge: '#knowledge',
  rules: '#rules',
  safety: '#safety',
  profile: '#profile',
  share: '#share',
  settings: '#settings',
} satisfies SidebarHrefs;

export const MAIN_LINE = { id: 'desk-rivera-main', name: rivera.business.deskName };
export const EMERGENCIES = { id: 'desk-rivera-emergencies', name: 'Emergencies' };

export interface RiveraFrameProps {
  /** Vision and the landing preview keep their original page-bottom concept line. */
  conceptFooterInSidebar?: boolean;
  current: NavKey;
  /** The counts beside Conversations and Safety, as each board draws them. */
  counts: { conversations?: NavCount; safety?: NavCount };
  /** Both of Turner's Desks, so the sidebar shows its Desk picker. */
  twoDesks?: boolean;
  /** The reviewer bar across the top, as on the arrival boards. */
  reviewer?: boolean;
  /** The page lays out its own columns from the sidebar's edge (`AppShell` `fill`). */
  fill?: boolean;
  /** The sidebar's Connectors row, after Rules, as the boards signed after it draw it. */
  connectors?: boolean;
  /** A panel beside the page, such as Ask Claude (`AppShell` `panel`). */
  panel?: ReactNode;
  /** A line across the top in place of the reviewer bar, such as the vision bar (`AppShell` `banner`). */
  banner?: ReactNode;
  onSwitchBusiness?: () => void;
  children: ReactNode;
}

/** The owner app for Mike Turner: the shell, the sidebar on `current`, and the page. */
export function RiveraFrame({ twoDesks = false, ...props }: RiveraFrameProps) {
  return (
    <OwnerFrame
      business={rivera.business.name}
      ownerName={rivera.business.ownerName}
      desks={twoDesks ? [MAIN_LINE, EMERGENCIES] : [MAIN_LINE]}
      {...props}
    />
  );
}

/** Chen & Co. CPA's one Desk. */
export const CHEN_LINE = { id: 'desk-chen-main', name: chen.business.deskName };

/** The owner app for Linda Chen, on Chen & Co. CPA's one Desk: the shell, the sidebar on `current`, and the page. */
export function ChenFrame(props: Omit<RiveraFrameProps, 'twoDesks' | 'reviewer'>) {
  return <OwnerFrame business={chen.business.name} ownerName={chen.business.ownerName} desks={[CHEN_LINE]} {...props} />;
}

interface OwnerFrameProps extends Omit<RiveraFrameProps, 'twoDesks'> {
  business: string;
  ownerName: string;
  desks: { id: string; name: string }[];
}

function OwnerFrame({
  conceptFooterInSidebar = true,
  business,
  ownerName,
  desks,
  current,
  counts,
  reviewer = false,
  fill = false,
  connectors = false,
  panel,
  banner,
  onSwitchBusiness,
  children,
}: OwnerFrameProps) {
  return (
    <AppShell
      todayHref={OWNER_HREFS.today}
      business={business}
      fill={fill}
      panel={panel}
      banner={reviewer ? <ReviewerBar ownerName={ownerName} onStartOver={fn()} /> : banner}
      sidebar={
        <Sidebar
          business={business}
          onSwitchBusiness={onSwitchBusiness ?? fn()}
          desks={desks}
          currentDeskId={desks[0]?.id ?? ''}
          onSwitchDesk={fn()}
          current={current}
          hrefs={connectors ? { ...OWNER_HREFS, connectors: '#connectors' } : OWNER_HREFS}
          peopleLabel="Customers"
          counts={counts}
          answering
          onAnsweringChange={fn()}
          owner={{ name: ownerName, status: 'Available for chats' }}
          about={conceptFooterInSidebar ? SIDEBAR_ABOUT : undefined}
          conceptFooter={conceptFooterInSidebar}
        />
      }
    >
      {children}
    </AppShell>
  );
}

/**
 * The Connectors tab boards draw an eighth sidebar row, Connectors, current on the Connectors,
 * connector and tool pages. That row comes with its own change to the Sidebar on main; until then
 * these boards' stories mark Rules current, the pages' earlier home, and say so.
 */
export const SIDEBAR_NOTE = 'The Connectors row lands with the Sidebar change on main; until then the sidebar has seven rows and these pages mark Rules current.';

/** The same, for a board whose current page is in the seven rows (Today, Rules). */
export const SIDEBAR_ROW_NOTE = 'The Connectors row lands with the Sidebar change on main; until then the sidebar has seven rows.';

/** The public link as Today shows it beside the greeting. */
export const PUBLIC_LINK = 'desk.example/rivera';

// ---------------------------------------------------------------------------------------------
// Today

export interface ThingToTry {
  icon: IconName;
  title: string;
  /** A held dot after the title, for something waiting on the owner. */
  waiting?: boolean;
  detail: string;
  action: string;
}

/** Today's things to try, as the arrival board signs them. */
export const THINGS_TO_TRY = {
  chat: {
    icon: 'conversations',
    title: 'Chat as a customer',
    detail: 'Your public page opens in a new tab. Ask about a price or a time.',
    action: 'Open your public page',
  },
  breakIt: {
    icon: 'safety',
    title: 'Try to break it',
    detail: 'Ask for a discount, another customer’s address or Mike’s home number. Safety shows what was stopped and why.',
    action: 'Show me ideas',
  },
  held: {
    icon: 'clock',
    title: 'Answer a held request',
    waiting: true,
    // Worded like the approval card: the held item's own rule, never a summary of the visitor.
    detail: `A request is waiting for your answer. Held by your rule: ${rivera.ruleCards['rv-quote'].reason}`,
    action: 'Open the request',
  },
  ownDesk: {
    icon: 'plus',
    title: 'Create your own Desk',
    detail: 'Describe a business in a few sentences. Claude drafts the rules, and you confirm them.',
    action: 'Start a Desk',
  },
} satisfies Record<string, ThingToTry>;

/** "Things to try": a heading with its caption and Hide, then one card of rows, each with its button. */
export function ThingsToTry({ things }: { things: ThingToTry[] }) {
  return (
    <section className="board-section" aria-labelledby="board-things-to-try">
      <div className="board-section__head">
        <h2 id="board-things-to-try" className="board-section__title cd-type-section">
          Things to try
        </h2>
        <p className="board-section__caption cd-type-meta">About 10 minutes. No real customer sees any of it.</p>
        <span className="board-section__end">
          <Button variant="ghost" onClick={fn()}>
            Hide this list
          </Button>
        </span>
      </div>
      <Card padding={16}>
        <ul className="board-things">
          {things.map((thing) => (
            <li key={thing.title} className="board-thing">
              <span className="board-thing__icon" aria-hidden="true">
                <Icon name={thing.icon} size={16} />
              </span>
              <span className="board-thing__text">
                <span className="board-thing__title cd-type-control">
                  {thing.title}
                  {thing.waiting ? <StatusDot tone="held" /> : null}
                </span>
                <span className="board-thing__detail cd-type-meta">{thing.detail}</span>
              </span>
              <span className="board-thing__action">
                <Button variant="secondary" onClick={fn()}>
                  {thing.action}
                </Button>
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}

/** "Your public page", at the top of Today's right column. */
function PublicPagePanel() {
  return (
    <div className="board-panel-card">
      <h2 className="board-panel-card__title cd-type-control">Your public page</h2>
      <p className="board-quiet cd-type-caption">{PUBLIC_LINK}</p>
      <div className="board-panel-card__action">
        <Button variant="secondary" onClick={fn()}>
          Chat as a customer
        </Button>
      </div>
      <p className="board-quiet cd-type-caption">Opens in a new tab. Your chat shows up here under Live now.</p>
    </div>
  );
}

/** The day letters under the bookings chart: the seven dates ending today, today last. */
const DAYS = ['F', 'S', 'S', 'M', 'T', 'W', 'T'] as const;

/** Where "Includes recorded history" goes: the ledger's explanation of the replayed history. */
export const RECORDED_HISTORY_HREF = '#recorded-history';

export interface LastSevenDaysProps {
  /** Each day's bar, as a share of the week's busiest day; null for the empty copy. */
  bars: readonly number[] | null;
}

/**
 * Today's right column: the public page panel, then "Last 7 days": bookings with their amount and
 * a bar per day, who handled the conversations, and the attempts stopped. Every number is the
 * screen's display string; nothing here computes one.
 */
export function LastSevenDays({ bars }: LastSevenDaysProps) {
  const empty = bars === null;
  return (
    <section className="board-week" aria-labelledby="board-week-title">
      <PublicPagePanel />
      <div className="board-week__head">
        <h2 id="board-week-title" className="board-week__title cd-type-section">
          Last 7 days
        </h2>
        {empty ? null : <RecordedHistoryLink href={RECORDED_HISTORY_HREF} />}
      </div>
      {empty ? (
        <div className="board-week__block">
          <h3 className="board-week__subtitle cd-type-control">Bookings</h3>
          <p className="board-quiet cd-type-meta">No bookings in the last 7 days.</p>
        </div>
      ) : (
        <div className="board-week__block">
          <p className="board-week__total">
            <span className="cd-type-figure">$1,860</span> <span className="board-quiet cd-type-message">booked</span>
          </p>
          <p className="board-quiet cd-type-meta">11 bookings, 2 so far today</p>
        </div>
      )}
      <div className="board-chart" aria-hidden="true">
        {DAYS.map((day, index) => {
          const share = bars?.[index] ?? 0;
          const today = index === DAYS.length - 1;
          return (
            <span key={index} className={`board-chart__day${today ? ' board-chart__day--today' : ''}`}>
              <span className="board-chart__track">
                <span className="board-chart__bar" style={{ height: share === 0 ? 'var(--space-2)' : `${share}%` }} />
              </span>
              <span className="board-chart__letter cd-type-caption">{day}</span>
            </span>
          );
        })}
      </div>
      <div className="board-week__block board-week__block--ruled">
        <h3 className="board-week__subtitle cd-type-control">Handled by Claude, or by you</h3>
        {empty ? (
          <p className="board-quiet cd-type-meta">No conversations in the last 7 days.</p>
        ) : (
          <>
            <div className="board-split" aria-hidden="true">
              <span className="board-split__handled" />
              <span className="board-split__held" />
            </div>
            <div className="board-split__legend cd-type-meta">
              <StatusLabel tone="handled">Claude handled 38</StatusLabel>
              <StatusLabel tone="held">You stepped in 3 times</StatusLabel>
            </div>
            <p className="board-quiet cd-type-caption">For a big discount, a refund and a Sunday emergency.</p>
          </>
        )}
      </div>
      <div className="board-week__block board-week__block--ruled">
        <h3 className="board-week__subtitle cd-type-control">Attempts to talk it around</h3>
        {empty ? (
          <p className="board-quiet cd-type-meta">No attempts in the last 7 days.</p>
        ) : (
          <>
            <p className="board-week__total">
              <span className="cd-type-figure-small">14</span> <span className="board-quiet cd-type-message">stopped</span>
            </p>
            <p className="board-quiet cd-type-meta">Nothing was shared and no money moved.</p>
          </>
        )}
        <p className="cd-type-meta">
          <TextLink href="#safety">Open Safety</TextLink>
        </p>
      </div>
    </section>
  );
}

/** One row of the short briefing: when, what happened in words with its dot, and the detail. */
export interface BriefingRow {
  time: string;
  tone: StatusTone;
  what: string;
  detail: string;
}

/** "Since last night": the summary in Claude's voice, a row of each kind, then "See all". */
export function SinceLastNight({ summary, rows, seeAll }: { summary: string; rows: BriefingRow[]; seeAll: string }) {
  return (
    <Card padding={20}>
      <p className="board-briefing__summary cd-type-summary">{summary}</p>
      <ul className="board-briefing">
        {rows.map((row) => (
          <li key={row.time} className="board-briefing__row">
            <span className="board-quiet cd-type-meta">{row.time}</span>
            <span className="cd-type-meta">
              <StatusLabel tone={row.tone}>{row.what}</StatusLabel>
            </span>
            <span className="cd-type-meta">{row.detail}</span>
          </li>
        ))}
      </ul>
      <p className="cd-type-meta">
        <TextLink href="#briefing">{seeAll}</TextLink>
      </p>
    </Card>
  );
}

/** Each day's bookings as a share of the busiest day, Friday to today, as the board draws them. */
const WEEK = [64, 32, 0, 64, 100, 32, 64] as const;

/**
 * Today as Mike Turner first sees it: the greeting, the things to try, the held request, Live now,
 * the short briefing and the last 7 days. `reviewer` adds the reviewer bar across the top.
 */
export function TodayNeedsYou({
  conceptFooterInSidebar = true,
  reviewer = true,
  twoDesks = false,
  onSwitchBusiness,
}: {
  conceptFooterInSidebar?: boolean;
  reviewer?: boolean;
  /** Both of Turner's Desks, so the sidebar shows its Desk picker. */
  twoDesks?: boolean;
  onSwitchBusiness?: () => void;
}) {
  return (
    <RiveraFrame
      current="today"
      conceptFooterInSidebar={conceptFooterInSidebar}
      reviewer={reviewer}
      twoDesks={twoDesks}
      onSwitchBusiness={onSwitchBusiness}
      counts={{ conversations: { n: 1, label: '1 live conversation' }, safety: { n: 2, label: '2 blocked' } }}
    >
      <div className="board-today">
        <div className="board-today__main">
          <Greeting text="Good morning, Mike" presence={{ line: 'Quiet right now.', people: [] }} link={{ label: PUBLIC_LINK, onCopy: fn() }} />
          <ThingsToTry things={[THINGS_TO_TRY.chat, THINGS_TO_TRY.breakIt, THINGS_TO_TRY.held, THINGS_TO_TRY.ownDesk]} />
          <section className="board-section" aria-labelledby="board-needs-you">
            <SectionHeader id="board-needs-you" title="Needs you" count={{ n: 1, label: '1 needs you' }} />
            <ApprovalCard
              decision={rivera.decisions.held}
              heldBy={rivera.ruleCards['rv-quote'].reason}
              context={
                <>
                  From the visitor: “<span data-copy="user">How much to clear a clogged drain? Can I get 15% off if I pay cash?</span>”
                </>
              }
              waiting="Web chat, 2 min ago"
              onAnswer={fn()}
            />
          </section>
          <section className="board-section" aria-labelledby="board-live-now">
            <SectionHeader id="board-live-now" title="Live now" count={{ n: 1, label: '1 live conversation' }} caption="Shows while someone is chatting" />
            <ul className="board-conversations__items">
              <li>
                <ConversationListItem
                  name="Your preview"
                  time="Just now"
                  status={{ tone: 'info', text: 'Your own preview, in the public page tab' }}
                  href="#conversation-preview"
                />
              </li>
            </ul>
          </section>
          <section className="board-section" aria-labelledby="board-since-last-night">
            <SectionHeader id="board-since-last-night" title="Since last night" caption={<RecordedHistoryLink href={RECORDED_HISTORY_HREF} />} />
            <SinceLastNight
              summary="All 7 conversations stayed inside your rules. I booked three visits, answered a question and stopped two attempts. Nothing was shared."
              rows={[
                { time: '3:30 am', tone: 'refused', what: 'Blocked', detail: 'An agent tried to book without a signed limit. Nothing was booked.' },
                { time: '6:40 am', tone: 'handled', what: 'Booked', detail: 'Dana Whitfield, leak repair' },
                { time: '5:12 am', tone: 'handled', what: 'Answered', detail: 'Asked if you cover Emeryville. You do.' },
              ]}
              seeAll="See all 7"
            />
          </section>
          {conceptFooterInSidebar ? <AppShellOnly layout="compact"><ConceptFooter /></AppShellOnly> : <ConceptFooter />}
        </div>
        <LastSevenDays bars={WEEK} />
      </div>
    </RiveraFrame>
  );
}

// ---------------------------------------------------------------------------------------------
// Conversations

export interface ListedConversation {
  name: string;
  time: string;
  /** Left out when the name already says it ("Visitor" for someone who gave no name), as in the app. */
  status?: { tone: StatusTone; text: string };
  /** Replayed into this copy: the row carries the Recorded tag. */
  recorded?: boolean;
}

/** The list under one day's label: "Today", "Yesterday", "Earlier this week". */
export interface ConversationGroup {
  label: string;
  items: ListedConversation[];
}

/** The conversations the Run 1 boards list beside the open one. */
export const CONVERSATION_LIST: ListedConversation[] = [
  { name: 'Lucía Herrera', time: '12:06 pm', status: { tone: 'handled', text: 'Visitor' } },
  { name: rivera.people.dana.name, time: '12:04 pm', status: { tone: 'held', text: 'Needs you' } },
  { name: rivera.conversations.alexAgent.name, time: '11:42 am', status: { tone: 'info', text: 'Agent' } },
  { name: 'Visitor in Berkeley', time: '10:58 am', status: { tone: 'held', text: 'Needs you' } },
];

export interface ConversationsPageProps {
  /** The open conversation, by the name the list shows. */
  open: string;
  /** Its time too, where the list repeats a name ("Visitor"). */
  openTime?: string;
  /** Today's conversations, under one "Today" label, unless `groups` is given. */
  items?: ListedConversation[];
  /** The list by day, each under its own label. */
  groups?: ConversationGroup[];
  /** A line under the title: "Includes recorded history". */
  caption?: ReactNode;
  /**
   * The recorded-history board's page, at a 14-inch laptop's window: a 312 px list with its days
   * spaced as that board draws them, and the footer at the open column's foot.
   */
  history?: boolean;
  children: ReactNode;
}

/**
 * The conversations page: the list of conversations in its own column at the left, under their
 * days, and the open conversation in the reading column beside it.
 */
export function ConversationsPage({ open, openTime, items = CONVERSATION_LIST, groups, caption, history = false, children }: ConversationsPageProps) {
  const days = groups ?? [{ label: 'Today', items }];
  const isOpen = (item: ListedConversation) => item.name === open && (openTime === undefined || item.time === openTime);
  return (
    <div className={`board-conversations${history ? ' board-conversations--history' : ''}`}>
      <nav className="board-conversations__list" aria-labelledby="board-conversations-title">
        <h1 id="board-conversations-title" className="board-conversations__title cd-type-page-title">
          Conversations
        </h1>
        {caption ? <p className="board-conversations__caption cd-type-caption">{caption}</p> : null}
        {days.map((day) => (
          <div key={day.label} className="board-conversations__day">
            <p className="board-quiet cd-type-meta">{day.label}</p>
            <ul className="board-conversations__items">
              {day.items.map((item) => (
                <li key={`${item.name} ${item.time}`}>
                  <ConversationListItem {...item} href={`#conversation-${item.time}`} current={isOpen(item)} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      <div className="board-conversations__open">{children}</div>
    </div>
  );
}

export interface TurnRowsProps {
  turns: readonly TranscriptTurn[];
  /** The owner's own screen opens a receipt's full trace; the visitor's receipts are read-only. */
  onOpenTrace?: (ledgerSeq: number) => void;
  /** The whisper's caption: who and when, in the screen's words. */
  whisperCaption?: string;
  /** Notes the owner's screen attaches under a turn, by its index in `turns`. */
  notes?: Record<number, string>;
  /** Who the agent acts for, as the owner reads it: "Alex Kim's assistant". */
  agentName?: string;
  /** The decisions whose receipt draws the sage check: an executed booking or a paid link. */
  checks?: readonly string[];
  /** Claude's translations for the owner of what the visitor wrote, by the turn's index. */
  translations?: Record<number, string>;
  /** On the owner's own screen her messages read "You", beside her own initials. */
  ownersOwnScreen?: boolean;
}

/**
 * A stored conversation as rows: each message in its own `TranscriptRow`, with the status events
 * that came before it and its own reply check attached under it, through `receiptFromEvent`.
 */
export function TurnRows({
  turns,
  onOpenTrace,
  whisperCaption = 'Your whisper. Only Claude sees this.',
  notes = {},
  agentName,
  checks = [],
  translations = {},
  ownersOwnScreen = false,
}: TurnRowsProps) {
  const rows: ReactNode[] = [];
  let pending: StatusEvent[] = [];
  let requests = 0;
  const attached = (index: number, events: (EvMessage | StatusEvent)[]) => {
    const receipts = events.map((event) => {
      const view = receiptFromEvent(event);
      const check = event.type !== 'message' && checks.includes(event.decision_id);
      return <MarginReceipt key={view.ledgerSeq} {...view} onOpenTrace={onOpenTrace} drawCheck={check} />;
    });
    const note = notes[index];
    return note === undefined ? receipts : [...receipts, <MarginNote key="note" text={note} />];
  };
  turns.forEach((turn, index) => {
    switch (turn.kind) {
      case 'visitor':
        rows.push(
          <TranscriptRow key={index} margin={notes[index] === undefined ? undefined : attached(index, [])}>
            <VisitorMessage text={turn.text} translation={translations[index]} />
          </TranscriptRow>,
        );
        return;
      case 'agent':
        requests += 1;
        rows.push(
          <TranscriptRow key={index} margin={notes[index] === undefined ? undefined : attached(index, [])}>
            <AgentMessage agentName={agentName ?? 'Agent'} signed={turn.signed} title="Signed request" meta={`Request ${requests}`} text={turn.text} />
          </TranscriptRow>,
        );
        return;
      case 'whisper':
        rows.push(
          <TranscriptRow key={index} margin={notes[index] === undefined ? undefined : attached(index, [])}>
            <Whisper caption={whisperCaption} text={turn.text} />
          </TranscriptRow>,
        );
        return;
      case 'event': {
        const { event } = turn;
        if (event.type === 'message') {
          const words =
            event.author === 'owner' ? (
              <PersonMessage
                name={ownersOwnScreen ? 'You' : rivera.business.ownerName}
                initials={ownersOwnScreen ? initialsOf(rivera.business.ownerName) : undefined}
                blocks={event.blocks}
                language={event.language}
              />
            ) : (
              <ClaudeMessage blocks={event.blocks} language={event.language} ownerName={rivera.business.ownerName} />
            );
          rows.push(
            <TranscriptRow key={index} margin={attached(index, [...pending, event])}>
              {words}
            </TranscriptRow>,
          );
          pending = [];
        } else if (event.type === 'owner_joined') {
          // A stand-in for `joined` in web/src/public/copy.ts, which the design system doesn't import.
          rows.push(<SystemLine key={index} text={`${event.name} joined the chat`} initials={initialsOf(event.name)} />);
        } else if (event.type === 'receipt' || event.type === 'held' || event.type === 'resolved') {
          pending.push(event);
        }
        return;
      }
      default:
        return;
    }
  });
  return <>{rows}</>;
}

// ---------------------------------------------------------------------------------------------
// Sign-off sheets

/**
 * A sign-off board: one sheet of labelled panels, each a real screen or part of one. The board's
 * own title, explanations and "How it behaves" notes are sign-off notes, not product, so they stay
 * in the canvas; each panel keeps its short label.
 */
export function Sheet({ title, gap = 40, children }: { title: string; gap?: 24 | 32 | 40; children: ReactNode }) {
  return (
    <main className={`board-sheet board-sheet--gap-${gap}`}>
      <h1 className="cd-sr-only">{title}</h1>
      {children}
    </main>
  );
}

/**
 * One labelled panel of a sheet, as wide as the board draws it (`width`, its border included) or
 * the sheet's full width. A `phone` panel is padded 16 px, a `compact` one 20 px 24 px, the others
 * 20 px 28 px; a `bare` panel holds a card, which is its own frame.
 */
export function Panel({
  label,
  width,
  phone = false,
  compact = false,
  bare = false,
  children,
}: {
  label: string;
  width?: number;
  phone?: boolean;
  compact?: boolean;
  bare?: boolean;
  children: ReactNode;
}) {
  const kind = phone ? ' board-panel--phone' : compact ? ' board-panel--compact' : '';
  return (
    <section
      className={`board-panel${kind}${bare ? ' board-panel--bare' : ''}${width === undefined ? ' board-panel--full' : ' board-panel--sized'}`}
      style={width === undefined ? undefined : ({ '--board-panel-width': `${width}px` } as CSSProperties)}
      aria-label={label}
    >
      <h2 className="board-panel__label cd-type-caption">{label}</h2>
      <div className="board-panel__frame">{children}</div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// The public page

/** The public page's brand, as the screen maps `PublicDesk` to it: the seed's field and accent, the text tokens as inks. */
export function brandOf(publicDesk: PublicDesk): PublicBrand {
  return {
    name: publicDesk.business_name,
    tagline: publicDesk.desk_name,
    monogram: Array.from(publicDesk.business_name)[0] ?? '',
    field: publicDesk.brand.primary ?? '',
    ink: 'var(--text-on-brand)',
    inkSecondary: 'var(--text-on-brand-secondary)',
    statusHandled: 'var(--status-handled-on-brand)',
    accent: publicDesk.brand.accent ?? '',
  };
}

/** Thursday 10:00, open until 18:00: the kernel's words, which the header shows as written. */
export const OPEN_NOW: NonNullable<PublicOpenStatus> = {
  open: true,
  until: '2026-10-29T18:00:00-07:00',
  opens_at: null,
  text: 'Open now, until 6:00 pm',
  as_of: '2026-10-29T10:00:00-07:00',
  refresh_at: '2026-10-29T18:00:00-07:00',
};

/** The kernel's line under a reply that passed the check, read from a fixture reply that did. */
const REPLY_CHECKED = (() => {
  const reply = rivera.events.quoteTurn.find((event): event is EvMessage => event.type === 'message');
  if (!reply) throw new Error('the Turner fixture has no checked reply');
  return reply.visitor_plain;
})();

/** A reply from Claude that passed the check, as the stream delivers it, for a board's own turn. */
export function checkedReply(id: string, blocks: RenderedBlock[], ledgerSeq: number): EvMessage {
  return {
    type: 'message',
    message_id: id,
    generation: 1,
    author: 'claude',
    language: 'en',
    handoff: false,
    blocks,
    visitor_plain: REPLY_CHECKED,
    ledger_seq: ledgerSeq,
    signature: placeholderHex(`signature:${id}`, 64),
  };
}

// ---------------------------------------------------------------------------------------------
// Safety

export type SafetyView = 'attempts' | 'entries';

/** The kinds an attempt is sorted into, "All" first and chosen. */
export const KINDS = ['All', 'Posing as you', 'Money', 'Private data', 'Codes', 'Hidden instructions', 'Other', 'Not sorted yet'] as const;

/** The kinds as the screen holds them: "All" chosen at first, and the choice follows each pick. */
export function KindChips() {
  const [kind, setKind] = useState<(typeof KINDS)[number]>('All');
  return (
    <div className="board-chips" role="radiogroup" aria-label="Kind of attempt">
      {KINDS.map((option) => (
        <Chip key={option} asRadio selected={option === kind} onClick={() => setKind(option)}>
          {option}
        </Chip>
      ))}
    </div>
  );
}

export interface SafetyPageProps {
  view: SafetyView;
  entries: number;
  list: ReactNode;
  detail: ReactNode;
  /** Claude's line about the week. */
  summary?: string;
  /** A caption beside the summary: "Includes recorded history". */
  caption?: ReactNode;
  /** The counts beside Conversations and Safety in the sidebar. */
  counts?: RiveraFrameProps['counts'];
  /**
   * The recorded-history board's page, at a 14-inch laptop's window: the page fills the main area
   * with its own 24/40/20 padding, the opened attempt is 400 px wide, 32 px from the list, and the
   * footer sits at the page's foot.
   */
  history?: boolean;
}

/**
 * The Safety page: its title and Claude's line about the week, the held request waiting on Today,
 * the ledger's chain check beside the view switch, and the page's two columns.
 */
export function SafetyPage({
  view,
  entries,
  list,
  detail,
  summary = '6 attempts to talk me around were stopped this week.',
  caption,
  counts = { conversations: { n: 3, label: '3 live conversations' }, safety: { n: 2, label: '2 blocked' } },
  history = false,
}: SafetyPageProps) {
  const page = (
    <div className={`board-safety${history ? ' board-safety--history' : ''}`}>
      <PageHeader
        title="Safety"
        subtitle={
          caption ? (
            <span className="board-safety__summary">
              <span className="board-safety__week cd-type-summary">{summary}</span>
              {caption}
            </span>
          ) : (
            <span className="board-safety__week cd-type-summary">{summary}</span>
          )
        }
        actions={
          <Button variant="secondary" href="#today">
            <StatusLabel tone="held">1 held for you, in Today</StatusLabel>
          </Button>
        }
      />
      <div className="board-safety__bar">
        <ChainStatus chainOk firstBadSeq={null} entries={entries} devKey />
        <SegmentedControl
          label="Show"
          options={[
            { value: 'attempts', label: 'Attempts' },
            { value: 'entries', label: 'Every entry' },
          ]}
          value={view}
          onChange={fn()}
        />
      </div>
      <div className={`board-safety__columns board-safety__columns--${view}`}>
        <div className="board-safety__list">{list}</div>
        <div className="board-safety__detail">{detail}</div>
      </div>
      {history ? <AppShellOnly layout="compact"><ConceptFooter /></AppShellOnly> : null}
    </div>
  );
  return (
    <RiveraFrame current="safety" counts={counts} fill={history}>
      {history ? <div className="board-filled-page">{page}</div> : page}
    </RiveraFrame>
  );
}

// ---------------------------------------------------------------------------------------------
// Rules and connectors

/**
 * An owner page at least the window's height, with the concept footer at its foot: after the
 * content on a long page, at the bottom of the window on a short one, as the connectors boards
 * draw it.
 */
export function BoardPage({ children }: { children: ReactNode }) {
  return (
    <div className="board-page">
      <div className="board-page__body">{children}</div>
      <AppShellOnly layout="compact"><ConceptFooter /></AppShellOnly>
    </div>
  );
}

/** The helper under every Rules composer, as the boards word it. */
export const RULES_HELPER = 'Claude shows you the change before anything applies.';

/**
 * The owner composer of the Rules page and a tool's page: the box named by its placeholder, the
 * helper under the words, and the page's suggestions under the box. On a phone the board draws the
 * box alone.
 */
export function AskAboutRules({ placeholder, chips }: { placeholder: string; chips: readonly string[] }) {
  return (
    <div className="board-ask">
      <Composer variant="owner" label={placeholder} placeholder={placeholder} helper={RULES_HELPER} onSend={fn()} />
      <SuggestionChips label="Suggestions" suggestions={chips} onPick={fn()} />
    </div>
  );
}

/** The Desk's connectors as the hub lists them: the summary line and a section per connector. */
export interface RulesHub {
  summary: string;
  sections: readonly Pick<ConnectorSectionProps, 'connector' | 'href' | 'tools' | 'addedNote'>[];
}

export interface RulesPageProps {
  hub: RulesHub;
  /** The suggestions under the composer, in the owner's words. */
  chips: readonly string[];
  /** A line under the page's title about what just changed. */
  notice?: ReactNode;
  /** The header's actions: "See all rules" before the preset menu, sharing a row on a phone. */
  actions?: ReactNode;
  /** Each section's line above its tools, by connector id: the payment limit on Payments and Stripe. */
  aboveTools?: Readonly<Record<string, ReactNode>>;
}

/**
 * The Rules page: its title and line, with See all rules before the preset menu when offered, the composer
 * that asks Claude for a change right under them, the Desk's connectors, a section each, with the
 * payment limit above the tools of the money groups when given, and the always-on rules.
 * Connectors are added from the Connectors page, so it has no "Add a connector".
 */
export function RulesPage({ hub, chips, notice, actions, aboveTools = {} }: RulesPageProps) {
  return (
    <BoardPage>
      <div className="board-rules__header">
        <PageHeader
          title="Rules"
          subtitle="What Claude can do on this Desk, where each tool comes from, and your rules for it."
          actions={actions}
          actionsBelowOnPhone
          hideSubtitleOnPhone
        />
      </div>
      {notice ? <div className="board-rules__notice">{notice}</div> : null}
      <AskAboutRules placeholder="Ask Claude to change a rule" chips={chips} />
      <ConnectorList summary={hub.summary}>
        {hub.sections.map((section) => (
          <ConnectorSection
            key={section.connector.id}
            {...section}
            href={`#${section.href}`}
            tools={section.tools.map((tool) => ({ ...tool, href: `#${tool.href}` }))}
            aboveTools={aboveTools[section.connector.id]}
          />
        ))}
      </ConnectorList>
      <AlwaysOnList />
    </BoardPage>
  );
}

export interface ConnectorsPageProps {
  /** The Desk's connectors, as the Connectors page groups them. */
  directory: Omit<ConnectorDirectoryProps, 'linkComponent'>;
  /** A line under the page's title about what just changed. */
  notice?: ReactNode;
}

/**
 * The Connectors page: its title with "Add a connector", a line about what just changed when there
 * is one, and the Desk's connectors grouped by where they come from.
 */
export function ConnectorsPage({ directory, notice }: ConnectorsPageProps) {
  return (
    <BoardPage>
      <div className="board-connectors__header">
        <PageHeader
          title="Connectors"
          subtitle="What Claude can reach, and the accounts behind it."
          actions={
            <Button variant="secondary" size="main" onClick={fn()}>
              Add a connector
            </Button>
          }
        />
      </div>
      {notice ? <div className="board-connectors__notice">{notice}</div> : null}
      <ConnectorDirectory
        {...directory}
        builtIn={directory.builtIn.map((row) => ({ ...row, href: row.href ? `#${row.href}` : undefined }))}
        connected={directory.connected.map((row) => ({ ...row, href: row.href ? `#${row.href}` : undefined }))}
      />
    </BoardPage>
  );
}

/** A rule row as the screen builds it from one of Turner's cards: its words, its limit and, for an effect card, the shared line. */
export function riveraRuleRow(card: RuleCard): RuleRowProps {
  const id = card.card_id as keyof typeof rivera.ruleWords;
  const limits: Partial<Record<keyof typeof rivera.ruleWords, string>> = rivera.ruleLimits;
  return {
    rule: card,
    words: rivera.ruleWords[id],
    limit: limits[id],
    shared: card.applies_to.startsWith('effect:') ? rivera.sharedChargeShared : undefined,
    onChangeOutcome: fn(),
  };
}

/** Turner's cards, with the shared rule for every tool that charges money. */
const RIVERA_CARDS: RuleCard[] = [...Object.values(rivera.ruleCards), rivera.sharedChargeCard];

/** The rules that govern one of Turner's tools, as rows, most specific first. */
export function riveraRulesFor(tool: ToolName, effects: Effect[]): RuleRowProps[] {
  return rulesForTool({ tool, effects }, RIVERA_CARDS).map(riveraRuleRow);
}

/** A trail to an owner page, its links in-page anchors so nothing leaves the story. */
export function Trail({ items }: { items: string[] }) {
  return (
    <Breadcrumb items={items.map((label, index) => (index === items.length - 1 ? { label } : { label, href: `#${label.toLowerCase()}` }))} />
  );
}

/**
 * A part of an owner page under its section header, with an optional caption at the right. The
 * cards under it are named regions of their own, so the part is a group, not a second landmark.
 */
export function PageSection({ title, caption, children }: { title: string; caption?: string; children: ReactNode }) {
  return (
    <div className="board-page-section">
      <SectionHeader title={title} caption={caption} />
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Setup

/**
 * The About pages' compact breakpoint. Below it a top bar is a phone's, and a phone's top bar carries
 * no lockup badge (owner, 2026-10-30), so the setup bar shows the bell and "Claude Desk" alone.
 */
const COMPACT_BAR = '(max-width: 1099.98px)';

function subscribeCompactBar(onChange: () => void): () => void {
  const query = window.matchMedia(COMPACT_BAR);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

function isCompactBar(): boolean {
  return window.matchMedia(COMPACT_BAR).matches;
}

/**
 * The setup interview's page (plan 04, Task 12): a bar with the 20 px mark, the wordmark and the business,
 * "Save and exit" at its right, then one 720 px column and the footer at the window's foot. Below the
 * About pages' compact breakpoint the wordmark drops its Preview badge, as every phone top bar does.
 * The step list in the bar is `Steps`, which comes with the Connectors and rules change, so it is
 * left out here.
 */
export function SetupFrame({ business, children }: { business: string; children: ReactNode }) {
  const compact = useSyncExternalStore(subscribeCompactBar, isCompactBar, () => false);
  return (
    <div className="board-setup">
      <header className="board-setup__bar">
        <span className="board-setup__brand">
          <Mark size={20} />
          <Wordmark preview={!compact} />
        </span>
        {/* A name the phone's bar cuts with an ellipsis; its title holds it in full, as on the screen. */}
        <span className="board-setup__business cd-type-control" data-copy="user" title={business}>
          {business}
        </span>
        <span className="board-setup__end">
          <Button variant="ghost" onClick={fn()}>
            Save and exit
          </Button>
        </span>
      </header>
      <main className="board-setup__main">
        <div className="board-setup__column">{children}</div>
        <ConceptFooter />
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// The agents page

/**
 * `/d/:slug/agents` (plan 04, Task 11): the public page's brand header on its own, then one 760 px
 * column with the way back to the chat, the page's title, the AI disclosure (`DisclosureLine`, as
 * the agents boards draw it since 2026-10-30), the page's cards, and the footer at the window's foot.
 */
export function AgentsFrame({ brand, children }: { brand: PublicBrand; children: ReactNode }) {
  return (
    <div className="board-agents">
      <PublicBrandHeader brand={brand} language="en" nameAsHeading={false} />
      <main className="board-agents__main">
        <p className="board-agents__back cd-type-body">
          <TextLink href="#chat">Back to the chat</TextLink>
        </p>
        <h1 className="board-agents__title cd-type-page-title">
          <span data-copy="user">{brand.name}</span> for AI agents
        </h1>
        <div className="board-agents__disclosure">
          <DisclosureLine language="en" businessName={brand.name} />
        </div>
        <div className="board-agents__cards">{children}</div>
        <ConceptFooter />
      </main>
    </div>
  );
}

/**
 * A card on the agents page: its title, an optional line under it, then what it holds. "Send an
 * agent" `holdsCards`, since the agent's run in it carries the Desk's reply cards.
 */
export function AgentsCard({ title, lead, holdsCards = false, children }: { title: string; lead?: string; holdsCards?: boolean; children: ReactNode }) {
  return (
    <Card as="section" label={title} padding={16} holdsCards={holdsCards}>
      <h2 className="board-agents__card-title cd-type-section">{title}</h2>
      {lead === undefined ? null : <p className="board-agents__card-lead cd-type-meta">{lead}</p>}
      <div className="board-agents__card-body">{children}</div>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// Settings (N-Run2-Settings-*): the page's columns, SubNav at the left and the section's content at
// the right, and General's content, which the delete dialog's board and the phone board share.

/** Settings' sections, in order. Connectors have their own tab, so there is no Integrations entry. */
export const SETTINGS_SECTIONS: readonly SubNavItem[] = [
  { key: 'general', label: 'General', href: '#settings-general' },
  { key: 'alerts', label: 'Alerts', href: '#settings-alerts' },
  { key: 'channels', label: 'Channels', href: '#settings-channels' },
  { key: 'billing', label: 'Billing', href: '#settings-billing' },
];

/** The counts beside Conversations and Safety, in the Settings boards' words. */
export const SETTINGS_COUNTS = {
  conversations: { n: 2, label: '2 live conversations' },
  safety: { n: 2, label: '2 attempts stopped today' },
} satisfies RiveraFrameProps['counts'];

/** Settings › General's details, in the board's words; the web app writes the time zone and the hours. */
export const GENERAL_DETAILS: readonly DetailItem[] = [
  { label: 'Business', value: rivera.business.name },
  { label: 'This Desk', value: rivera.business.deskName },
  { label: 'Customers see you as', value: rivera.business.ownerName },
  { label: 'Time zone', value: 'Pacific Time (Los Angeles)' },
  { label: 'Hours', value: 'Weekdays 8:00 am to 6:00 pm, Saturdays 9:00 am to 1:00 pm' },
];

/**
 * The Answering switch's line, the same on a laptop and a phone: the short line N-Run2-Settings-Phone
 * writes (owner decision, 2026-10-30), where N-Run2-Settings-General adds a second sentence.
 */
export const ANSWERING_LINE = 'Within your rules';

/** Deleting a Desk, in the board's words: the line beside the button, and the dialog's body. */
export const DELETE_DESK_LINE = 'Its public link stops working and its chats close. Its safety record is kept.';

/**
 * Settings for Turner Plumbing on `current`: the title, SubNav, the section's content, and the
 * footer. `banner`, such as the vision bar, runs across the top of the app.
 */
export function SettingsPage({ current, banner, conceptFooterInSidebar = true, children }: { current: string; banner?: ReactNode; conceptFooterInSidebar?: boolean; children: ReactNode }) {
  return (
    <RiveraFrame current="settings" fill connectors counts={SETTINGS_COUNTS} banner={banner} conceptFooterInSidebar={conceptFooterInSidebar}>
      <div className="board-filled-page">
        <div className="board-settings">
          <PageHeader title="Settings" />
          <div className="board-settings__columns">
            <div className="board-settings__nav">
              <SubNav label="Settings" items={SETTINGS_SECTIONS} current={current} />
            </div>
            <div className="board-settings__content">{children}</div>
          </div>
          {conceptFooterInSidebar ? <AppShellOnly layout="compact"><ConceptFooter /></AppShellOnly> : <ConceptFooter />}
        </div>
      </div>
    </RiveraFrame>
  );
}

/** Settings › General's content: the business's details, Answering, and deleting this Desk. */
export function GeneralSettings({ answering, onDelete = fn() }: { answering: string; onDelete?: () => void }) {
  return (
    <>
      <Card as="section" label="Claude acts for you" padding={0}>
        <div className="board-settings__answering">
          <Switch label="Claude acts for you" description={answering} checked onChange={fn()} />
        </div>
      </Card>
      <section aria-labelledby="board-settings-delete" className="board-settings__section board-settings__delete">
        <SectionHeader id="board-settings-delete" title="Delete this Desk" />
        <div className="board-settings__delete-row">
          <p className="board-settings__delete-line board-quiet cd-type-meta">{DELETE_DESK_LINE}</p>
          <Button variant="secondary" size="main" onClick={onDelete}>
            Delete this Desk
          </Button>
        </div>
      </section>
    </>
  );
}

/** Settings › Channels' line over the channels, in the board's words. */
export const CHANNELS_LEAD = 'Where visitors reach this Desk. Each place proves who someone is in its own way; your rules apply everywhere.';

/**
 * Settings › Channels as the web app builds it (N-Run2-Settings-Channels): the line on what a
 * channel is, then the channels. With `banner`, the same page under a line across the app, as the
 * vision story draws it under the vision bar (N-R2-Vision-Channels).
 */
export function ChannelsSettings({ banner, conceptFooterInSidebar = true }: { banner?: ReactNode; conceptFooterInSidebar?: boolean }) {
  return (
    <SettingsPage current="channels" banner={banner} conceptFooterInSidebar={conceptFooterInSidebar}>
      <p className="board-quiet cd-type-body">{CHANNELS_LEAD}</p>
      <ChannelList publicLink={PUBLIC_LINK} />
    </SettingsPage>
  );
}

/** A vision note at the top of a Settings section the prototype doesn't run: the Pill, then its line. */
export function VisionNote({ children }: { children: ReactNode }) {
  return (
    <div className="board-settings__vision">
      <Pill>Mock</Pill>
      <p className="board-quiet cd-type-meta">{children}</p>
    </div>
  );
}
