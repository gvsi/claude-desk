/** The note at the head of an owner's transcript, beside where the chat came from. */
export const TRANSCRIPT_NOTE = 'Notes from the checks sit under each message. Select one for the full trace.';

/** The head's "Latest" line once a booking ran and its booked card was shown: what got done, not the check. */
export const LATEST_VISIT_BOOKED = 'Visit booked';

/** The head's "Latest" line once a deposit was paid and its charge or payment card was shown. */
export const LATEST_DEPOSIT_PAID = 'Deposit paid';

/** A recorded refusal, using the same words as Today and Safety. */
export const TURNED_DOWN = 'Turned down';

/** Visitor outcomes in the Conversations list. */
export const VISITOR_QUOTED = 'Quoted';
export const VISITOR_LEAD_CAPTURED = 'New lead';
export const VISITOR_OWNER_DECLINED = 'You declined';
export const VISITOR_DOCUMENT_SENT = 'Verified · Invoice sent';
export const VISITOR_VISIT_BOOKED = 'Booked';
/** A visitor row whose visitor hasn't written yet, in the open chat's own words. */
export const VISITOR_NO_MESSAGES = 'No messages yet';
export const visitorCalledBack = (ownerFirstName: string): string => `${ownerFirstName} called back`;
