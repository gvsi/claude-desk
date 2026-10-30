import { Button } from '../Button/Button.tsx';
import { Card } from '../Card/Card.tsx';
import type { ConnectorView } from '../ConnectorName/ConnectorName.tsx';
import { StatusDot } from '../StatusDot/StatusDot.tsx';

import './ToolChangedItem.css';

export interface ToolChangedItemProps {
  /** The connector whose tool changed. */
  connector: ConnectorView;
  /** The tool's name: "Refund". */
  tool: string;
  /** When it was noticed, in the screen's words: "Noticed today at 9:14". */
  noticed: string;
  /** What can't happen until the owner decides: "Refunds can't run until you decide." */
  consequence: string;
  /** Opens the tool's page, where the change is reviewed. */
  onReview: () => void;
}

/**
 * Today's "Needs you" item for a tool that a changed definition switched off: what changed, the
 * connector (a mock, said in words) and when it was noticed, what can't run meanwhile, and a
 * button to its review. The card is named by what changed, so "Review" is heard in its context.
 */
export function ToolChangedItem({ connector, tool, noticed, consequence, onReview }: ToolChangedItemProps) {
  const title = `${connector.name} changed “${tool}”, so it's off until you review it.`;
  const kind = connector.source.kind === 'built_in' ? 'Built in' : 'Mock';
  return (
    <Card as="article" label={title} padding={16}>
      <div className="cd-tool-changed">
        <StatusDot tone="held" />
        <div className="cd-tool-changed__text">
          <p className="cd-tool-changed__title cd-type-body">{title}</p>
          <p className="cd-tool-changed__meta cd-type-meta">{`${connector.name} · ${kind} · ${noticed}. ${consequence}`}</p>
        </div>
        <div className="cd-tool-changed__action">
          <Button variant="secondary" onClick={() => onReview()}>
            Review
          </Button>
        </div>
      </div>
    </Card>
  );
}
