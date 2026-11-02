import type { ReactNode } from 'react';

import { Button } from '../Button/Button.tsx';
import { useSendOnce } from '../Button/useSendOnce.ts';
import { Card } from '../Card/Card.tsx';
import { ConnectorName, type ConnectorView } from '../ConnectorName/ConnectorName.tsx';
import { Notice } from '../Notice/Notice.tsx';
import { OUTCOME_TONE, outcomePhrase, type RuleMode } from '../OutcomeMenu/outcomeWords.ts';
import type { RuleWord } from '../RuleRow/RuleRow.tsx';
import { ToolTitleList, namesATool, type ToolTitles } from '../RuleRow/ToolTitles.tsx';
import { StatusLabel } from '../StatusDot/StatusDot.tsx';
import type { RuleField } from './ruleDiff.ts';

import './ChangeReview.css';

/**
 * What a rule is about: the tools it names by their titles (`{ titles: ['Payment link'] }`), each
 * the tool's own words and shown as its own user-text item, or the screen's own words for a group
 * of tools ("Every tool that charges money").
 */
export type RuleTarget = ToolTitles | string;

/** One side of a change: what a rule enforces before or after it, in the screen's words. */
export interface ChangeSide {
  /** What the rule applies to: `{ titles: ['Payment link'] }`, or a group's words, "Every tool that charges money". */
  appliesTo?: RuleTarget;
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
  /**
   * What the rule is about: the tools it names (`{ titles: ['Payment link', 'Refund'] }`, shown
   * "Payment link and Refund"), or a group's words ("Every tool that charges money").
   */
  title: RuleTarget;
  connector?: ConnectorView;
  /**
   * The rule is on a group of tools, such as every tool that charges money: the meta line says
   * "Shared rule" after `connector`, the one connector all those tools share, or first when they
   * have none in common. Unset when the rule moves between one tool and a group: the sides'
   * `appliesTo` show that move.
   */
  shared?: boolean;
  before: ChangeSide | null;
  after: ChangeSide | null;
  /** For a changed row, the fields that differ (`RuleDiffRow.fields`). */
  changed: readonly RuleField[];
}

