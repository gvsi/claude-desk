import { useId } from 'react';

import { BUSINESS_WORDS } from '../../../owner/connectors/businessWords.ts';
import type { IconName } from '../../icons/index.tsx';
import { Button } from '../Button/Button.tsx';
import { Card } from '../Card/Card.tsx';
import { ConnectorIcon } from '../ConnectorIcon/ConnectorIcon.tsx';
import type { ConnectorView } from '../ConnectorName/ConnectorName.tsx';
import { ConnectorSummary } from '../ConnectorName/ConnectorSummary.tsx';
import { StatusDot } from '../StatusDot/StatusDot.tsx';

import './SetupToolsList.css';

/**
 * One connector in setup's tools step, and where it stands on the new Desk: `on` once its tools
 * are turned on, `always_on` on every Desk (Verification), `off` with its button, or
 * `needs_review` for an app already connected whose tools are listed and none of them on.
 */
export type SetupToolsRow =
  | { connector: ConnectorView; state: 'on' | 'always_on' }
  | {
      connector: ConnectorView;
      state: 'off';
      /** How many tools it brings, before its button: "3 tools". */
      tools?: number;
      /** "Add" (built in) or "Connect" (an app): the screen opens the connector's review or sign-in. */
      onChoose: () => void;
    }
  | {
      connector: ConnectorView;
      state: 'needs_review';
      /** How many tools it brings, before where it stands: "2 tools". */
      tools?: number;
      /** "Review": the screen opens the review of its tools; nothing connects again. */
      onReview: () => void;
    };

export interface SetupToolsListProps {
  /** Rows by tool or connector key, for returning focus after a review. */
  rowRef?: (key: string, row: HTMLLIElement | null) => void;
  /** The Desk's own jobs, in the order the API lists them. */
  jobs?: readonly SetupJobRow[];
  /** The connectors that are part of Claude Desk, Verification among them, under "Built in". */
  builtIn: readonly SetupToolsRow[];
  /** The apps that can be connected from outside, under "Connect your own". */
  external: readonly SetupToolsRow[];
}

export type SetupJobRow = {
  key: string;
  title: string;
  line: string;
  glyph: IconName;
} & ({ state: 'on' } | { state: 'needs_review'; onReview: () => void });

/** What a row that is on says, beside its handled dot. */
const STATUS_WORDS = { on: 'On', always_on: 'Always on' } as const;

/**
 * Setup's tools step (N-R2-Setup-05-Tools): "Built in" and "Connect your own", each a card of
 * rows. A row is the connector's tile, its name and line, and at its right where it stands ("On",
 * "Always on") or its button ("Add" for a built-in connector, "Connect" for an app, after how many
 * tools it brings). An app already connected, its tools waiting (N-Live-REV-560), says how many it
 * brings, then "Needs review" and "Review", as a job does. Rows are not links; nothing turns on from here.
 */
export function SetupToolsList({ jobs = [], builtIn, external, rowRef }: SetupToolsListProps) {
  return (
    <div className="cd-setup-tools">
      <Jobs rows={jobs} rowRef={rowRef} />
      <Group title="Built in" verb="Add" rows={builtIn} rowRef={rowRef} />
      <Group title="Connect your own" verb="Connect" rows={external} rowRef={rowRef} />
    </div>
  );
}

