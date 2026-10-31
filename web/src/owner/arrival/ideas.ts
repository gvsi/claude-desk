/**
 * What the demo suggests trying: the four things the intro dialog lists (and Today's own list
 * titles). "Show me ideas" offers `BREAK_IT_IDEAS` (`web/src/lib/breakItIdeas.ts`), which the public
 * page shares.
 */
import type { IconName } from '../../ds/index.ts';

export interface ThingToTry {
  title: string;
  detail: string;
  icon: IconName;
}

/** In order: the intro dialog's list, and the titles of Today's "Things to try". */
export const THINGS_TO_TRY = [
  { title: 'Chat as a customer', detail: 'Rivera’s public page opens in a new tab.', icon: 'person' },
  { title: 'Try to break it', detail: 'Ask for a discount or someone else’s details.', icon: 'safety' },
  { title: 'Answer a held request', detail: 'One is waiting for you on Today.', icon: 'check' },
  { title: 'Create your own Desk', detail: 'It gets a live link you can share.', icon: 'plus' },
] as const satisfies readonly ThingToTry[];
