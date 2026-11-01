import { Children, type ReactNode } from 'react';

import { Button } from '../Button/Button.tsx';
import { CrossFade } from '../ConnectorSection/CrossFade.tsx';

import './ConnectorList.css';

export interface ConnectorListProps {
  /**
   * One line about the Desk's connectors and its rules version, from the active version. When it
   * changes, as a confirmed change lands, only the words that changed cross-fade.
   */
  summary: string;
  /** Adds "Add a connector" after the last connector: the screen opens the picker. The Rules page leaves it out, as connectors are added from the Connectors page. */
  onAddConnector?: () => void;
  /** One `ConnectorSection` per connector the Desk has: built in first, then the ones it connected. */
  children: ReactNode;
}

/**
 * The Rules hub's list of connectors: the summary line, a list named "Connectors" with one item
 * per section, and "Add a connector" at the end when the page passes `onAddConnector`. Under 640 px
 * of its own width the summary and the last button go, as the archived phone board drew them.
 */
export function ConnectorList({ summary, onAddConnector, children }: ConnectorListProps) {
  const sections = Children.toArray(children);
  return (
    <div className="cd-connector-list">
      <div className="cd-connector-list__body">
        <p className="cd-connector-list__summary cd-type-meta">
          <CrossFade text={summary} fade byWord />
        </p>
        <ul role="list" className="cd-connector-list__items" aria-label="Connectors">
          {sections.map((section, index) => (
            <li key={index} className="cd-connector-list__item">
              {section}
            </li>
          ))}
        </ul>
        {onAddConnector ? (
          <div className="cd-connector-list__add">
            <Button variant="secondary" size="main" onClick={() => onAddConnector()}>
              Add a connector
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
