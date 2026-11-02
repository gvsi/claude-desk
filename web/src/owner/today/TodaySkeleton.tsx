import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { DeskSummary, UnfinishedSetupStep } from '../../api/views.ts';
import { Skeleton, SkeletonCard, type SkeletonText } from '../../ds/index.ts';
import { rivera } from '../../ds/fixtures/index.ts';
import { useTextLines, type TextPart } from '../../lib/useTextLines.ts';
import { greetingFor } from '../../lib/format.ts';
import { ANSWER_ROOM, THINGS_TO_TRY } from '../arrival/ideas.ts';
import { doneCaption } from '../arrival/doneSignals.ts';
import { STEP_INDEX, STEP_NAMES } from '../../setup/copy.ts';
import { publicLink } from '../customerLink.ts';
import { isLive } from '../useDesks.ts';
import {
  CONTINUE_SETUP_COPY,
  continueSetupLine,
  handledCount,
  howItWorksSteps,
  outcomeWords,
  stepLabel,
  steppedInCount,
  TODAY_COPY,
  todayOutcomes,
  type TodayOutcomesLine,
} from './copy.ts';
import { sinceLastNightLine } from './sinceLastNightLine.ts';

import './Today.css';

const BUTTON = 'cd-button cd-button--secondary cd-button--inline cd-type-control';

// Decision 15: these are the fresh copy's words, used only in invisible measurement probes.
// A different Desk's names, request, rule or recorded activity may land with one accepted move.
const DETAILS = [
  TODAY_COPY.chatDetail,
  `${TODAY_COPY.breakBeforeOwner}${rivera.business.ownerName.split(' ')[0]}${TODAY_COPY.breakAfterOwner}`,
  // The seed's hold went past an automatic rule's limit, so no rule is named (`owner_reads._held_by`).
  TODAY_COPY.waiting,
  TODAY_COPY.createDetail,
] as const;

/** The fresh copy's night (Decision 15): three conversations, Dana's booking and the agent's answer. */
const FRESH_NIGHT = sinceLastNightLine({ conversations: 3, bookings: 1, answers: 1, turned_down: 0 }) ?? '';

/** Intrinsic grid/flex columns take the words' width in the real font, rather than a pill's width. */
function useWordWidth(box: RefObject<HTMLElement | null>, words: string | readonly TextPart[], className: string, intrinsic: boolean) {
  const [width, setWidth] = useState<number>();
  const key = JSON.stringify(typeof words === 'string' ? [words] : words);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element || !intrinsic) return;
    let live = true;
    const measure = () => {
      if (!live || !element.isConnected || element.closest('[data-state="leaving"]')) return;
      const probe = document.createElement('span');
      probe.className = className;
      probe.inert = true;
      probe.setAttribute('aria-hidden', 'true');
      Object.assign(probe.style, { position: 'absolute', visibility: 'hidden', width: 'max-content', maxWidth: 'none' });
      for (const part of JSON.parse(key) as TextPart[]) {
        if (typeof part === 'string') probe.append(part);
        else {
          const span = document.createElement('span');
          span.className = part.className;
          span.textContent = part.text;
          probe.append(span);
        }
      }
      element.append(probe);
      try {
        setWidth(probe.getBoundingClientRect().width);
        const own = getComputedStyle(probe);
        return own.font || `${own.fontStyle} ${own.fontWeight} ${own.fontSize} ${own.fontFamily}`;
      }
      finally { probe.remove(); }
    };
    const font = measure();
    const text = (JSON.parse(key) as TextPart[]).map((part) => typeof part === 'string' ? part : part.text).join('');
    if (font) void document.fonts.load(font, text).then(measure, measure);
    void document.fonts.ready.then(measure);
    document.fonts.addEventListener('loadingdone', measure);
    return () => { live = false; document.fonts.removeEventListener('loadingdone', measure); };
  }, [box, key, className, intrinsic]);
  return intrinsic ? width : undefined;
}

