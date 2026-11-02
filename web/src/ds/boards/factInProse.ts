/**
 * The vision boards' copy of the kernel's reply check on prose (`scan_prose` in
 * `backend/desk/kernel_service/reply_check.py`), so a board story fails where the kernel would block
 * Claude's words. The kernel scans only a reply's prose: a real receipt is the kernel's own fixed
 * line (`render.status`), never scanned. A vision page's receipts are free text written for the
 * page, so the vision stories hold them to the same check themselves (`expectNoFactsInProse`).
 * It reads text as the kernel shows it (`shown`): NFKC, without the characters no font draws, and
 * with each Hangul filler as a blank. It holds:
 * - the always-on scans: any Unicode numeral or character drawn as a digit, with the letters shaped
 *   like 0 or 1 next to one or in a word of their own, any currency sign, and the percent signs;
 * - words mixing Latin letters with another script (`mixed_script`);
 * - both lexicons, `lexicon/en.txt` and `lexicon/es.txt`, entry for entry with their categories
 *   (`LEXICON`; `factInProse.test.ts` fails if either side has an entry the other lacks), matched
 *   as the kernel matches them: case-insensitively, as whole words, on every reading it takes of the
 *   text (`readings`), each folded as it folds it: letters drawn like Latin ones read as those
 *   (`lookalikes.ts`, its `lexicon/lookalikes.txt`, which the test keeps in step too), a bare stroke
 *   as l and as I, an ASCII capital I as l too, and a spaced acute as an apostrophe;
 * - booking and callback claims: a claim passes with a condition straight before it
 *   (`BOOKING_CONDITION`), inside such a claim of its category, or beside its own receipt category.
 * `factInProse.kernel.ts` holds the kernel's own verdicts on sentences, and the test fails where
 * this check disagrees with one. What it doesn't read, which the kernel does: canaries, since no
 * board quotes a private document; the Desk's own names, which `mixed_script` spares, and a business
 * tool's approved free names, since the boards name neither; and the reading of a reply as Markdown
 * renders it, since the vision pages show Claude's words as written.
 */

import { LOOKALIKES } from './lookalikes.ts';

/** A lexicon line's category, as the kernel names them. */
export type LexiconCategory = 'number' | 'money' | 'percent' | 'date' | 'promise' | 'booking' | 'callback';

/** One line of a kernel lexicon: its language, its category and its regex, as the file writes it. */
export interface LexiconEntry {
  language: 'en' | 'es';
  category: LexiconCategory;
  pattern: string;
}

/** What the scan found: the kernel's rule id (`digit`, `currency`, `percent_sign`, `lex.<lang>.<category>`) and the words. */
export interface FactHit {
  rule: string;
  span: string;
}

