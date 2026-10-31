import { useId, type ReactNode } from 'react';

import { Button } from '../Button/Button.tsx';
import { Card } from '../Card/Card.tsx';

import './AccessPanel.css';

export interface AccessPanelProps {
  /** The teammate's first name, as the owner wrote it: "Luis". */
  name: string;
  /** What they can open, in the owner's words, in order: "Job cards", "Customer history". */
  canOpen: readonly string[];
  /** What they can't open, in order: "Invoices", "Payroll". */
  cantOpen: readonly string[];
  /** Opens the owner's access editor for this teammate. */
  onEditAccess: () => void;
}

/**
 * What one teammate can and can't open on a team Desk: two lists of quiet chips under "{name} can
 * open" and "Can’t open", and "Edit access". The chips are words, not controls; only the owner
 * changes access, through the editor.
 */
export function AccessPanel({ name, canOpen, cantOpen, onEditAccess }: AccessPanelProps) {
  return (
    <Card as="section" label={`${name}’s access`} padding={16}>
      <div className="cd-access-panel">
        <AccessGroup
          heading={
            <>
              <span data-copy="user">{name}</span> can open
            </>
          }
          items={canOpen}
        />
        <AccessGroup heading="Can’t open" items={cantOpen} />
        <div className="cd-access-panel__action">
          <Button variant="secondary" onClick={onEditAccess}>
            Edit access
          </Button>
        </div>
      </div>
    </Card>
  );
}

/** A heading line and the chips it names; with nothing in it, a line that says so instead. */
function AccessGroup({ heading, items }: { heading: ReactNode; items: readonly string[] }) {
  const headingId = useId();
  return (
    <>
      <p id={headingId} className="cd-access-panel__heading cd-type-control">
        {heading}
      </p>
      {items.length === 0 ? (
        <p className="cd-access-panel__none cd-type-meta">Nothing on this Desk.</p>
      ) : (
        <ul role="list" className="cd-access-panel__chips" aria-labelledby={headingId}>
          {items.map((item) => (
            <li key={item} className="cd-access-panel__chip cd-type-meta">
              {item}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
