import type { ToolStatus } from '../../../api/contracts.ts';
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
}

/** The tool's status in words, with its dot. A status this build doesn't know reads as off until reviewed. */
function statusOf(status: ToolStatus, note: string): { tone: StatusTone; words: string } {
  if (status === 'enabled') return { tone: 'handled', words: note === '' ? 'On' : `On · ${note}` };
  if (status === 'disabled') return { tone: 'info', words: 'Off' };
  return { tone: 'info', words: 'Off until you review a change' };
}

/**
 * The top of a tool's page: its name as the page's serif `h1`, what it does, and a line saying
 * which connector it comes from and whether it is on.
 */
export function ToolPageHeader({ name, description, connector, status, definitionNote }: ToolPageHeaderProps) {
  const shown = statusOf(status, definitionNote?.trim() ?? '');
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
    </header>
  );
}
