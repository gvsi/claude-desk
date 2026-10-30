import { Button } from '../Button/Button.tsx';
import { Card } from '../Card/Card.tsx';
import { ConnectorIcon } from '../ConnectorIcon/ConnectorIcon.tsx';
import { ConnectorName, type ConnectorView } from '../ConnectorName/ConnectorName.tsx';

import './ConnectorOfferCard.css';

/** What the card leads into: adding, connecting, turning off or disconnecting, or nothing yet. */
export type ConnectorOfferAction = 'add' | 'connect' | 'turn_off' | 'disconnect' | 'coming_soon';

/** The button's words for each action that has one. */
const ACTION_LABELS = {
  add: 'Review and add',
  connect: 'Review and connect',
  turn_off: 'Review and turn off',
  disconnect: 'Review and disconnect',
} as const satisfies Record<Exclude<ConnectorOfferAction, 'coming_soon'>, string>;

export interface ConnectorOfferCardProps {
  connector: ConnectorView;
  /** The tools it brings, in the screen's words: "2 tools · Payment link, Charge within a signed limit". */
  toolsLine: string;
  /** What already covers them: "Covered by your always-on rule: no money moves without your rule or a signed limit." */
  coverage?: string;
  action: ConnectorOfferAction;
  /** Opens the same review the picker leads into. Nothing turns on or off from the card. */
  onReview: () => void;
}

/**
 * Claude's card in the Ask Claude panel when the owner asks for a connector: what it is, the tools
 * it brings and what covers them, and one button that opens its review. Nothing turns on or off
 * from the card itself.
 */
export function ConnectorOfferCard({ connector, toolsLine, coverage, action, onReview }: ConnectorOfferCardProps) {
  // An action this build doesn't know offers nothing to press.
  const label = Object.hasOwn(ACTION_LABELS, action) ? ACTION_LABELS[action as keyof typeof ACTION_LABELS] : null;
  return (
    <Card as="article" label={connector.name} padding={16}>
      <div className="cd-connector-offer">
        <div className="cd-connector-offer__identity">
          <ConnectorIcon icon={connector.icon} size="section" />
          <div className="cd-connector-offer__text">
            <span className="cd-connector-offer__name cd-type-body">
              <ConnectorName connector={connector} size="inline" />
            </span>
            <p className="cd-connector-offer__tools cd-type-meta">{toolsLine}</p>
          </div>
        </div>
        {coverage ? <p className="cd-connector-offer__coverage cd-type-meta">{coverage}</p> : null}
        {action === 'coming_soon' ? (
          <p className="cd-connector-offer__coming cd-type-meta">Coming soon in this demo.</p>
        ) : label !== null ? (
          <div className="cd-connector-offer__action">
            <Button variant="primary" onClick={() => onReview()}>
              {label}
            </Button>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
