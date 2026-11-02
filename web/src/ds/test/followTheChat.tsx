/**
 * For stories of the public page: the end of the conversation, kept just above the composer as the
 * public chat page keeps it, with the 24 px of room the page leaves under the conversation
 * (`web/src/public/PublicChat.css`), so its last row ends 24 px above the composer area. On a phone
 * the about column opens the scroll region, so without it the newest messages would be out of view
 * below the charter. Place it after the conversation, inside `PublicShell`'s children.
 */
import { useLayoutEffect, useRef } from 'react';

export function FollowTheChat() {
  const end = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const region = end.current?.closest<HTMLElement>('.cd-public-shell__scroll');
    if (region) region.scrollTop = region.scrollHeight;
  });
  return <div ref={end} style={{ blockSize: 'var(--space-24)' }} />;
}
