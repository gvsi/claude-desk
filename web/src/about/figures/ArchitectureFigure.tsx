/**
 * The first release's architecture, drawn for the reading page's hero width: v1's two processes and two checkpoints.
 * It opened the product proposal until the launch film took its place (owner, 2026-11-02), and a document can still
 * open with it (`documents.ts`); its side-by-side layout doesn't fit the article's column. A visitor or their agent talks
 * to the chat layer, where Claude proposes; the kernel, its own process, decides each action and checks each
 * reply, and signs a ledger of both. Built from boxes, with the connectors drawn in SVG and hidden from screen
 * readers, so the words read in order.
 *
 * Its labels are the v1 diagram's, as the kernel and safety session checked them; a change to any of them goes
 * through that session first. Each check says two lines, as the proposal's "Enforced in code" tiers do: what code
 * decides, then what the models may do.
 *
 * The first time it is a third in view, it traces one request along that path, once (`usePlayOnce`, `reader.css`).
 */
import { useId, type CSSProperties } from 'react';

import { Icon, Pill, StatusDot, type StatusTone } from '../../ds/index.ts';
import { usePlayOnce } from './usePlayOnce.ts';

import '../reader.css';

/** The diagram's labels: the figure's accessible name, then each label in reading order. */
export const ARCHITECTURE_LABELS = {
  name: 'Claude proposes; the kernel decides what runs and what is shown',
  visitor: 'Visitor',
  visitorAgent: 'or their agent',
  chat: 'Chat layer',
  chatProposes: 'Claude proposes each action and drafts each reply',
  chatCredential: 'No business credential',
  kernel: 'Kernel',
  kernelProcess: 'Its own process; holds every business credential',
  decide: 'Decide',
  decideRules: 'Cedar rules from the owner’s cards',
  decideReview: 'A Sonnet review can only narrow',
  runs: 'Runs',
  ownerDecides: 'Owner decides',
  refused: 'Refused',
  check: 'Check reply',
  checkCards: 'Prices, dates and discounts only in typed cards',
  checkModels: 'Sonnet and Jev can only add blocks',
  shown: 'Shown',
  handedOff: 'Handed off',
  ledger: 'Signed ledger of every decision and check',
} as const;

const L = ARCHITECTURE_LABELS;

/** Emphasize the known technologies without changing the checked label's text. */
function technologyNames(label: string) {
  return label.split(/\b(Cedar|Sonnet|Jev)\b/g).map((part, i) =>
    i % 2 === 1 ? <span key={i} className="cd-about-arch__tech">{part}</span> : part,
  );
}

/**
 * The path the figure traces, in order: the visitor, the chat layer, the kernel's Decide and an action that runs,
 * Check reply and a reply that is shown, then the signed ledger.
 */
const TRACE = ['visitor', 'chat', 'decide', 'runs', 'check', 'shown', 'ledger'] as const;

type TraceStep = (typeof TRACE)[number];

/** A step's place on the path, from which its turn to light is worked out. */
type StepStyle = CSSProperties & { '--cd-arch-i': number };

/** The hook that names a step of the trace, and its place on the path. */
function traced(step: TraceStep): { 'data-arch-step': TraceStep; style: StepStyle } {
  return { 'data-arch-step': step, style: { '--cd-arch-i': TRACE.indexOf(step) } };
}

/** What can come of a check: its word, the status color the rest of the product gives it, and its step if traced. */
interface Outcome {
  word: string;
  tone: StatusTone;
  step?: TraceStep;
}

const DECIDE: Outcome[] = [
  { word: L.runs, tone: 'handled', step: 'runs' },
  { word: L.ownerDecides, tone: 'held' },
  { word: L.refused, tone: 'refused' },
];

const CHECK: Outcome[] = [
  { word: L.shown, tone: 'handled', step: 'shown' },
  { word: L.handedOff, tone: 'held' },
];

export interface ArchitectureFigureProps {
  /** The phone layout: the boxes stacked, top to bottom. */
  compact?: boolean;
}

/** A connector between two boxes, pointing right or down; `both` points both ways. */
function Connector({ direction }: { direction: 'right' | 'both' | 'down' }) {
  if (direction === 'down') {
    return (
      <span className="cd-about-arch__link cd-about-arch__link--down" aria-hidden="true">
        <svg className="cd-about-arch__connector" width={12} height={22} viewBox="0 0 12 22">
          <path d="M6 1v19" />
          <path d="m1 15 5 5 5-5" />
        </svg>
      </span>
    );
  }
  return (
    <span className="cd-about-arch__link" aria-hidden="true">
      <svg className="cd-about-arch__connector" width={28} height={12} viewBox="0 0 28 12">
        {direction === 'both' ? (
          <>
            <path d="M2 6h24" />
            <path d="m6 2-4 4 4 4" />
            <path d="m22 2 4 4-4 4" />
          </>
        ) : (
          <>
            <path d="M1 6h25" />
            <path d="m21 1 5 5-5 5" />
          </>
        )}
      </svg>
    </span>
  );
}