/** Measure known words in their real type and wrapping rules, without leaving words in the layer. */
function TextLines({ words, text = 'meta', className = '', probeClassName = className, anchor, intrinsic = false, lineWidth = '100%', lastWidth = '75%', singleLineClassName }: {
  words: string | readonly TextPart[]; text?: SkeletonText; className?: string; probeClassName?: string; anchor?: string; intrinsic?: boolean;
  lineWidth?: string | number; lastWidth?: string | number; singleLineClassName?: string;
}) {
  const box = useRef<HTMLSpanElement>(null);
  const width = useWordWidth(box, words, `${probeClassName} cd-type-${text}`, intrinsic);
  const count = useTextLines(box, {
    parts: typeof words === 'string' ? [words] : words,
    className: `${probeClassName} cd-type-${text}`,
  }, 1);
  return (
    <span ref={box} className={`${className} cd-today-skeleton__text`} style={width === undefined ? undefined : { width }} data-skeleton-anchor={anchor}>
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} shape="line" text={text} width={i === count - 1 ? lastWidth : lineWidth}
          className={`${typeof lineWidth === 'number' ? 'cd-today-skeleton__fixed-line' : ''} ${count === 1 ? singleLineClassName ?? '' : ''}`} />
      ))}
    </span>
  );
}

const PRESENCE: readonly TextPart[] = [
  { text: '', className: 'cd-today-skeleton__glyph-room' },
  'One person is talking to your Desk right now.',
];

function GreetingWords() {
  const box = useRef<HTMLDivElement>(null);
  const greeting = `${greetingFor(new Date(), 'America/Los_Angeles')}, ${rivera.business.ownerName.split(' ')[0]}`;
  const title = useWordWidth(box, greeting, 'cd-greeting__title cd-type-greeting', true);
  const presence = useWordWidth(box, PRESENCE, 'cd-greeting__presence cd-type-body', true);
  // The words' own width: the greeting's basis beside the link from 640 px, and its width on a phone.
  return <div ref={box} className="cd-greeting__text" style={{ width: Math.max(title ?? 0, presence ?? 0) }}>
    <TextLines words={greeting} text="greeting" probeClassName="cd-greeting__title" anchor="greeting" lastWidth="100%" />
    <TextLines words={PRESENCE} text="body" probeClassName="cd-greeting__presence" lastWidth="80%" lineWidth="80%" singleLineClassName="cd-today-skeleton__presence" />
  </div>;
}

function WordRoom({ words, probeClassName = 'cd-type-meta' }: { words: string; probeClassName?: string }) {
  const box = useRef<HTMLSpanElement>(null);
  const width = useWordWidth(box, words, probeClassName, true);
  return <span ref={box} className="cd-today-skeleton__word-room" style={{ width }} />;
}

