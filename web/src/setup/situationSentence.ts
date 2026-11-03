/**
 * A tried situation's line: the sentence of the draft rule that decided it, read as Rules reads that
 * card (`ruleSentence`). A situation no single card decided keeps the kernel's own reason: the
 * result names no always-on rule, so setup never words one from the reason's text.
 */
import type { RulesDraft, SituationResult } from '../api/views.ts';
import { ruleSentence, type SentencePart, type SentenceWords } from '../owner/rules/ruleSentence.ts';

export function situationSentence({ result }: SituationResult, draft: RulesDraft, words: SentenceWords): readonly SentencePart[] | undefined {
  const [id, ...more] = result.card_ids;
  // A card the draft doesn't have is not permission to read another rule in its place.
  const card = id === undefined || more.length > 0 ? undefined : draft.cards.find((c) => c.card_id === id);
  return card === undefined ? undefined : ruleSentence(card, words);
}
