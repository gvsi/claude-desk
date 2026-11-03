/**
 * Situation stories read the Turner rule cards that decide them as Rules reads those cards. A
 * situation no card decided (a discount, someone else's address) keeps the kernel's own words.
 */
import { ruleSentence } from '../../owner/rules/ruleSentence.ts';
import { NO_BUSINESS_TOOLS } from '../../owner/connectors/catalog.ts';
import { rivera } from './rivera.ts';

const words = { business: NO_BUSINESS_TOOLS, cards: Object.values(rivera.ruleCards) };
export const setupSituationSentences = {
  booking: ruleSentence(rivera.ruleCards['rv-book-wk'], words),
  deposit: ruleSentence(rivera.ruleCards['rv-mandate'], words),
  documents: ruleSentence(rivera.ruleCards['rv-docs'], words),
};
