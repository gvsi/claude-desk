/**
 * TextLink on a touch screen. A link on its own line, such as Today's "Open Safety", takes a tap
 * anywhere in a 44 px tall band centred on its words, through an unseen hit area. Links stacked in a
 * list reach only halfway to each other, and links in a reading page's running text keep no hit
 * area beyond their words, where the lines are a few px apart. Nothing about the text moves or shows.
 */
import { act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';

import { coarsePointer, expectApart, expectHitAreaLands, expectUnseen, hitArea } from '../../test/touch.ts';
import { TextLink } from './TextLink.tsx';

declare global {
  // Tells React this test drives its updates inside act().
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

/** Renders `ui` into a fresh host on the page; the returned function takes it off again. */
function mount(ui: ReactElement): { host: HTMLDivElement; unmount: () => void } {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(ui));
  return {
    host,
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

/** Each link's line boxes, so a test can tell that no text moved. */
function lines(host: HTMLElement): unknown[] {
  return [...host.querySelectorAll('.cd-text-link')].map((link) => [...link.getClientRects()].map((rect) => rect.toJSON()));
}

it('touch_hit_area_reaches_44_px_on_its_own_line', async () => {
  const { host, unmount } = mount(
    <div style={{ padding: 40 }}>
      <p className="cd-type-meta">
        <TextLink href="#safety">Open Safety</TextLink>
      </p>
      <div className="cd-type-meta" style={{ width: 200, marginTop: 40 }}>
        <TextLink href="#vision">Where this is going: channels, a city office and a team Desk</TextLink>
      </div>
    </div>,
  );
  try {
    const [safety, vision] = [...host.querySelectorAll<HTMLElement>('.cd-text-link')] as [HTMLElement, HTMLElement];
    const fine = lines(host);
    expect(getComputedStyle(safety, '::after').content, 'no hit area under a fine pointer').toBe('none');
    expect(vision.getClientRects().length, 'the long link wraps').toBeGreaterThan(1);

    await coarsePointer();
    expect(lines(host), 'the words keep their places').toEqual(fine);
    const own = safety.getBoundingClientRect();
    const area = hitArea(safety);
    expect(area.height, 'Open Safety: 44 px tall').toBe(44);
    expect(own.top - area.top, 'centred').toBe(area.bottom - own.bottom);
    expect(area.width, 'as wide as its words, already over 44 px').toBe(own.width);
    expectHitAreaLands(safety);
    expectUnseen(safety);

    // A link over two lines takes a tap anywhere on its words, on both lines.
    for (const rect of vision.getClientRects()) {
      const x = (rect.left + rect.right) / 2;
      const y = (rect.top + rect.bottom) / 2;
      expect(vision.contains(document.elementFromPoint(x, y)), 'the wrapped link takes a tap on each line').toBe(true);
    }
  } finally {
    unmount();
  }
});

it('touch_hit_areas_of_stacked_links_stay_apart', async () => {
  // As the public page lists its links for agents: one per list item, 6 px apart on 20 px lines.
  const { host, unmount } = mount(
    <ul role="list" className="cd-type-body" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)', margin: 40, padding: 0, listStyle: 'none' }}>
      <li>
        <TextLink href="#agents">What agents can do here</TextLink>
      </li>
      <li>
        <TextLink href="#send">Send an agent</TextLink>
      </li>
    </ul>,
  );
  try {
    const fine = lines(host);
    await coarsePointer();
    expect(lines(host), 'the words keep their places').toEqual(fine);
    const [first, second] = [...host.querySelectorAll<HTMLElement>('.cd-text-link')] as [HTMLElement, HTMLElement];
    expectApart(hitArea(first), hitArea(second), 'stacked links');
    expect(hitArea(first).bottom, 'halfway across the gap to the next link').toBe(first.getBoundingClientRect().bottom + 4);
    expectHitAreaLands(first);
    expectHitAreaLands(second);
  } finally {
    unmount();
  }
});

it('explicit_running_text_outside_article_typography_has_no_touch_hit_area', async () => {
  const { host, unmount } = mount(
    <p className="cd-type-body" style={{ width: 358, padding: 16 }}>
      Check the link, or <TextLink href="/" runningText>start again from the home page</TextLink>.
    </p>,
  );
  try {
    const fine = lines(host);
    const link = host.querySelector<HTMLElement>('.cd-text-link') as HTMLElement;
    expect(link.closest('.cd-type-article-body, .cd-type-article-body-phone')).toBeNull();
    await coarsePointer();
    expect(lines(host), 'the words keep their places').toEqual(fine);
    expect(getComputedStyle(link, '::after').content, 'a sentence link has no enlarged hit area').toBe('none');
    expect(getComputedStyle(link).position, 'a sentence link stays unpositioned').toBe('static');
  } finally {
    unmount();
  }
});

it('links_in_running_text_keep_no_hit_area_beyond_their_words', async () => {
  // A reading page's paragraph, where a link's line sits a few px from the next: a hit area there
  // would reach over the next line's link, so the words alone take the tap, as they always have.
  const { host, unmount } = mount(
    <article className="cd-type-article-body-phone" style={{ width: 358, padding: 16 }}>
      <p>
        Claude Desk follows <TextLink href="#a">the usage policy</TextLink> and{' '}
        <TextLink href="#b">Claude’s constitution</TextLink>, and it can take payments only under{' '}
        <TextLink href="#c">a rule its owner signed</TextLink>.
      </p>
    </article>,
  );
  try {
    const fine = lines(host);
    await coarsePointer();
    expect(lines(host), 'the words keep their places').toEqual(fine);
    const links = [...host.querySelectorAll<HTMLElement>('.cd-text-link')];
    for (const link of links) {
      expect(getComputedStyle(link, '::after').content, `${link.textContent}: no hit area`).toBe('none');
      expect(getComputedStyle(link).position, `${link.textContent}: not positioned`).toBe('static');
    }
  } finally {
    unmount();
  }
});
