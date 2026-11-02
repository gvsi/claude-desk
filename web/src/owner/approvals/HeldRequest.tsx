/**
 * A request held for the owner, answered in place wherever it shows: Today's Needs you and the
 * conversation it was held in. Both screens draw it with these pieces, so both answer it the same
 * way: the answers as the request stands, a conflict's line above it, one card from held to
 * answered so the answer lands where it was given, the rule an "always" answer drafted under it
 * once answered, and keyboard focus that never falls to the page as the button that had it goes away.
 */
import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';

import type { Decision } from '../../api/contracts.ts';
import { ApiError, ownerErrorCopy, request } from '../../api/http.ts';
import { ApprovalCard, Button, Notice } from '../../ds/index.ts';
import { aboveMoneyCapCopy, relativeWait } from '../../lib/format.ts';
import { useOwnerDesk } from '../OwnerLayout.tsx';
import type { AnswerDraftState, Answered, HeldItem, UseAnswer } from './useAnswer.ts';

const DRAFTED = 'Your answer also drafted a rule. Review it before it applies.';

/** The request with nothing offered: what the owner sees until it is read again. */
export function withNoAnswers(decision: Decision): Decision {
  return { ...decision, answers: [] };
}

/** What the approval card shows about a held request beyond the decision itself, wherever it is answered. */
export function aboutTheRequest(item: HeldItem, now: Date) {
  const { session } = item;
  const name = session.display_name?.trim() ? session.display_name : undefined;
  return {
    heldBy: item.held_by ?? undefined,
    // Only the visitor's own words, labelled as theirs: a held request draws no AI-written summary
    // (`claude_summary`), since a visitor could steer one to sway the owner's answer. The API never
    // sends one on a held request; its `NeedsYouItem` docstring says why.
    context:
      item.from_the_visitor !== null && item.from_the_visitor !== '' ? (
        <>
          From the visitor: “<span data-copy="user">{item.from_the_visitor}</span>”
        </>
      ) : undefined,
    waiting: `${session.kind === 'agent' ? 'Agent' : 'Web chat'}, ${relativeWait(item.held_at, now)}`,
    // A demo visitor's request is tagged as one, never passed off as a real customer's.
    demoVisitor: session.demo_visitor === true,
    // The verified person's name on record, or the agent's own: "Only for {name}, always".
    personName: session.verified || session.kind === 'agent' ? name : undefined,
  };
}

/** Focus that fell to the page as the element that had it went away goes to `el`. */
function catchFallenFocus(el: HTMLElement | null | undefined): void {
  const active = document.activeElement;
  if (active === null || active === document.body) el?.focus();
}

export interface HeldRequestProps {
  /** The request as it was held: as Needs you lists it, or as it was answered here. */
  item: HeldItem;
  answers: UseAnswer;
  /** When Needs you was last read (its `dataUpdatedAt`): after a conflict, only a read since shows the request as it stands. */
  readAt: number;
  now: Date;
  /** Called with the card as it mounts and unmounts, so "Open the request" can focus it. */
  registerCard?: (decisionId: string, el: HTMLElement | null) => void;
  /** What follows the card once it is answered here, under the rule it drafted: Today's Dismiss. */
  children?: ReactNode;
}

/**
 * A held request with its answers, and the same card once it is answered here: its final line,
 * then the rule an "always" answer drafted and `children` under it. Keeping one card from held to
 * answered is what lets the answer land in place. A request answered here before this card
 * mounted (a conversation moves its card under the hold once the hold's receipt arrives) draws
 * answered at once. After a conflict, its line sits above the request and the answers are the ones
 * a read since then offers; until one lands, it offers none. Focus that fell to the page as the
 * answers changed (the one pressed may no longer be offered) goes to the request, once per conflict.
 */
