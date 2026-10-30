import { useEffect, useRef, useState, type ReactNode } from 'react';

import { Button } from '../Button/Button.tsx';
import { Card } from '../Card/Card.tsx';
import { ConnectorName, type ConnectorView } from '../ConnectorName/ConnectorName.tsx';
import { Notice } from '../Notice/Notice.tsx';
import { OUTCOME_TONE, outcomePhrase, type RuleMode } from '../OutcomeMenu/outcomeWords.ts';
import type { RuleWord } from '../RuleRow/RuleRow.tsx';
import { StatusLabel } from '../StatusDot/StatusDot.tsx';
import type { RuleField } from './ruleDiff.ts';

import './ChangeReview.css';

/** One side of a change: what a rule enforces before or after it, in the screen's words. */
export interface ChangeSide {
  /** What the rule applies to, in the screen's words: "Payment link", "Every tool that charges money". */
  appliesTo?: string;
  mode: RuleMode;
  /** The formatted amount limit of an auto card ("$300"). */
  limit?: string;
  reason: string;
  words: readonly RuleWord[];
}

/** One row of a proved change, built by the screen from `ruleDiff` or from the tools it turns on. */
export interface ChangeRowView {
  key: string;
  change: 'added' | 'removed' | 'changed' | 'turned_on';
  /** The tool the rule is about: "Payment link". */
  title: string;
  connector?: ConnectorView;
  before: ChangeSide | null;
  after: ChangeSide | null;
  /** For a changed row, the fields that differ (`RuleDiffRow.fields`). */
  changed: readonly RuleField[];
}

export interface ChangeReviewProps {
  rows: readonly ChangeRowView[];
  /** The proof report in the screen's words (Plan 04's `checkStatus`). Only `checked` can be confirmed. */
  checks: { status: 'checked' | 'failed' | 'unavailable'; lines: readonly string[] };
  /** The primary button's words: "Confirm change" by default; "Confirm and turn on". */
  confirmLabel?: string;
  /** The secondary button's words: "Keep my rules" by default; "Back". */
  cancelLabel?: string;
  /**
   * Called once per click; the button then waits until `pending` clears, an error is delivered
   * (one appears, or another replaces it), or the promise it returns rejects.
   */
  onConfirm: () => void | Promise<unknown>;
  onCancel: () => void;
  /** The draft changes something the screen shows above it, such as the money limit, so it can be confirmed with no rows. */
  hasOtherChanges?: boolean;
  /**
   * The change can cancel open payment links Claude made on its own (a preset switch, a lowered
   * money limit), so the fixed line says so above the buttons. The screen decides; a raised limit
   * cancels none.
   */
  cancelsLinks?: boolean;
  /** The confirm is in flight: the confirm keeps its label under the busy spinner. */
  pending?: boolean;
  /** The screen's message when the confirm failed; confirm works again. */
  error?: string;
}

const TAGS = {
  added: 'Added',
  removed: 'Removed',
  changed: 'Changed',
  turned_on: 'Turned on',
} as const satisfies Record<ChangeRowView['change'], string>;

/** What applying such a change does to open payment links, in Claude's first person. */
const CANCELS_LINKS = "Open payment links I made on my own that the new rules don't allow will be cancelled.";

const CHECK_HEADINGS = {
  checked: 'Checked before you confirm',
  failed: "This change can't be applied",
  unavailable: "Rules can't be checked right now",
} as const satisfies Record<ChangeReviewProps['checks']['status'], string>;

/** The fields shown on a side's line of words. */
const WORD_FIELDS: readonly RuleField[] = ['who', 'limits', 'hours', 'review'];

function joinWords(words: readonly RuleWord[]): string {
  return words
    .map((word) => word.text.trim())
    .filter((text) => text !== '')
    .join(' · ');
}

/** "Changed", in words beside a line whose field changed. */
function ChangedTag() {
  return <span className="cd-change-review__changed cd-type-caption">Changed</span>;
}

