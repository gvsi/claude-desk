/**
 * The owner's conversation with Claude about rules (N-Conn-12-Chat), inside `AskClaudePanel`: the
 * owner's words, Claude's answer in serif, and any change it drafted, reviewed inline before
 * anything applies. `chatTurn` asks Claude (`ruleChat`) and says what came back in turns.
 */
import type { QueryClient } from '@tanstack/react-query';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

import type { RenderedBlock } from '../../api/contracts.ts';
import { ApiError, RULES_UNAVAILABLE_COPY, request } from '../../api/http.ts';
import type { RuleChatOut, RulesDraft } from '../../api/views.ts';
import { AskClaudePanel, ClaudeMessage, Notice, VisitorMessage, type NoticeTone } from '../../ds/index.ts';
import { aboveMoneyCapCopy } from '../../lib/format.ts';
import { draftFromDiff, type RuleDraft } from './drafts.ts';
import { land } from './landing.ts';
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

/** A turn's scroll margin on one side: how far from the conversation's edge it is brought into view. */
function scrollMargin(turn: Element, side: 'top' | 'bottom'): number {
  const style = getComputedStyle(turn);
  return Number.parseFloat(side === 'top' ? style.scrollMarginTop : style.scrollMarginBottom) || 0;
}

/**
 * Scrolls the conversation `log` the least that shows `end`, the end of the newest exchange in
 * `turn`, without taking the exchange's start, the owner's words in `lead`, above the log's top:
 * when both can't show, the owner's words win. Words too long to be whole give their place to the
 * newest turn's start. Each keeps its turn's scroll margin from the log's edge.
 */
function revealExchange(log: HTMLElement, lead: HTMLElement, turn: HTMLElement, end: Element): void {
  const port = log.getBoundingClientRect();
  const whole = (el: HTMLElement) => el.getBoundingClientRect().height + scrollMargin(el, 'top') + scrollMargin(el, 'bottom') <= port.height;
  const start = whole(lead) ? lead : turn;
  // How far down the log may go before the start passes its top, and how far it must go to show the end.
  const room = start.getBoundingClientRect().top - scrollMargin(start, 'top') - port.top;
  const short = end.getBoundingClientRect().bottom + scrollMargin(turn, 'bottom') - port.bottom;
  log.scrollTop += Math.min(Math.max(0, short), room);
}

/**
 * Brings the newest exchange into view as each turn is added: from the owner's words that lead it
 * to the newest turn, and, for a change Claude drafted, to the review's buttons once they show (the
 * review may read the rules first). The owner's words come first, so a new turn opens with them
 * whole, never cut under the panel's header: when the whole exchange doesn't fit, "Confirm change"
 * and "Keep my rules" are a scroll away below them. Only a new turn scrolls, and only the
 * conversation: the owner's own scrolling is left alone.
 */
function useRevealNewTurns(root: { current: HTMLElement | null }, turns: readonly ChatTurn[]): void {
  const last = turns.at(-1);
  const lastId = last?.id;
  const leadId = turns.findLast((turn) => turn.kind === 'owner')?.id;
  const drafted = last?.kind === 'claude' && last.draft !== null;
  useEffect(() => {
    const turnOf = (id: number | undefined) => (id === undefined ? null : (root.current?.querySelector<HTMLElement>(`[data-turn="${id}"]`) ?? null));
    const turn = turnOf(lastId);
    const log = turn?.closest<HTMLElement>('[role="log"]');
    if (!turn || !log) return undefined;
    const lead = turnOf(leadId) ?? turn;
    revealExchange(log, lead, turn, turn);
    if (!drafted) return undefined;
    // The review's last button ("Keep my rules", or "Try again" when the rules couldn't be read)
    // closes it, and the exchange.
    const revealActions = () => {
      const buttons = turn.querySelectorAll('.cd-rule-draft button');
      const end = buttons[buttons.length - 1];
      if (end === undefined) return false;
      revealExchange(log, lead, turn, end);
      return true;
    };
    if (revealActions()) return undefined;
    const observer = new MutationObserver(() => {
      if (revealActions()) observer.disconnect();
    });
    observer.observe(turn, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [root, lastId, leadId, drafted]);
}

/**
 * The panel and the conversation in it, in order: the owner's words in a bubble, Claude's answer
 * in serif and the change it drafted as an inline review, and any line on what went wrong. Once a
 * change is confirmed, its receipt takes the review's place, and Rules shows where it landed.
 */
export const RuleChat = forwardRef<HTMLDivElement, RuleChatProps>(function RuleChat({ deskId, ownerName, turns, busy, onSend, onClose, onSettled }, ref) {
  const root = useRef<HTMLDivElement>(null);
  useImperativeHandle(ref, () => root.current as HTMLDivElement, []);
  useRevealNewTurns(root, turns);
  return (
    <div ref={root} className="cd-rule-chat">
      <AskClaudePanel onClose={onClose} onSend={onSend} busy={busy}>
        {turns.map((turn) => {
          if (turn.kind === 'owner') {
            return (
              <div key={turn.id} data-turn={turn.id} className="cd-rule-chat__turn">
                <VisitorMessage text={turn.text} />
              </div>
            );
          }
          if (turn.kind === 'notice') {
            return (
              <div key={turn.id} data-turn={turn.id} className="cd-rule-chat__turn">
                <Notice tone={turn.tone}>{turn.line}</Notice>
              </div>
            );
          }
          return (
            <div key={turn.id} data-turn={turn.id} className="cd-rule-chat__turn cd-rule-chat__answer">
              <ClaudeMessage blocks={[prose(turn.answer)]} language="en" ownerName={ownerName} />
              {turn.draft === null ? null : turn.settled === 'kept' ? (
                <p className="cd-rule-chat__kept cd-type-meta">Nothing changed. Your rules stay as they are.</p>
              ) : (
                // Confirmed, the receipt takes the review's place, and the change lands on Rules beside it.
                <RuleDraftReview
                  deskId={deskId}
                  draft={turn.draft}
                  inline
                  onConfirmed={(change) => land(deskId, change)}
                  onDone={(outcome) => {
                    onSettled(turn.id, outcome);
                    // The receipt has landed where the review's buttons were: focus, left on the
                    // button pressed, goes to the panel's composer rather than the page.
                    const box = root.current;
                    if (outcome === 'confirmed' && box !== null && !box.contains(document.activeElement)) box.querySelector('textarea')?.focus();
                  }}
                />
              )}
            </div>
          );
        })}
      </AskClaudePanel>
    </div>
  );
});