export function HeldRequest({ item, answers, readAt, now, registerCard, children }: HeldRequestProps) {
  const id = item.decision.decision_id;
  const answered = answers.answered.get(id);
  const pending = answers.pending.has(id);
  const conflict = answered === undefined ? answers.conflictFor(id) : undefined;
  const asItStands = conflict === undefined || pending || readAt > conflict.at;

  const card = useRef<HTMLDivElement | null>(null);
  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      card.current = el;
      registerCard?.(id, el);
    },
    [id, registerCard],
  );
  const conflictSeen = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (conflict === undefined || pending || conflictSeen.current === conflict.at) return;
    conflictSeen.current = conflict.at;
    catchFallenFocus(card.current);
  });

  let decision = item.decision;
  if (answered !== undefined) decision = answered.decision;
  else if (!asItStands) decision = withNoAnswers(item.decision);
  const drafted = answered !== undefined && answered.card_diff !== null && answered.card_diff.length > 0;
  const after =
    answered !== undefined && (drafted || (children !== undefined && children !== null)) ? (
      <>
        {drafted ? <DraftedRule entry={answered} /> : null}
        {children}
      </>
    ) : undefined;

  return (
    <>
      {conflict !== undefined ? <Notice tone="error">{conflict.line}</Notice> : null}
      <ApprovalCard
        decision={decision}
        {...aboutTheRequest(item, now)}
        onAnswer={(a) => answers.answer(item, a)}
        pending={pending}
        error={answers.errorFor(id)}
        after={after}
        cardRef={ref}
      />
    </>
  );
}

export interface AnsweredFocus {
  /** Each answered card registers here as it mounts and unmounts. */
  register: (decisionId: string, el: HTMLElement | null) => void;
  /** The answered card for `decisionId`, while it is shown. */
  cardFor: (decisionId: string) => HTMLElement | undefined;
}

/**
 * Focus for the requests answered on a screen. As an answer lands, its card stays where it was and
 * its answers go; focus that was on the button pressed, and fell to the page as it went, follows the
 * card (the card itself moves it to its status line first). Requests answered before the screen
 * mounted take no focus. `cardFor` finds an answered card, for Dismiss and for a request's address.
 */
export function useAnsweredFocus(answered: ReadonlyMap<string, Answered>): AnsweredFocus {
  const cards = useRef(new Map<string, HTMLElement>());
  const seen = useRef(new Set(answered.keys()));
  useLayoutEffect(() => {
    for (const id of answered.keys()) {
      if (seen.current.has(id)) continue;
      seen.current.add(id);
      catchFallenFocus(cards.current.get(id));
    }
  }, [answered]);
  const register = useCallback((decisionId: string, el: HTMLElement | null) => {
    if (el) cards.current.set(decisionId, el);
    else cards.current.delete(decisionId);
  }, []);
  const cardFor = useCallback((decisionId: string) => cards.current.get(decisionId), []);
  return { register, cardFor };
}

/**
 * An "always" answer's rule: the cards it proposes are drafted only when the owner asks to review
 * them, and nothing applies until they confirm the draft. Shown under the answered card wherever
 * the request was answered.
 */
export function DraftedRule({ entry }: { entry: Answered }) {
  const { desk } = useOwnerDesk();
  const deskId = desk.desk_id;
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ line: string; retry: boolean } | null>(null);
  const cardDiff = entry.card_diff ?? [];

  const review = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const draft = await request('draftRules', { params: { desk_id: deskId }, body: { add: cardDiff } });
      const state: AnswerDraftState = { cardDiff, draft };
      void navigate(`/app/${encodeURIComponent(deskId)}/rules/drafts/${draft.version}`, { state });
    } catch (err) {
      if (err instanceof ApiError && err.kind === 'unauthorized') return;
      // Above the money cap, trying again can't help until the limit is raised.
      if (err instanceof ApiError && err.code === 'above_money_cap') setFailure({ line: aboveMoneyCapCopy(err.capCents), retry: false });
      else setFailure({ line: ownerErrorCopy(err), retry: true });
    } finally {
      setBusy(false);
    }
  };

  const action = (label: string): ReactNode => (
    <Button variant="secondary" busy={busy} onClick={() => void review()}>
      {label}
    </Button>
  );
  return (
    <div className="cd-held-request__rule">
      {failure === null ? (
        <Notice tone="info" action={action('Review the rule')}>
          {DRAFTED}
        </Notice>
      ) : (
        <Notice tone="error" action={failure.retry ? action('Try again') : undefined}>
          {failure.line}
        </Notice>
      )}
    </div>
  );
}
