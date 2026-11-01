import { useEffect, useId, useRef, useState } from 'react';

import { Button } from '../Button/Button.tsx';
import { useSendOnce } from '../Button/useSendOnce.ts';
import type { ConnectorView } from '../ConnectorName/ConnectorName.tsx';
import { Dialog } from '../Dialog/Dialog.tsx';
import { Pill } from '../Pill/Pill.tsx';
import { SectionHeader } from '../SectionHeader/SectionHeader.tsx';

import './ConnectionPanel.css';

/** One line of a connection's details, in the screen's words: "Account", "Turner Plumbing, test mode (mock)". */
export interface ConnectionDetail {
  label: string;
  value: string;
}

/** A connector the owner can turn off or disconnect, and what stops when they do. */
export interface ConnectionTurnOff {
  kind: 'turn_off';
  /** What stops, in one sentence: "Claude stops offering payment links and charges." */
  consequence: string;
  /** The names of the connector's tools, and the reasons of the rules that stop applying. */
  stops: { tools: readonly string[]; rules: readonly string[] };
  /** Called once from the confirm; the dialog waits until `pending` has come and gone. */
  onTurnOff: () => void;
  /** The screen is turning it off. */
  pending?: boolean;
}

/** A connector that can't be turned off: Verification. */
export interface ConnectionAlwaysOn {
  kind: 'always_on';
  /** Why, in the owner's words: "It's how Claude confirms a customer before sharing anything private." */
  reason: string;
}

export interface ConnectionPanelProps {
  connector: ConnectorView;
  /** An app connected from outside: its connection's details, each value already in words. */
  details?: readonly ConnectionDetail[];
  off: ConnectionTurnOff | ConnectionAlwaysOn;
}

/** The words that differ between a built-in connector, which is turned off, and an app, which is disconnected. */
function wordsFor(connector: ConnectorView) {
  const name = connector.name;
  if (connector.source.kind === 'built_in') {
    return {
      heading: `Turn off ${name}`,
      kept: 'Your rules are kept, so you can add it back.',
      action: `Turn off ${name}`,
      question: `Turn off ${name}?`,
      keep: 'Keep it on',
      external: false,
    };
  }
  return {
    heading: 'Connection',
    kept: 'Your rules for them are kept in case you connect again.',
    action: 'Disconnect',
    question: `Disconnect ${name}?`,
    keep: 'Keep it connected',
    external: true,
  };
}

/**
 * The end of a connector's page: for an app, its connection's details; then what turning it off
 * or disconnecting stops, and a button that asks first in a plain confirm. Turning off only
 * narrows what Claude can do, so it applies at once, without a proved review. Verification is
 * always on, so it says so and has no button.
 */
export function ConnectionPanel({ connector, details, off }: ConnectionPanelProps) {
  const headingId = useId();
  if (off.kind === 'always_on') {
    return (
      <div className="cd-connection-panel">
        <p className="cd-connection-panel__line cd-type-body">Always on. {off.reason}</p>
      </div>
    );
  }
  const words = wordsFor(connector);
  return (
    <section className="cd-connection-panel" aria-labelledby={headingId}>
      <SectionHeader id={headingId} title={words.heading} />
      {details && details.length > 0 ? (
        <dl className="cd-connection-panel__details">
          {details.map((detail) => (
            <div key={detail.label} className="cd-connection-panel__detail">
              <dt className="cd-connection-panel__term cd-type-meta">{detail.label}</dt>
              <dd className="cd-connection-panel__value cd-type-body">{detail.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <TurnOff connector={connector} off={off} words={words} />
    </section>
  );
}

function TurnOff({ connector, off, words }: { connector: ConnectorView; off: ConnectionTurnOff; words: ReturnType<typeof wordsFor> }) {
  const pending = off.pending === true;
  const [open, setOpen] = useState(false);
  const { waiting, send } = useSendOnce<'turn_off'>(pending);

  // When the screen is done turning it off, the confirm has done its job and goes; the screen
  // says how it went.
  const sawPending = useRef(pending);
  useEffect(() => {
    const ended = sawPending.current && !pending;
    sawPending.current = pending;
    if (ended) setOpen(false);
  }, [pending]);

  const title = words.external ? (
    <>
      Disconnect <span className="cd-connection-panel__name">{connector.name}</span>? <Pill>Mock</Pill>
    </>
  ) : (
    words.question
  );

  return (
    <div className="cd-connection-panel__off">
      <p className="cd-connection-panel__line cd-type-body">
        {off.consequence} You&apos;ll see the change before it applies. {words.kept}
      </p>
      <Button variant="secondary" size="main" waiting={waiting} onClick={() => setOpen(true)}>
        {words.action}
      </Button>
      {open ? (
        <Dialog
          title={title}
          body={
            <div className="cd-connection-panel__confirm">
              <p>These tools stop at once:</p>
              <ul>
                {off.stops.tools.map((tool, index) => (
                  <li key={`${index}-${tool}`}>{tool}</li>
                ))}
              </ul>
              {off.stops.rules.length > 0 ? (
                <>
                  <p>These rules stop applying:</p>
                  <ul>
                    {off.stops.rules.map((rule, index) => (
                      <li key={`${index}-${rule}`}>{rule}</li>
                    ))}
                  </ul>
                </>
              ) : (
                <p>None of your rules stop applying.</p>
              )}
              <p>{words.kept}</p>
            </div>
          }
          confirmLabel={words.action}
          cancelLabel={words.keep}
          pending={waiting}
          onConfirm={() => send('turn_off', () => off.onTurnOff())}
          onCancel={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}
