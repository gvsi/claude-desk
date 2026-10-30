import { ConnectorIcon } from '../ConnectorIcon/ConnectorIcon.tsx';
import { ConnectorName, type ConnectorView } from '../ConnectorName/ConnectorName.tsx';
import { StatusLabel, type StatusTone } from '../StatusDot/StatusDot.tsx';
import { ConnectorPromise, type ConnectorPromiseProps } from './ConnectorPromise.tsx';

import './ConnectorHeader.css';

/** Whether the connector is on: a built-in one is on or off, Verification always on, an app connected. */
export type ConnectorStatus = 'on' | 'always_on' | 'connected' | 'off';

/** Each status in words, with its dot. */
const STATUS = {
  on: { words: 'On', tone: 'handled' },
  always_on: { words: 'Always on', tone: 'handled' },
  connected: { words: 'Connected', tone: 'handled' },
  off: { words: 'Off', tone: 'info' },
} as const satisfies Record<ConnectorStatus, { words: string; tone: StatusTone }>;

export interface ConnectorHeaderProps {
  connector: ConnectorView;
  status: ConnectorStatus;
  /** The connector's promise about what Claude can't see or do, shown under the header. */
  promise?: ConnectorPromiseProps;
}

/**
 * The top of a connector's page: its 48 px tile, its name as the page's `h1` with "Built in" or
 * the Mock badge, its description, and at the right whether it is on, in words with a dot. A
 * connector with a promise (Google Calendar's) shows it under the header.
 */
export function ConnectorHeader({ connector, status, promise }: ConnectorHeaderProps) {
  // A status this build doesn't know reads as off: never as on.
  const shown = Object.hasOwn(STATUS, status) ? STATUS[status] : STATUS.off;
  return (
    <div className="cd-connector-header-group">
      <header className="cd-connector-header">
        <ConnectorIcon icon={connector.icon} size="page" />
        <div className="cd-connector-header__text">
          <ConnectorName connector={connector} size="page" level={1} />
          <p className="cd-connector-header__description cd-type-body">{connector.description}</p>
        </div>
        <p className="cd-connector-header__status cd-type-meta">
          <StatusLabel tone={shown.tone}>{shown.words}</StatusLabel>
        </p>
      </header>
      {promise ? <ConnectorPromise title={promise.title} detail={promise.detail} /> : null}
    </div>
  );
}