/**
 * One of the kernel's checks: its box, with its name and its two lines (what code decides, then what the models may
 * do), then what can come of it, each a pill with a status dot and its word. The box is a step of the trace, and so
 * is one outcome's pill, through the hook on its list item.
 */
function Check({
  name,
  lines,
  step,
  outcomes,
  compact,
}: {
  name: string;
  lines: readonly [string, string];
  step: TraceStep;
  outcomes: Outcome[];
  compact: boolean;
}) {
  const list = (
    <ul className="cd-about-arch__outcomes">
      {outcomes.map(({ word, tone, step: outcome }) => (
        <li key={word} {...(outcome ? traced(outcome) : {})}>
          <Pill>
            <StatusDot tone={tone} />
            {word}
          </Pill>
        </li>
      ))}
    </ul>
  );
  return (
    <div className="cd-about-arch__check">
      <div className="cd-about-arch__box" {...traced(step)}>
        <span className="cd-about-arch__name cd-type-section">{name}</span>
        {lines.map((line) => (
          <span key={line} className="cd-about-arch__line cd-type-caption">
            {technologyNames(line)}
          </span>
        ))}
        {compact ? list : null}
      </div>
      {compact ? null : (
        <>
          <Connector direction="right" />
          {list}
        </>
      )}
    </div>
  );
}

export function ArchitectureFigure({ compact = false }: ArchitectureFigureProps) {
  const nameId = `${useId()}-name`;
  const [ref, play] = usePlayOnce<HTMLElement>('architecture');
  return (
    <figure
      ref={ref}
      className={`cd-about-figure cd-about-arch${compact ? ' cd-about-figure--compact cd-about-arch--compact' : ''}`}
      aria-labelledby={nameId}
      data-play={play ?? undefined}
    >
      <div className="cd-about-frame cd-about-arch__frame" data-diagram="">
        <div className="cd-about-arch__visitor">
          <div className="cd-about-arch__box cd-about-arch__box--center" {...traced('visitor')}>
            <span className="cd-about-arch__name cd-type-section">{L.visitor}</span>
            <span className="cd-about-arch__line cd-type-caption">{L.visitorAgent}</span>
          </div>
        </div>
        <Connector direction={compact ? 'down' : 'both'} />
        <div className="cd-about-arch__box cd-about-arch__chat" {...traced('chat')}>
          <span>
            <span className="cd-about-arch__kicker cd-type-caption">{L.chat}</span>
            <span className="cd-about-arch__proposes cd-type-article-body-phone">{L.chatProposes}</span>
          </span>
          <span className="cd-about-arch__line cd-about-arch__credential cd-type-caption">{L.chatCredential}</span>
        </div>
        <Connector direction={compact ? 'down' : 'right'} />
        <div className="cd-about-arch__kernel">
          <div className="cd-about-arch__kernel-head">
            <span className="cd-about-arch__kicker cd-about-arch__kicker--kernel cd-type-caption">{L.kernel}</span>
            <span className="cd-about-arch__line cd-type-caption">{L.kernelProcess}</span>
          </div>
          <div className="cd-about-arch__checks">
            <Check
              name={L.decide}
              lines={[L.decideRules, L.decideReview]}
              step="decide"
              outcomes={DECIDE}
              compact={compact}
            />
            <Check
              name={L.check}
              lines={[L.checkCards, L.checkModels]}
              step="check"
              outcomes={CHECK}
              compact={compact}
            />
          </div>
          <div className={`cd-about-arch__ledger ${compact ? 'cd-type-caption' : 'cd-type-meta'}`} {...traced('ledger')}>
            {compact ? null : <Icon name="lock" size={14} />}
            <span>{L.ledger}</span>
          </div>
        </div>
      </div>
      <figcaption className={`cd-about-figcaption ${compact ? 'cd-type-caption' : 'cd-type-article-caption'}`}>
        <span className="cd-about-fignum">Figure 1</span>{' '}
        <span>
          The first release’s architecture: two processes, two checkpoints.{' '}
          {/* The phone board keeps the caption short; the name is still read there. */}
          <span className={compact ? 'cd-sr-only' : undefined}>
            <span id={nameId} data-figure-label="">
              {L.name}
            </span>
            .
          </span>
        </span>
      </figcaption>
    </figure>
  );
}