function Jobs({ rows, rowRef }: { rows: readonly SetupJobRow[]; rowRef: SetupToolsListProps['rowRef'] }) {
  const headingId = useId();
  if (rows.length === 0) return null;
  return (
    <Card as="section" label={BUSINESS_WORDS.jobs} padding={16}>
      <h2 id={headingId} className="cd-setup-tools__heading cd-type-control">{BUSINESS_WORDS.jobs}</h2>
      <ul role="list" className="cd-setup-tools__rows" aria-labelledby={headingId}>
        {rows.map((row) => (
          <li key={row.key} ref={(el) => rowRef?.(row.key, el)} className="cd-setup-tools__row cd-setup-tools__row--job">
            <ConnectorIcon icon="quotes" glyph={row.glyph} size="section" />
            <span className="cd-connector-summary">
              <span className="cd-connector-summary__name cd-type-body">{row.title}</span>
              <span className="cd-connector-summary__description cd-type-meta">{row.line}</span>
            </span>
            {row.state === 'on' ? (
              <span className="cd-setup-tools__end cd-type-meta"><StatusDot tone="handled" />{STATUS_WORDS.on}</span>
            ) : row.state === 'needs_review' ? (
              <span className="cd-setup-tools__end cd-setup-tools__end--action cd-type-meta">
                <NeedsReview name={row.title} onReview={row.onReview} />
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Group({ title, verb, rows, rowRef }: { title: string; verb: 'Add' | 'Connect'; rows: readonly SetupToolsRow[]; rowRef: SetupToolsListProps['rowRef'] }) {
  const headingId = useId();
  if (rows.length === 0) return null;
  return (
    <Card as="section" label={title} padding={16}>
      <h2 id={headingId} className="cd-setup-tools__heading cd-type-control">
        {title}
      </h2>
      <ul role="list" className="cd-setup-tools__rows" aria-labelledby={headingId}>
        {rows.map((row) => (
          <li key={row.connector.id} ref={(el) => rowRef?.(row.connector.id, el)} className="cd-setup-tools__row">
            <ConnectorSummary connector={row.connector} hideBuiltIn />
            <End row={row} verb={verb} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

/**
 * What a job, or an app connected with its tools waiting, says before it is on: "Needs review"
 * beside a held dot, then a secondary "Review" named for what it reviews ("Review Stripe").
 */
function NeedsReview({ name, onReview }: { name: string; onReview: () => void }) {
  return (
    <>
      <span className="cd-setup-tools__job-status"><StatusDot tone="held" />{BUSINESS_WORDS.needsReview}</span>
      <Button variant="secondary" onClick={() => onReview()}>
        <span aria-hidden="true">{BUSINESS_WORDS.review}</span>
        <span className="cd-sr-only">{`${BUSINESS_WORDS.review} ${name}`}</span>
      </Button>
    </>
  );
}

/** How many tools an app brings, in secondary meta before where it stands or its button. */
function ToolCount({ tools }: { tools: number | undefined }) {
  if (tools === undefined) return null;
  return <span className="cd-setup-tools__count">{tools === 1 ? '1 tool' : `${tools} tools`}</span>;
}

function End({ row, verb }: { row: SetupToolsRow; verb: 'Add' | 'Connect' }) {
  if (row.state === 'needs_review') {
    return (
      <span className="cd-setup-tools__end cd-setup-tools__end--action cd-type-meta">
        <ToolCount tools={row.tools} />
        <NeedsReview name={row.connector.name} onReview={row.onReview} />
      </span>
    );
  }
  if (row.state === 'off') {
    const { connector, tools, onChoose } = row;
    return (
      <span className="cd-setup-tools__end cd-setup-tools__end--action cd-type-meta">
        <ToolCount tools={tools} />
        {/* Named "Add Documents", "Connect Stripe", so each button says which connector it adds. */}
        <Button variant="secondary" onClick={() => onChoose()}>
          <span aria-hidden="true">{verb}</span>
          <span className="cd-sr-only">{`${verb} ${connector.name}`}</span>
        </Button>
      </span>
    );
  }
  // A state this build doesn't know says nothing, rather than a status it can't vouch for.
  if (!Object.hasOwn(STATUS_WORDS, row.state)) return null;
  return (
    <span className={`cd-setup-tools__end cd-setup-tools__end--${row.state === 'on' ? 'on' : 'always-on'} cd-type-meta`}>
      <StatusDot tone="handled" />
      {STATUS_WORDS[row.state]}
    </span>
  );
}
