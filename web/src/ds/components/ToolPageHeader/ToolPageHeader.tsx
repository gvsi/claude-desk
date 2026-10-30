import type { ToolStatus } from '../../../api/contracts.ts';
import { Button } from '../Button/Button.tsx';
import { useSendOnce } from '../Button/useSendOnce.ts';
import { ConnectorIcon } from '../ConnectorIcon/ConnectorIcon.tsx';
import { ConnectorName, type ConnectorView } from '../ConnectorName/ConnectorName.tsx';
import { StatusLabel, type StatusTone } from '../StatusDot/StatusDot.tsx';

import './ToolPageHeader.css';

export interface ToolPageHeaderProps {
  /** The tool's name: "Refund". */
  name: string;
  /** What it does and its effects: "Refunds a payment to the card it came from. Moves money out. Can't be undone." */
  description: string;
  /** The connector it comes from. */
  connector: ConnectorView;
  /** Its profile's status. */
  status: ToolStatus;
  /** A connected tool's definition, in the screen's words: "Definition unchanged", "Definition reviewed today". Shown only while it is on. */
  definitionNote?: string;
  /**
   * The demo's "Simulate a tool change", which changes this tool's definition on its connector's
   * mock server. Shown only for an external connector's tool while it is on. Called once per press;
   * the button then waits until `simulatePending` has come and gone, or the promise it returns rejects.
   */
  onSimulateChange?: () => void | Promise<unknown>;
  /** The simulated change is in flight: the button keeps its label under the busy spinner. */
  simulatePending?: boolean;
}

/** The tool's status in words, with its dot. A status this build doesn't know reads as off until reviewed. */
function statusOf(status: ToolStatus, note: string): { tone: StatusTone; words: string } {
  if (status === 'enabled') return { tone: 'handled', words: note === '' ? 'On' : `On · ${note}` };
  if (status === 'disabled') return { tone: 'info', words: 'Off' };
  return { tone: 'info', words: 'Off until you review a change' };
}

/**
 * The demo's strip under the source line: what simulating does, and the button that does it once.
 * The tool then turns `needs_review` and the screen shows its review.
 */
function SimulateStrip({
  connectorName,
  onSimulateChange,
  pending,
}: {
  connectorName: string;
  onSimulateChange: () => void | Promise<unknown>;
  pending: boolean;
}) {
  const { waiting, send } = useSendOnce<'simulate'>(pending);
  return (
    <div className="cd-tool-page-header__simulate">
      <p className="cd-tool-page-header__simulate-caption cd-type-meta">
        Demo only. Changes this tool's definition on the mock {connectorName} server, so you can see what happens.
      </p>
      <Button variant="ghost" busy={waiting} onClick={() => send('simulate', onSimulateChange)}>
        Simulate a tool change
      </Button>
    </div>
  );
}

/**
 * The top of a tool's page: its name as the page's serif `h1`, what it does, and a line saying
 * which connector it comes from and whether it is on. For a connected tool that is on, the demo's
 * "Simulate a tool change" strip follows when the screen passes `onSimulateChange`.
 */
export function ToolPageHeader({ name, description, connector, status, definitionNote, onSimulateChange, simulatePending = false }: ToolPageHeaderProps) {
  const shown = statusOf(status, definitionNote?.trim() ?? '');
  const simulates = onSimulateChange !== undefined && connector.source.kind === 'external' && status === 'enabled';
  return (
    <header className="cd-tool-page-header">
      <h1 className="cd-tool-page-header__title cd-type-page-title">{name}</h1>
      <p className="cd-tool-page-header__description cd-type-body">{description}</p>
      <p className="cd-tool-page-header__source cd-type-meta">
        <span className="cd-tool-page-header__from">
          <ConnectorIcon icon={connector.icon} size="inline" />
          <span>
            From <ConnectorName connector={connector} size="inline" />
          </span>
        </span>{' '}
        <span className="cd-tool-page-header__status">
          <StatusLabel tone={shown.tone}>{shown.words}</StatusLabel>
        </span>
      </p>
      {simulates ? <SimulateStrip connectorName={connector.name} onSimulateChange={onSimulateChange} pending={simulatePending} /> : null}
    </header>
  );
}
