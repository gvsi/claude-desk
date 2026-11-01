/**
 * ChatMarkdown in a real browser: each kind of Markdown as its element, the safety settings (no
 * images, no raw HTML, links only for http, https and mailto), unfinished Markdown while the text
 * grows, and the reveal, with motion and under reduced motion, which this project's browser
 * context emulates by default.
 */
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { motion } from '../../test/reducedMotion.ts';
import { ChatMarkdown } from './ChatMarkdown.tsx';

declare global {
  // Tells React this test drives its updates inside act().
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let mounted: { root: Root; host: HTMLDivElement } | null = null;

afterEach(() => {
  if (mounted !== null) {
    const { root, host } = mounted;
    act(() => root.unmount());
    host.remove();
    mounted = null;
  }
  vi.useRealTimers();
});

/** Moves the faked clock, frames included, and lets React draw what they changed. */
async function pass(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Renders `ui` into a fresh host on the page and returns the host. */
function mount(ui: ReactElement): HTMLDivElement {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(ui));
  mounted = { root, host };
  return host;
}

/** Renders `ui` again into the mounted host, as a parent passing new props would. */
function rerender(ui: ReactElement): void {
  if (mounted === null) throw new Error('nothing mounted');
  const { root } = mounted;
  act(() => root.render(ui));
}

/** The header row's cells, as words. */
function head(md: HTMLElement): string[] {
  return [...md.querySelectorAll('thead tr > *')].map((cell) => cell.textContent ?? '');
}

/** The rendered reply: the `.cd-md` root. */
function reply(host: HTMLElement): HTMLElement {
  const root = host.querySelector<HTMLElement>('.cd-md');
  if (root === null) throw new Error('no .cd-md root');
  return root;
}

const EVERY_KIND = [
  '# Big heading',
  '## Second heading',
  '### Repair or replace',
  '#### Small heading',
  '**Repair** usually makes sense when it is *one* worn part, like `the thermostat`.',
  '- the tank isn\'t leaking\n- it\'s one worn part',
  '1. rust in the water\n2. past 12 years',
  '| | Repair | Replace |\n| --- | --- | --- |\n| What changes | One worn part | The whole tank |',
  '> Mike texts before she arrives.',
  '---',
  'The [Energy Saver guide](https://www.energy.gov/energysaver/water-heating) explains the options.',
].join('\n\n');

it('each_markdown_kind_renders_as_its_element', () => {
  const md = reply(mount(<ChatMarkdown links="open" text={EVERY_KIND} />));
  expect(md).toHaveClass('cd-md', 'cd-type-reply');
  expect([...md.children].map((child) => child.tagName.toLowerCase())).toEqual([
    'h1', 'h2', 'h3', 'h4', 'p', 'ul', 'ol', 'div', 'blockquote', 'hr', 'p',
  ]);
  expect(md.querySelector('h3')?.textContent).toBe('Repair or replace');
  expect(md.querySelector('p strong')?.textContent).toBe('Repair');
  expect(md.querySelector('p em')?.textContent).toBe('one');
  expect(md.querySelector('p code')?.textContent).toBe('the thermostat');
  expect([...md.querySelectorAll('ul > li')].map((li) => li.textContent)).toEqual(["the tank isn't leaking", "it's one worn part"]);
  expect([...md.querySelectorAll('ol > li')].map((li) => li.textContent)).toEqual(['rust in the water', 'past 12 years']);
  // A table sits in its hairline card, which scrolls sideways on a phone.
  expect(md.querySelector('.cd-md__table > table')).not.toBeNull();
  expect(head(md)).toEqual(['', 'Repair', 'Replace']);
  // An empty corner cell names no column, so it is a plain cell: screen readers skip it.
  expect([...md.querySelectorAll('thead tr > *')].map((cell) => cell.tagName.toLowerCase())).toEqual(['td', 'th', 'th']);
  expect([...md.querySelectorAll('tbody td')].map((td) => td.textContent)).toEqual(['What changes', 'One worn part', 'The whole tank']);
  expect(md.querySelector('blockquote p')?.textContent).toBe('Mike texts before she arrives.');
  expect(md.querySelector('a')?.textContent).toBe('Energy Saver guide');
});

it('an_image_renders_no_img_only_its_words', () => {
  const md = reply(mount(<ChatMarkdown text={'See the tank: ![rusty tank base](https://example.com/tank.png) and ![](https://example.com/x.png)'} />));
  expect(md.querySelectorAll('img')).toHaveLength(0);
  expect(md.textContent).toBe('See the tank: rusty tank base and ');
});

it('raw_html_renders_as_text_never_as_elements', () => {
  const text = 'Five <b>x</b> and <img src=x onerror="window.hacked=1"> and <script>window.hacked=1</script>';
  const md = reply(mount(<ChatMarkdown text={text} />));
  expect(md.querySelectorAll('b, img, script')).toHaveLength(0);
  expect(md.textContent).toBe(text);
  expect((window as { hacked?: number }).hacked).toBeUndefined();
});

it('an_https_link_shows_its_text_only_and_opens_in_a_new_tab', () => {
  const md = reply(mount(<ChatMarkdown links="open" text={'The [Energy Saver guide](https://www.energy.gov/energysaver/water-heating) explains it. Or [write to Mike](mailto:mike@example.com).'} />));
  const links = [...md.querySelectorAll('a')];
  expect(links.map((link) => [link.textContent, link.getAttribute('href'), link.target, link.rel])).toEqual([
    ['Energy Saver guide', 'https://www.energy.gov/energysaver/water-heating', '_blank', 'noopener noreferrer'],
    ['write to Mike', 'mailto:mike@example.com', '_blank', 'noopener noreferrer'],
  ]);
  expect(md.textContent).toBe('The Energy Saver guide explains it. Or write to Mike.');
});

it('a_link_to_any_other_scheme_or_place_renders_as_its_text', () => {
  const others = ['javascript:alert(1)', 'data:text/html,hi', 'tel:5105550142', 'irc://example.com/x', '/admin', '#top', 'http://'];
  const text = others.map((url, index) => `[link ${index}](${url})`).join(' ');
  const md = reply(mount(<ChatMarkdown links="open" text={text} />));
  expect(md.querySelectorAll('a')).toHaveLength(0);
  expect(md.textContent).toBe(others.map((_, index) => `link ${index}`).join(' '));
});

it('inert_links_show_their_text_then_their_url_and_link_nowhere', () => {
  // A stopped draft may carry the very link it was stopped for, so its URL shows.
  const text = 'Pay at [this page](https://pay.example.net/rivera), see https://example.com/tank or mail me@example.com, not [this](javascript:alert(1)).';
  const md = reply(mount(<ChatMarkdown text={text} links="inert" />));
  expect(md.querySelectorAll('a')).toHaveLength(0);
  // Every target shows as written, one that could never be a link included: it is only text.
  expect(md.textContent).toBe('Pay at this page (https://pay.example.net/rivera), see https://example.com/tank or mail me@example.com, not this (javascript:alert(1)).');
});

it('links_are_inert_unless_a_screen_asks_for_them_open', () => {
  // Safe by default: a screen that forgets the prop shows where a link goes and opens nothing.
  const md = reply(mount(<ChatMarkdown text="See [the guide](https://example.com/guide)." />));
  expect(md.querySelectorAll('a')).toHaveLength(0);
  expect(md.textContent).toBe('See the guide (https://example.com/guide).');
});

it('inert_links_show_their_address_as_written', () => {
  // Not as a URL parser rewrites it: no added slash, no percent-encoding, no xn-- domain, and a
  // target that isn't http, https or mailto shows too.
  const text = '[Pay](https://pay.example.net), [la señal](https://example.com/señal), [el sitio](https://bücher.example/a), [Call Mike](tel:+15550100) and https://example.com.';
  const md = reply(mount(<ChatMarkdown text={text} links="inert" />));
  expect(md.querySelectorAll('a')).toHaveLength(0);
  expect(md.textContent).toBe(
    'Pay (https://pay.example.net), la señal (https://example.com/señal), el sitio (https://bücher.example/a), Call Mike (tel:+15550100) and https://example.com.',
  );
});

it('an_inert_bare_address_shows_once_with_or_without_a_path', () => {
  // Hardening writes https://example.com as https://example.com/, which is the same address.
  const text = 'See https://example.com, www.example.com, http://example.org and www.example.com/hours today.';
  const md = reply(mount(<ChatMarkdown text={text} links="inert" />));
  expect(md.querySelectorAll('a')).toHaveLength(0);
  expect(md.textContent).toBe(text);
});

it('footnote_syntax_stays_as_its_own_words_in_place', () => {
  // Footnotes aren't a chat format: rendered, they would move a note to the end under a label and
  // a back link the reply never had.
  const md = reply(mount(<ChatMarkdown text={'First.[^note]\n\n[^note]: A **checked** note.\n\nLast.'} />));
  expect(md.querySelectorAll('section, sup, a')).toHaveLength(0);
  expect([...md.children].map((block) => [block.tagName.toLowerCase(), block.textContent])).toEqual([
    ['p', 'First.[^note]'],
    ['p', '[^note]: A checked note.'],
    ['p', 'Last.'],
  ]);
  expect(md.querySelector('strong')?.textContent).toBe('checked');
  expect(md.textContent).not.toMatch(/Footnotes|↩/);
});

it('the_rest_of_github_markdown_still_renders', () => {
  const md = reply(mount(<ChatMarkdown links="open" text={'The ~~old~~ new tank, see www.example.com or https://example.com/tank.'} />));
  expect(md.querySelector('del')?.textContent).toBe('old');
  expect([...md.querySelectorAll('a')].map((link) => link.getAttribute('href'))).toEqual(['https://www.example.com', 'https://example.com/tank']);
});

it('a_bare_www_address_opens_as_https', () => {
  // GitHub Markdown links www.example.com to http; the reply check reads a visible www. address
  // as https, so that is where it opens. A link that shows http, or whose text isn't its address,
  // keeps its target.
  const text = 'Visit www.example.com today, or www.example.com/hours?day=sat, [the old page](http://x.example) and http://y.example/a.';
  const md = reply(mount(<ChatMarkdown links="open" text={text} />));
  expect([...md.querySelectorAll('a')].map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
    ['www.example.com', 'https://www.example.com'],
    ['www.example.com/hours?day=sat', 'https://www.example.com/hours?day=sat'],
    ['the old page', 'http://x.example/'],
    ['http://y.example/a', 'http://y.example/a'],
  ]);
  // In a stopped draft, a bare address already shows where it goes, so it shows once.
  rerender(<ChatMarkdown text="Visit www.example.com today." links="inert" />);
  expect(reply(mounted?.host as HTMLElement).textContent).toBe('Visit www.example.com today.');
});