/** The kernel's lexicons, in file order. Generated from the files; the parity test keeps it in step. */
export const LEXICON: readonly LexiconEntry[] = [
  { language: 'en', category: 'number', pattern: String.raw`two|three|four|five|six|seven|eight|nine|ten|eleven|twelve` },
  { language: 'en', category: 'number', pattern: String.raw`(?:thir|four|fif|six|seven|eigh|nine)teen` },
  { language: 'en', category: 'number', pattern: String.raw`(?:twen|thir|for|four|fif|six|seven|eigh|nine)ty` },
  { language: 'en', category: 'number', pattern: String.raw`hundreds?|thousands?|millions?|billions?|dozens?|half|halves` },
  { language: 'en', category: 'number', pattern: String.raw`zeros?|zeroes` },
  { language: 'en', category: 'number', pattern: String.raw`quarters?` },
  { language: 'en', category: 'number', pattern: String.raw`thirds?` },
  { language: 'en', category: 'number', pattern: String.raw`(?:four|fif|six|seven|eigh|nin|ten|eleven|twelf)ths?` },
  { language: 'en', category: 'number', pattern: String.raw`(?:thir|four|fif|six|seven|eigh|nine)teenths?|(?:twen|thir)tieths?` },
  { language: 'en', category: 'number', pattern: String.raw`one(?:[\s-]+and)?[\s-]+(?:hundreds?|thousands?|millions?|billions?|dozens?|half|dollars?|bucks?|cents?|euros?|pesos?|usd|per[\s-]?cent|percent)` },
  { language: 'en', category: 'money', pattern: String.raw`dollars?|bucks?|cents?|usd|eur|euros?|pesos?|mxn` },
  { language: 'en', category: 'money', pattern: String.raw`grand` },
  { language: 'en', category: 'percent', pattern: String.raw`percent(?:age)?s?|per[\s-]?cent|pct` },
  { language: 'en', category: 'date', pattern: String.raw`mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|sundays?` },
  { language: 'en', category: 'date', pattern: String.raw`january|february|march|april|june|july|august|september|october|november|december` },
  { language: 'en', category: 'date', pattern: String.raw`(?:(?<=[^\W\d_] )|(?<=[^\W\d_], )|(?:in|on|by|until|till|next|this|early|late|mid|last)[\s-]+)(?-i:May)` },
  { language: 'en', category: 'date', pattern: String.raw`today|tonight|tomorrow|yesterday|weekends?|noon|midnight|o['’]?clock` },
  { language: 'en', category: 'date', pattern: String.raw`(?:next|this|last)[\s-]+(?:week|month)|(?:next|this)[\s-]+year(?![’']s\b)|this[\s-]+(?:morning|afternoon|evening)` },
  { language: 'en', category: 'date', pattern: String.raw`[ap]\.\s?m\.?|pm` },
  { language: 'en', category: 'date', pattern: String.raw`same[\s-]{0,3}day` },
  { language: 'en', category: 'date', pattern: String.raw`(?:in|within)[\s-]+(?:[^\W\d_]+[\s-]+){0,3}(?:minutes?|mins?|hours?|hrs?)` },
  { language: 'en', category: 'date', pattern: String.raw`first[\s-]+thing[\s-]+in[\s-]+the[\s-]+morning` },
  { language: 'en', category: 'promise', pattern: String.raw`guarant(?:ee|ees|eed|eeing|y)|promis(?:e|es|ed|ing)` },
  { language: 'en', category: 'promise', pattern: String.raw`(?<!feel )free(?! to\b)` },
  { language: 'en', category: 'promise', pattern: String.raw`(?<!feel )(?<!you['’]re )(?<!you are )(?<!you['’]ll be )(?<!you will be )free(?= to\b)` },
  { language: 'en', category: 'promise', pattern: String.raw`free(?=[\s-]+to[\s-]+(?:all|any(?:one|body)?|every(?:one|body)?|each|both|some|most|several|many|no|unlimited)\b)` },
  { language: 'en', category: 'promise', pattern: String.raw`free(?=[\s-]+to[\s-]+(?:the|an?|this|that|these|those|our|your|my|his|her|its|their|you|them)\b)` },
  { language: 'en', category: 'promise', pattern: String.raw`free(?=[\s-]+to[\s-]+(?:new|existing|first[\s-]?time|current|returning|regular|local)\b)` },
  { language: 'en', category: 'promise', pattern: String.raw`free(?=[\s-]+to[\s-]+(?:members?|customers?|clients?|guests?|patrons?|subscribers?|visitors?|locals|residents?)\b)` },
  { language: 'en', category: 'promise', pattern: String.raw`free(?=[\s-]+to[\s-]+(?:students?|seniors?|kids|children|famil(?:y|ies)|patients?)\b)` },
  { language: 'en', category: 'promise', pattern: String.raw`discount(?:s|ed|ing)?|refund(?:s|ed|ing|able)?|waiv(?:e|es|ed|er|ing)|complimentary` },
  { language: 'en', category: 'promise', pattern: String.raw`on[\s-]+the[\s-]+house|warrant(?:y|ies)|money[\s-]+back` },
  { language: 'en', category: 'promise', pattern: String.raw`no[\s-]+(?!(?:matter|one|way|doubt)(?![\w-]))(?:[^\W\d_]+[\s-]+){0,2}(?:charges?|costs?)` },
  { language: 'en', category: 'promise', pattern: String.raw`(?<!count )(?<!counts )(?<!counted )(?<!counting )(?<!rely )(?<!relies )(?<!relied )(?<!relying )(?<!depend )(?<!depends )(?<!depended )(?<!depending )on[\s-]+us` },
  { language: 'en', category: 'promise', pattern: String.raw`no[\s-]+(?:[^\W\d_]+[\s-]+){0,2}fees?` },
  { language: 'en', category: 'booking', pattern: String.raw`(?:(?:your|the|this|that|my|our|[^\W\d_]+['’]s)[\s-]+(?:(?:(?<=-)|(?!(?:once|whenever|when|[il]f|after|before|unt[il]l|t[il]ll|unless|as|of|for|with|to|at|on|in|from|about|by|and|or|but)\s))[^\W\d_]+[\s-]+){0,3}|(?<![^\W_] ))(?:bookings?|appointments?|visits?|reservations?|slots?|spots?|viewings?|showings?|tours?|class(?:es)?|lessons?|sessions?|tables?|rooms?|stays?|consultations?|consults?|fittings?|tastings?|treatments?|massages?|haircuts?|trials?|demos?|pickups?|meetings?)(?:['’]s(?:[\s-]+(?:(?:all|now|already|just|also|officially|successfully|finally)[\s-]+)?been)?|['’]re|[\s-]+(?:is|are|was|were|ha(?:s|ve)[\s-]+(?:(?:all|now|already|just|also|officially|successfully|finally)[\s-]+)?been))[\s-]+(?:(?:all|now|already|just|also|officially|successfully|finally)[\s-]+){0,2}(?:booked|confirmed|scheduled|reserved|set|saved)` },
  { language: 'en', category: 'booking', pattern: String.raw`your(?!(?:[\s-]+(?:[il]dent[il]ty|deta[il]ls|contact|ema[il]l|phone|number|address|account|[il]nformat[il]on|[il]nfo|name|code|ver[il]f[il]cat[il]on|payment[\s-]+method|preferences|message|request)){1,3}(?:['’]s(?:[\s-]+(?:(?:all|now|already|just|also|officially|successfully|finally)[\s-]+)?been)?|['’]re|[\s-]+(?:is|are|was|were|ha(?:s|ve)[\s-]+(?:(?:all|now|already|just|also|officially|successfully|finally)[\s-]+)?been))[\s-]+(?:(?:all|now|already|just|also|officially|successfully|finally)[\s-]+){0,2}(?:confirmed|set)(?!\w))(?!(?:[\s-]+(?!(?:[il]s|are|was|were|has|have|and|or|plus|your|the|this|that|my|our|an?|(?:bookings?|appointments?|visits?|reservations?|slots?|spots?|viewings?|showings?|tours?|class(?:es)?|lessons?|sessions?|tables?|rooms?|stays?|consultations?|consults?|fittings?|tastings?|treatments?|massages?|haircuts?|trials?|demos?|pickups?|meetings?))\b)[^\W\d_]+){0,3}[\s-]+(?<!serv[il]ce[\s-])(?:intro[\s-]+calls?|callbacks?|calls?[\s-]+backs?|(?:(?!(?:bookings?|appointments?|visits?|reservations?|slots?|spots?|viewings?|showings?|tours?|class(?:es)?|lessons?|sessions?|tables?|rooms?|stays?|consultations?|consults?|fittings?|tastings?|treatments?|massages?|haircuts?|trials?|demos?|pickups?|meetings?|serv[il]ce|[il]s|are|was|were|has|have)-)[^\W\d_]+-){0,2}calls?)(?:[\s-]+request|[\s-]+w[il]th[\s-]+(?!(?:(?:bookings?|appointments?|visits?|reservations?|slots?|spots?|viewings?|showings?|tours?|class(?:es)?|lessons?|sessions?|tables?|rooms?|stays?|consultations?|consults?|fittings?|tastings?|treatments?|massages?|haircuts?|trials?|demos?|pickups?|meetings?)|service|and|or|plus|your|the|a|an|is|are|was|were|has|have|once|when|if|after|before|unless)\b)[^\W\d_]+(?:[\s-]+(?!(?:(?:bookings?|appointments?|visits?|reservations?|slots?|spots?|viewings?|showings?|tours?|class(?:es)?|lessons?|sessions?|tables?|rooms?|stays?|consultations?|consults?|fittings?|tastings?|treatments?|massages?|haircuts?|trials?|demos?|pickups?|meetings?)|service|and|or|plus|your|the|a|an|is|are|was|were|has|have|once|when|if|after|before|unless)\b)[^\W\d_]+)?)?(?:['’](?:s|re)|[\s-]+(?:is|are|was|were|has|have))\b)(?:[\s-]+(?:(?<=-)|(?!(?:[il]s|are|was|were|has|have|once|whenever|when|[il]f|after|before|unt[il]l|t[il]ll|unless|as)\s))[^\W\d_]+){1,7}(?:['’]s(?:[\s-]+(?:(?:all|now|already|just|also|officially|successfully|finally)[\s-]+)?been)?|['’]re|[\s-]+(?:is|are|was|were|ha(?:s|ve)[\s-]+(?:(?:all|now|already|just|also|officially|successfully|finally)[\s-]+)?been))[\s-]+(?:(?:all|now|already|just|also|officially|successfully|finally)[\s-]+){0,2}(?:booked|scheduled|reserved|confirmed|set(?![\s-]+(?:up|to)\b))` },
  { language: 'en', category: 'booking', pattern: String.raw`you(?:['’]?re|[\s-]+(?:are|were)|(?:['’]ve|[\s-]+have)[\s-]+(?:(?:all|now|already|just|also|officially|successfully|finally)[\s-]+)?been)[\s-]+(?:(?:all|now|already|just|also|officially|successfully|finally)[\s-]+){0,2}(?:booked|confirmed|scheduled|reserved|set)` },
  { language: 'en', category: 'booking', pattern: String.raw`(?:it|that|everything)(?:['’]s(?:[\s-]+(?:(?:all|now|already|just|also|officially|successfully|finally)[\s-]+)?been)?|[\s-]+(?:is|was|has[\s-]+(?:(?:all|now|already|just|also|officially|successfully|finally)[\s-]+)?been))[\s-]+(?:(?:all|now|already|just|also|officially|successfully|finally)[\s-]+){0,2}(?:booked|confirmed|scheduled|reserved|set)` },
  { language: 'en', category: 'booking', pattern: String.raw`(?:[il]|we)(?:[\s-]+(?:all|now|already|just|also|officially|successfully|finally))?(?:(?:['’]ve|[\s-]+have)(?:[\s-]+(?:all|now|already|just|also|officially|successfully|finally))?(?:[\s-]+got)?|[\s-]+got)[\s-]+you[\s-]+(?:(?:all|now|already|just|also|officially|successfully|finally)[\s-]+){0,2}(?:booked|confirmed|scheduled|reserved|set|down)` },
  { language: 'en', category: 'booking', pattern: String.raw`(?:[il]|we|she|he|they)(?:['’]ve|['’]s|[\s-]+ha(?:ve|s))?(?:[\s-]+(?:now|already|just|also|officially|successfully|finally))?[\s-]+(?:booked|scheduled|confirmed|reserved)[\s-]+(?:you|it(?!['’][^\W\d_])|(?:your|the|a)[\s-]+(?:(?:(?<=-)|(?!(?:once|whenever|when|[il]f|after|before|unt[il]l|t[il]ll|unless|as|of|for|with|to|at|on|in|from|about|by|and|or|but)\s))[^\W\d_]+[\s-]+){0,3}(?:bookings?|appointments?|visits?|reservations?|slots?|spots?|viewings?|showings?|tours?|class(?:es)?|lessons?|sessions?|tables?|rooms?|stays?|consultations?|consults?|fittings?|tastings?|treatments?|massages?|haircuts?|trials?|demos?|pickups?|meetings?))` },
  { language: 'en', category: 'booking', pattern: String.raw`(?:booked|scheduled|confirmed|reserved)[\s-]+you(?!['’][^\W\d_])` },
  { language: 'en', category: 'booking', pattern: String.raw`(?:(?:you|who)(?:[ ]+(?:have|has|had)|[\x27’](?:ve|d))?(?:[ ]+(?:all|now|already|just|also|officially|successfully|finally|ever|previously|recently|personally|actually)){0,2}[ ]+(?:booked|scheduled|confirmed|reserved)[ ]+(?:your|the|a)[ ]+(?:(?:(?<=-)|(?!(?:once|whenever|when|[il]f|after|before|unt[il]l|t[il]ll|unless|as|of|for|with|to|at|on|in|from|about|by|and|or|but)\s))(?!(?:bookings?|appointments?|visits?|reservations?|slots?|spots?|viewings?|showings?|tours?|class(?:es)?|lessons?|sessions?|tables?|rooms?|stays?|consultations?|consults?|fittings?|tastings?|treatments?|massages?|haircuts?|trials?|demos?|pickups?|meetings?|intro|callbacks?|calls?|backs?|booked|scheduled|confirmed|reserved|and|or|but|plus|your|the|an?)\b)[^\W\d_]+[ ]+){0,3}?(?:bookings?|appointments?|visits?|reservations?|slots?|spots?|viewings?|showings?|tours?|class(?:es)?|lessons?|sessions?|tables?|rooms?|stays?|consultations?|consults?|fittings?|tastings?|treatments?|massages?|haircuts?|trials?|demos?|pickups?|meetings?))|(?P<claim>(?<!you )(?<!you['’]ve )(?<!you have )(?<!you already )(?<!you['’]ve already )(?<!you ever )(?<!you['’]ve ever )(?<!who )(?<!who['’]ve )(?<!n['’]t )(?<!not )(?<!never )(?:booked|scheduled|confirmed|reserved)[\s-]+(?:your|the|a)[\s-]+(?:(?:(?<=-)|(?!(?:once|whenever|when|[il]f|after|before|unt[il]l|t[il]ll|unless|as|of|for|with|to|at|on|in|from|about|by|and|or|but)\s))[^\W\d_]+[\s-]+){0,3}(?:bookings?|appointments?|visits?|reservations?|slots?|spots?|viewings?|showings?|tours?|class(?:es)?|lessons?|sessions?|tables?|rooms?|stays?|consultations?|consults?|fittings?|tastings?|treatments?|massages?|haircuts?|trials?|demos?|pickups?|meetings?))` },
  { language: 'en', category: 'booking', pattern: String.raw`(?<![^\W_] )(?:bookings?|appointments?|visits?|reservations?|slots?|spots?|viewings?|showings?|tours?|class(?:es)?|lessons?|sessions?|tables?|rooms?|stays?|consultations?|consults?|fittings?|tastings?|treatments?|massages?|haircuts?|trials?|demos?|pickups?|meetings?)(?:[\s-]+|[\s-]*:[\s-]*)(?:(?:all|now|already|just|also|officially|successfully|finally)[\s-]+){0,2}(?:booked|confirmed|scheduled|reserved|set|saved)` },
  { language: 'en', category: 'booking', pattern: String.raw`(?:your|the|this|that|my|our|[^\W\d_]+['’]s)[\s-]+(?:(?:(?<=-)|(?!(?:once|whenever|when|[il]f|after|before|unt[il]l|t[il]ll|unless|as|of|for|with|to|at|on|in|from|about|by|and|or|but)\s))[^\W\d_]+[\s-]+){0,3}(?:bookings?|appointments?|visits?|reservations?|slots?|spots?|viewings?|showings?|tours?|class(?:es)?|lessons?|sessions?|tables?|rooms?|stays?|consultations?|consults?|fittings?|tastings?|treatments?|massages?|haircuts?|trials?|demos?|pickups?|meetings?)[\s-]*[:-][\s-]*(?:(?:all|now|already|just|also|officially|successfully|finally)[\s-]+){0,2}(?:booked|confirmed|scheduled|reserved|set|saved)` },
  { language: 'en', category: 'booking', pattern: String.raw`(?<![^\W_] )all[\s-]+(?:booked|confirmed|scheduled|reserved)(?![\s-]+(?:[^\W\d_]+[\s-]+)?(?:bookings?|appointments?|visits?|reservations?|slots?|spots?|viewings?|showings?|tours?|class(?:es)?|lessons?|sessions?|tables?|rooms?|stays?|consultations?|consults?|fittings?|tastings?|treatments?|massages?|haircuts?|trials?|demos?|pickups?|meetings?|(?<!serv[il]ce[\s-])(?:intro[\s-]+calls?|callbacks?|calls?[\s-]+backs?|calls?))(?!\w))` },
  { language: 'en', category: 'callback', pattern: String.raw`(?:(?:your|the|this|that|my|our|[^\W\d_]+['’]s)[\s-]+(?:(?:(?<=-)|(?!(?:once|whenever|when|[il]f|after|before|unt[il]l|t[il]ll|unless|as|of|for|with|to|at|on|in|from|about|by|and|or|but)\s))(?!(?:[il]s|are|was|were|has|have)[\s-])[^\W\d_]+(?:-[^\W\d_]+)*\s+){0,3}|(?<![^\W_] ))(?<!serv[il]ce[\s-])(?:intro[\s-]+calls?|callbacks?|calls?[\s-]+backs?|(?:(?!(?:bookings?|appointments?|visits?|reservations?|slots?|spots?|viewings?|showings?|tours?|class(?:es)?|lessons?|sessions?|tables?|rooms?|stays?|consultations?|consults?|fittings?|tastings?|treatments?|massages?|haircuts?|trials?|demos?|pickups?|meetings?|serv[il]ce|[il]s|are|was|were|has|have)-)[^\W\d_]+-){0,2}calls?)(?:[\s-]+request|[\s-]+w[il]th[\s-]+(?!(?:(?:bookings?|appointments?|visits?|reservations?|slots?|spots?|viewings?|showings?|tours?|class(?:es)?|lessons?|sessions?|tables?|rooms?|stays?|consultations?|consults?|fittings?|tastings?|treatments?|massages?|haircuts?|trials?|demos?|pickups?|meetings?)|service|and|or|plus|your|the|a|an|is|are|was|were|has|have|once|when|if|after|before|unless)\b)[^\W\d_]+(?:[\s-]+(?!(?:(?:bookings?|appointments?|visits?|reservations?|slots?|spots?|viewings?|showings?|tours?|class(?:es)?|lessons?|sessions?|tables?|rooms?|stays?|consultations?|consults?|fittings?|tastings?|treatments?|massages?|haircuts?|trials?|demos?|pickups?|meetings?)|service|and|or|plus|your|the|a|an|is|are|was|were|has|have|once|when|if|after|before|unless)\b)[^\W\d_]+)?)?(?:['’]s(?:[\s-]+(?:(?:all|now|already|just|also|officially|successfully|finally)[\s-]+)?been)?|['’]re|[\s-]+(?:is|are|was|were|ha(?:s|ve)[\s-]+(?:(?:all|now|already|just|also|officially|successfully|finally)[\s-]+)?been))[\s-]+(?:(?:all|now|already|just|also|officially|successfully|finally)[\s-]+){0,2}(?:booked|confirmed|scheduled|reserved|set|saved)` },
  { language: 'en', category: 'callback', pattern: String.raw`(?:[il]|we|she|he|they)(?:['’]ve|['’]s|[\s-]+ha(?:ve|s))?(?:[\s-]+(?:now|already|just|also|officially|successfully|finally))?[\s-]+(?:booked|scheduled|confirmed|reserved)[\s-]+(?:(?:your|the|a)[\s-]+(?:(?:(?<=-)|(?!(?:once|whenever|when|[il]f|after|before|unt[il]l|t[il]ll|unless|as|of|for|with|to|at|on|in|from|about|by|and|or|but)\s))(?!(?:[il]s|are|was|were|has|have)[\s-])[^\W\d_]+(?:-[^\W\d_]+)*\s+){0,3}(?<!serv[il]ce[\s-])(?:intro[\s-]+calls?|callbacks?|calls?[\s-]+backs?|(?:(?!(?:bookings?|appointments?|visits?|reservations?|slots?|spots?|viewings?|showings?|tours?|class(?:es)?|lessons?|sessions?|tables?|rooms?|stays?|consultations?|consults?|fittings?|tastings?|treatments?|massages?|haircuts?|trials?|demos?|pickups?|meetings?|serv[il]ce|[il]s|are|was|were|has|have)-)[^\W\d_]+-){0,2}calls?)(?:[\s-]+request|[\s-]+w[il]th[\s-]+(?!(?:(?:bookings?|appointments?|visits?|reservations?|slots?|spots?|viewings?|showings?|tours?|class(?:es)?|lessons?|sessions?|tables?|rooms?|stays?|consultations?|consults?|fittings?|tastings?|treatments?|massages?|haircuts?|trials?|demos?|pickups?|meetings?)|service|and|or|plus|your|the|a|an|is|are|was|were|has|have|once|when|if|after|before|unless)\b)[^\W\d_]+(?:[\s-]+(?!(?:(?:bookings?|appointments?|visits?|reservations?|slots?|spots?|viewings?|showings?|tours?|class(?:es)?|lessons?|sessions?|tables?|rooms?|stays?|consultations?|consults?|fittings?|tastings?|treatments?|massages?|haircuts?|trials?|demos?|pickups?|meetings?)|service|and|or|plus|your|the|a|an|is|are|was|were|has|have|once|when|if|after|before|unless)\b)[^\W\d_]+)?)?)` },
  { language: 'en', category: 'callback', pattern: String.raw`(?:(?:you|who)(?:[ ]+(?:have|has|had)|[\x27’](?:ve|d))?(?:[ ]+(?:all|now|already|just|also|officially|successfully|finally|ever|previously|recently|personally|actually)){0,2}[ ]+(?:booked|scheduled|confirmed|reserved)[ ]+(?:your|the|a)[ ]+(?:(?:(?<=-)|(?!(?:once|whenever|when|[il]f|after|before|unt[il]l|t[il]ll|unless|as|of|for|with|to|at|on|in|from|about|by|and|or|but)\s))(?!(?:[il]s|are|was|were|has|have)[\s-])(?!(?:bookings?|appointments?|visits?|reservations?|slots?|spots?|viewings?|showings?|tours?|class(?:es)?|lessons?|sessions?|tables?|rooms?|stays?|consultations?|consults?|fittings?|tastings?|treatments?|massages?|haircuts?|trials?|demos?|pickups?|meetings?|intro|callbacks?|calls?|backs?|booked|scheduled|confirmed|reserved|and|or|but|plus|your|the|an?)\b)[^\W\d_]+(?:-(?!(?:bookings?|appointments?|visits?|reservations?|slots?|spots?|viewings?|showings?|tours?|class(?:es)?|lessons?|sessions?|tables?|rooms?|stays?|consultations?|consults?|fittings?|tastings?|treatments?|massages?|haircuts?|trials?|demos?|pickups?|meetings?|intro|callbacks?|calls?|backs?|booked|scheduled|confirmed|reserved|and|or|but|plus|your|the|an?)\b)[^\W\d_]+)*\s+){0,3}?(?<!serv[il]ce[\s-])(?:intro[ ]+calls?|callbacks?|calls?[ ]+backs?|(?:(?!(?:bookings?|appointments?|visits?|reservations?|slots?|spots?|viewings?|showings?|tours?|class(?:es)?|lessons?|sessions?|tables?|rooms?|stays?|consultations?|consults?|fittings?|tastings?|treatments?|massages?|haircuts?|trials?|demos?|pickups?|meetings?|serv[il]ce|[il]s|are|was|were|has|have)-)(?!(?:bookings?|appointments?|visits?|reservations?|slots?|spots?|viewings?|showings?|tours?|class(?:es)?|lessons?|sessions?|tables?|rooms?|stays?|consultations?|consults?|fittings?|tastings?|treatments?|massages?|haircuts?|trials?|demos?|pickups?|meetings?|intro|callbacks?|calls?|backs?|booked|scheduled|confirmed|reserved|and|or|but|plus|your|the|an?)\b)[^\W\d_]+-){0,2}calls?)(?:[ ]+request|[ ]+w[il]th[ ]+(?!(?:(?:bookings?|appointments?|visits?|reservations?|slots?|spots?|viewings?|showings?|tours?|class(?:es)?|lessons?|sessions?|tables?|rooms?|stays?|consultations?|consults?|fittings?|tastings?|treatments?|massages?|haircuts?|trials?|demos?|pickups?|meetings?)|service|and|or|plus|your|the|a|an|is|are|was|were|has|have|once|when|if|after|before|unless)\b)(?!(?:bookings?|appointments?|visits?|reservations?|slots?|spots?|viewings?|showings?|tours?|class(?:es)?|lessons?|sessions?|tables?|rooms?|stays?|consultations?|consults?|fittings?|tastings?|treatments?|massages?|haircuts?|trials?|demos?|pickups?|meetings?|intro|callbacks?|calls?|backs?|booked|scheduled|confirmed|reserved|and|or|but|plus|your|the|an?)\b)[^\W\d_]+(?:[ ]+(?!(?:(?:bookings?|appointments?|visits?|reservations?|slots?|spots?|viewings?|showings?|tours?|class(?:es)?|lessons?|sessions?|tables?|rooms?|stays?|consultations?|consults?|fittings?|tastings?|treatments?|massages?|haircuts?|trials?|demos?|pickups?|meetings?)|service|and|or|plus|your|the|a|an|is|are|was|were|has|have|once|when|if|after|before|unless)\b)(?!(?:bookings?|appointments?|visits?|reservations?|slots?|spots?|viewings?|showings?|tours?|class(?:es)?|lessons?|sessions?|tables?|rooms?|stays?|consultations?|consults?|fittings?|tastings?|treatments?|massages?|haircuts?|trials?|demos?|pickups?|meetings?|intro|callbacks?|calls?|backs?|booked|scheduled|confirmed|reserved|and|or|but|plus|your|the|an?)\b)[^\W\d_]+)?)?)|(?P<claim>(?<!you )(?<!you['’]ve )(?<!you have )(?<!you already )(?<!you['’]ve already )(?<!you ever )(?<!you['’]ve ever )(?<!who )(?<!who['’]ve )(?<!n['’]t )(?<!not )(?<!never )(?:booked|scheduled|confirmed|reserved)[\s-]+(?:your|the|a)[\s-]+(?:(?:(?<=-)|(?!(?:once|whenever|when|[il]f|after|before|unt[il]l|t[il]ll|unless|as|of|for|with|to|at|on|in|from|about|by|and|or|but)\s))(?!(?:[il]s|are|was|were|has|have)[\s-])[^\W\d_]+(?:-[^\W\d_]+)*\s+){0,3}(?<!serv[il]ce[\s-])(?:intro[\s-]+calls?|callbacks?|calls?[\s-]+backs?|(?:(?!(?:bookings?|appointments?|visits?|reservations?|slots?|spots?|viewings?|showings?|tours?|class(?:es)?|lessons?|sessions?|tables?|rooms?|stays?|consultations?|consults?|fittings?|tastings?|treatments?|massages?|haircuts?|trials?|demos?|pickups?|meetings?|serv[il]ce|[il]s|are|was|were|has|have)-)[^\W\d_]+-){0,2}calls?)(?:[\s-]+request|[\s-]+w[il]th[\s-]+(?!(?:(?:bookings?|appointments?|visits?|reservations?|slots?|spots?|viewings?|showings?|tours?|class(?:es)?|lessons?|sessions?|tables?|rooms?|stays?|consultations?|consults?|fittings?|tastings?|treatments?|massages?|haircuts?|trials?|demos?|pickups?|meetings?)|service|and|or|plus|your|the|a|an|is|are|was|were|has|have|once|when|if|after|before|unless)\b)[^\W\d_]+(?:[\s-]+(?!(?:(?:bookings?|appointments?|visits?|reservations?|slots?|spots?|viewings?|showings?|tours?|class(?:es)?|lessons?|sessions?|tables?|rooms?|stays?|consultations?|consults?|fittings?|tastings?|treatments?|massages?|haircuts?|trials?|demos?|pickups?|meetings?)|service|and|or|plus|your|the|a|an|is|are|was|were|has|have|once|when|if|after|before|unless)\b)[^\W\d_]+)?)?)` },
  { language: 'en', category: 'callback', pattern: String.raw`(?<![^\W_] )(?<!serv[il]ce[\s-])(?:intro[\s-]+calls?|callbacks?|calls?[\s-]+backs?|(?:(?!(?:bookings?|appointments?|visits?|reservations?|slots?|spots?|viewings?|showings?|tours?|class(?:es)?|lessons?|sessions?|tables?|rooms?|stays?|consultations?|consults?|fittings?|tastings?|treatments?|massages?|haircuts?|trials?|demos?|pickups?|meetings?|serv[il]ce|[il]s|are|was|were|has|have)-)[^\W\d_]+-){0,2}calls?)(?:[\s-]+request|[\s-]+w[il]th[\s-]+(?!(?:(?:bookings?|appointments?|visits?|reservations?|slots?|spots?|viewings?|showings?|tours?|class(?:es)?|lessons?|sessions?|tables?|rooms?|stays?|consultations?|consults?|fittings?|tastings?|treatments?|massages?|haircuts?|trials?|demos?|pickups?|meetings?)|service|and|or|plus|your|the|a|an|is|are|was|were|has|have|once|when|if|after|before|unless)\b)[^\W\d_]+(?:[\s-]+(?!(?:(?:bookings?|appointments?|visits?|reservations?|slots?|spots?|viewings?|showings?|tours?|class(?:es)?|lessons?|sessions?|tables?|rooms?|stays?|consultations?|consults?|fittings?|tastings?|treatments?|massages?|haircuts?|trials?|demos?|pickups?|meetings?)|service|and|or|plus|your|the|a|an|is|are|was|were|has|have|once|when|if|after|before|unless)\b)[^\W\d_]+)?)?(?:[\s-]+|[\s-]*:[\s-]*)(?:(?:all|now|already|just|also|officially|successfully|finally)[\s-]+){0,2}(?:booked|confirmed|scheduled|reserved|set|saved)` },
  { language: 'en', category: 'callback', pattern: String.raw`(?:your|the|this|that|my|our|[^\W\d_]+['’]s)[\s-]+(?:(?:(?<=-)|(?!(?:once|whenever|when|[il]f|after|before|unt[il]l|t[il]ll|unless|as|of|for|with|to|at|on|in|from|about|by|and|or|but)\s))(?!(?:[il]s|are|was|were|has|have)[\s-])[^\W\d_]+(?:-[^\W\d_]+)*\s+){0,3}(?<!serv[il]ce[\s-])(?:intro[\s-]+calls?|callbacks?|calls?[\s-]+backs?|(?:(?!(?:bookings?|appointments?|visits?|reservations?|slots?|spots?|viewings?|showings?|tours?|class(?:es)?|lessons?|sessions?|tables?|rooms?|stays?|consultations?|consults?|fittings?|tastings?|treatments?|massages?|haircuts?|trials?|demos?|pickups?|meetings?|serv[il]ce|[il]s|are|was|were|has|have)-)[^\W\d_]+-){0,2}calls?)(?:[\s-]+request|[\s-]+w[il]th[\s-]+(?!(?:(?:bookings?|appointments?|visits?|reservations?|slots?|spots?|viewings?|showings?|tours?|class(?:es)?|lessons?|sessions?|tables?|rooms?|stays?|consultations?|consults?|fittings?|tastings?|treatments?|massages?|haircuts?|trials?|demos?|pickups?|meetings?)|service|and|or|plus|your|the|a|an|is|are|was|were|has|have|once|when|if|after|before|unless)\b)[^\W\d_]+(?:[\s-]+(?!(?:(?:bookings?|appointments?|visits?|reservations?|slots?|spots?|viewings?|showings?|tours?|class(?:es)?|lessons?|sessions?|tables?|rooms?|stays?|consultations?|consults?|fittings?|tastings?|treatments?|massages?|haircuts?|trials?|demos?|pickups?|meetings?)|service|and|or|plus|your|the|a|an|is|are|was|were|has|have|once|when|if|after|before|unless)\b)[^\W\d_]+)?)?[\s-]*[:-][\s-]*(?:(?:all|now|already|just|also|officially|successfully|finally)[\s-]+){0,2}(?:booked|confirmed|scheduled|reserved|set|saved)` },
  { language: 'en', category: 'booking', pattern: String.raw`your[\s-]+(?=(?:(?!(?:[il]s|are|was|were|has|have|once|when|if|after|before|unless)\b)(?:[^\W\d_]+|&)[\s-]+){0,6}(?:bookings?|appointments?|visits?|reservations?|slots?|spots?|viewings?|showings?|tours?|class(?:es)?|lessons?|sessions?|tables?|rooms?|stays?|consultations?|consults?|fittings?|tastings?|treatments?|massages?|haircuts?|trials?|demos?|pickups?|meetings?)(?!\w))(?=(?:(?!(?:[il]s|are|was|were|has|have|once|when|if|after|before|unless)\b)(?:[^\W\d_]+|&)[\s-]+){0,6}(?:intro[\s-]+calls?|callbacks?|calls?[\s-]+backs?|(?:(?!(?:bookings?|appointments?|visits?|reservations?|slots?|spots?|viewings?|showings?|tours?|class(?:es)?|lessons?|sessions?|tables?|rooms?|stays?|consultations?|consults?|fittings?|tastings?|treatments?|massages?|haircuts?|trials?|demos?|pickups?|meetings?|serv[il]ce|[il]s|are|was|were|has|have)-)[^\W\d_]+-){0,2}calls?)(?:[\s-]+request|[\s-]+w[il]th[\s-]+(?!(?:(?:bookings?|appointments?|visits?|reservations?|slots?|spots?|viewings?|showings?|tours?|class(?:es)?|lessons?|sessions?|tables?|rooms?|stays?|consultations?|consults?|fittings?|tastings?|treatments?|massages?|haircuts?|trials?|demos?|pickups?|meetings?)|service|and|or|plus|your|the|a|an|is|are|was|were|has|have|once|when|if|after|before|unless)\b)[^\W\d_]+(?:[\s-]+(?!(?:(?:bookings?|appointments?|visits?|reservations?|slots?|spots?|viewings?|showings?|tours?|class(?:es)?|lessons?|sessions?|tables?|rooms?|stays?|consultations?|consults?|fittings?|tastings?|treatments?|massages?|haircuts?|trials?|demos?|pickups?|meetings?)|service|and|or|plus|your|the|a|an|is|are|was|were|has|have|once|when|if|after|before|unless)\b)[^\W\d_]+)?)?(?!\w))(?=(?:(?!(?:[il]s|are|was|were|has|have|once|when|if|after|before|unless)\b)(?:[^\W\d_]+|&)[\s-]+){1,5}(?:and|or|plus|&)[\s-]+)(?:(?!(?:[il]s|are|was|were|has|have|once|when|if|after|before|unless)\b)(?:[^\W\d_]+|&)[\s-]+){2,6}(?!(?:[il]s|are|was|were|has|have|once|when|if|after|before|unless)\b)(?:[^\W\d_]+|&)(?:['’]s(?:[\s-]+(?:(?:all|now|already|just|also|officially|successfully|finally)[\s-]+)?been)?|['’]re|[\s-]+(?:is|are|was|were|ha(?:s|ve)[\s-]+(?:(?:all|now|already|just|also|officially|successfully|finally)[\s-]+)?been))[\s-]+(?:(?:all|now|already|just|also|officially|successfully|finally)[\s-]+){0,2}(?:booked|confirmed|scheduled|reserved|set|saved)` },
  { language: 'en', category: 'callback', pattern: String.raw`your[\s-]+(?=(?:(?!(?:[il]s|are|was|were|has|have|once|when|if|after|before|unless)\b)(?:[^\W\d_]+|&)[\s-]+){0,6}(?:bookings?|appointments?|visits?|reservations?|slots?|spots?|viewings?|showings?|tours?|class(?:es)?|lessons?|sessions?|tables?|rooms?|stays?|consultations?|consults?|fittings?|tastings?|treatments?|massages?|haircuts?|trials?|demos?|pickups?|meetings?)(?!\w))(?=(?:(?!(?:[il]s|are|was|were|has|have|once|when|if|after|before|unless)\b)(?:[^\W\d_]+|&)[\s-]+){0,6}(?:intro[\s-]+calls?|callbacks?|calls?[\s-]+backs?|calls?)(?!\w))(?=(?:(?!(?:[il]s|are|was|were|has|have|once|when|if|after|before|unless)\b)(?:[^\W\d_]+|&)[\s-]+){1,5}(?:and|or|plus|&)[\s-]+)(?:(?!(?:[il]s|are|was|were|has|have|once|when|if|after|before|unless)\b)(?:[^\W\d_]+|&)[\s-]+){2,6}(?!(?:[il]s|are|was|were|has|have|once|when|if|after|before|unless)\b)(?:[^\W\d_]+|&)(?:['’]s(?:[\s-]+(?:(?:all|now|already|just|also|officially|successfully|finally)[\s-]+)?been)?|['’]re|[\s-]+(?:is|are|was|were|ha(?:s|ve)[\s-]+(?:(?:all|now|already|just|also|officially|successfully|finally)[\s-]+)?been))[\s-]+(?:(?:all|now|already|just|also|officially|successfully|finally)[\s-]+){0,2}(?:booked|confirmed|scheduled|reserved|set|saved)` },
  { language: 'en', category: 'booking', pattern: String.raw`your(?=(?:[\s-]+(?!(?:[il]s|are|was|were|has|have|once|whenever|when|[il]f|after|before|until|unless|as)\b)[^\W\d_]+){0,6}[\s-]+(?:bookings?|appointments?|visits?|reservations?|slots?|spots?|viewings?|showings?|tours?|class(?:es)?|lessons?|sessions?|tables?|rooms?|stays?|consultations?|consults?|fittings?|tastings?|treatments?|massages?|haircuts?|trials?|demos?|pickups?|meetings?|serv[il]ce[\s-]+calls?)(?!\w))(?:[\s-]+(?!(?:[il]s|are|was|were|has|have|once|whenever|when|[il]f|after|before|until|unless|as)\b)[^\W\d_]+){1,7}(?:['’]s(?:[\s-]+(?:(?:all|now|already|just|also|officially|successfully|finally)[\s-]+)?been)?|['’]re|[\s-]+(?:is|are|was|were|ha(?:s|ve)[\s-]+(?:(?:all|now|already|just|also|officially|successfully|finally)[\s-]+)?been))[\s-]+(?:(?:all|now|already|just|also|officially|successfully|finally)[\s-]+){0,2}(?:booked|confirmed|scheduled|reserved|set|saved)` },
  { language: 'es', category: 'number', pattern: String.raw`dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|doce|trece|catorce|quince` },
  { language: 'es', category: 'number', pattern: String.raw`dieci(?:seis|siete|ocho|nueve)|veinte|veinti[a-z]+` },
  { language: 'es', category: 'number', pattern: String.raw`treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa` },
  { language: 'es', category: 'number', pattern: String.raw`cien|cientos?|(?:dos|tres|cuatro|seis|sete|ocho|nove)cient[oa]s|quinient[oa]s` },
  { language: 'es', category: 'number', pattern: String.raw`mil|miles|millon(?:es)?|docenas?|mitad` },
  { language: 'es', category: 'number', pattern: String.raw`ceros?` },
  { language: 'es', category: 'number', pattern: String.raw`cuart[oa]s?` },
  { language: 'es', category: 'number', pattern: String.raw`tercios?|terceras?[\s-]+partes?` },
  { language: 'es', category: 'number', pattern: String.raw`quint[oa]s?|sext[oa]s?|sep?tim[oa]s?|octav[oa]s?|noven[oa]s?|decim(?:o|a|as)` },
  { language: 'es', category: 'number', pattern: String.raw`(?:uno|una|once|medio)[\s-]+(?:y[\s-]+)?(?:cien|cientos?|mil|miles|millon(?:es)?|docenas?|dolar(?:es)?|pesos?|euros?|centavos?|por[\s-]?ciento)` },
  { language: 'es', category: 'money', pattern: String.raw`dolar(?:es)?|pesos?|euros?|centavos?|usd|mxn` },
  { language: 'es', category: 'percent', pattern: String.raw`por[\s-]?ciento|porcentajes?` },
  { language: 'es', category: 'date', pattern: String.raw`lunes|martes|miercoles|jueves|viernes|sabados?|domingos?` },
  { language: 'es', category: 'date', pattern: String.raw`enero|febrero|marzo|abril|mayo|junio|julio|agosto|sept?iembre|octubre|noviembre|diciembre` },
  { language: 'es', category: 'date', pattern: String.raw`hoy|manana|ayer|anoche|mediodia|medianoche` },
  { language: 'es', category: 'date', pattern: String.raw`fin(?:es)?[\s-]+de[\s-]+semana|(?:la[\s-]+)?(?:proxima|siguiente)[\s-]+semana|semana[\s-]+(?:que[\s-]+viene|proxima|entrante)` },
  { language: 'es', category: 'date', pattern: String.raw`esta[\s-]+(?:noche|tarde|semana)|(?:este|el[\s-]+proximo)[\s-]+mes` },
  { language: 'es', category: 'date', pattern: String.raw`las[\s-]+once|la[\s-]+una` },
  { language: 'es', category: 'date', pattern: String.raw`(?:el[\s-]+)?mismo[\s-]+dia` },
  { language: 'es', category: 'date', pattern: String.raw`(?:el[\s-]+)?mes[\s-]+que[\s-]+viene` },
  { language: 'es', category: 'date', pattern: String.raw`(?:en|dentro[\s-]+de)[\s-]+(?:[^\W\d_]+[\s-]+){0,3}(?:minutos?|mins?|horas?|hrs?)` },
  { language: 'es', category: 'date', pattern: String.raw`(?:a[\s-]+)?primera[\s-]+hora` },
  { language: 'es', category: 'promise', pattern: String.raw`garantias?|garantiz[a-z]*|promet[a-z]*|promesas?` },
  { language: 'es', category: 'promise', pattern: String.raw`gratis|gratuit[oa]s?|descuentos?|descont[a-z]*|reembols[a-z]*` },
  { language: 'es', category: 'promise', pattern: String.raw`sin[\s-]+(?:ningun[\s-]+)?(?:costos?|costes?|cargos?)|de[\s-]+regalo` },
  { language: 'es', category: 'promise', pattern: String.raw`sin[\s-]+recargos?` },
  { language: 'es', category: 'promise', pattern: String.raw`no[\s-]+(?:hay|tienen?|llevan?)[\s-]+(?:[^\W\d_]+[\s-]+){0,2}(?:cargos?|costos?|costes?|recargos?)` },
  { language: 'es', category: 'promise', pattern: String.raw`sin[\s-]+(?:ninguna[\s-]+)?comision(?:es)?` },
  { language: 'es', category: 'promise', pattern: String.raw`por[\s-]+nuestra[\s-]+cuenta|(?:por[\s-]+)?cuenta[\s-]+de[\s-]+la[\s-]+casa` },
  { language: 'es', category: 'promise', pattern: String.raw`entradas?[\s-]+libres?` },
  { language: 'es', category: 'promise', pattern: String.raw`libres?[\s-]+de[\s-]+(?:costos?|costes?|cargos?|pagos?|impuestos?)` },
  { language: 'es', category: 'promise', pattern: String.raw`libres?(?=[\s-]+(?:para|a)[\s-]+(?:tod[oa]s|todo[\s-]+el[\s-]+mundo|cualquiera)\b)` },
  { language: 'es', category: 'promise', pattern: String.raw`libres?(?=[\s-]+(?:(?:para|a)[\s-]+(?:(?:el|la|l[oa]s|nuestr[oa]s?|sus?|tus?)[\s-]+)?|al[\s-]+)(?:soci[oa]s?|miembros?|clientes?|publico|usted(?:es)?|ti|vos(?:otros|otras)?)\b)` },
  { language: 'es', category: 'booking', pattern: String.raw`(?:tus?|sus?|el|la|los|las|una?|mis?|est[ea]s?|es[ea]s?|nuestr[oa]s?)[\s-]+(?:[^\W\d_]+[\s-]+)?(?:citas?|reservas?|visitas?[\s-]+guiadas?|visitas?|turnos?|horas?|plazas?|recorridos?|clases?|leccion(?:es)?|sesion(?:es)?|mesas?|habitacion(?:es)?|estancias?|estadias?|alojamientos?|consultas?|pruebas?|degustacion(?:es)?|tratamientos?|masajes?|cortes?[\s-]+de[\s-]+pelo|demostracion(?:es)?|recogidas?|reunion(?:es)?)[\s-]+(?:ya[\s-]+)?(?:estan?|quedan?|quedo|quedaron|fu(?:e|eron)|ha[ns]?[\s-]+(?:quedado|sido))[\s-]+(?:confirmad|reservad|agendad|apartad|programad|hech|guardad|list)[oa]s?` },
  { language: 'es', category: 'booking', pattern: String.raw`(?:(?<!\by )(?<!\be )(?<!\bo )(?<!\bu )(?:tus?|sus?|el|la|los|las|una?|mis?|est[ea]s?|es[ea]s?|nuestr[oa]s?)[\s-]+(?:(?![yeou]\b)[^\W\d_]+[\s-]+)?(?:devolucion(?:es)?[\s-]+de[\s-]+llamadas?|llamadas?)[\s-]+(?:ya[\s-]+)?(?:estan?|quedan?|quedo|quedaron|fu(?:e|eron)|ha[ns]?[\s-]+(?:quedado|sido))[\s-]+(?:confirmad|reservad|agendad|apartad|programad|hech|guardad|list)[oa]s?|(?:ya[\s-]+)?(?:estas|estan?|quedas|quedan?|quedo|quedaste|quedaron|fu(?:e|iste|eron)|ha[ns]?[\s-]+(?:quedado|sido))[\s-]+(?:confirmad|reservad|agendad|apartad|programad|hech|guardad|list)[oa]s?[\s-]+(?:(?:tus?|sus?|el|la|los|las)[\s-]+)?(?:(?![yeou]\b)[^\W\d_]+[\s-]+)?(?:devolucion(?:es)?[\s-]+de[\s-]+llamadas?|llamadas?)(?![\s-]+[yeou]\b))|(?P<claim>(?:ya[\s-]+)?(?:estas|estan?|quedas|quedan?|quedo|quedaste|quedaron|fu(?:e|iste|eron)|ha[ns]?[\s-]+(?:quedado|sido))[\s-]+(?:(?:confirmad|reservad|agendad|apartad)[oa]s?|hech[oa]s?(?=[\s-]+(?:(?:tus?|sus?|el|la|los|las)[\s-]+)?(?:citas?|reservas?|visitas?[\s-]+guiadas?|visitas?|turnos?|horas?|plazas?|recorridos?|clases?|leccion(?:es)?|sesion(?:es)?|mesas?|habitacion(?:es)?|estancias?|estadias?|alojamientos?|consultas?|pruebas?|degustacion(?:es)?|tratamientos?|masajes?|cortes?[\s-]+de[\s-]+pelo|demostracion(?:es)?|recogidas?|reunion(?:es)?)(?!\w))))` },
  { language: 'es', category: 'booking', pattern: String.raw`(?<![^\W_] )(?:citas?|reservas?|visitas?[\s-]+guiadas?|visitas?|turnos?|horas?|plazas?|recorridos?|clases?|leccion(?:es)?|sesion(?:es)?|mesas?|habitacion(?:es)?|estancias?|estadias?|alojamientos?|consultas?|pruebas?|degustacion(?:es)?|tratamientos?|masajes?|cortes?[\s-]+de[\s-]+pelo|demostracion(?:es)?|recogidas?|reunion(?:es)?)(?:[\s-]+|[\s-]*:[\s-]*)(?:ya[\s-]+)?(?:confirmad|reservad|agendad|apartad|programad|hech|guardad|list)[oa]s?` },
  { language: 'es', category: 'booking', pattern: String.raw`(?<!\bno )(?<!\bnunca )(?<!\bno (?:me|te|le|lo|la|os|se) )(?<!\bno (?:nos|les|los|las) )(?<!\bno (?:me|te|le|lo|la|os|se) (?:me|te|le|lo|la|os|se) )(?<!\bno (?:me|te|le|lo|la|os|se) (?:nos|les|los|las) )(?<!\bno (?:nos|les|los|las) (?:me|te|le|lo|la|os|se) )(?<!\bno (?:nos|les|los|las) (?:nos|les|los|las) )(?<!\bnunca (?:me|te|le|lo|la|os|se) )(?<!\bnunca (?:nos|les|los|las) )(?<!\bnunca (?:me|te|le|lo|la|os|se) (?:me|te|le|lo|la|os|se) )(?<!\bnunca (?:me|te|le|lo|la|os|se) (?:nos|les|los|las) )(?<!\bnunca (?:nos|les|los|las) (?:me|te|le|lo|la|os|se) )(?<!\bnunca (?:nos|les|los|las) (?:nos|les|los|las) )(?:he|hemos)[\s-]+(?:ya[\s-]+)?(?:reservado|agendado|confirmado|programado|apartado)[\s-]+(?:tus?|sus?|el|la|los|las|una?)[\s-]+(?:[^\W\d_]+[\s-]+)?(?:citas?|reservas?|visitas?[\s-]+guiadas?|visitas?|turnos?|horas?|plazas?|recorridos?|clases?|leccion(?:es)?|sesion(?:es)?|mesas?|habitacion(?:es)?|estancias?|estadias?|alojamientos?|consultas?|pruebas?|degustacion(?:es)?|tratamientos?|masajes?|cortes?[\s-]+de[\s-]+pelo|demostracion(?:es)?|recogidas?|reunion(?:es)?)` },
  { language: 'es', category: 'callback', pattern: String.raw`(?:[yeou]|tus?|sus?|el|la|los|las|una?|mis?|est[ea]s?|es[ea]s?|nuestr[oa]s?)[\s-]+(?:[^\W\d_]+[\s-]+)?(?:devolucion(?:es)?[\s-]+de[\s-]+llamadas?|llamadas?)[\s-]+(?:ya[\s-]+)?(?:estan?|quedan?|quedo|quedaron|fu(?:e|eron)|ha[ns]?[\s-]+(?:quedado|sido))[\s-]+(?:confirmad|reservad|agendad|apartad|programad|hech|guardad|list)[oa]s?` },
  { language: 'es', category: 'callback', pattern: String.raw`(?:ya[\s-]+)?(?:estas|estan?|quedas|quedan?|quedo|quedaste|quedaron|fu(?:e|iste|eron)|ha[ns]?[\s-]+(?:quedado|sido))[\s-]+(?:confirmad|reservad|agendad|apartad|programad|hech|guardad|list)[oa]s?[\s-]+(?:(?:tus?|sus?|el|la|los|las)[\s-]+)?(?:[^\W\d_]+[\s-]+)?(?:devolucion(?:es)?[\s-]+de[\s-]+llamadas?|llamadas?)` },
  { language: 'es', category: 'callback', pattern: String.raw`(?<![^\W_] )(?:devolucion(?:es)?[\s-]+de[\s-]+llamadas?|llamadas?)(?:[\s-]+|[\s-]*:[\s-]*)(?:ya[\s-]+)?(?:confirmad|reservad|agendad|apartad|programad|hech|guardad|list)[oa]s?` },
  { language: 'es', category: 'callback', pattern: String.raw`(?<!\bno )(?<!\bnunca )(?<!\bno (?:me|te|le|lo|la|os|se) )(?<!\bno (?:nos|les|los|las) )(?<!\bno (?:me|te|le|lo|la|os|se) (?:me|te|le|lo|la|os|se) )(?<!\bno (?:me|te|le|lo|la|os|se) (?:nos|les|los|las) )(?<!\bno (?:nos|les|los|las) (?:me|te|le|lo|la|os|se) )(?<!\bno (?:nos|les|los|las) (?:nos|les|los|las) )(?<!\bnunca (?:me|te|le|lo|la|os|se) )(?<!\bnunca (?:nos|les|los|las) )(?<!\bnunca (?:me|te|le|lo|la|os|se) (?:me|te|le|lo|la|os|se) )(?<!\bnunca (?:me|te|le|lo|la|os|se) (?:nos|les|los|las) )(?<!\bnunca (?:nos|les|los|las) (?:me|te|le|lo|la|os|se) )(?<!\bnunca (?:nos|les|los|las) (?:nos|les|los|las) )(?:he|hemos)[\s-]+(?:ya[\s-]+)?(?:reservado|agendado|confirmado|programado|apartado)[\s-]+(?:tus?|sus?|el|la|los|las|una?)[\s-]+(?:[^\W\d_]+[\s-]+)?(?:devolucion(?:es)?[\s-]+de[\s-]+llamadas?|llamadas?)` },
];

