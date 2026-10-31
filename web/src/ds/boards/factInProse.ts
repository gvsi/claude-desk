/**
 * What only a card may say on a Desk, so never Claude's words (invariant 2): money (a sign, or a
 * number with a currency), a percentage or a discount, a calendar date (ISO, numeric or an ordinal
 * day), a clock time, a month or a weekday (English and Spanish), a date relative to now ("today",
 * "last week", "next time"), a permit's recorded status, a booking (booked, confirmed, scheduled,
 * reserved, an appointment), or a promise ("will", "she'll", "going to", "guarantee", "promise").
 * The kernel's reply check blocks these in prose; the cards carry them. "May" is left out, as it is
 * more often a verb, and "confirm" alone stays allowed ("I can confirm it's you").
 * `factInProse.test.ts` holds a sample of each kind and every signed vision line.
 */
export const FACT_IN_PROSE = new RegExp(
  [
    // Money and discounts.
    String.raw`[$€£]\s?\d`,
    String.raw`\d\s?[€£]`,
    String.raw`\b\d+(?:[.,]\d+)?\s?(?:dollars?|usd|cents?|euros?|eur)\b`,
    String.raw`\d\s?%`,
    String.raw`\bpercent\b`,
    String.raw`(?<![\p{L}])por ciento(?![\p{L}])`,
    String.raw`\bdiscount(?:s|ed)?\b`,
    String.raw`(?<![\p{L}])descuentos?(?![\p{L}])`,
    // Dates and times.
    String.raw`\b\d{4}-\d{1,2}-\d{1,2}\b`,
    String.raw`\b\d{1,2}/\d{1,2}(?:/\d{2,4})?\b`,
    String.raw`\b\d{1,2}(?:st|nd|rd|th)\b`,
    String.raw`\b\d{1,2}:\d{2}\b`,
    String.raw`\b\d{1,2}\s?(?:am|pm)\b`,
    String.raw`\b\d{1,2}\s?[ap]\.\s?m\.?`,
    String.raw`\b(?:january|february|march|april|june|july|august|september|october|november|december)\b`,
    String.raw`\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b`,
    String.raw`(?<![\p{L}])(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre|lunes|martes|miércoles|jueves|viernes|sábado|domingo)(?![\p{L}])`,
    String.raw`\b(?:today|tonight|tomorrow|yesterday)\b`,
    String.raw`(?<![\p{L}])(?:hoy|mañana|ayer)(?![\p{L}])`,
    String.raw`\b(?:last|next|this) (?:week|weekend|time)\b`,
    // A recorded status.
    String.raw`\b(?:passed|approved|issued|denied)\b`,
    // A booking.
    String.raw`\bbook(?:ed|ing)?\b`,
    String.raw`\b(?:confirmed|scheduled|reserved|appointments?)\b`,
    String.raw`(?<![\p{L}])(?:confirmad[oa]s?|reservad[oa]s?|citas?)(?![\p{L}])`,
    // A promise.
    String.raw`\b(?:will|shall)\b`,
    String.raw`\b\p{L}+[’']ll\b`,
    String.raw`\bgoing to\b`,
    String.raw`\b(?:guarantee|promise)(?:s|d)?\b`,
  ].join('|'),
  'iu',
);
