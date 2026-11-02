import type { RefObject } from 'react';

import type { Decision, DecisionState } from '../../../api/contracts.ts';
import { receiptTone } from '../MarginReceipt/receiptTone.ts';
import { errorCopy } from '../Notice/errorCopy.ts';
import { StatusDot, type StatusTone } from '../StatusDot/StatusDot.tsx';

import './ApprovalStatus.css';

/** The card's status line in each state: waiting while held, then the final line. */
const STATUS_LINES = {
  held: 'Waiting for your answer',
  approved: 'You allowed this.',
  executed: "You allowed this. It's done.",
  failed: "You allowed this, but it didn't go through. Nothing was done.",
  unknown: 'You allowed this. Still confirming whether it went through.',
  refused_at_execution: "Your rules changed before this ran, so it wasn't done.",
  denied: 'You denied this.',
  expired: 'This request expired before you answered. Nothing was done.',
  cancelled: 'The visitor cancelled before you answered. Nothing was done.',
  allowed: 'Your rules allowed this.',
  refused: 'Your rules refused this.',
} as const satisfies Record<DecisionState, string>;

/**
 * The kernel's owner line for an execution refusal or a request the visitor's booking closed (a
 * `cancelled` one that carries it), else the state's line; unknown states ask for a reload.
 */
function statusLine({ state, owner_plain }: Decision): string {
  if ((state === 'refused_at_execution' || state === 'cancelled') && owner_plain != null) return owner_plain;
  return Object.hasOwn(STATUS_LINES, state) ? STATUS_LINES[state] : errorCopy('conflict');
}

/** The request's status, shared by its Today card and its notification. */
export function ApprovalStatus({ decision, tone = receiptTone({ kind: 'decision', state: decision.state }), statusRef }: {
  decision: Decision;
  tone?: StatusTone;
  statusRef?: RefObject<HTMLSpanElement>;
}) {
  return (
    <span className="cd-approval-card__status cd-type-caption">
      <StatusDot tone={tone} />
      {statusRef ? (
        <span ref={statusRef} role="status" tabIndex={-1} className="cd-approval-card__status-line">
          {statusLine(decision)}
        </span>
      ) : (
        <span className="cd-approval-card__status-line">{statusLine(decision)}</span>
      )}
    </span>
  );
}