/** A side's outcome: the dot and the phrase. */
function Outcome({ side }: { side: ChangeSide }) {
  return (
    <span className="cd-change-review__outcome cd-type-meta">
      <StatusLabel tone={OUTCOME_TONE[side.mode]}>{outcomePhrase(side.mode, side.limit)}</StatusLabel>
    </span>
  );
}

/** The connector's name and badge, then what the rule applies to, then the side's words, joined by " · ". */
function MetaLine({
  connector,
  appliesTo,
  words,
  tag,
}: {
  connector?: ConnectorView;
  appliesTo?: string;
  words: readonly RuleWord[];
  tag?: boolean;
}) {
  const text = joinWords(words);
  const target = appliesTo?.trim() ?? '';
  const parts: ReactNode[] = [];
  if (connector) parts.push(<ConnectorName key="connector" connector={connector} size="inline" />);
  if (target !== '') parts.push(<span key="target">{target}</span>);
  if (text !== '') parts.push(<span key="words">{text}</span>);
  if (parts.length === 0) return null;
  return (
    <p className="cd-change-review__meta cd-type-meta">
      {parts.flatMap((part, index) => (index === 0 ? [part] : [<span key={`sep-${index}`}> · </span>, part]))}
      {tag ? (
        <>
          {' '}
          <ChangedTag />
        </>
      ) : null}
    </p>
  );
}

/** A changed rule's side, Before or After; the after side tags each line whose field changed. */
function Side({ label, side, changed }: { label: 'Before' | 'After'; side: ChangeSide; changed: readonly RuleField[] | null }) {
  const has = (field: RuleField) => changed?.includes(field) === true;
  return (
    <div role="group" aria-label={label} className="cd-change-review__side">
      <p className="cd-change-review__side-label cd-type-caption">{label}</p>
      <div className="cd-change-review__side-main">
        <div className="cd-change-review__side-text">
          {hasTarget(side) ? (
            <p className="cd-change-review__meta cd-change-review__target cd-type-meta">
              {side.appliesTo}
              {has('applies_to') ? (
                <>
                  {' '}
                  <ChangedTag />
                </>
              ) : null}
            </p>
          ) : null}
          <MetaLine words={side.words} tag={WORD_FIELDS.some(has)} />
          <p className="cd-change-review__reason cd-type-body">
            {side.reason}
            {has('reason') ? (
              <>
                {' '}
                <ChangedTag />
              </>
            ) : null}
          </p>
        </div>
        <span className="cd-change-review__side-outcome">
          <Outcome side={side} />
          {has('mode') ? <ChangedTag /> : null}
        </span>
      </div>
    </div>
  );
}

/** True when the side says what its rule applies to. */
function hasTarget(side: ChangeSide | null): boolean {
  return side?.appliesTo !== undefined && side.appliesTo.trim() !== '';
}

function Row({ row }: { row: ChangeRowView }) {
  const single = row.after ?? row.before;
  const showsBoth = row.change === 'changed' && row.before !== null && row.after !== null;
  // A changed target is tagged on the after side's target line; without the screen's words for
  // it, the title carries the tag, so the change is never unmarked.
  const untaggedTarget = showsBoth && row.changed.includes('applies_to') && !(hasTarget(row.before) && hasTarget(row.after));
  return (
    <li className="cd-change-review__row">
      <span className="cd-change-review__tag cd-type-caption">{TAGS[row.change] ?? TAGS.changed}</span>
      <div className="cd-change-review__body">
        <p className="cd-change-review__title cd-type-body">
          {row.title}
          {untaggedTarget ? (
            <>
              {' '}
              <ChangedTag />
            </>
          ) : null}
        </p>
        {showsBoth && row.before && row.after ? (
          <>
            <MetaLine connector={row.connector} words={[]} />
            <div className="cd-change-review__sides">
              <Side label="Before" side={row.before} changed={null} />
              <Side label="After" side={row.after} changed={row.changed} />
            </div>
          </>
        ) : single ? (
          <>
            <MetaLine connector={row.connector} appliesTo={single.appliesTo} words={single.words} />
            <p className="cd-change-review__reason cd-type-body">{single.reason}</p>
          </>
        ) : null}
      </div>
      {!showsBoth && single ? <Outcome side={single} /> : null}
    </li>
  );
}

