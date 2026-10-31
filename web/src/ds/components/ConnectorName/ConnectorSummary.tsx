import { ConnectorIcon } from '../ConnectorIcon/ConnectorIcon.tsx';
import { ConnectorName, type ConnectorView } from './ConnectorName.tsx';

import './ConnectorSummary.css';

export interface ConnectorSummaryProps {
  connector: ConnectorView;
  /** Leaves out "Built in" where the list's group already says it, as `ConnectorName`'s does. */
  hideBuiltIn?: boolean;
}

/**
 * The start of a row that lists a connector to choose: its 36 px tile, then its name (weight 520,
 * the badge 8 px from it) over its one line in secondary meta. It returns the two as siblings, so
 * the list's own row lays them out with whatever it puts at the end, and keeps its own breakpoint.
 */
export function ConnectorSummary({ connector, hideBuiltIn = false }: ConnectorSummaryProps) {
  return (
    <>
      <ConnectorIcon icon={connector.icon} size="section" />
      <span className="cd-connector-summary">
        <span className="cd-connector-summary__name cd-type-body">
          <ConnectorName connector={connector} size="inline" hideBuiltIn={hideBuiltIn} />
        </span>{' '}
        <span className="cd-connector-summary__description cd-type-meta">{connector.description}</span>
      </span>
    </>
  );
}
