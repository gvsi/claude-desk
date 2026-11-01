import { useId } from 'react';

import { afterName } from '../../../lib/names.ts';
import { Button } from '../Button/Button.tsx';
import type { ConnectorView } from '../ConnectorName/ConnectorName.tsx';
import { ConnectorSummary } from '../ConnectorName/ConnectorSummary.tsx';
import { useModalDialog } from '../Dialog/useModalDialog.ts';
import { IconButton } from '../IconButton/IconButton.tsx';

import './ConnectorPicker.css';

/** A connector in the picker, and where it stands on this Desk. */
export interface PickerItem {
  connector: ConnectorView;
  /** `available` to add or connect; `added` (built in) or `connected` (an app) already; `coming_soon` in this demo. */
  state: 'available' | 'added' | 'connected' | 'coming_soon';
}

export interface ConnectorPickerProps {
  /** The business's name: "Chen & Co. CPA". */
  business: string;
  /** The built-in connectors, "Claude Desk". Verification is never among them, since every Desk has it. */
  builtIn: readonly PickerItem[];
  /** The apps connected from outside, "Other apps". */
  external: readonly PickerItem[];
  /** A note under the lists: "Google Calendar is coming soon in this demo. …". */
  note?: string;
  /** Called with the connector's `id` when the owner chooses "Add" or "Connect". */
  onChoose: (id: string) => void;
  /** Called by Escape, the Close button, and a close by the browser. */
  onClose: () => void;
}

/** The words for a state that has no button; a state this build doesn't know shows nothing to press. */
const STATE_WORDS = {
  added: 'Added',
  connected: 'Connected',
  coming_soon: 'Coming soon in this demo',
} as const satisfies Record<Exclude<PickerItem['state'], 'available'>, string>;

const MOCK_LINE = 'Mock connectors stand in for the real apps. No account is used and nothing is sent to them.';

/**
 * "Add a connector": a modal dialog listing the built-in connectors and the apps a Desk can add,
 * each with what it does and where it stands. Choosing one leads into its review; nothing turns on
 * from here. Focus starts on the first connector to add, Tab stays inside, and Escape or "Close"
 * closes it.
 */
export function ConnectorPicker({ business, builtIn, external, note, onChoose, onClose }: ConnectorPickerProps) {
  const ids = useId();
  const titleId = `${ids}-title`;
  const introId = `${ids}-intro`;
  // Focus starts on the first connector to add or connect; with none, on the Close button.
  const modal = useModalDialog(onClose, (dialog) =>
    dialog.querySelector<HTMLElement>('.cd-connector-picker__action button') ?? dialog.querySelector<HTMLElement>('.cd-connector-picker__close button'),
  );

  return (
    <dialog {...modal} aria-labelledby={titleId} aria-describedby={introId} className="cd-connector-picker">
      <div className="cd-connector-picker__header">
        <h2 id={titleId} className="cd-connector-picker__title cd-type-page-title">
          Add a connector
        </h2>
        <span className="cd-connector-picker__close">
          <IconButton label="Close" icon="close" onClick={() => onClose()} />
        </span>
      </div>
      <p id={introId} className="cd-connector-picker__intro cd-type-body">
        Add what fits {business}{afterName(business, '.')} Each tool you add starts at Ask me first unless one of your rules already covers it, and you review
        them before anything turns on.
      </p>
      <PickerGroup id={`${ids}-built-in`} heading="Claude Desk" items={builtIn} verb="Add" onChoose={onChoose} />
      {external.length > 0 ? <PickerGroup id={`${ids}-external`} heading="Other apps" items={external} verb="Connect" onChoose={onChoose} /> : null}
      {note || external.length > 0 ? (
        <div className="cd-connector-picker__notes cd-type-meta">
          {note ? <p>{note}</p> : null}
          {external.length > 0 ? <p>{MOCK_LINE}</p> : null}
        </div>
      ) : null}
    </dialog>
  );
}

interface PickerGroupProps {
  id: string;
  heading: string;
  items: readonly PickerItem[];
  verb: 'Add' | 'Connect';
  onChoose: (id: string) => void;
}

function PickerGroup({ id, heading, items, verb, onChoose }: PickerGroupProps) {
  if (items.length === 0) return null;
  return (
    <div className="cd-connector-picker__group">
      <h3 id={id} className="cd-connector-picker__group-heading cd-type-control">
        {heading}
      </h3>
      <ul role="list" className="cd-connector-picker__items" aria-labelledby={id}>
        {items.map(({ connector, state }) => (
          <li key={connector.id} className="cd-connector-picker__item">
            <ConnectorSummary connector={connector} />
            {state === 'available' ? (
              <span className="cd-connector-picker__action">
                {/* Named "Add Payments", "Connect Stripe", so each button says which connector it adds. */}
                <Button variant="secondary" onClick={() => onChoose(connector.id)}>
                  <span aria-hidden="true">{verb}</span>
                  <span className="cd-sr-only">{`${verb} ${connector.name}`}</span>
                </Button>
              </span>
            ) : Object.hasOwn(STATE_WORDS, state) ? (
              <span className="cd-connector-picker__state cd-type-meta">{STATE_WORDS[state as keyof typeof STATE_WORDS]}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
