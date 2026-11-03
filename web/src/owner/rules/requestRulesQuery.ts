/**
 * The Desk's rules, as a screen reads them to name the rule beside a request (`useRequestRules`),
 * under a key of their own beneath Rules' (`['rules', deskId]`): a change to the rules, which reads
 * Rules' key again, reads these with it, while Rules keeps its own first read and its loading page
 * when the owner opens it from a screen that read these. Kept apart from the hook so Today's read
 * ahead can send it without the rest of Rules.
 */
import { queryOptions } from '@tanstack/react-query';

import { request } from '../../api/http.ts';

export const requestRulesQuery = (deskId: string) =>
  queryOptions({ queryKey: ['rules', deskId, 'requests'], queryFn: () => request('rules', { params: { desk_id: deskId } }) });
