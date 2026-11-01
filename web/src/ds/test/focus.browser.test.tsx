import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';

import { Button } from '../components/Button/Button.tsx';
import { Chip } from '../components/Chip/Chip.tsx';
import { Composer } from '../components/Composer/Composer.tsx';
import { TextField } from '../components/TextField/TextField.tsx';
import { TextLink } from '../components/TextLink/TextLink.tsx';

/** What a focus style could change: the outline, the border, a shadow ring and the fill. */
const LOOK = [
  'outlineStyle',
  'outlineWidth',
  'outlineColor',
  'outlineOffset',
  'borderTopColor',
  'borderRightColor',
  'borderBottomColor',
  'borderLeftColor',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'boxShadow',
  'backgroundColor',
] as const;

/** How `field` and every element around it, up to `top`, are drawn: a ring on the composer's box shows here too. */
function looks(field: Element, top: Element): Record<string, string>[] {
  const drawn: Record<string, string>[] = [];
  for (let el: Element | null = field; el !== null && el !== top; el = el.parentElement) {
    const style = getComputedStyle(el);
    drawn.push(Object.fromEntries([['element', el.className], ...LOOK.map((name) => [name, style[name]])]));
  }
  return drawn;
}

/** A color token as the browser resolves it on the page. */
function tokenColor(token: string): string {
  const probe = document.createElement('span');
  probe.style.color = `var(${token})`;
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}

/** A button before `children`, so a Tab from it is the next stop's keyboard focus. */
function AfterStart({ children }: { children: ReactNode }) {
  return (
    <div style={{ padding: 'var(--space-16)' }}>
      <button type="button">Start</button>
      {/* A link here goes nowhere when clicked, so the page stays put. */}
      <div data-focus-probe style={{ marginTop: 'var(--space-16)' }} onClick={(event) => event.preventDefault()}>
        {children}
      </div>
    </div>
  );
}

const noop = () => {};

describe('focus', () => {
  const TEXT_ENTRY: [string, ReactNode][] = [
    ['a text field', <TextField label="Business name" value="" onChange={noop} />],
    ['a text area', <TextField label="Your business" multiline value="" onChange={noop} />],
    ['a held text field', <TextField label="Business name" value="Rivera Plumbing" readOnly onChange={noop} />],
    ['the owner composer', <Composer variant="owner" label="Ask Claude" placeholder="Ask Claude" onSend={noop} />],
    ['the public chat composer', <Composer variant="visitor" label="Message" placeholder="Message" onSend={noop} />],
    ['the whisper composer', <Composer variant="whisper" label="Whisper to Claude" placeholder="Whisper to Claude" onSend={noop} />],
  ];

  it.each(TEXT_ENTRY)('text_entry_shows_only_its_caret: %s', async (_, entry) => {
    const screen = await render(<AfterStart>{entry}</AfterStart>);
    const start = screen.getByRole('button', { name: 'Start' }).element() as HTMLButtonElement;
    const field = screen.container.querySelector<HTMLElement>('[data-focus-probe] :is(input, textarea)');
    if (field === null) throw new Error('no text field');

    // At rest, with the pointer over it: hover draws what it draws, focus adds nothing to it.
    await userEvent.hover(field);
    const atRest = looks(field, screen.container);

    // Clicked: focus, and nothing drawn changes on the field or around it.
    await userEvent.click(field);
    expect(document.activeElement).toBe(field);
    expect(looks(field, screen.container)).toEqual(atRest);

    // By keyboard: the same.
    start.focus();
    expect(looks(field, screen.container)).toEqual(atRest);
    await userEvent.tab();
    expect(document.activeElement).toBe(field);
    expect(field.matches(':focus-visible'), 'focus came from the keyboard').toBe(true);
    expect(looks(field, screen.container)).toEqual(atRest);
    await screen.unmount();
  });

  const CONTROLS: [string, ReactNode][] = [
    ['a button', <Button variant="secondary" onClick={noop}>Save</Button>],
    ['a link', <TextLink href="#rules">See rule</TextLink>],
    ['a chip', <Chip onClick={noop}>Book a visit</Chip>],
  ];

  it.each(CONTROLS)('controls_ring_in_ring_focus_on_keyboard_focus_only: %s', async (_, control) => {
    // The ring is its own warm token: the secondary ink, never the link blue.
    const ring = tokenColor('--ring-focus');
    expect(ring).toBe(tokenColor('--text-secondary'));
    expect(ring).not.toBe(tokenColor('--accent-blue'));

    const screen = await render(<AfterStart>{control}</AfterStart>);
    const start = screen.getByRole('button', { name: 'Start' }).element() as HTMLButtonElement;
    const target = screen.container.querySelector<HTMLElement>('[data-focus-probe] :is(a, button)');
    if (target === null) throw new Error('no control');

    // Clicked: focus, and no ring.
    await userEvent.click(target);
    expect(document.activeElement).toBe(target);
    expect(target.matches(':focus-visible'), 'focus came from the pointer').toBe(false);
    expect(getComputedStyle(target).outlineStyle).toBe('none');

    // By keyboard: the 2 px ring at a 2 px offset, in the token's color.
    start.focus();
    await userEvent.tab();
    expect(document.activeElement).toBe(target);
    const style = getComputedStyle(target);
    expect([style.outlineStyle, style.outlineWidth, style.outlineOffset, style.outlineColor]).toEqual(['solid', '2px', '2px', ring]);
    await screen.unmount();
  });
});
