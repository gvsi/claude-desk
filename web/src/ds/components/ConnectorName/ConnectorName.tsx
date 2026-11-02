import type { ConnectorIconName } from '../ConnectorIcon/ConnectorIcon.tsx';
import { Pill } from '../Pill/Pill.tsx';

import './ConnectorName.css';

/**
 * The screen's view of one connector, where tools come from. Plan 04 owns which tools each one
 * groups. Every external connector in the demo is a mock, and `mock: true` is required, so the
 * "Mock" badge can't be left out.
 */
export interface ConnectorView {
  /** The connector's key on the screen: "payments", "stripe". */
  id: string;
  /** Its name: "Payments", "Stripe". */
  name: string;
  icon: ConnectorIconName;
  /** One line on what it does: "Your customers' charges and refunds. Test mode, no money moves." */
  description: string;
  source: { kind: 'built_in' } | { kind: 'external'; mock: true };
}

export interface ConnectorNameProps {
  connector: ConnectorView;
  /** `page`: the serif page title; `section`: the section type of the hub; `inline`: the surrounding line's type. */
  size: 'page' | 'section' | 'inline';
  /** A heading at this level; a `span` when left out. */
  level?: 1 | 2 | 3;
  /**
   * Leaves out "Built in" where the page already groups connectors by where they come from, as
   * the Rules page and the Connectors page draw them. The "Mock" badge is never left out.
   */
  hideBuiltIn?: boolean;
  /** Draws "Built in" as a pill, as "Mock" is, where a board sets the two side by side (Rules, REV-RULES-D). */
  builtInPill?: boolean;
}

const TYPE = { page: 'cd-type-page-title', section: 'cd-type-section', inline: null } as const;

/**
 * A connector's name with what it is beside it: "Built in" in quiet caption type for a built-in
 * connector, or an outlined "Mock" pill for an external one. Every component that names a
 * connector uses it, so "Mock" sits beside every external connector's name.
 */
export function ConnectorName({ connector, size, level, hideBuiltIn = false, builtInPill = false }: ConnectorNameProps) {
  const Tag = level === undefined ? 'span' : (`h${level}` as const);
  const type = TYPE[size];
  // Anything but a built-in connector is external, and so a mock in the demo.
  const builtIn = connector.source.kind === 'built_in';
  return (
    <Tag className={`cd-connector-name cd-connector-name--${size}`}>
      <span className={type ? `cd-connector-name__name ${type}` : 'cd-connector-name__name'}>{connector.name}</span>
      {builtIn && hideBuiltIn ? null : (
        <>
          {/* A real space, so the name and its badge read as two words; the flex gap draws it. */}{' '}
          {builtIn && !builtInPill ? <span className="cd-connector-name__built-in cd-type-caption">Built in</span> : <Pill>{builtIn ? 'Built in' : 'Mock'}</Pill>}
        </>
      )}
    </Tag>
  );
}
