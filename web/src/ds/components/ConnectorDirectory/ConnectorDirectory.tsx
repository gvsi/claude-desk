import { useId, type ComponentType, type ReactNode } from 'react';

import { Icon } from '../../icons/index.tsx';
import { Button } from '../Button/Button.tsx';
import { Card } from '../Card/Card.tsx';
import { ConnectorIcon } from '../ConnectorIcon/ConnectorIcon.tsx';
import { ConnectorName, type ConnectorView } from '../ConnectorName/ConnectorName.tsx';
import { SectionHeader } from '../SectionHeader/SectionHeader.tsx';
import { StatusLabel } from '../StatusDot/StatusDot.tsx';
import type { RulesLinkProps } from '../ToolRulesCard/ToolRulesCard.tsx';

import './ConnectorDirectory.css';

/** One connector on the Connectors page, in the screen's words. */
export interface DirectoryRowView {
  connector: ConnectorView;
  /** How many tools it brings. */
  tools: number;
  /** Its page under Connectors (`connectors/<id>`). An app that isn't connected has none yet. */
  href?: string;
  /** A quiet word before the count: "Always on" for Verification, "Coming soon in this demo" for an app the demo can't connect yet. */
  note?: string;
  /** A connected app's account, in the screen's words, after "Connected": "Turner Plumbing, test mode (mock)". */
  connection?: string;
  /**
   * An app to connect: "Connect" calls this, and opens the add flow's sign-in. An available app
   * without it has no button, as an app that is coming soon in the demo, which says so in `note`.
   */
  onConnect?: () => void;
}

export interface ConnectorDirectoryProps {
  /** The built-in connectors on this Desk, Verification among them. */
  builtIn: readonly DirectoryRowView[];
  /** The line beside "Built in": how to remove one, and that Verification stays. */
  builtInCaption?: string;
  /** The apps connected from outside. */
  connected: readonly DirectoryRowView[];
  /** The apps that can be connected. */
  available: readonly DirectoryRowView[];
  /**
   * The id of the connector added a moment ago, built in or connected: its row says "Added just
   * now". An app still to connect can't have been added, so an available row never says it.
   */
  justAdded?: ConnectorView['id'];
  /** The app's router link; a plain `<a>` by default. */
  linkComponent?: ComponentType<RulesLinkProps>;
}

/** What a row says right after its connector was added, in the signed board's words. */
const JUST_ADDED = 'Added just now';

function PlainLink({ children, ...props }: RulesLinkProps) {
  return <a {...props}>{children}</a>;
}

/** "1 tool", "2 tools". */
function toolCount(tools: number): string {
  return tools === 1 ? '1 tool' : `${tools} tools`;
}

/**
 * The Connectors page's list: what is built in, the apps connected, and the apps that can be, each
 * a group under its heading in one card of rows. A built-in or connected row is one link to the
 * connector's page; an available app has "Connect" instead. The row of the connector just added
 * says so. Under 640 px of its own width each row's count sits under its line, and "Connect" under
 * the count.
 */
export function ConnectorDirectory({
  builtIn,
  builtInCaption,
  connected,
  available,
  justAdded,
  linkComponent: Link = PlainLink,
}: ConnectorDirectoryProps) {
  return (
    <div className="cd-connector-directory">
      <Group title="Built in" caption={builtInCaption} rows={builtIn} justAdded={justAdded} Link={Link} />
      <Group title="Connected" rows={connected} justAdded={justAdded} Link={Link} />
      <Group title="Available" rows={available} Link={Link} />
    </div>
  );
}

function Group({
  title,
  caption,
  rows,
  justAdded,
  Link,
}: {
  title: string;
  caption?: string;
  rows: readonly DirectoryRowView[];
  justAdded?: string;
  Link: ComponentType<RulesLinkProps>;
}) {
  const headingId = useId();
  if (rows.length === 0) return null;
  return (
    <section className="cd-connector-directory__group" aria-labelledby={headingId}>
      <SectionHeader id={headingId} title={title} caption={caption} />
      <Card padding={0}>
        <ul role="list" className="cd-connector-directory__rows">
          {rows.map((row) => (
            <li key={row.connector.id} className="cd-connector-directory__row">
              <Row row={row} added={justAdded !== undefined && row.connector.id === justAdded} Link={Link} />
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}

function Row({ row, added, Link }: { row: DirectoryRowView; added: boolean; Link: ComponentType<RulesLinkProps> }) {
  const { connector } = row;
  const body: ReactNode = (
    <>
      <ConnectorIcon icon={connector.icon} size="section" />
      <span className="cd-connector-directory__text">
        <ConnectorName connector={connector} size="section" hideBuiltIn />{' '}
        <span className="cd-connector-directory__description cd-type-meta">{connector.description}</span>
        {row.connection ? (
          <>
            {' '}
            <span className="cd-connector-directory__connection cd-type-meta">
              <StatusLabel tone="handled">Connected</StatusLabel>{' '}
              <span className="cd-connector-directory__account">
                · {row.connection}
                {added ? ` · ${JUST_ADDED}` : null}
              </span>
            </span>
          </>
        ) : added ? (
          <>
            {' '}
            <span className="cd-connector-directory__added cd-type-meta">{JUST_ADDED}</span>
          </>
        ) : null}
      </span>{' '}
      <span className="cd-connector-directory__meta cd-type-meta">
        {row.note ? (
          <>
            <span className="cd-connector-directory__note cd-type-caption">{row.note}</span>{' '}
            <span className="cd-connector-directory__dot" aria-hidden="true">
              ·
            </span>{' '}
          </>
        ) : null}
        <span className="cd-connector-directory__count">{toolCount(row.tools)}</span>
      </span>
    </>
  );
  if (row.onConnect) {
    const onConnect = row.onConnect;
    return (
      <div className="cd-connector-directory__item">
        {body}
        <span className="cd-connector-directory__action">
          {/* Named "Connect Google Calendar", so the button says which app it connects. */}
          <Button variant="secondary" onClick={() => onConnect()}>
            <span aria-hidden="true">Connect</span>
            <span className="cd-sr-only">{`Connect ${connector.name}`}</span>
          </Button>
        </span>
      </div>
    );
  }
  if (row.href) {
    return (
      <Link href={row.href} className="cd-connector-directory__item cd-connector-directory__link">
        {body}
        <Icon name="chevron-right" size={16} className="cd-connector-directory__chevron" />
      </Link>
    );
  }
  return <div className="cd-connector-directory__item">{body}</div>;
}