// ---- Folding, as `_fold` reads prose for the lexicons ------------------------------------------

/** The apostrophes the kernel reads as "’" (`APOSTROPHES`): ‘ ‛ ʼ ʻ ′ ‵ ＇ ` ´. */
const APOSTROPHES = new Set(['‘', '‛', 'ʼ', 'ʻ', '′', '‵', '＇', '`', '´']);
const MINUS_SIGN = '−';
const DASH = /^\p{Pd}$/u;
const MARK = /^[\p{Mn}\p{Me}]$/u;
const SPACE = /^\s$/u;
/** NFKC writes an acute accent (´) as a space and a combining acute (`SPACED_ACUTE`). */
const SPACED_ACUTE = /\s\u0301/u;
const COMBINING_ACUTE = '\u0301';

/** Each letter of the lookalike table read as the ASCII letter it looks like (`LOOKALIKES`). */
const LETTER_LOOKALIKES: ReadonlyMap<string, string> = new Map(
  LOOKALIKES.filter(([, looksLike]) => /^[A-Za-z]$/.test(looksLike)).map(([code, looksLike]) => [String.fromCodePoint(code), looksLike]),
);
/** The table's letters drawn as a bare stroke, l or I (`STROKES`: those it reads as l). */
const STROKES: ReadonlySet<string> = new Set([...LETTER_LOOKALIKES].filter(([, letter]) => letter === 'l').map(([ch]) => ch));
/** The strokes with the ASCII capital I, read as l ("tweIve", `STROKES_AND_I`). */
const STROKES_AND_I: ReadonlySet<string> = new Set([...STROKES, 'I']);