it('a_hard_break_starts_one_new_line', () => {
  // Two trailing spaces or a backslash end a line in Markdown, as Claude's own line break does.
  const md = reply(mount(<ChatMarkdown text={'Line one  \nLine two\n\nLine three\\\nLine four\n\nLine five\nLine six'} />));
  const paragraphs = [...md.querySelectorAll('p')];
  expect(paragraphs.map((paragraph) => paragraph.querySelectorAll('br').length)).toEqual([1, 1, 0]);
  const line = Number.parseFloat(getComputedStyle(md).lineHeight);
  for (const paragraph of paragraphs) expect(paragraph.getBoundingClientRect().height, paragraph.textContent ?? '').toBe(2 * line);
});

it('switching_links_redraws_the_same_reply', () => {
  const text = 'See [the guide](https://example.com/guide).';
  const host = mount(<ChatMarkdown links="open" text={text} />);
  expect(reply(host).querySelectorAll('a')).toHaveLength(1);
  rerender(<ChatMarkdown text={text} links="inert" />);
  expect(reply(host).querySelectorAll('a')).toHaveLength(0);
  expect(reply(host).textContent).toBe('See the guide (https://example.com/guide).');
});

const HEAD = '| | Repair | Replace |\n| --- | --- | --- |';

/** Each body row's cells, as words. */
function rows(md: HTMLElement): string[][] {
  return [...md.querySelectorAll('tbody tr')].map((row) => [...row.children].map((cell) => cell.textContent ?? ''));
}

