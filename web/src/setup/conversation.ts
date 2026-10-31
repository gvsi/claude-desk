import type { Choice, ProposalCard, SetupMessage, SetupProposalBody, SetupState } from '../api/views.ts';

/** Older API messages omit card and choices until the consultant conversation is served. */
type CompatibleMessage = Pick<SetupMessage, 'role' | 'text'> & Partial<Pick<SetupMessage, 'card' | 'choices'>>;

/** Cards render as their own messages, never as empty text bubbles. */
export function isCard(message: CompatibleMessage): boolean {
  return message.card != null;
}

/** The latest Claude choices remain live until any owner message follows them. */
export function liveChoices(state: Omit<SetupState, 'messages'> & { messages: CompatibleMessage[] }): { index: number; choices: Choice[] } | null {
  if (state.step !== 'questions' || state.consent === null || state.question === null) return null;
  for (let index = state.messages.length - 1; index >= 0; index -= 1) {
    const message = state.messages[index];
    if (!message) continue;
    if (message.role === 'owner') return null;
    if (message.role === 'claude' && !isCard(message) && message.choices?.length) return { index, choices: message.choices };
  }
  return null;
}

/** The inline actions accept or decline; typed changes are conversation turns. */
export interface ProposalDecision {
  action: 'accept' | 'decline';
  proposal: ProposalCard;
  amount_cents?: number;
}

export type DecisionResult =
  | { ok: true; body: SetupProposalBody }
  | { ok: false; field: 'amount_cents'; message: string; code?: never }
  | { ok: false; field: 'amount_cents'; code: 'amount_required'; message: string };

/** Build only a valid request body, or a field error the screen can show without sending. */
export function decisionBody(decision: ProposalDecision): DecisionResult {
  if (decision.action === 'decline') return { ok: true, body: { accept: false } };
  const body: SetupProposalBody = { accept: true };
  if (decision.amount_cents !== undefined) {
    const amount = decision.amount_cents;
    if (decision.proposal.kind !== 'job' || decision.proposal.job?.config?.block !== 'purpose_payment') {
      return { ok: false, field: 'amount_cents', message: 'Only a payment job can change its amount.' };
    }
    if (!Number.isInteger(amount) || amount < 0 || amount > 1_000_000) {
      return { ok: false, field: 'amount_cents', message: 'Enter a whole number of cents between 0 and 1,000,000.' };
    }
    body.amount_cents = amount;
  }
  if (decision.proposal.kind === 'job' && decision.proposal.job?.config?.block === 'purpose_payment'
    && decision.proposal.job.config.amount_cents === null && body.amount_cents === undefined) {
    return { ok: false, field: 'amount_cents', code: 'amount_required', message: 'Enter an amount before accepting this payment job.' };
  }
  return { ok: true, body };
}
