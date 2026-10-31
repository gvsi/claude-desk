import { useId } from 'react';

import { Button } from '../Button/Button.tsx';
import { Card } from '../Card/Card.tsx';
import { ConnectorIcon } from '../ConnectorIcon/ConnectorIcon.tsx';
import { ConnectorName, type ConnectorView } from '../ConnectorName/ConnectorName.tsx';
import { StatusDot } from '../StatusDot/StatusDot.tsx';

import './SetupToolsList.css';

/**
 * One connector in setup's tools step, and where it stands on the new Desk: `on` once its tools
 * are turned on, `always_on` on every Desk (Verification), or `off` with its button.
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
    };

export interface SetupToolsListProps {
  /** The connectors that are part of Claude Desk, Verification among them, under "Built in". */
  builtIn: readonly SetupToolsRow[];
  /** The apps that can be connected from outside, under "Connect your own". */
  external: readonly SetupToolsRow[];
}

/** What a row that is on says, beside its handled dot. */
const STATUS_WORDS = { on: 'On', always_on: 'Always on' } as const;

/**
 * Setup's tools step (N-R2-Setup-05-Tools): "Built in" and "Connect your own", each a card of
 * rows. A row is the connector's tile, its name and line, and at its right where it stands ("On",
 * "Always on") or its button ("Add" for a built-in connector, "Connect" for an app, after how many
 * tools it brings). Rows are not links; nothing turns on from here.
 */
export function SetupToolsList({ builtIn, external }: SetupToolsListProps) {
  return (
    <div className="cd-setup-tools">
      <Group title="Built in" verb="Add" rows={builtIn} />
      <Group title="Connect your own" verb="Connect" rows={external} />
    </div>
  );
}

function Group({ title, verb, rows }: { title: string; verb: 'Add' | 'Connect'; rows: readonly SetupToolsRow[] }) {
  const headingId = useId();
  if (rows.length === 0) return null;
  return (
    <Card as="section" label={title} padding={16}>
      <h2 id={headingId} className="cd-setup-tools__heading cd-type-control">
        {title}
      </h2>
      <ul role="list" className="cd-setup-tools__rows" aria-labelledby={headingId}>
        {rows.map((row) => (
          <li key={row.connector.id} className="cd-setup-tools__row">
            <ConnectorIcon icon={row.connector.icon} size="section" />
            <span className="cd-setup-tools__text">
              <span className="cd-setup-tools__name cd-type-body">
                <ConnectorName connector={row.connector} size="inline" hideBuiltIn />
              </span>{' '}
              <span className="cd-setup-tools__description cd-type-meta">{row.connector.description}</span>
            </span>
            <End row={row} verb={verb} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

function End({ row, verb }: { row: SetupToolsRow; verb: 'Add' | 'Connect' }) {
  if (row.state === 'off') {
    const { connector, tools, onChoose } = row;
    return (
      <span className="cd-setup-tools__end cd-setup-tools__end--action cd-type-meta">
        {tools === undefined ? null : <span className="cd-setup-tools__count">{tools === 1 ? '1 tool' : `${tools} tools`}</span>}
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