it('growing_text_that_stops_mid_bold_shows_no_raw_markers', () => {
  const md = reply(mount(<ChatMarkdown links="open" text="Here is **the most impor" streaming />));
  expect(md.querySelector('strong')?.textContent).toBe('the most');
  // The last word may be unfinished, so it waits for the next words.
  expect(md.textContent).toBe('Here is the most');
  rerender(<ChatMarkdown links="open" text="Here is **the most important** part: a [guide](https://www.ener" streaming />);
  expect(md.querySelector('strong')?.textContent).toBe('the most important');
  expect(md.textContent).toBe('Here is the most important part: a');
  rerender(<ChatMarkdown links="open" text="Here is **the most important** part: a [guide](https://www.energy.gov/x) to read." />);
  expect(md.textContent).toBe('Here is the most important part: a guide to read.');
});

it('growing_text_that_stops_mid_table_shows_no_pipes_or_broken_rows', () => {
  const md = reply(mount(<ChatMarkdown text={'Compare:\n\n| | Repair | Rep'} streaming />));
  expect(md.textContent).toBe('Compare:');
  rerender(<ChatMarkdown text={`Compare:\n\n${HEAD}\n| What changes | One wo`} streaming />);
  expect(md.textContent).not.toContain('|');
  expect(head(md)).toEqual(['', 'Repair', 'Replace']);
  expect(rows(md)).toEqual([['What changes', 'One', '']]);
  rerender(<ChatMarkdown text={`Compare:\n\n${HEAD}\n| What changes | One worn part | The whole tank |\n| Best when | No leaks, newer tank |`} streaming />);
  expect(rows(md)).toEqual([
    ['What changes', 'One worn part', 'The whole tank'],
    ['Best when', 'No leaks, newer tank', ''],
  ]);
});