/** A dash or hyphen of any kind and the minus sign as "-", an apostrophe of any kind as "’" (`_plain`). */
function plain(ch: string): string {
  if (DASH.test(ch) || ch === MINUS_SIGN) return '-';
  return APOSTROPHES.has(ch) ? '’' : ch;
}

/**
 * One way of reading text for the lexicons (`_fold`'s arguments): what each of `strokes` is read
 * as, and with `acute`, a spaced acute read as "’".
 */
interface FoldOptions {
  stroke?: string;
  strokes?: ReadonlySet<string>;
  acute?: boolean;
}

/** A reading of text, and for each of its characters, the index in the text it came from. */
interface Reading {
  reading: string;
  origin: number[];
}

/**
 * `text` as the lexicons read it (`_fold`): accents and other combining marks dropped, each letter
 * that looks like an ASCII one read as it ("Tuеsday" with a Cyrillic е is Tuesday), each of
 * `strokes` (by default the bare strokes) read as `stroke`, each dash "-", each apostrophe "’" and
 * each run of whitespace one space, but with `acute`, a whitespace character before a combining
 * acute as "’"; and for each folded character, the index in `text` it came from.
 */
export function fold(text: string, { stroke = 'l', strokes = STROKES, acute = false }: FoldOptions = {}): Reading {
  let reading = '';
  const origin: number[] = [];
  let index = 0;
  for (const ch of text) {
    if (acute && SPACE.test(ch) && text.startsWith(COMBINING_ACUTE, index + ch.length)) {
      reading += '’';
      origin.push(index);
    } else if (SPACE.test(ch)) {
      if (reading === '' || !reading.endsWith(' ')) {
        reading += ' ';
        origin.push(index);
      }
    } else {
      for (const part of plain(ch).normalize('NFKD')) {
        if (MARK.test(part)) continue;
        const shownPart = plain(part);
        const read = strokes.has(shownPart) ? stroke : (LETTER_LOOKALIKES.get(shownPart) ?? shownPart);
        reading += read;
        for (let unit = 0; unit < read.length; unit += 1) origin.push(index);
      }
    }
    index += ch.length;
  }
  return { reading, origin };
}

