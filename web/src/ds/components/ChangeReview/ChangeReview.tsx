import { useRef, useState, type ReactNode } from 'react';

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
   * Called once per click; the button then waits until `pending` clears, `error` shows a new
   * message, or the promise it returns rejects.
   */
  onConfirm: () => void | Promise<unknown>;
  onCancel: () => void;
  /** The draft changes something the screen shows above it, such as the money limit, so it can be confirmed with no rows. */
  hasOtherChanges?: boolean;
  /** The confirm is in flight: "Confirming". */
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

const CHECK_HEADINGS = {
  checked: 'Checked before you confirm',
  failed: "This change can't be applied",
  unavailable: "Rules can't be checked right now",
} as const satisfies Record<ChangeReviewProps['checks']['status'], string>;

/** The fields shown on a side's line of words. */
const WORD_FIELDS: readonly RuleField[] = ['who', 'limits', 'hours', 'review'];

/** The confirm click that waits for its result, and the screen's `pending` and `error` it last saw. */
interface ConfirmLock {
  click: number;
  sawPending: boolean;
  error: string | undefined;
}

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

/** The connector's name and badge, then the side's words, joined by " · ". */
function MetaLine({ connector, words, tag }: { connector?: ConnectorView; words: readonly RuleWord[]; tag?: boolean }) {
  const text = joinWords(words);
  const parts: ReactNode[] = [];
  if (connector) parts.push(<ConnectorName key="connector" connector={connector} size="inline" />);
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

function Row({ row }: { row: ChangeRowView }) {
  const single = row.after ?? row.before;
  const showsBoth = row.change === 'changed' && row.before !== null && row.after !== null;
  return (
    <li className="cd-change-review__row">
      <span className="cd-change-review__tag cd-type-caption">{TAGS[row.change] ?? TAGS.changed}</span>
      <div className="cd-change-review__body">
        <p className="cd-change-review__title cd-type-body">{row.title}</p>
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
            <MetaLine connector={row.connector} words={single.words} />
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
  pending = false,
  error,
}: ChangeReviewProps) {
  const checked = checks.status === 'checked';
  const failed = error !== undefined && error.trim() !== '';
  const canConfirm = rows.length > 0 || hasOtherChanges;

  // One click waits for its result: until `pending` has come and gone, `error` shows a new
  // message, or the promise onConfirm returned rejects.
  const [lock, setLock] = useState<ConfirmLock | null>(null);
  const clicks = useRef(0);
  let locked = false;
  if (lock !== null) {
    if (pending) {
      locked = true;
      if (!lock.sawPending) setLock({ ...lock, sawPending: true });
    } else if (lock.sawPending || (failed && error !== lock.error)) {
      setLock(null);
    } else {
      locked = true;
    }
  }
  const waiting = pending || locked;

  const confirm = () => {
    if (waiting || !checked) return;
    clicks.current += 1;
    const click = clicks.current;
    setLock({ click, sawPending: false, error });
    const sent = onConfirm();
    if (sent !== undefined && typeof sent.then === 'function') {
      sent.then(undefined, () => setLock((current) => (current !== null && current.click === click ? null : current)));
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
      <div className="cd-change-review__controls">
        {canConfirm ? (
          <Button variant="primary" size="main" disabled={!checked} busy={checked && waiting} onClick={confirm}>
            {pending ? 'Confirming' : confirmLabel}
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
