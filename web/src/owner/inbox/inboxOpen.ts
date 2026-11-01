import { createContext, useContext } from 'react';

/**
 * Whether the demo bar's Demo inbox sheet is open, as the owner's frame hears it: Today waits for it
 * to close, and hand focus back, before an address that names a held request lands on its card.
 * False where no frame says otherwise (the still picture behind the intro dialog).
 */
export const InboxOpenContext = createContext(false);

export function useInboxOpen(): boolean {
  return useContext(InboxOpenContext);
}