/**
 * The readings of `text` the lexicons take (`_readings`): a bare stroke as l, as I, and an ASCII
 * capital I as l too ("doIIars"); where NFKC wrote an acute accent as a space and a combining acute,
 * each also with that pair read as "’" ("o´clock") besides the space it is drawn on ("no´charge").
 * Two ways that read the same are one reading, as the kernel keys them by their text.
 */
function readings(text: string): Reading[] {
  const variants: FoldOptions[] = [{}, { stroke: 'i' }, { strokes: STROKES_AND_I }];
  if (SPACED_ACUTE.test(text)) variants.push(...variants.map((variant) => ({ ...variant, acute: true })));
  return [...new Map(variants.map((variant) => {
    const folded = fold(text, variant);
    return [folded.reading, folded] as const;
  })).values()];
}

/** Whether `text` writes a combining mark anywhere (`_marked`): "sí", not "si". */
function marked(text: string): boolean {
  return [...text.normalize('NFKD')].some((part) => MARK.test(part));
}

/**
 * Default-ignorable code points beyond category Cf (`IGNORABLE`): the combining grapheme joiner,
 * Khmer inherent vowels, Mongolian variation selectors, variation selectors and the code points
 * reserved as ignorable.
 */
const IGNORABLE: readonly (readonly [number, number])[] = [
  [0x034f, 0x034f],
  [0x17b4, 0x17b5],
  [0x180b, 0x180f],
  [0x2065, 0x2065],
  [0xfe00, 0xfe0f],
  [0xfff0, 0xfff8],
  [0xe0000, 0xe0fff],
];
/** Default-ignorable, but drawn as a blank (`HANGUL_FILLERS`). */
const HANGUL_FILLERS = new Set(['\u115f', '\u1160', '\u3164', '\uffa0']);
const LINE_CONTROLS = new Set(['\t', '\n', '\r']);
const FORMAT_OR_SURROGATE = /^[\p{Cf}\p{Cs}]$/u;
const CONTROL = /^\p{Cc}$/u;