it('a_tables_scroll_area_takes_the_keyboard_named_by_its_header', () => {
  // A wide table scrolls sideways; Safari only scrolls it by keyboard when it can take focus.
  const md = reply(mount(<ChatMarkdown text={`${HEAD}\n| What changes | One worn part | The whole tank |\n\n|  |  |\n| --- | --- |\n| a | b |`} />));
  const [named, unnamed] = [...md.querySelectorAll<HTMLElement>('.cd-md__table')];
  expect([named?.tabIndex, named?.getAttribute('role'), named?.getAttribute('aria-label')]).toEqual([0, 'region', 'Repair, Replace']);
  // A header with no words names nothing, so that area is no region, but it still takes focus.
  expect([unnamed?.tabIndex, unnamed?.getAttribute('role'), unnamed?.getAttribute('aria-label')]).toEqual([0, null, null]);
});

it('the_header_rows_line_and_fill_run_the_cards_full_width', () => {
  // The empty corner cell is a plain cell, but it draws as the header row: its fill and hairline.
  const md = reply(mount(<ChatMarkdown text={`${HEAD}\n| What changes | One worn part | The whole tank |`} />));
  const [corner, repair] = [...md.querySelectorAll<HTMLElement>('thead tr > *')];
  const style = (cell: HTMLElement | undefined) => {
    const computed = getComputedStyle(cell as HTMLElement);
    return [computed.backgroundColor, computed.borderBottomWidth, computed.borderBottomStyle, computed.borderBottomColor];
  };
  expect(corner?.tagName).toBe('TD');
  expect(style(corner)).toEqual(style(repair));
  expect(style(corner)[1]).toBe('1px');
  // The last body row still draws no line against the card's edge.
  expect(getComputedStyle(md.querySelector('tbody tr:last-child td') as Element).borderBottomWidth).toBe('0px');
});

it('a_task_list_shows_its_marks_as_written_and_no_checkboxes', () => {
  const md = reply(mount(<ChatMarkdown text={'- [x] Deposit sorted\n- [ ] Visit booked\n- [X] Photos sent'} />));
  expect(md.querySelectorAll('input')).toHaveLength(0);
  expect([...md.querySelectorAll('li')].map((item) => item.textContent)).toEqual(['[x] Deposit sorted', '[ ] Visit booked', '[X] Photos sent']);
});

