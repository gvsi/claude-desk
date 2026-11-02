import { useEffect, type RefObject } from 'react';

/**
 * Marks a conversation's scroll area with `data-scrolled` while it is scrolled away from its top, so
 * its stylesheet can fade the messages that pass under its top edge. At the top the mark goes, and
 * the first message shows whole. `inside` is the area itself or an element in it, and `area` the
 * area's selector, matched from `inside` up; watched, with a passive listener, while `shown`.
 */
export function useTopFade(inside: RefObject<Element | null>, area: string, shown = true): void {
  useEffect(() => {
    const el = shown ? inside.current?.closest(area) : null;
    if (!el) return undefined;
    const mark = () => el.toggleAttribute('data-scrolled', el.scrollTop > 0);
    mark();
    el.addEventListener('scroll', mark, { passive: true });
    return () => {
      el.removeEventListener('scroll', mark);
      el.removeAttribute('data-scrolled');
    };
  }, [inside, area, shown]);
}
