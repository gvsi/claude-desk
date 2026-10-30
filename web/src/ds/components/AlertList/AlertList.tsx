import { Card } from '../Card/Card.tsx';

import './AlertList.css';

/** One alert setting, in the screen's words: when the owner hears, about what, and how. */
export interface AlertListItem {
  /** When the owner hears about them: "Right away", "In your briefing", "Not at all". */
  when: string;
  /** Which alerts: "Held requests, paused chats and emergencies". */
  what: string;
  /** How they reach the owner, at the row's right: "Demo inbox", "Each morning at 7:00 am". Left out when they don't. */
  how?: string;
}

export interface AlertListProps {
  /** The list's name, the same as the heading over it: "Set for a plumber". */
  label: string;
  items: readonly AlertListItem[];
}

/**
 * The alerts a Desk is set to send, read-only, in one card: a row for each timing with the alerts
 * it covers under it and, at the right, how they reach the owner. Ruled between the rows.
 */
export function AlertList({ label, items }: AlertListProps) {
  return (
    <Card padding={0}>
      <ul role="list" className="cd-alert-list" aria-label={label}>
        {items.map((item) => (
          <li key={item.when} className="cd-alert-list__row">
            <div className="cd-alert-list__text">
              <p className="cd-alert-list__when cd-type-body">{item.when}</p>
              <p className="cd-alert-list__what cd-type-meta">{item.what}</p>
            </div>
            {item.how === undefined ? null : <p className="cd-alert-list__how cd-type-meta">{item.how}</p>}
          </li>
        ))}
      </ul>
    </Card>
  );
}
