import { useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react';

import type { SessionMode } from '../../../api/contracts.ts';
import { Button } from '../Button/Button.tsx';
import { Notice } from '../Notice/Notice.tsx';
import { StatusDot } from '../StatusDot/StatusDot.tsx';

import './TakeOverBar.css';

export interface TakeOverBarProps {
  /** Who answers the chat: Claude (`ai`), the owner (`owner`), or nobody after the breaker (`paused`). */
  mode: SessionMode;
  /** The visitor as the owner's screen names them: "Dana Whitfield", "Visitor". */
  visitorName: string;
  /** `owner_display_name`, the name the visitor sees: "Mike Turner". */
  ownerName: string;
  /** An agent's session: no line about what the visitor sees, because agents never receive it. */
  agent?: boolean;
  onTakeOver: () => void;
  onHandBack: () => void;
  onResume: () => void;
  /** The change is being sent: every control waits, announced with `aria-busy`. */
  pending?: boolean;
  /** The screen's line for a change that failed (`errorCopy`), never a code. */
  error?: string;
}

/** The owner's own display name, quoted as the visitor will see it; exempt from the copy check's voice rules. */
function Name({ children }: { children: string }) {
  return <span data-copy="user">{children}</span>;
}

/**
 * The visitor's or agent's name, which they may have chosen: set off as user text and first in
 * its line, so no sentence of the bar's own runs into it.
 */
function VisitorName({ children }: { children: string }) {
  return (
    <bdi className="cd-user-name" data-copy="user">
      {children}
    </bdi>
  );
}

/**
 * Who is answering a conversation, and the owner's controls for it, above the composer: Take over
 * while Claude answers, Hand back to Claude while the owner is in the chat, and Resume Claude or
 * Take over once the breaker paused it. Held approval cards stay answerable in every mode.
 */
export function TakeOverBar({
  mode,
  visitorName,
  ownerName,
  agent = false,
  onTakeOver,
  onHandBack,
  onResume,
  pending = false,
  error,
}: TakeOverBarProps) {
  // When the button that had focus goes with the mode, focus moves to the bar's first line, so a
  // keyboard user isn't dropped to the top of the page.
  const firstLine = useRef<HTMLParagraphElement>(null);
  const pressedHere = useRef(false);
  useLayoutEffect(() => {
    if (!pressedHere.current) return;
    pressedHere.current = false;
    const line = firstLine.current;
    const active = line?.ownerDocument.activeElement;
    if (line && (active == null || active === line.ownerDocument.body)) line.focus();
  }, [mode]);

  // The button pressed here, in this mode, and whether its change has been pending since: while it
  // is, that button spins and the others wait. It goes when the mode changes or that change ends,
  // so a change sent from elsewhere makes every button wait, none spinning.
  const [pressed, setPressed] = useState<{ label: string; mode: SessionMode; pending: boolean } | null>(null);
  if (pressed !== null) {
    if (pressed.mode !== mode || (pressed.pending && !pending)) setPressed(null);
    else if (!pressed.pending && pending) setPressed({ ...pressed, pending: true });
  }
  const spinning = pending && pressed !== null && pressed.mode === mode ? pressed.label : null;

  // Button ignores a press while busy or waiting, so this runs only while nothing is pending.
  const press = (label: string, handler: () => void) => () => {
    pressedHere.current = true;
    setPressed({ label, mode, pending: false });
    handler();
  };
  // Keyed by its words, so a button never turns into the opposite one under the owner's focus.
  const button = (variant: 'primary' | 'secondary', label: string, handler: () => void) => (
    <Button
      key={label}
      variant={variant}
      size="main"
      busy={spinning === label}
      waiting={pending && spinning !== label}
      onClick={press(label, handler)}
    >
      {label}
    </Button>
  );

  let lead: ReactNode;
  let buttons: ReactNode;
  let visitorSees: ReactNode = null;
  switch (mode) {
    case 'owner':
      lead = (
        <>
          <FirstLine lineRef={firstLine} title>
            You&apos;re in this chat
          </FirstLine>
          <p className="cd-take-over__line cd-type-caption">Claude won&apos;t send anything here until you hand it back.</p>
        </>
      );
      buttons = button('secondary', 'Hand back to Claude', onHandBack);
      visitorSees = <>“Claude is helping again.”</>;
      break;
    case 'paused':
      lead = (
        <FirstLine lineRef={firstLine} title>
          <StatusDot tone="held" />
          <span>Claude paused this chat after repeated blocked attempts.</span>
        </FirstLine>
      );
      buttons = (
        <>
          {button('primary', 'Resume Claude', onResume)}
          {button('secondary', 'Take over', onTakeOver)}
        </>
      );
      break;
    default:
      // `ai`, and a mode this build doesn't know: only Take over is offered.
      lead = (
        <FirstLine lineRef={firstLine}>
          <VisitorName>{visitorName}</VisitorName> never sees whispers. Whispers steer Claude, and your rules still apply.
        </FirstLine>
      );
      buttons = button('secondary', 'Take over', onTakeOver);
      visitorSees = (
        <>
          “<Name>{ownerName}</Name> joined the chat.”
        </>
      );
  }

  return (
    <div className="cd-take-over" aria-busy={pending || undefined}>
      <div className="cd-take-over__lead">{lead}</div>
      <div className="cd-take-over__action">
        <div className={`cd-take-over__buttons${mode === 'paused' ? ' cd-take-over__buttons--stacked' : ''}`}>{buttons}</div>
        {visitorSees && !agent ? (
          <p className="cd-take-over__line cd-type-caption">
            <VisitorName>{visitorName}</VisitorName> sees {visitorSees}
          </p>
        ) : null}
      </div>
      {error && !pending ? (
        <div className="cd-take-over__error">
          <Notice tone="error">{error}</Notice>
        </div>
      ) : null}
    </div>
  );
}

/** The bar's first line: a status title, or the explanation when Claude is answering. */
function FirstLine({ lineRef, title = false, children }: { lineRef: Ref<HTMLParagraphElement>; title?: boolean; children: ReactNode }) {
  return (
    <p
      ref={lineRef}
      tabIndex={-1}
      className={`cd-take-over__first cd-type-caption${title ? ' cd-take-over__first--title' : ' cd-take-over__line'}`}
    >
      {children}
    </p>
  );
}
