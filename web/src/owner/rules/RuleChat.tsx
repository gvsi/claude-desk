/**
 * The owner's conversation with Claude about rules (N-Conn-12-Chat), inside `AskClaudePanel`: the
 * owner's words, Claude's answer in serif, and any change it drafted, reviewed inline before
 * anything applies. `chatTurn` asks Claude (`ruleChat`) and says what came back in turns.
 */
import type { QueryClient } from '@tanstack/react-query';
import { forwardRef } from 'react';

import type { RenderedBlock } from '../../api/contracts.ts';
import { ApiError, RULES_UNAVAILABLE_COPY, request } from '../../api/http.ts';
import type { RuleChatOut, RulesDraft } from '../../api/views.ts';
import { AskClaudePanel, ClaudeMessage, Notice, VisitorMessage, type NoticeTone } from '../../ds/index.ts';
import { aboveMoneyCapCopy } from '../../lib/format.ts';
import { draftFromDiff, type RuleDraft } from './drafts.ts';
import { RuleDraftReview, rulesQuery } from './RuleDraftReview.tsx';

import './RuleChat.css';

/** One turn of the conversation, in the order it happened. */
export type ChatTurn =
  | { id: number; kind: 'owner'; text: string }
  | { id: number; kind: 'claude'; answer: string; draft: RuleDraft | null; settled?: 'confirmed' | 'kept' }
  | { id: number; kind: 'notice'; tone: NoticeTone; line: string };

/** A turn before it has its place in the conversation. */
type NewTurn = ChatTurn extends infer T ? (T extends { id: number } ? Omit<T, 'id'> : never) : never;

/** What a draft that couldn't be made says, wherever the owner asked for it. */
export const DRAFT_FAILED = "I couldn't draft that just now. Try again.";

/**
 * Why a drafting request failed, in the owner's words, or null when the session ended (the app goes
 * back to the start, so there is nothing to say here): rules that can't be checked now, a money
 * rule above the payment limit, or anything else.
 */
export function draftFailure(err: unknown): { tone: NoticeTone; line: string } | null {
  if (err instanceof ApiError && err.kind === 'unauthorized') return null;
  if (err instanceof ApiError && err.code === 'rules_cannot_be_checked') return { tone: 'info', line: RULES_UNAVAILABLE_COPY };
  if (err instanceof ApiError && err.code === 'above_money_cap') return { tone: 'info', line: aboveMoneyCapCopy(err.capCents) };
  return { tone: 'error', line: DRAFT_FAILED };
}

/** A proving retry's last answer can be the draft alone, with no words. */
function isRulesDraft(out: RuleChatOut | RulesDraft): out is RulesDraft {
  return 'version' in out && 'cards' in out;
}

/**
 * Asks Claude about `text` and says what came back: its answer, with the change it drafted built
 * against the active rules (read now, so the review compares with what applies); or why it
 * couldn't. Never throws.
 */
export async function chatTurn(deskId: string, text: string, queryClient: QueryClient): Promise<NewTurn[]> {
  let out: RuleChatOut;
  try {
    const answered: RuleChatOut | RulesDraft = await request('ruleChat', { params: { desk_id: deskId }, body: { text } });
    out = isRulesDraft(answered) ? { answer: '', draft: answered } : answered;
  } catch (err) {
    const failure = draftFailure(err);
    return failure === null ? [] : [{ kind: 'notice', ...failure }];
  }
  if (out.draft === null) return [{ kind: 'claude', answer: out.answer, draft: null }];
  const rules = await queryClient.fetchQuery(rulesQuery(deskId)).catch(() => queryClient.getQueryData(rulesQuery(deskId).queryKey) ?? null);
  if (rules === null) return [{ kind: 'claude', answer: out.answer, draft: null }, { kind: 'notice', tone: 'error', line: DRAFT_FAILED }];
  return [{ kind: 'claude', answer: out.answer, draft: draftFromDiff(out.draft, rules.active) }];
}

/** Claude's words as the one prose block a message shows in serif. */
function prose(text: string): RenderedBlock {
  return { kind: 'prose', template: null, text, fact_id: null, title: null, lines: [], href: null, options: [] };
}

export interface RuleChatProps {
  deskId: string;
  /** The owner's name, for any card that names her. */
  ownerName: string;
  turns: readonly ChatTurn[];
  /** A request is out: "Claude is writing". */
  busy: boolean;
  /** Another change, from the panel's composer. */
  onSend: (text: string) => void;
  /** "Close" or Escape. */
  onClose: () => void;
  /** A drafted change was confirmed, or the owner kept her rules. */
  onSettled: (turnId: number, outcome: 'confirmed' | 'kept') => void;
}

/**
 * The panel and the conversation in it, in order: the owner's words in a bubble, Claude's answer
 * in serif and the change it drafted as an inline review, and any line on what went wrong.
 */
export const RuleChat = forwardRef<HTMLDivElement, RuleChatProps>(function RuleChat({ deskId, ownerName, turns, busy, onSend, onClose, onSettled }, ref) {
  return (
    <div ref={ref} className="cd-rule-chat">
      <AskClaudePanel onClose={onClose} onSend={onSend} busy={busy}>
        {turns.map((turn) => {
          if (turn.kind === 'owner') return <VisitorMessage key={turn.id} text={turn.text} />;
          if (turn.kind === 'notice') {
            return (
              <Notice key={turn.id} tone={turn.tone}>
                {turn.line}
              </Notice>
            );
          }
          return (
            <div key={turn.id} className="cd-rule-chat__answer">
              <ClaudeMessage blocks={[prose(turn.answer)]} language="en" ownerName={ownerName} />
              {turn.draft === null ? null : turn.settled === 'kept' ? (
                <p className="cd-rule-chat__kept cd-type-meta">Nothing changed. Your rules stay as they are.</p>
              ) : (
                <RuleDraftReview deskId={deskId} draft={turn.draft} inline onDone={(outcome) => onSettled(turn.id, outcome)} />
              )}
            </div>
          );
        })}
      </AskClaudePanel>
    </div>
  );
});