/**
 * A character no font draws (`_unseen`): a format character, another default-ignorable code point,
 * a control character other than a tab or a line break, or a lone surrogate.
 */
function unseen(ch: string): boolean {
  const code = ch.codePointAt(0) as number;
  return FORMAT_OR_SURROGATE.test(ch) || (CONTROL.test(ch) && !LINE_CONTROLS.has(ch)) || IGNORABLE.some(([low, high]) => low <= code && code <= high);
}

/** `text` without what no font draws, and each Hangul filler as the blank a font draws for it (`_drawn`). */
function drawn(text: string): string {
  let out = '';
  for (const ch of text) if (!unseen(ch)) out += HANGUL_FILLERS.has(ch) ? ' ' : ch;
  return out;
}

/** Text as the scan reads it and a visitor sees it (`shown`): NFKC, drawn before and after. */
function shown(text: string): string {
  return drawn(drawn(text).normalize('NFKC'));
}

// ---- The lexicons' regexes, in JavaScript --------------------------------------------------------

/** Python's Unicode word classes, which JavaScript's `\w` and `\b` (ASCII only) don't match. */
const WORD = String.raw`[\p{L}\p{N}_]`;
const NOT_WORD = String.raw`[^\p{L}\p{N}_]`;
const BOUNDARY = String.raw`(?:(?<=${WORD})(?!${WORD})|(?<!${WORD})(?=${WORD}))`;

