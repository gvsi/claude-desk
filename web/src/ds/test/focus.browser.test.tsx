import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';

import { Button } from '../components/Button/Button.tsx';
import { Chip } from '../components/Chip/Chip.tsx';
import { Composer } from '../components/Composer/Composer.tsx';
import { TextField } from '../components/TextField/TextField.tsx';
import { TextLink } from '../components/TextLink/TextLink.tsx';

import '../components/VerifyCodeForm/VerifyCodeForm.css';

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
  // Each text entry with how its edge is drawn: a field's own border, or the composer box's inset edge.
  const TEXT_ENTRY: [string, ReactNode, 'field' | 'composer'][] = [
    ['a text field', <TextField label="Business name" value="" onChange={noop} />, 'field'],
    ['a text area', <TextField label="Your business" multiline value="" onChange={noop} />, 'field'],
    // A field drawn by its own component's stylesheet, as the verify code, the intro's passcode and the checkout's name are.
    ['a verify code field', <input type="text" className="cd-verify-code__field cd-type-body" aria-label="Code" />, 'field'],
    ['the owner composer', <Composer variant="owner" label="Ask Claude" placeholder="Ask Claude" onSend={noop} />, 'composer'],
    ['the public chat composer', <Composer variant="visitor" label="Message" placeholder="Message" onSend={noop} />, 'composer'],
    ['the whisper composer', <Composer variant="whisper" label="Whisper to Claude" placeholder="Whisper to Claude" onSend={noop} />, 'composer'],
  ];

  it.each(TEXT_ENTRY)('text_entry_shows_its_caret_and_a_stronger_edge: %s', async (_, entry, kind) => {
    // No ring on text entry, by pointer or keyboard: its caret, and its own edge one step stronger,
    // so focus shows even while the caret blinks off (owner, 2026-11-01, WCAG 2.4.7). A field's border
    // goes from line-field to line-field-focus; the composer's inset edge from line-hairline to line-field.
    const screen = await render(<AfterStart>{entry}</AfterStart>);
    const start = screen.getByRole('button', { name: 'Start' }).element() as HTMLButtonElement;
    const field = screen.container.querySelector<HTMLElement>('[data-focus-probe] :is(input, textarea)');
    if (field === null) throw new Error('no text field');
    const box = kind === 'composer' ? field.closest<HTMLElement>('.cd-composer__box') : field;
    if (box === null) throw new Error("no composer box");
    const edge = () => (kind === 'field' ? getComputedStyle(box).borderTopColor : getComputedStyle(box).boxShadow);
    const [resting, focused] = kind === 'field'
      ? [tokenColor('--line-field'), tokenColor('--line-field-focus')]
      : [tokenColor('--line-hairline'), tokenColor('--line-field')];
    expect(focused).not.toBe(resting);
    expect(focused).not.toBe(tokenColor('--accent-blue'));
    expect(edge()).toContain(resting);

    // Clicked: focus, no ring, and the stronger edge.
    await userEvent.click(field);
    expect(document.activeElement).toBe(field);
    expect(getComputedStyle(field).outlineStyle).toBe('none');
    expect(edge()).toContain(focused);

    // Away, the resting edge comes back; by keyboard, the same stronger edge and still no ring.
    start.focus();
    expect(edge()).toContain(resting);
    await userEvent.tab();
    expect(document.activeElement).toBe(field);
    expect(field.matches(':focus-visible'), 'focus came from the keyboard').toBe(true);
    expect(getComputedStyle(field).outlineStyle).toBe('none');
    expect(edge()).toContain(focused);
    await screen.unmount();
  });

  const CONTROLS: [string, ReactNode][] = [
    ['a button', <Button variant="secondary" onClick={noop}>Save</Button>],
    ['a link', <TextLink href="#rules">See rule</TextLink>],
    ['a chip', <Chip onClick={noop}>Book a visit</Chip>],
    ['a radio button', <input type="radio" name="probe" aria-label="Sign in with a code" />],
    ['a checkbox', <input type="checkbox" aria-label="Remember this device" />],
  ];

  it.each(CONTROLS)('controls_ring_in_ring_focus_on_keyboard_focus_only: %s', async (_, control) => {
    // The ring is its own warm token: the secondary ink, never the link blue.
    const ring = tokenColor('--ring-focus');
    expect(ring).toBe(tokenColor('--text-secondary'));
    expect(ring).not.toBe(tokenColor('--accent-blue'));

    const screen = await render(<AfterStart>{control}</AfterStart>);
    const start = screen.getByRole('button', { name: 'Start' }).element() as HTMLButtonElement;
    const target = screen.container.querySelector<HTMLElement>('[data-focus-probe] :is(a, button, input)');
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

  it('a_held_text_field_rings_on_keyboard_focus', async () => {
    // A held (read-only) field draws no caret, so caret-only focus would leave it nothing: like any
    // other control, it shows the warm ring when the keyboard reaches it.
    const screen = await render(<AfterStart><TextField label="Business name" value="Rivera Plumbing" readOnly onChange={noop} /></AfterStart>);
    const start = screen.getByRole('button', { name: 'Start' }).element() as HTMLButtonElement;
    const field = screen.container.querySelector<HTMLElement>('[data-focus-probe] input');
    if (field === null) throw new Error('no held field');
    start.focus();
    await userEvent.tab();
    expect(document.activeElement).toBe(field);
    const style = getComputedStyle(field);
    expect([style.outlineStyle, style.outlineWidth, style.outlineOffset, style.outlineColor]).toEqual(['solid', '2px', '2px', tokenColor('--ring-focus')]);
    await screen.unmount();
  });
});