it('a_reference_link_keeps_its_address_from_another_paragraph', () => {
  // Streamdown renders each block alone, so a definition in its own paragraph vanished and the
  // link showed as "[Book][1]". The reply renders as one block when it defines a reference.
  const text = 'You can [Book][1] here.\n\nAnything else?\n\n[1]: https://example.com/book';
  const open = reply(mount(<ChatMarkdown links="open" text={text} />));
  expect([...open.querySelectorAll('a')].map((link) => [link.textContent, link.getAttribute('href')])).toEqual([['Book', 'https://example.com/book']]);
  expect([...open.children].map((block) => block.textContent)).toEqual(['You can Book here.', 'Anything else?']);
  rerender(<ChatMarkdown text={text} links="inert" />);
  expect([...reply(mounted?.host as HTMLElement).children].map((block) => block.textContent)).toEqual(['You can Book (https://example.com/book) here.', 'Anything else?']);
});

it('a_reference_defined_inside_a_quote_keeps_its_address', () => {
  const text = 'You can [Book][1] here.\n\nAnything else?\n\n> [1]: https://example.com/book';
  const md = reply(mount(<ChatMarkdown links="open" text={text} />));
  expect([...md.querySelectorAll('a')].map((link) => [link.textContent, link.getAttribute('href')])).toEqual([['Book', 'https://example.com/book']]);
  expect(md.textContent).not.toContain('[Book][1]');
});

it('a_row_wider_than_its_header_keeps_every_word', () => {
  // GitHub Markdown drops cells past the header's; the header gains empty cells instead.
  const md = reply(mount(<ChatMarkdown text={'| Item |\n| --- |\n| Service | Do not book yet |\n| Deposit |'} />));
  expect(head(md)).toEqual(['Item', '']);
  expect([...md.querySelectorAll('thead tr > *')].map((cell) => cell.tagName.toLowerCase())).toEqual(['th', 'td']);
  expect(rows(md)).toEqual([
    ['Service', 'Do not book yet'],
    ['Deposit', ''],
  ]);
});

it('a_whole_reply_renders_as_written_with_nothing_closed', () => {
  // Closing unfinished Markdown is for text that is still arriving: a stray marker in a whole
  // reply is the reply's own.
  const md = reply(mount(<ChatMarkdown text="Use snake_case, and _this or 2 * 3." />));
  expect(md.querySelectorAll('em, strong')).toHaveLength(0);
  expect(md.textContent).toBe('Use snake_case, and _this or 2 * 3.');
});

/** A reply of about 1,500 characters: 7.5 s at 200 a second, so the 3 s ceiling sets its pace. */
const LONG = Array.from({ length: 39 }, (_, index) => `Sentence ${index + 1} is about the water heater.`).join(' ');

it('reveal_grows_by_whole_words_to_the_whole_reply_within_about_3_s_and_says_so_once', async () => {
  await motion();
  vi.useFakeTimers();
  const revealed = vi.fn();
  const md = reply(mount(<ChatMarkdown text={LONG} reveal onRevealed={revealed} />));
  expect(LONG.length).toBeGreaterThan(1400);
  // The first word shows at once, in place of Claude's writing dots.
  const seen = [md.textContent ?? ''];
  expect(seen[0]).toBe('Sentence');
  for (let elapsed = 0; elapsed < 2900; elapsed += 100) {
    await pass(100);
    seen.push(md.textContent ?? '');
  }
  expect(revealed).not.toHaveBeenCalled();
  await pass(200);
  expect(md.textContent).toBe(LONG);
  expect(revealed).toHaveBeenCalledTimes(1);
  // Each moment shows the start of the reply, cut after a whole word, and it only grows.
  for (const [index, shown] of seen.entries()) {
    expect(LONG.startsWith(shown), shown).toBe(true);
    expect([undefined, ' '], shown).toContain(LONG[shown.length]);
    if (index > 0) expect(shown.length).toBeGreaterThanOrEqual(seen[index - 1]?.length ?? 0);
  }
  expect(seen[15]?.length).toBeGreaterThan(LONG.length / 3);
  expect(seen[15]?.length).toBeLessThan((LONG.length * 2) / 3);
  // Each revealed word settles in.
  expect(settling(md).map((word) => word.textContent).join('')).toBe(LONG);
  await pass(5000);
  expect(revealed).toHaveBeenCalledTimes(1);
});