function useRows(box: RefObject<HTMLElement | null>) {
  const [rows, setRows] = useState(1);
  useLayoutEffect(() => {
    const element = box.current!;
    const measure = () => {
      if (element.closest('[data-state="leaving"]')) return;
      setRows(new Set([...element.children].map((child) => child.getBoundingClientRect().top)).size);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return rows;
}

/** Reserve the real flex items, then paint the signed full-width pill on each occupied row. */
function Legend() {
  const box = useRef<HTMLDivElement>(null);
  const rows = useRows(box);
  return <div className="cd-today-skeleton__legend">
    <div ref={box} className="cd-week__legend cd-type-meta cd-today-skeleton__legend-room">
      {[handledCount(2), steppedInCount(1)].map((words) => <span key={words} className="cd-week__legend-item"><span className="cd-status-dot" /><WordRoom words={words} /></span>)}
    </div>
    <div className="cd-today-skeleton__legend-paint">
      {Array.from({ length: rows }, (_, i) => <Skeleton key={i} shape="line" text="meta" />)}
    </div>
  </div>;
}

/**
 * The fresh copy's Today line (Decision 15): the night's answer and booking handled, its one request
 * held, nothing turned down.
 */
const FRESH_OUTCOMES = todayOutcomes({ handled: 2, held: 1, turnedDown: 0 });

/** A Desk whose setup isn't finished has most likely been asked nothing yet today. */
const QUIET_OUTCOMES = todayOutcomes({ handled: 0, held: 0, turnedDown: 0 });

/** What the "Not live yet" card needs to be drawn as it will land: the Desk's own words and step. */
export interface SkeletonSetup {
  /** The step setup stopped at. */
  step: UnfinishedSetupStep;
  /** Whether the Desk answers the public, which decides the card's line. */
  answering: boolean;
  /** The business's name, in the card's title. */
  business: string;
}

/**
 * What Today's shapes draw the "Not live yet" card from: the Desk's unfinished setup, or nothing
 * once it is live. Today's own skeleton and the loading page both take it from here, so they agree.
 */
export function skeletonSetupOf(desk: DeskSummary): SkeletonSetup | undefined {
  if (isLive(desk) || !desk.setup) return undefined;
  return { step: desk.setup.step, answering: desk.answering, business: desk.business_name };
}

/**
 * The "Not live yet" card (`ContinueSetup`) in its own classes: the status, the title and the line
 * at their real wrapping, "Continue setup" at its width, and the setup steps, or on a narrow card
 * the one line that says where setup is.
 */
function ContinueSetupShape({ step, answering, business }: SkeletonSetup) {
  const at = STEP_INDEX[step];
  return (
    <div className="cd-continue-setup">
      <SkeletonCard padding={20} anchor="setup-card">
        <div className="cd-continue-setup__body">
          <div className="cd-continue-setup__head">
            <div className="cd-continue-setup__words cd-today-skeleton__setup-words">
              <div className="cd-continue-setup__status cd-type-meta">
                <span className="cd-skeleton-line cd-skeleton-line--meta">
                  <Skeleton
                    shape="block"
                    radius="full"
                    height="var(--cd-skeleton-pill)"
                    measure={{
                      label: CONTINUE_SETUP_COPY.notLive,
                      className: 'cd-status-label cd-type-meta',
                      tagName: 'span',
                      suffix: { className: 'cd-status-dot', width: 'var(--size-dot)' },
                    }}
                    anchor="setup-status"
                  />
                </span>
              </div>
              <TextLines words={[CONTINUE_SETUP_COPY.title, business]} text="section" className="cd-continue-setup__title" anchor="setup-title" />
              <TextLines words={continueSetupLine(step, answering)} text="body" className="cd-continue-setup__line" />
            </div>
            <div className="cd-continue-setup__action">
              <Skeleton
                shape="block"
                measure={{ label: CONTINUE_SETUP_COPY.action, className: 'cd-button cd-button--primary cd-button--inline cd-type-control', tagName: 'a' }}
                height="var(--size-control)"
                anchor="setup-action"
              />
            </div>
          </div>
          <div className="cd-steps-frame">
            <div className="cd-steps cd-type-meta">
              {STEP_NAMES.map((name, i) => (
                <div key={name} className={`cd-steps__step cd-steps__step--${i < at ? 'done' : i === at ? 'current' : 'later'}`}>
                  {i > 0 ? <span className="cd-steps__join" /> : null}
                  <Skeleton shape="circle" size={22} />
                  <TextLines words={name} className="cd-steps__name" intrinsic lineWidth="100%" lastWidth="100%" />
                </div>
              ))}
            </div>
            <div className="cd-steps__compact cd-type-meta">
              <TextLines words={[`Step ${at + 1} of ${STEP_NAMES.length}: `, { text: STEP_NAMES[at]!, className: 'cd-steps__compact-name' }]} />
            </div>
          </div>
        </div>
      </SkeletonCard>
    </div>
  );
}

/**
 * How your Desk works: the three steps, in their real wrapping, then the Today line's rows: the
 * fresh copy's, or for a Desk whose setup isn't finished (`quiet`) the one line of a day nobody has
 * asked it anything yet.
 */
function HowItWorksShape({ quiet }: { quiet: boolean }) {
  return (
    <div className="cd-today__section cd-how">
      <SectionTitle anchor="how-title" />
      <SkeletonCard anchor="how-card">
        <div className="cd-how__steps">
          {howItWorksSteps(rivera.business.name).map((step, i) => (
            <div key={step.title} className="cd-how__step">
              <Skeleton shape="block" width="var(--size-control)" height="var(--size-control)" className="cd-today-skeleton__how-tile" anchor={`how-tile-${i}`} />
              <div className="cd-how__words">
                <TextLines words={stepLabel(i + 1)} className="cd-how__label" intrinsic lineWidth="100%" lastWidth="100%" />
                <TextLines words={step.title} text="control" className="cd-how__title" intrinsic lineWidth="100%" lastWidth="100%" />
                <TextLines words={step.line} className="cd-how__line" />
              </div>
            </div>
          ))}
        </div>
        <TodayLineRows outcomes={quiet ? QUIET_OUTCOMES : FRESH_OUTCOMES} />
      </SkeletonCard>
    </div>
  );
}

/** The Today line: one quiet line in its real wrapping, or else its real flex items, unseen, then one pill on each row they take. */
function TodayLineRows({ outcomes }: { outcomes: TodayOutcomesLine }) {
  if (outcomes.quiet) {
    return <div className="cd-how__today cd-today-skeleton__how-today">
      <TextLines words={outcomes.line} />
    </div>;
  }
  return <TodayLineItems outcomes={outcomes} />;
}

function TodayLineItems({ outcomes }: { outcomes: Extract<TodayOutcomesLine, { quiet: false }> }) {
  const box = useRef<HTMLDivElement>(null);
  const rows = useRows(box);
  return <div className="cd-how__today cd-today-skeleton__how-today">
    <div className="cd-today-skeleton__legend">
      <div ref={box} className="cd-today-skeleton__how-items cd-type-meta cd-today-skeleton__legend-room">
        <span><WordRoom words={outcomes.lead} /></span>
        {outcomes.parts.map((part) => (
          <span key={part.kind} className="cd-how__outcome"><span className="cd-status-dot" /><WordRoom words={outcomeWords(part)} /></span>
        ))}
      </div>
      <div className="cd-today-skeleton__legend-paint cd-today-skeleton__how-paint">
        {Array.from({ length: rows }, (_, i) => <Skeleton key={i} shape="line" text="meta" />)}
      </div>
    </div>
  </div>;
}

/** A fresh hold's status and age can also wrap to two rows in the card's narrow column. */
function ApprovalTop() {
  const box = useRef<HTMLDivElement>(null);
  const rows = useRows(box);
  return <div className="cd-today-skeleton__approval-top">
    <div ref={box} className="cd-approval-card__top cd-type-caption cd-today-skeleton__legend-room">
      <span className="cd-approval-card__status"><span className="cd-status-dot" /><WordRoom words="Waiting for your answer" probeClassName="cd-approval-card__status-line" /></span>
      {/* Decision 15: the held age depends on relativeWait(held_at, now); it may land once at a different width. */}
      <span className="cd-approval-card__waiting"><WordRoom words="Web chat, 12 min ago" probeClassName="cd-type-caption" /></span>
    </div>
    <div className="cd-today-skeleton__approval-top-paint">
      {Array.from({ length: rows }, (_, i) => <Skeleton key={i} shape="line" text="caption" width="80%" />)}
    </div>
  </div>;
}

function AnswerRoom({ label }: { label: string }) {
  const box = useRef<HTMLSpanElement>(null);
  const className = 'cd-button cd-button--secondary cd-button--main cd-type-control';
  const width = useWordWidth(box, label, className, true);
  return <span ref={box} className={className} style={{ minWidth: width }} />;
}

/** A narrow font/platform can put each answer on its own row; the real controls decide that. */
function ApprovalAnswers() {
  const box = useRef<HTMLDivElement>(null);
  const rows = useRows(box);
  return <div className="cd-today-skeleton__answers">
    <div ref={box} className="cd-approval-card__row cd-today-skeleton__legend-room">
      <AnswerRoom label="Allow this time" /><AnswerRoom label="Deny this time" />
    </div>
    <div className="cd-approval-card__row cd-today-skeleton__answers-paint">
      {[0, 1].map((i) => <Skeleton key={i} shape="block" width={rows > 1 ? '100%' : '46%'} height="var(--size-control-main)" className="cd-today-skeleton__answer" />)}
    </div>
  </div>;
}

function SectionTitle({ anchor, caption = false }: { anchor: string; caption?: boolean }) {
  return (
    <div className="cd-section-header">
      <div className="cd-section-header__title">
        <Skeleton shape="line" text="section" width={135} anchor={anchor} />
      </div>
      {caption ? <Skeleton shape="line" text="caption" width={145} /> : null}
    </div>
  );
}

/**
 * The first view of a fresh copy: the band (greeting, link, "Chat as a customer", how the Desk works
 * and four things to try), one held request and the recorded night. Given a Desk whose setup isn't
 * finished (`setup`), the band draws its "Not live yet" card first under the greeting, as Today will.
 */
export function TodaySkeleton({ setup }: { setup?: SkeletonSetup } = {}) {
  return (
    <div className="cd-today cd-today--skeleton">
      <div className="cd-today__band">
        <div className="cd-today__greeting">
          <div className="cd-greeting">
            <GreetingWords />
            <div className="cd-greeting__actions">
              <Skeleton
                shape="block"
                className="cd-today-skeleton__link"
                radius="full"
                measure={{
                  label: publicLink('turner-plumbing-abc123'),
                  className: 'cd-greeting__link cd-type-meta',
                  tagName: 'span',
                  suffix: { className: 'cd-greeting__copy', width: 'calc(var(--size-control) - var(--space-6))' },
                }}
                height="var(--size-control)"
                anchor="link-pill"
              />
              <Skeleton shape="block" className="cd-today-skeleton__action" measure={{ label: 'Chat as a customer', className: BUTTON, tagName: 'a' }} height="var(--size-control)" anchor="header-action" />
            </div>
          </div>
        </div>
        {setup === undefined ? null : <ContinueSetupShape {...setup} />}
        <HowItWorksShape quiet={setup !== undefined} />
        <div className="cd-things">
          <div className="cd-things__head">
            <div className="cd-things__head-line">
              <TextLines words="Things to try" text="section" className="cd-things__title" anchor="things-title" intrinsic lineWidth={85} lastWidth={85} />
              <div className="cd-things__hide">
                <Skeleton shape="block" measure={{ label: 'Hide this list', className: 'cd-button cd-button--ghost cd-button--inline cd-type-control' }} height="var(--size-control)" anchor="things-hide" />
              </div>
            </div>
            <TextLines words={doneCaption(0)} className="cd-things__caption" />
          </div>
          <SkeletonCard padding={16} anchor="things-card">
            <div className="cd-things__list">
              {['Open your public page', 'Show me ideas', 'Open the request', 'Start a Desk'].map((label, i) => (
                <div key={i} className={`cd-things__item cd-today-skeleton__thing-${i}`}>
                  <Skeleton shape="block" width="var(--size-control)" height="var(--size-control)" anchor={`thing-tile-${i}`} />
                  <div className="cd-things__text">
                    <TextLines words={THINGS_TO_TRY[i]!.title} text="control" className="cd-things__item-title" lineWidth="90%" lastWidth="90%" />
                    {label === 'Open the request' ? (
                      <span className="cd-things__detail cd-type-meta" data-room={ANSWER_ROOM}>
                        <span className="cd-things__detail-now">
                          <TextLines words={DETAILS[i]!} probeClassName="cd-things__detail" />
                        </span>
                      </span>
                    ) : <TextLines words={DETAILS[i]!} className="cd-things__detail" />}
                  </div>
                  {/* From 640 px each card's button at its foot; on a phone each row's chevron. */}
                  <div className="cd-things__action">
                    <Skeleton shape="block" measure={{ label, className: BUTTON, tagName: i === 0 || i === 3 ? 'a' : 'button' }} height="var(--size-control)" anchor={`thing-action-${i}`} />
                  </div>
                  <span className="cd-things__go">
                    <Skeleton shape="block" width={16} height={16} anchor={`thing-go-${i}`} />
                  </span>
                </div>
              ))}
            </div>
          </SkeletonCard>
          <TextLines words={TODAY_COPY.vision} className="cd-things__vision" />
        </div>
      </div>
      <div className="cd-today__main">
        <div className="cd-today__section">
          <SectionTitle anchor="needs-title" />
          <SkeletonCard anchor="held-card">
            <ApprovalTop />
            <TextLines words={rivera.decisions.held.reason_plain} text="summary" className="cd-approval-card__reason" lastWidth="var(--cd-today-approval-last-width)" />
            <TextLines words={`From the visitor: “${rivera.conversations.visitor.turns.find((turn) => turn.kind === 'visitor')?.text ?? ''}”`} className="cd-approval-card__context" />
            <div className="cd-approval-card__answers">
              <ApprovalAnswers />
            </div>
          </SkeletonCard>
        </div>
        <div className="cd-today__section">
          <SectionTitle anchor="live-title" caption />
          <div className="cd-live">
            <div className="cd-conversation-item" data-skeleton-anchor="live-row">
              <div className="cd-conversation-item__top">
                <Skeleton shape="line" text="control" width="55%" />
                <Skeleton shape="line" text="caption" width="20%" />
              </div>
              {/* Decision 15: the fresh copy's live visitor, Dana, has written, so her row quotes her. */}
              <div className="cd-conversation-item__quote">
                <Skeleton shape="line" text="meta" width="30%" />
              </div>
            </div>
          </div>
        </div>
        <div className="cd-today__section">
          <SectionTitle anchor="since-title" />
          <SkeletonCard anchor="since-card">
            {/* The box's inset is already taken off the width the words are measured in, so the probe
                carries the type alone, or it would take the inset off again. */}
            <TextLines words={FRESH_NIGHT} text="summary" className="cd-since__line" probeClassName="" />
            <div className="cd-briefing">
              {['booking', 'answer'].map((kind) => (
                <div key={kind} className="cd-briefing__item">
                  <div className="cd-briefing-row">
                    {/* Decision 15: the time column depends on the copy's opening clock; it may land once at a different width. */}
                    <Skeleton shape="line" text="caption" width={86} />
                    <span className="cd-briefing-row__kind cd-type-meta">
                      <span className="cd-status-label">
                        <Skeleton shape="circle" size={6} />
                        <TextLines words={kind === 'booking' ? 'Booked' : 'Answered'} intrinsic lineWidth={58} lastWidth={58} />
                      </span>
                    </span>
                    <div className="cd-briefing-row__words">
                      {kind === 'booking' ? (
                        <>
                          <TextLines words={rivera.people.dana.name} lastWidth="100%" />
                          <TextLines words={rivera.bookingReasonPlain} className="cd-briefing-row__line" />
                        </>
                      ) : (
                        <TextLines words={['Claude answered ', { text: rivera.conversations.alexAgent.name, className: 'cd-user-name' }, '.']} className="cd-briefing-row__line" />
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </SkeletonCard>
        </div>
      </div>
      <div className="cd-today-aside">
        <div className="cd-today__section">
          <SectionTitle anchor="week-title" />
          <SkeletonCard padding={16} anchor="week-card">
            <div className="cd-week">
              <div className="cd-week__part">
                <Skeleton shape="line" text="figure" width="45%" />
                <Skeleton shape="line" text="meta" width="70%" />
                <div className="cd-week__bars">
                  {[0, 1, 2, 3, 4, 5, 6].map((i) => (
                    <div key={i} className="cd-week__day">
                      <div className="cd-week__bar-room">
                        <Skeleton
                          shape="block"
                          width="var(--space-24)"
                          height={i === 6 ? 'calc(var(--space-40) + var(--space-16))' : 'var(--space-2)'}
                          anchor={`week-bar-${i}`}
                        />
                      </div>
                      <Skeleton shape="line" text="caption" width="50%" />
                    </div>
                  ))}
                </div>
              </div>
              <div className="cd-week__part">
                <TextLines words={TODAY_COPY.handledTitle} text="control" className="cd-week__title" lineWidth="70%" lastWidth="70%" />
                <Skeleton shape="block" height="var(--space-6)" />
                <Legend />
              </div>
              <div className="cd-week__part">
                <Skeleton shape="line" text="control" width="70%" />
                <TextLines words={TODAY_COPY.turnedDownEmpty} className="cd-week__line" lineWidth="65%" lastWidth="65%" />
                <Skeleton shape="line" text="meta" width="30%" />
              </div>
            </div>
          </SkeletonCard>
        </div>
      </div>
    </div>
  );
}
