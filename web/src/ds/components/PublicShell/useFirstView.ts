import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

/** Places the empty invitation, then fades it and glides only the desktop composer on first send. */
export function useFirstView(shellRef: RefObject<HTMLDivElement>, firstView: boolean, aboutBeside: boolean, starterCount: number): boolean {
  // Remember the drawn positions, so the first send animates only a transform between layouts.
  const [invitationShown, setInvitationShown] = useState(firstView);
  const firstPositions = useRef<{ composer: DOMRect; welcome: DOMRect; chips?: DOMRect; docked: boolean } | null>(null);
  const wasFirstView = useRef(firstView);
  useLayoutEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const welcome = shell.querySelector<HTMLElement>('.cd-public-shell__welcome');
    const chips = shell.querySelector<HTMLElement>('.cd-public-shell__starters');
    const group = shell.querySelector<HTMLElement>('.cd-public-shell__composer-group');
    const lift = shell.querySelector<HTMLElement>('.cd-public-shell__composer-lift');
    const region = shell.querySelector<HTMLElement>('.cd-public-shell__scroll');
    if (!group || !lift || !region) return;
    const previous = wasFirstView.current;
    wasFirstView.current = firstView;
    const tokens = getComputedStyle(shell);
    const token = (name: string) => parseFloat(tokens.getPropertyValue(name));
    group.style.transform = '';
    if (!firstView) {
      const old = firstPositions.current;
      firstPositions.current = null;
      if (!previous || !old || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        setInvitationShown(false);
        return;
      }
      // A visual viewport fit translates the shell, making it the fixed elements' containing block,
      // and a short shell scrolls: they then sit against its scrolled content, as absolute ones do.
      const shellBounds = tokens.transform === 'none' ? null : shell.getBoundingClientRect();
      const originTop = shellBounds ? shellBounds.top + shell.clientTop - shell.scrollTop : 0;
      const originLeft = shellBounds ? shellBounds.left + shell.clientLeft - shell.scrollLeft : 0;
      const animations: Animation[] = [];
      for (const [element, rect] of [[welcome, old.welcome], [chips, old.chips]] as const) {
        if (!element || !rect) continue;
        // Keep the invitation where it was, outside the new transcript's layout, as it fades.
        Object.assign(element.style, { position: 'fixed', top: `${rect.top - originTop}px`, left: `${rect.left - originLeft}px`, width: `${rect.width}px`, margin: '0', transform: 'none' });
        animations.push(element.animate([{ opacity: 1 }, { opacity: 0 }], {
          duration: token('--motion-fast'), easing: tokens.getPropertyValue('--motion-ease').trim(), fill: 'forwards',
        }));
      }
      let live = true;
      void Promise.all(animations.map((animation) => animation.finished)).then(() => {
        if (live) setInvitationShown(false);
      }).catch(() => {});
      if (old.docked && aboutBeside && !shell.classList.contains('cd-public-shell--short')) {
        animations.push(lift.animate([
          { transform: `translateY(${old.composer.top - lift.getBoundingClientRect().top}px)` },
          { transform: 'translateY(0)' },
        ], {
          duration: token('--motion-base') + token('--motion-instant'),
          easing: tokens.getPropertyValue('--motion-ease-emphasis').trim(),
        }));
      }
      return () => { live = false; animations.forEach((animation) => animation.cancel()); };
    }
    setInvitationShown(true);
    const place = () => {
      if (!welcome) return;
      group.style.transform = '';
      welcome.removeAttribute('style');
      chips?.removeAttribute('style');
      const docked = aboutBeside && !shell.classList.contains('cd-public-shell--short');
      if (docked) {
        const half = group.offsetHeight / 2 + token('--space-32');
        const roomAbove = welcome.getBoundingClientRect().top - region.getBoundingClientRect().top - token('--space-20');
        welcome.style.transform = `translateY(${-Math.max(0, Math.min(half, roomAbove))}px)`;
        group.style.transform = `translateY(${welcome.getBoundingClientRect().bottom + token('--space-20') - group.getBoundingClientRect().top}px)`;
      }
      firstPositions.current = { composer: lift.getBoundingClientRect(), welcome: welcome.getBoundingClientRect(), chips: chips?.getBoundingClientRect(), docked };
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(region);
    observer.observe(group);
    if (welcome) observer.observe(welcome);
    // A short shell scrolls under the invitation: keep where it shows now, for the fade.
    shell.addEventListener('scroll', place, { passive: true });
    return () => {
      observer.disconnect();
      shell.removeEventListener('scroll', place);
    };
  }, [firstView, aboutBeside, starterCount]);
  return firstView || invitationShown;
}
