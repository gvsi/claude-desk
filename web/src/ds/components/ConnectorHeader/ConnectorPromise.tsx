import { Icon } from '../../icons/index.tsx';
import { Card } from '../Card/Card.tsx';

import './ConnectorHeader.css';

export interface ConnectorPromiseProps {
  /** What the connector never does, in one sentence: "Claude sees only when you're busy, never what the event is: no titles, guests or notes." */
  title: string;
  /** The longer explanation under it, in meta type. */
  detail?: string;
}

/**
 * A connector's promise about what Claude can't see or do with it: a card with a lock, the
 * promise in weight 520 and its detail under it. It sits under a connector's page header and in
 * its mock sign-in.
 */
export function ConnectorPromise({ title, detail }: ConnectorPromiseProps) {
  return (
    <Card label={title} padding={16}>
      <div className="cd-connector-promise">
        <Icon name="lock" size={16} className="cd-connector-promise__icon" />
        <div className="cd-connector-promise__text">
          <p className="cd-connector-promise__title cd-type-body">{title}</p>
          {detail ? <p className="cd-connector-promise__detail cd-type-meta">{detail}</p> : null}
        </div>
      </div>
    </Card>
  );
}
