/**
 * For stories of the public page: the end of the conversation, kept just above the composer as the
 * public chat page keeps it, with the 24 px of room the page leaves under the conversation
 * (`web/src/public/PublicChat.css`), so its last row ends 24 px above the composer area. On a phone
 * the about column opens the scroll region, so without it the newest messages would be out of view
 * below the charter. Place it after the conversation, inside `PublicShell`'s children.
 */
import { useLayoutEffect, useRef } from 'react';
import { expect } from 'storybook/test';

/** The room the public chat page leaves under the conversation (`web/src/public/PublicChat.css`). */
export const ROOM_UNDER_THE_END_PX = 24;

export function FollowTheChat() {
  const end = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const region = end.current?.closest<HTMLElement>('.cd-public-shell__scroll');
    if (region) region.scrollTop = region.scrollHeight;
  });
  return <div ref={end} style={{ blockSize: 'var(--space-24)' }} />;
}

/** Where the chat scrolls, its last row ends the page's room above the composer area. */
export async function expectRoomUnderTheEnd(root: HTMLElement): Promise<void> {
  const rows = root.querySelectorAll<HTMLElement>('.cd-public-shell__conversation .cd-transcript-row');
  const last = rows[rows.length - 1];
  const area = root.querySelector<HTMLElement>('.cd-public-shell__composer');
  if (!last || !area) throw new Error('no rows in the conversation, or no composer area');
  await expect(Math.round(area.getBoundingClientRect().top - last.getBoundingClientRect().bottom)).toBe(ROOM_UNDER_THE_END_PX);
}
