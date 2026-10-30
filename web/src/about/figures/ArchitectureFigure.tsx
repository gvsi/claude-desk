/**
 * The product proposal's lead figure: v1's two processes and two checkpoints. A visitor or their agent talks
 * to the chat layer, where Claude proposes; the kernel, its own process, decides each action and checks each
 * reply, and signs a ledger of both. Built from boxes, with the connectors drawn in SVG and hidden from screen
 * readers, so the words read in order.
 *
 * Its labels are the v1 diagram's, as the kernel and safety session checked them; a change to any of them goes
 * through that session first.
 */
import { useId } from 'react';

import { Icon, Pill, StatusDot, type StatusTone } from '../../ds/index.ts';

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
  decideRules: 'Cedar rules compiled from the owner’s cards',
  runs: 'Runs',
  ownerDecides: 'Owner decides',
  refused: 'Refused',
  check: 'Check reply',
  checkCards: 'Prices, dates and discounts only in typed cards',
  shown: 'Shown',
  handedOff: 'Handed off',
  ledger: 'Signed ledger of every decision and check',
} as const;

const L = ARCHITECTURE_LABELS;

/** What can come of a check: its word, and the status color the rest of the product gives it. */
interface Outcome {
  word: string;
  tone: StatusTone;
}

const DECIDE: Outcome[] = [
  { word: L.runs, tone: 'handled' },
  { word: L.ownerDecides, tone: 'held' },
  { word: L.refused, tone: 'refused' },
];

const CHECK: Outcome[] = [
  { word: L.shown, tone: 'handled' },
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

/** One of the kernel's checks: its box, then what can come of it, each a pill with a status dot and its word. */
function Check({ name, line, outcomes, compact }: { name: string; line: string; outcomes: Outcome[]; compact: boolean }) {
  const list = (
    <ul className="cd-about-arch__outcomes">
      {outcomes.map(({ word, tone }) => (
        <li key={word}>
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
      <div className="cd-about-arch__box">
        <span className="cd-about-arch__name cd-type-section">{name}</span>
        <span className="cd-about-arch__line cd-type-caption">{line}</span>
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
  return (
    <figure
      className={`cd-about-figure cd-about-arch${compact ? ' cd-about-figure--compact cd-about-arch--compact' : ''}`}
      aria-labelledby={nameId}
    >
      <div className="cd-about-frame cd-about-arch__frame" data-diagram="">
        <div className="cd-about-arch__visitor">
          <div className="cd-about-arch__box cd-about-arch__box--center">
            <span className="cd-about-arch__name cd-type-section">{L.visitor}</span>
            <span className="cd-about-arch__line cd-type-caption">{L.visitorAgent}</span>
          </div>
        </div>
        <Connector direction={compact ? 'down' : 'both'} />
        <div className="cd-about-arch__box cd-about-arch__chat">
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
            <Check name={L.decide} line={L.decideRules} outcomes={DECIDE} compact={compact} />
            <Check name={L.check} line={L.checkCards} outcomes={CHECK} compact={compact} />
          </div>
          <div className={`cd-about-arch__ledger ${compact ? 'cd-type-caption' : 'cd-type-meta'}`}>
            {compact ? null : <Icon name="lock" size={14} />}
            <span>{L.ledger}</span>
          </div>
        </div>
      </div>
      <figcaption className={`cd-about-figcaption ${compact ? 'cd-type-caption' : 'cd-type-article-caption'}`}>
        <span className="cd-about-fignum">Figure 1</span>{' '}
        <span>
          v1 architecture: two processes, two checkpoints.{' '}
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
