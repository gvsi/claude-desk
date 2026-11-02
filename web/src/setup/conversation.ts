import { SETUP_COPY } from './copy.ts';
import type { Choice, ProposalCard, SetupMessage, SetupProposalBody, SetupState } from '../api/views.ts';

/** The owner's message the API writes from picks (its own module, so the mock's dev server can load it too). */
export { pickedAnswer } from './pickedAnswer.ts';

/** Older API messages omit card and choices until the consultant conversation is served. */
type CompatibleMessage = Pick<SetupMessage, 'role' | 'text'> & Partial<Pick<SetupMessage, 'card' | 'choices' | 'several'>>;

/** Cards render as their own messages, never as empty text bubbles. */
export function isCard(message: CompatibleMessage): boolean {
  return message.card != null;
}

/**
 * The latest Claude choices remain live until any owner message follows them; `several` when the
 * owner may pick more than one of them.
 */
export function liveChoices(state: Omit<SetupState, 'messages'> & { messages: CompatibleMessage[] }): { index: number; choices: Choice[]; several: boolean } | null {
  if (state.step !== 'questions' || state.consent === null || state.question === null) return null;
  for (let index = state.messages.length - 1; index >= 0; index -= 1) {
    const message = state.messages[index];
    if (!message) continue;
    if (message.role === 'owner') return null;
    if (message.role === 'claude' && !isCard(message) && message.choices?.length) return { index, choices: message.choices, several: message.several === true };
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
  | { ok: false; field: 'amount_cents'; code: 'amount_required'; message: string };

/** Build only a valid request body, or a field error the screen can show without sending. */
export function decisionBody(decision: ProposalDecision): DecisionResult {
  if (decision.action === 'decline') return { ok: true, body: { accept: false } };
  const body: SetupProposalBody = { accept: true };
  const invalid: DecisionResult = { ok: false, field: 'amount_cents', code: 'amount_required', message: SETUP_COPY.proposal.amountError };
  if (decision.amount_cents !== undefined) {
    const amount = decision.amount_cents;
    if (decision.proposal.kind !== 'job' || decision.proposal.job?.job !== 'payment') {
      return invalid;
    }
    if (!Number.isInteger(amount) || amount <= 0 || amount > 1_000_000) {
      return invalid;
    }
    body.amount_cents = amount;
  }
  const job = decision.proposal.job;
  if (decision.proposal.kind === 'job' && job?.job === 'payment'
    && (job.config?.block !== 'purpose_payment' || (job.config.amount_cents === null || job.config.amount_cents <= 0)) && body.amount_cents === undefined) {
    return invalid;
  }
  return { ok: true, body };
}