it('reveal_paces_about_200_characters_a_second', async () => {
  await motion();
  vi.useFakeTimers();
  const revealed = vi.fn();
  // 99 characters: about half a second.
  const text = Array.from({ length: 20 }, () => 'tank').join(' ');
  const md = reply(mount(<ChatMarkdown text={text} reveal onRevealed={revealed} />));
  await pass(250);
  expect(md.textContent?.length).toBeGreaterThan(40);
  expect(md.textContent?.length).toBeLessThan(60);
  await pass(200);
  expect(revealed).not.toHaveBeenCalled();
  await pass(150);
  expect(md.textContent).toBe(text);
  expect(revealed).toHaveBeenCalledTimes(1);
});

it('with_reduced_motion_a_reveal_shows_the_whole_reply_and_says_so_at_once', () => {
  // This project's browser context emulates reduced motion.
  expect(window.matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(true);
  const revealed = vi.fn();
  const md = reply(mount(<ChatMarkdown text={LONG} reveal onRevealed={revealed} />));
  expect(md.textContent).toBe(LONG);
  expect(revealed).toHaveBeenCalledTimes(1);
  rerender(<ChatMarkdown text={LONG} reveal onRevealed={revealed} />);
  expect(revealed).toHaveBeenCalledTimes(1);
});

/** The words still settling in, or settled in, through Streamdown's word animation. */
function settling(md: HTMLElement): HTMLElement[] {
  return [...md.querySelectorAll<HTMLElement>('[data-sd-animate]')];
}

it('new_words_settle_in_on_the_settle_token_and_shown_words_stay_put', async () => {
  await motion();
  const md = reply(mount(<ChatMarkdown text={'Got it: leaks '} streaming />));
  const first = settling(md);
  expect(first.map((word) => word.textContent?.trim())).toEqual(['Got', 'it:', 'leaks']);
  const settle = Number.parseFloat(getComputedStyle(md).getPropertyValue('--motion-settle'));
  expect(settle).toBe(150);
  for (const word of first) {
    expect(getComputedStyle(word).animationName).toBe('cd-md-settle');
    expect(Number.parseFloat(getComputedStyle(word).animationDuration) * 1000).toBe(settle);
  }
  rerender(<ChatMarkdown text={'Got it: leaks and blocked drains.\n\n- emergency calls '} streaming />);
  const next = settling(md);
  expect(next.map((word) => word.textContent?.trim())).toEqual(['Got', 'it:', 'leaks', 'and', 'blocked', 'drains.', 'emergency', 'calls']);
  // A word already shown keeps its element, so it never settles in twice.
  for (const [index, word] of first.entries()) expect(next[index]).toBe(word);
  // A list item's marker settles in with its first word.
  expect(getComputedStyle(md.querySelector('li') as Element, '::marker').animationName).toBe('cd-md-settle-marker');
});

it('with_reduced_motion_no_word_settles_in', () => {
  const md = reply(mount(<ChatMarkdown text={'Got it: leaks and blocked drains.\n\n- emergency calls '} streaming />));
  expect(settling(md)).toHaveLength(0);
  expect(md.getAnimations({ subtree: true })).toHaveLength(0);
  expect(md.querySelector('li')?.textContent).toBe('emergency calls');
});

it('without_reveal_the_whole_reply_shows_and_says_so_at_once', async () => {
  await motion();
  const revealed = vi.fn();
  const md = reply(mount(<ChatMarkdown text={LONG} onRevealed={revealed} />));
  expect(md.textContent).toBe(LONG);
  expect(revealed).toHaveBeenCalledTimes(1);
});