/**
 * A kernel regex in JavaScript: folded as the kernel folds it, its letter and word classes and
 * `\b` written for Unicode, and wrapped as a whole word (`(?<!\w)(?:…)(?!\w)`). Python's named groups
 * become JavaScript named groups with span indices. Scoped flags such as `(?-i:May)` stay as they are.
 */
export function toJavaScript(pattern: string): RegExp {
  const classed = fold(pattern)
    .reading.replaceAll(String.raw`[^\W\d_]`, String.raw`\p{L}`)
    .replaceAll(String.raw`[^\W_]`, String.raw`[\p{L}\p{N}]`);
  return new RegExp(`(?<!${WORD})(?:${translateClasses(classed).replaceAll('(?P<', '(?<')})(?!${WORD})`, 'dgiu');
}

/**
 * Python's `\w`, `\W`, `\b` and `\d` in JavaScript, minding character classes: inside `[…]`, `\w`
 * becomes its members (`\p{L}\p{N}_`), not a nested class, which JavaScript rejects. A `\W` inside
 * a class has no JavaScript spelling, so it throws, and the parity test fails until it's handled.
 */
function translateClasses(pattern: string): string {
  let out = '';
  let inClass = false;
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern.charAt(i);
    if (ch === '\\') {
      const next = pattern.charAt(i + 1);
      i += 1;
      if (next === 'w') out += inClass ? String.raw`\p{L}\p{N}_` : WORD;
      else if (next === 'W') {
        if (inClass) throw new Error(`A kernel lexicon class holds \\W, which has no JavaScript spelling: ${pattern}`);
        out += NOT_WORD;
      } else if (next === 'b' && !inClass) out += BOUNDARY;
      else if (next === 'd') out += String.raw`\p{Nd}`;
      else out += `\\${next}`;
      continue;
    }
    if (ch === '[' && !inClass) inClass = true;
    else if (ch === ']' && inClass) inClass = false;
    out += ch;
  }
  return out;
}

const COMPILED = LEXICON.map((entry) => ({ rule: `lex.${entry.language}.${entry.category}`, category: entry.category, regex: toJavaScript(entry.pattern) }));

// ---- The always-on scans -------------------------------------------------------------------------

/** Percent, Arabic percent, per mille and per ten thousand (`PERCENT_SIGNS`). */
const PERCENT_SIGNS = new Set(['%', '٪', '‰', '‱']);
const KEYCAP_TEN = '\u{1f51f}';
const NUMERAL = /^\p{N}$/u;
const CURRENCY = /^\p{Sc}$/u;
/** Inside one number, between two numerals (`NUMBER_SEPARATORS`): "1.234,56", "10:30". */
const NUMBER_SEPARATORS = new Set(['.', ',', ':', "'", '’', ' ']);
/** Each character of the lookalike table drawn as a digit (`DIGIT_LOOKALIKES`): a Cyrillic З for 3. */
const DIGIT_LOOKALIKES: ReadonlySet<string> = new Set(
  LOOKALIKES.filter(([, looksLike]) => /^[0-9]$/.test(looksLike)).map(([code]) => String.fromCodePoint(code)),
);
/**
 * The letters shaped like 0 or 1 (`ZERO_OR_ONE`): O, l and I, and the table's letters it reads as O
 * or l. They are read as digits next to a digit ("ЗОО"), or in a word made only of them that isn't
 * plain ASCII ("ІОО"; "I" and "OK" stay words).
 */