export interface ChangeReviewProps {
  rows: readonly ChangeRowView[];
  /** The proof report in the screen's words (Plan 04's `checkStatus`). Only `checked` can be confirmed. */
  checks: {
    status: 'checked' | 'failed' | 'unavailable';
    lines: readonly string[];
  };
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

/** A side's outcome: the dot and the phrase, in weight 520 when it is what changed. */
function Outcome({ side, strong = false }: { side: ChangeSide; strong?: boolean }) {
  return (
    <span className={`cd-change-review__outcome cd-type-meta${strong ? ' cd-change-review__strong' : ''}`}>
      <StatusLabel tone={OUTCOME_TONE[side.mode]}>{outcomePhrase(side.mode, side.limit)}</StatusLabel>
    </span>
  );
}

/** True when `target` says something: a tool's title, or a group's words. */
function says(target: RuleTarget | undefined): target is RuleTarget {
  if (target === undefined) return false;
  return typeof target === 'string' ? target.trim() !== '' : namesATool(target);
}

/** A target as it reads: a group's words as they are, each tool's title its own user-text item. */
function Target({ target }: { target: RuleTarget }) {
  return typeof target === 'string' ? target : <ToolTitleList titles={target.titles} />;
}

/** What a row's meta line says after the connector when its rule is shared by several tools. */
const SHARED_RULE = 'Shared rule';

/**
 * The connector's name, then "Shared rule" for a shared rule, then the side's words, joined by " · ".
 * What the rule applies to isn't said here: the row's title names it, and a side names it when it
 * isn't the title. A built-in connector is named alone; an external one keeps its Mock badge
 * (`ConnectorName`), so a mock is never named without saying so.
 */
function MetaLine({
  connector,
  shared = false,
  words,
  tag,
  strong,
}: {
  connector?: ConnectorView;
  shared?: boolean;
  words: readonly RuleWord[];
  tag?: boolean;
  /** The line's value changed: in weight 520. */
  strong?: boolean;
}) {
  const text = joinWords(words);
  const parts: ReactNode[] = [];
  // The review's rows name the connector without "Built in"; an app keeps its Mock badge.
  if (connector) parts.push(<ConnectorName key="connector" connector={connector} size="inline" hideBuiltIn />);
  if (shared) parts.push(<span key="shared">{SHARED_RULE}</span>);
  if (text !== '') parts.push(<span key="words">{text}</span>);
  if (parts.length === 0) return null;
  return (
    <p className={`cd-change-review__meta cd-type-meta${strong ? ' cd-change-review__strong' : ''}`}>
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

/**
 * One side of a rule, Before or After, under its label beside a 2 px bar: the refused tone for what
 * goes, the handled tone for what applies. The words stay neutral; on the after side of a changed
 * rule, each line whose field changed, the outcome included, is in weight 520 and tagged "Changed".
 */
function Side({ label, side, changed }: { label: 'Before' | 'After'; side: ChangeSide; changed: readonly RuleField[] | null }) {
  const has = (field: RuleField) => changed?.includes(field) === true;
  const wordsChanged = WORD_FIELDS.some(has);
  return (
    <div role="group" aria-label={label} className={`cd-change-review__side cd-change-review__side--${label === 'Before' ? 'before' : 'after'}`}>
      <p className="cd-change-review__side-label cd-type-caption">{label}</p>
      <div className="cd-change-review__side-main">
        <div className="cd-change-review__side-text">
          {hasTarget(side) ? (
            <p className={`cd-change-review__meta cd-change-review__target cd-type-meta${has('applies_to') ? ' cd-change-review__strong' : ''}`}>
              {side.appliesTo === undefined ? null : <Target target={side.appliesTo} />}
              {has('applies_to') ? (
                <>
                  {' '}
                  <ChangedTag />
                </>
              ) : null}
            </p>
          ) : null}
          <MetaLine words={side.words} tag={wordsChanged} strong={wordsChanged} />
          <p className={`cd-change-review__reason cd-type-body${has('reason') ? ' cd-change-review__strong' : ''}`}>
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
          <Outcome side={side} strong={has('mode')} />
          {has('mode') ? <ChangedTag /> : null}
        </span>
      </div>
    </div>
  );
}

/** True when the side says what its rule applies to. */
function hasTarget(side: ChangeSide | null): boolean {
  return says(side?.appliesTo);
}

/** Whether two targets name the same tools, or are the same group's words. */
function sameTarget(a: RuleTarget, b: RuleTarget): boolean {
  if (typeof a === 'string' || typeof b === 'string') return typeof a === typeof b && String(a).trim() === String(b).trim();
  return a.titles.length === b.titles.length && a.titles.every((title, index) => title === b.titles[index]);
}

/** The side without what it applies to. */
function withoutTarget({ appliesTo: _target, ...side }: ChangeSide): ChangeSide {
  return side;
}

function Row({ row }: { row: ChangeRowView }) {
  const shown = row.after ?? row.before;
  // A row with one side names its target once, in its title, as a changed row does: a target that is
  // the title isn't said again on the meta line or the side.
  const single = shown && shown.appliesTo !== undefined && sameTarget(shown.appliesTo, row.title) ? withoutTarget(shown) : shown;
  const showsBoth = row.change === 'changed' && row.before !== null && row.after !== null;
  // A changed target is tagged on the after side's target line; without the screen's words for
  // it, the title carries the tag, so the change is never unmarked.
  const untaggedTarget = showsBoth && row.changed.includes('applies_to') && !(hasTarget(row.before) && hasTarget(row.after));
  return (
    <li className="cd-change-review__row">
      <span className="cd-change-review__tag cd-type-caption">{TAGS[row.change] ?? TAGS.changed}</span>
      <div className="cd-change-review__body">
        <p className="cd-change-review__title cd-type-body">
          <Target target={row.title} />
          {untaggedTarget ? (
            <>
              {' '}
              <ChangedTag />
            </>
          ) : null}
        </p>
        {showsBoth && row.before && row.after ? (
          <>
            <MetaLine connector={row.connector} shared={row.shared} words={[]} />
            <div className="cd-change-review__sides">
              <Side label="Before" side={row.before} changed={null} />
              <Side label="After" side={row.after} changed={row.changed} />
            </div>
          </>
        ) : single ? (
          <>
            <MetaLine connector={row.connector} shared={row.shared} words={single.words} />
            <div className="cd-change-review__sides">
              {/* A removed rule is what goes; an added rule, or a tool turned on, is what applies. */}
              <Side label={row.after ? 'After' : 'Before'} side={single} changed={null} />
            </div>
          </>
        ) : null}
      </div>
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

  // One click waits for its result (`useSendOnce`): until `pending` has come and gone, an error is
  // delivered, the promise onConfirm returned rejects, or onConfirm throws.
  const { waiting, send } = useSendOnce<'confirm'>(pending, error);

  const confirm = () => {
    if (!checked) return;
    send('confirm', () => onConfirm());
  };

  const status = Object.hasOwn(CHECK_HEADINGS, checks.status) ? checks.status : 'unavailable';
  return (
    <div className="cd-change-review" aria-busy={waiting || undefined}>
      <Card as="section" label="Changes" padding={16}>
        <p className="cd-change-review__heading cd-type-control">Changes</p>
        {rows.length > 0 ? (
          <ul role="list" className="cd-change-review__rows">
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
            {checks.lines.map((line, index) => (
              <li key={`${index}-${line}`}>{line}</li>
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
