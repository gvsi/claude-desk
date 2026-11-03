/**
 * The active rules as a screen reads them to name the rule beside a request: Today's and a
 * conversation's held cards, and Safety's turned-down requests (`requestRule.ts`). Each names one
 * rule in its sentence, so they read the words a sentence needs with the rules.
 */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import type { RuleCard } from '../../api/contracts.ts';
import { businessTools } from '../connectors/catalog.ts';
import { FRESH_MS, type ReadOptions } from '../useDesks.ts';
import { useReadFailure, type ReadFailure } from '../useReadFailure.ts';
import { requestRulesQuery } from './requestRulesQuery.ts';
import { peopleQuery } from './RuleDraftReview.tsx';
import type { SentenceWords } from './ruleSentence.ts';

export { requestRulesQuery } from './requestRulesQuery.ts';

export interface RequestRules {
  /** The active version's cards, default ones included (the namers leave them out). */
  cards: readonly RuleCard[];
  words: SentenceWords;
  /** The active version's number, so a record's older decision is never explained by a newer card. */
  version?: number | null;
}

export interface RequestRulesRead {
  /** The rules and their words, once read; null until then, and while every read has failed. */
  rules: RequestRules | null;
  /**
   * The read has answered, failed or paused, so a screen waiting for it to open can open. Once
   * settled it stays settled, so a paused read sent again on reconnect never brings a skeleton back.
   */
  settled: boolean;
  /**
   * The latest read failed: the line and Try again a screen shows where the rule would be named, so
   * a failed read never looks like a request no rule decided. Null once a read works.
   */
  failure: ReadFailure | null;
}

/**
 * The active rules and the words their sentences need: the business's tools and, when a rule names
 * one of its customers, the people on record (read only then, so their names show in place of "One
 * customer" once in). Fresh for `FRESH_MS`, as Today's other reads are, so a read ahead counts.
 */
export function useRequestRules(deskId: string, { retryOnMount = true }: ReadOptions = {}): RequestRulesRead {
  const rules = useQuery({ ...requestRulesQuery(deskId), staleTime: FRESH_MS, retryOnMount });
  const failure = useReadFailure(rules, { pausedRoute: 'rules' });
  const view = rules.data;
  const namesPeople = view?.active.cards.some((card) => card.who === 'person') ?? false;
  const people = useQuery({ ...peopleQuery(deskId), enabled: namesPeople });
  const settledNow = view !== undefined || rules.isError || rules.isPaused;
  const [wasSettled, setWasSettled] = useState(settledNow);
  if (settledNow && !wasSettled) setWasSettled(true);
  const settled = settledNow || wasSettled;
  if (view === undefined) return { rules: null, settled, failure };
  const cards = view.active.cards;
  return {
    rules: { cards, version: view.active.version, words: { business: businessTools(view.tools), tools: view.tools, cards, people: people.data ?? null } },
    settled,
    failure,
  };
}