/**
 * A proved change before it applies: a rule draft, a connector turned on, a changed tool turned
 * back on. A row per change with the enforced words before and after, the checks, and one
 * confirm, enabled only when the checks passed. Turning a connector off needs no proof, so it has
 * a plain confirm instead (`ConnectionPanel`).
 */
export function ChangeReview({
  rows,
  checks,
  confirmLabel = 'Confirm change',
  cancelLabel = 'Keep my rules',
  onConfirm,
  onCancel,
  hasOtherChanges = false,
  cancelsLinks = false,
  pending = false,
  error,
}: ChangeReviewProps) {
  const checked = checks.status === 'checked';
  const failed = error !== undefined && error.trim() !== '';
  const canConfirm = rows.length > 0 || hasOtherChanges;

  // One click waits for its result: until `pending` has come and gone, an error is delivered, or
  // the promise onConfirm returned rejects. An error is delivered each time one appears or another
  // replaces it, so the same words after a cleared error release the button again; clearing an
  // error, as a screen does when a confirm starts, releases nothing. The ref is set in the click
  // itself, so a second click before the screen re-renders sends nothing.
  const [clicked, setClicked] = useState<number | null>(null);
  const sent = useRef(false);
  const clicks = useRef(0);
  const release = () => {
    sent.current = false;
    setClicked(null);
  };
  const sawPending = useRef(pending);
  useEffect(() => {
    const ended = sawPending.current && !pending;
    sawPending.current = pending;
    if (ended) release();
  }, [pending]);
  const delivered = useRef(failed ? error : undefined);
  useEffect(() => {
    const now = failed ? error : undefined;
    const before = delivered.current;
    delivered.current = now;
    if (now !== undefined && now !== before) release();
  }, [failed, error]);
  const waiting = pending || clicked !== null;

  const confirm = () => {
    if (sent.current || waiting || !checked) return;
    sent.current = true;
    clicks.current += 1;
    const click = clicks.current;
    setClicked(click);
    const result = onConfirm();
    if (result !== undefined && typeof result.then === 'function') {
      // A rejection releases only its own click.
      result.then(undefined, () => {
        if (clicks.current !== click) return;
        sent.current = false;
        setClicked((current) => (current === click ? null : current));
      });
    }
  };

  const status = Object.hasOwn(CHECK_HEADINGS, checks.status) ? checks.status : 'unavailable';
  return (
    <div className="cd-change-review" aria-busy={waiting || undefined}>
      <Card as="section" label="Changes" padding={16}>
        <p className="cd-change-review__heading cd-type-control">Changes</p>
        {rows.length > 0 ? (
          <ul className="cd-change-review__rows">
            {rows.map((row) => (
              <Row key={row.key} row={row} />
            ))}
          </ul>
        ) : (
          <p className="cd-change-review__empty cd-type-body">{hasOtherChanges ? 'Your rules stay the same.' : 'No rules change.'}</p>
        )}
      </Card>
      <Card as="section" label={CHECK_HEADINGS[status]} padding={16}>
        <p className="cd-change-review__heading cd-type-control">{CHECK_HEADINGS[status]}</p>
        {checks.lines.length > 0 ? (
          <ul className="cd-change-review__checks cd-type-meta">
            {checks.lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : null}
      </Card>
      {cancelsLinks ? <p className="cd-change-review__cancels cd-type-body">{CANCELS_LINKS}</p> : null}
      <div className="cd-change-review__controls">
        {canConfirm ? (
          <Button variant="primary" size="main" disabled={!checked} busy={checked && waiting} onClick={confirm}>
            {confirmLabel}
          </Button>
        ) : null}
        <Button variant="secondary" size="main" waiting={waiting} onClick={() => onCancel()}>
          {cancelLabel}
        </Button>
      </div>
      {failed && !pending ? <Notice tone="error">{error}</Notice> : null}
    </div>
  );
}