const ZERO_OR_ONE: ReadonlySet<string> = new Set([
  'O',
  'l',
  'I',
  ...[...LETTER_LOOKALIKES].filter(([, letter]) => letter === 'O' || letter === 'l').map(([ch]) => ch),
]);
const LETTER_OR_MARK = /^[\p{L}\p{M}]$/u;
const ASCII = /^[\x00-\x7f]*$/;

/** A Unicode numeral, or a character drawn as a digit (`_numeral`). */
const numeral = (ch: string | undefined) => ch !== undefined && (NUMERAL.test(ch) || DIGIT_LOOKALIKES.has(ch));

/** Whether `chars[start:end]` is a word of its own (`_alone`): no letter or mark right before or after it. */
function alone(chars: readonly string[], start: number, end: number): boolean {
  return [chars[start - 1], chars[end]].every((ch) => ch === undefined || !LETTER_OR_MARK.test(ch));
}

/** Where the number starting at `start` ends (`_number_end`): numerals, and a separator between two of them. */
function numberEnd(chars: readonly string[], start: number): number {
  let end = start;
  while (
    end < chars.length &&
    (numeral(chars[end]) ||
      ZERO_OR_ONE.has(chars[end] as string) ||
      (NUMBER_SEPARATORS.has(chars[end] as string) && end > start && numeral(chars[end - 1]) && numeral(chars[end + 1])))
  ) {
    end += 1;
  }
  return end;
}

// ---- Words mixing scripts ------------------------------------------------------------------------

/** The letters that belong to a script (`SCRIPT_LETTERS`): modifier letters (Lm), such as ʼ, belong to none. */
const SCRIPT_LETTER = /^[\p{Lu}\p{Ll}\p{Lt}\p{Lo}]$/u;
/**
 * A Latin letter. The kernel asks whether its Unicode name starts with "LATIN ", which JavaScript
 * can't read; on text after NFKC, the Latin script property is an acceptable stand-in.
 */
const LATIN = /^\p{Script=Latin}$/u;

/** Each run of letters and combining marks in `chars` (`_words`), and where it starts. */
function words(chars: readonly string[]): { start: number; word: string }[] {
  const found: { start: number; word: string }[] = [];
  let start: number | null = null;
  for (let i = 0; i <= chars.length; i += 1) {
    const ch = chars[i];
    if (ch !== undefined && LETTER_OR_MARK.test(ch)) start ??= i;
    else if (start !== null) {
      found.push({ start, word: chars.slice(start, i).join('') });
      start = null;
    }
  }
  return found;
}

/** Whether `word` has Latin letters and letters of another script (`_mixes_scripts`): "Tuеsday" with a Cyrillic е. */
function mixesScripts(word: string): boolean {
  const latin = [...word].filter((ch) => SCRIPT_LETTER.test(ch)).map((ch) => LATIN.test(ch));
  return latin.some(Boolean) && !latin.every(Boolean);
}

// ---- Booking claims ------------------------------------------------------------------------------

/**
 * A condition straight before a booking claim (`BOOKING_CONDITION`), in either language: "once
 * you're booked", "cuando tu cita está confirmada". "si" counts only where the prose writes no mark
 * on it, since "sí" is yes.
 */
const BOOKING_CONDITION = new RegExp(
  String.raw`(?<!${WORD})(?:once|whenever|when|[il]f|after|before|unt[il]l|t[il]ll|unless|as soon as|cuando|(?<si>s[il])|una vez que|en cuanto|apenas|tan pronto como|despues de que|antes de que|hasta que) (?:(?:ya|me|te|le|lo|la|nos|os|les|los|las|se) ){0,3}$`,
  'dgiu',
);
/** More characters than the longest condition and its space (`CONDITION_REACH`). */
const CONDITION_REACH = 48;

function conditioned(text: string, reading: string, origin: readonly number[], start: number): boolean {
  const condition = new RegExp(BOOKING_CONDITION.source, 'dgiu');
  condition.lastIndex = Math.max(0, start - CONDITION_REACH);
  const found = condition.exec(reading.slice(0, start));
  if (found === null) return false;
  const si = found.indices?.groups?.si;
  if (si === undefined) return true;
  return !marked(text.slice(origin[si[0]], origin[start]));
}

/**
 * The booking and callback claims `_booking_claims` reports, from every reading of `text`: a
 * condition reaches only within its own reading, the claims found are shared across them, and
 * containment applies within each category, so neither category can suppress a claim requiring
 * the other receipt.
 */
function bookingClaims(text: string, read: readonly Reading[]): FactHit[] {
  const found = new Map<string, { start: number; end: number; rule: string; category: LexiconCategory }>();
  for (const { reading, origin } of read) {
    const matches = COMPILED.filter((entry) => entry.category === 'booking' || entry.category === 'callback')
      .flatMap((entry) => [...reading.matchAll(entry.regex)].flatMap((match) => {
        // Context-only alternatives have no claim span. The group, when present, owns the span.
        const span = entry.regex.source.includes('(?<claim>') ? match.indices?.groups?.claim : match.indices?.[0];
        return span === undefined || span[1] <= span[0] ? [] : [{ start: span[0], end: span[1], rule: entry.rule, category: entry.category }];
      }))
      .sort((a, b) => a.start - b.start || a.end - b.end || a.rule.localeCompare(b.rule));
    const reaches = new Map<LexiconCategory, number>();
    for (const match of matches) {
      if (conditioned(text, reading, origin, match.start)) reaches.set(match.category, Math.max(reaches.get(match.category) ?? -1, match.end));
      if ((reaches.get(match.category) ?? -1) < match.end) {
        const claim = { start: origin[match.start] as number, end: (origin[match.end - 1] as number) + 1, rule: match.rule, category: match.category };
        found.set(`${claim.start} ${claim.end} ${claim.rule}`, claim);
      }
    }
  }
  const hits: FactHit[] = [];
  const outer = new Map<LexiconCategory, number>();
  const previous = new Map<LexiconCategory, { start: number; end: number }>();
  for (const claim of [...found.values()].sort((a, b) => a.start - b.start || b.end - a.end || a.rule.localeCompare(b.rule))) {
    const prior = previous.get(claim.category);
    if (prior !== undefined && (prior.start !== claim.start || prior.end !== claim.end)) outer.set(claim.category, Math.max(outer.get(claim.category) ?? -1, prior.end));
    previous.set(claim.category, claim);
    if ((outer.get(claim.category) ?? -1) < claim.end) hits.push({ rule: claim.rule, span: text.slice(claim.start, claim.end) });
  }
  return hits;
}

// ---- The scan ------------------------------------------------------------------------------------

/**
 * Everything in `text` the kernel's prose check would block: numerals, currency and percent signs,
 * words mixing scripts, and each lexicon match in any reading, with claims as `bookingClaims`
 * reports them. `bookingCard` and `callbackCard` exempt only their own category, after containment
 * is resolved.
 */
export function factsInProse(text: string, { bookingCard = false, callbackCard = false }: { bookingCard?: boolean; callbackCard?: boolean } = {}): FactHit[] {
  const seen = shown(text);
  const hits: FactHit[] = [];
  // The always-on scans, one character at a time; a number, separators and all, is one hit.
  const chars = [...seen];
  for (let i = 0; i < chars.length; ) {
    const ch = chars[i] as string;
    if (PERCENT_SIGNS.has(ch)) hits.push({ rule: 'percent_sign', span: ch });
    else if (ch === KEYCAP_TEN) hits.push({ rule: 'digit', span: ch });
    if (numeral(ch) || ZERO_OR_ONE.has(ch)) {
      const end = numberEnd(chars, i);
      const run = chars.slice(i, end).join('');
      // A run with a numeral in it, or a word of its own made of 0/1 letters that isn't plain ASCII.
      if ([...run].some((part) => numeral(part)) || (alone(chars, i, end) && !ASCII.test(run))) hits.push({ rule: 'digit', span: run });
      i = end;
      continue;
    }
    if (CURRENCY.test(ch)) hits.push({ rule: 'currency', span: ch });
    i += 1;
  }
  // A word mixing Latin letters with another script. The boards have no Desk names to exempt.
  hits.push(...words(chars).filter(({ word }) => mixesScripts(word)).map(({ word }) => ({ rule: 'mixed_script', span: word })));
  const read = readings(seen);
  hits.push(...bookingClaims(seen, read).filter((hit) =>
    !(bookingCard && hit.rule.endsWith('.booking') || callbackCard && hit.rule.endsWith('.callback'))));
  // Every reading's matches count; two entries or two readings matching the same words are one hit,
  // as the kernel counts them.
  const counted = new Set<string>();
  for (const entry of COMPILED) {
    if (entry.category === 'booking' || entry.category === 'callback') continue;
    for (const { reading, origin } of read) {
      for (const match of reading.matchAll(entry.regex)) {
        if (match[0] === '') continue;
        const start = origin[match.index] as number;
        const end = (origin[match.index + match[0].length - 1] as number) + 1;
        const key = `${entry.rule} ${start} ${end}`;
        if (counted.has(key)) continue;
        counted.add(key);
        hits.push({ rule: entry.rule, span: seen.slice(start, end) });
      }
    }
  }
  return hits;
}
