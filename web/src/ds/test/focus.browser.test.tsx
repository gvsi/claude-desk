import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';

import { Button } from '../components/Button/Button.tsx';
import { Chip } from '../components/Chip/Chip.tsx';
import { Composer } from '../components/Composer/Composer.tsx';
import { ConnectorSignIn } from '../components/ConnectorSignIn/ConnectorSignIn.tsx';
import { IconButton } from '../components/IconButton/IconButton.tsx';
import { Sidebar } from '../components/Sidebar/Sidebar.tsx';
import { TextField } from '../components/TextField/TextField.tsx';
import { TextLink } from '../components/TextLink/TextLink.tsx';
import { chooseTheme } from './theme.ts';
import { rivera } from '../fixtures';

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

/** A 1 px (or `width`) edge just inside the element's own box, as the browser writes the shadow. */
function insetEdge(color: string, width = 1): string {
  return `${color} 0px 0px 0px ${width}px inset`;
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

/** Focus on `target` as the keyboard puts it there: focus let go, a key pressed, then focus moved. */
async function keyboardFocus(target: HTMLElement) {
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  await userEvent.keyboard('{Shift}');
  target.focus();
  expect(document.activeElement).toBe(target);
  expect(target.matches(':focus-visible'), 'focus came from the keyboard').toBe(true);
}

const noop = () => {};

const SIDEBAR_HREFS = {
  today: '#today',
  conversations: '#conversations',
  people: '#customers',
  knowledge: '#knowledge',
  rules: '#rules',
  connectors: '#connectors',
  safety: '#safety',
  profile: '#profile',
  share: '#share',
  settings: '#settings',
};

function OwnerSidebar() {
  return (
    <Sidebar
      business="Turner Plumbing"
      onSwitchBusiness={noop}
      desks={[
        { id: 'main', name: 'Main line' },
        { id: 'emergencies', name: 'Emergencies' },
      ]}
      currentDeskId="main"
      onSwitchDesk={noop}
      current="today"
      hrefs={SIDEBAR_HREFS}
      peopleLabel="Customers"
      answering
      onAnsweringChange={noop}
      owner={{ name: 'Mike Turner', status: 'Available for chats' }}
    />
  );
}

describe('focus', () => {
  // Each text entry with how its edge is drawn: a field's own border, or the composer box's inset edge.
  const TEXT_ENTRY: [string, ReactNode, 'field' | 'composer'][] = [
    ['a text field', <TextField label="Business name" value="" onChange={noop} />, 'field'],
    ['a held field', <TextField label="Business name" value="Turner Plumbing" readOnly onChange={noop} />, 'field'],
    ['a held text area', <TextField label="Your business" value="Turner Plumbing" multiline readOnly onChange={noop} />, 'field'],
    ['a text area', <TextField label="Your business" multiline value="" onChange={noop} />, 'field'],
    // A field drawn by its own component's stylesheet, as the verify code, the intro's passcode and the checkout's name are.
    ['a verify code field', <input type="text" className="cd-verify-code__field cd-type-body" aria-label="Code" />, 'field'],
    ['the owner composer', <Composer variant="owner" label="Ask Claude" placeholder="Ask Claude" onSend={noop} />, 'composer'],
    ['the public chat composer', <Composer variant="visitor" label="Message" placeholder="Message" onSend={noop} />, 'composer'],
    ['the whisper composer', <Composer variant="whisper" label="Whisper to Claude" placeholder="Whisper to Claude" onSend={noop} />, 'composer'],
  ];

  describe.each(['dark', 'light'] as const)('%s text entry', (theme) => {
    it.each(TEXT_ENTRY)('text_entry_shows_a_stronger_edge_without_resizing: %s', async (_, entry, kind) => {
      chooseTheme(theme);
      const screen = await render(<AfterStart>{entry}</AfterStart>);
      try {
        const start = screen.getByRole('button', { name: 'Start' }).element() as HTMLButtonElement;
        const field = screen.container.querySelector<HTMLElement>('[data-focus-probe] :is(input, textarea)')!;
        const box = kind === 'composer' ? field.closest<HTMLElement>('.cd-composer__box')! : field;
        const bounds = box.getBoundingClientRect().toJSON();
        const resting = tokenColor(kind === 'field' ? '--line-field' : '--line-hairline');
        const focused = tokenColor(kind === 'field' ? '--line-focus' : '--line-field');
        const edge = () => kind === 'field' ? getComputedStyle(box).borderTopColor : getComputedStyle(box).boxShadow;
        expect(edge()).toContain(resting);
        const checkFocus = () => {
          const style = getComputedStyle(field);
          expect(style.outlineStyle).toBe('none');
          expect(style.boxShadow).toBe(kind === 'field' ? insetEdge(focused) : 'none');
          expect(edge()).toContain(focused);
          if (kind === 'field') {
            expect([style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth]).toEqual(Array(4).fill('1px'));
            expect([style.borderTopColor, style.borderRightColor, style.borderBottomColor, style.borderLeftColor]).toEqual(Array(4).fill(focused));
          }
          expect(box.getBoundingClientRect().toJSON()).toEqual(bounds);
        };
        await userEvent.click(field);
        expect(document.activeElement).toBe(field);
        checkFocus();
        start.focus();
        expect(edge()).toContain(resting);
        await userEvent.tab();
        expect(document.activeElement).toBe(field);
        expect(field.matches(':focus-visible')).toBe(true);
        checkFocus();
      } finally {
        await screen.unmount();
        chooseTheme('dark');
      }
    });
  });

  it('focus_edge_is_its_own_warm_token', () => {
    // The edge is the secondary ink, never the link blue (owner, 2026-11-01).
    const edge = tokenColor('--line-focus');
    expect(edge).toBe(tokenColor('--text-secondary'));
    expect(edge).not.toBe(tokenColor('--accent-blue'));
  });

  // Controls with no border of their own: fills, ghosts, icon buttons, and inputs that aren't text entry.
  // (The danger fills, named only where refusals are drawn, are checked in Button's own tests.)
  const BORDERLESS: [string, ReactNode][] = [
    ['a ghost button', <Button variant="ghost" onClick={noop}>Dismiss</Button>],
    ['a secondary button', <Button variant="secondary" onClick={noop}>Save</Button>],
    ['an icon button', <IconButton label="Add a photo or file" icon="plus" onClick={noop} />],
    ['a radio button', <input type="radio" name="probe" aria-label="Sign in with a code" />],
    ['a checkbox', <input type="checkbox" aria-label="Remember this device" />],
  ];

  it.each(BORDERLESS)('borderless_controls_show_a_1px_edge_inside_on_keyboard_focus_only: %s', async (_, control) => {
    const screen = await render(<AfterStart>{control}</AfterStart>);
    const start = screen.getByRole('button', { name: 'Start' }).element() as HTMLButtonElement;
    const target = screen.container.querySelector<HTMLElement>('[data-focus-probe] :is(a, button, input)');
    if (target === null) throw new Error('no control');
    const resting = getComputedStyle(target).boxShadow;
    const box = target.getBoundingClientRect().toJSON();

    // Clicked: focus, and nothing drawn.
    await userEvent.click(target);
    expect(document.activeElement).toBe(target);
    expect(target.matches(':focus-visible'), 'focus came from the pointer').toBe(false);
    expect([getComputedStyle(target).outlineStyle, getComputedStyle(target).boxShadow]).toEqual(['none', resting]);

    // By keyboard: a 1 px line-focus edge inside the control's own box, no ring outside it, and
    // nothing moves.
    start.focus();
    await userEvent.tab();
    expect(document.activeElement).toBe(target);
    const style = getComputedStyle(target);
    expect([style.outlineStyle, style.boxShadow]).toEqual(['none', insetEdge(tokenColor('--line-focus'))]);
    expect(target.getBoundingClientRect().toJSON()).toEqual(box);
    await screen.unmount();
  });

  it('a_sidebar_row_shows_the_edge_inside_it', async () => {
    const screen = await render(<OwnerSidebar />);
    const row = screen.getByRole('link', { name: 'Rules' }).element() as HTMLElement;
    await keyboardFocus(row);
    const style = getComputedStyle(row);
    expect([style.outlineStyle, style.boxShadow]).toEqual(['none', insetEdge(tokenColor('--line-focus'))]);
    await screen.unmount();
  });

  it('a_primary_button_shows_a_2px_edge_of_the_page_on_its_fill', async () => {
    // The warm line hardly shows on the cream fill, so the primary's edge is the page's own dark.
    const screen = await render(<AfterStart><Button variant="primary" onClick={noop}>Approve</Button></AfterStart>);
    const button = screen.getByRole('button', { name: 'Approve' }).element() as HTMLElement;
    await userEvent.click(button);
    expect([getComputedStyle(button).outlineStyle, getComputedStyle(button).boxShadow]).toEqual(['none', 'none']);
    await keyboardFocus(button);
    const style = getComputedStyle(button);
    expect([style.outlineStyle, style.boxShadow]).toEqual(['none', insetEdge(tokenColor('--bg-app'), 2)]);
    await screen.unmount();
  });

  // Bordered controls: their own border turns line-focus.
  const BORDERED: [string, () => ReactNode, (container: HTMLElement) => HTMLElement | null, string][] = [
    ['a chip', () => <AfterStart><Chip onClick={noop}>Book a visit</Chip></AfterStart>, (c) => c.querySelector('.cd-chip'), '--line-control'],
    ['the Desk picker in the sidebar', () => <OwnerSidebar />, (c) => c.querySelector('.cd-sidebar__desk-toggle'), '--line-card'],
  ];

  it.each(BORDERED)('bordered_controls_turn_their_own_border_on_keyboard_focus_only: %s', async (_, ui, find, rest) => {
    const screen = await render(ui());
    const target = find(screen.container);
    if (target === null) throw new Error('no control');
    const box = target.getBoundingClientRect().toJSON();
    const border = (el: HTMLElement) => {
      const style = getComputedStyle(el);
      return [style.borderTopColor, style.borderRightColor, style.borderBottomColor, style.borderLeftColor];
    };
    expect(border(target)).toEqual(Array(4).fill(tokenColor(rest)));

    // Clicked: the border at rest, nothing else drawn.
    await userEvent.click(target);
    expect(target.matches(':focus-visible'), 'focus came from the pointer').toBe(false);
    expect(border(target)).toEqual(Array(4).fill(tokenColor(rest)));
    expect([getComputedStyle(target).outlineStyle, getComputedStyle(target).boxShadow]).toEqual(['none', 'none']);
    if (target.getAttribute('aria-expanded') === 'true') await userEvent.click(target);

    // By keyboard: the border turns line-focus; no ring, no shadow, and nothing moves.
    await keyboardFocus(target);
    expect(border(target)).toEqual(Array(4).fill(tokenColor('--line-focus')));
    expect([getComputedStyle(target).outlineStyle, getComputedStyle(target).boxShadow]).toEqual(['none', 'none']);
    expect(target.getBoundingClientRect().toJSON()).toEqual(box);
    await screen.unmount();
  });

  it('a_chip_hovered_fills_and_keeps_its_border', async () => {
    // Hover is the fill alone: the border stays at rest, so only focus changes it.
    const screen = await render(<AfterStart><Chip onClick={noop}>Book a visit</Chip></AfterStart>);
    const chip = screen.container.querySelector<HTMLElement>('.cd-chip');
    if (chip === null) throw new Error('no chip');
    expect(getComputedStyle(chip).backgroundColor).toBe('rgba(0, 0, 0, 0)');
    await userEvent.hover(chip);
    expect(chip.matches(':hover')).toBe(true);
    expect(getComputedStyle(chip).backgroundColor).toBe(tokenColor('--fill-hover'));
    expect(getComputedStyle(chip).borderTopColor).toBe(tokenColor('--line-control'));
    await screen.unmount();
  });

  // Links in running text: a TextLink, and a plain link with no class of its own, as a reply's links are.
  const TEXT_LINKS: [string, ReactNode][] = [
    ['a text link', <TextLink href="#rules">See rule</TextLink>],
    ['a plain link', <a href="#rules">See rule</a>],
  ];

  it.each(TEXT_LINKS)('text_links_turn_primary_with_a_2px_underline_on_keyboard_focus: %s', async (_, link) => {
    const screen = await render(<AfterStart>{link}</AfterStart>);
    const target = screen.getByRole('link', { name: 'See rule' }).element() as HTMLElement;
    const underline = () => {
      const style = getComputedStyle(target);
      return [style.color, style.textDecorationLine, style.textDecorationThickness, style.textDecorationColor];
    };
    const thickness = getComputedStyle(target).textDecorationThickness;
    expect(thickness).not.toBe('2px');
    // Clicked: the underline as it was (a TextLink's firms up under the pointer, as hover does).
    await userEvent.click(target);
    expect([getComputedStyle(target).textDecorationThickness, getComputedStyle(target).boxShadow]).toEqual([thickness, 'none']);
    // By keyboard, the pointer still over it: the words and a 2 px underline in the primary ink (a grey
    // line under a blue link reads like its resting state), and nothing around the words.
    expect(getComputedStyle(target).color).not.toBe(tokenColor('--text-primary'));
    await keyboardFocus(target);
    const primary = tokenColor('--text-primary');
    expect(underline()).toEqual([primary, 'underline', '2px', primary]);
    expect([getComputedStyle(target).outlineStyle, getComputedStyle(target).boxShadow]).toEqual(['none', 'none']);
    await screen.unmount();
  });

  it('a_link_drawn_as_a_button_keeps_the_buttons_edge', async () => {
    // A class of its own takes its kind's focus, not the underline.
    const screen = await render(<AfterStart><Button variant="secondary" href="#rules">See rules</Button></AfterStart>);
    const link = screen.getByRole('link', { name: 'See rules' }).element() as HTMLElement;
    await keyboardFocus(link);
    const style = getComputedStyle(link);
    expect([style.boxShadow, style.textDecorationLine]).toEqual([insetEdge(tokenColor('--line-focus')), 'none']);
    await screen.unmount();
  });

  it('the_send_button_shows_a_2px_edge_of_the_page_on_its_fill', async () => {
    // Send, enabled once there are words, is a round primary on the cream fill: its keyboard edge is 2 px of
    // the page's own dark, as a primary Button's.
    const screen = await render(<AfterStart><Composer variant="owner" label="Ask Claude" placeholder="Ask Claude" onSend={noop} /></AfterStart>);
    const field = screen.container.querySelector<HTMLElement>('[data-focus-probe] textarea');
    if (field === null) throw new Error('no composer');
    await userEvent.click(field);
    await userEvent.keyboard('Raise my cash discount limit');
    const send = screen.getByRole('button', { name: 'Send' }).element() as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    await keyboardFocus(send);
    const style = getComputedStyle(send);
    expect([style.outlineStyle, style.boxShadow]).toEqual(['none', insetEdge(tokenColor('--bg-app'), 2)]);
    await screen.unmount();
  });

  it('a_selected_sign_in_choice_keeps_blue_on_click_and_turns_its_border_on_keyboard_focus', async () => {
    // Storybook's synthetic clicks don't set the browser's focus modality. Use native pointer and
    // keyboard input here to prove that a selected radio's label changes only on keyboard focus.
    const { googleCalendar } = rivera;
    const screen = await render(
      <ConnectorSignIn
        connector={googleCalendar.view}
        promise={{ title: googleCalendar.promise.title }}
        {...googleCalendar.signIn}
        onChange={noop}
        onContinue={noop}
        onCancel={noop}
      />,
    );
    const jobs = screen.getByRole('radio', { name: /^Turner Plumbing jobs/ }).element() as HTMLInputElement;
    const label = jobs.closest('label') as HTMLLabelElement;
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const drawn = (el: HTMLElement) => [getComputedStyle(el).outlineStyle, getComputedStyle(el).boxShadow];

    for (const afterKeyboard of [false, true]) {
      await userEvent.click(cancel);
      await userEvent.click(jobs);
      expect(jobs.checked).toBe(true);
      expect(jobs.matches(':focus-visible'), `clicked after keyboard: ${afterKeyboard}`).toBe(false);
      expect(getComputedStyle(label).borderTopColor).toBe(tokenColor('--accent-blue'));
      expect(drawn(label)).toEqual(['none', 'none']);
      expect(drawn(jobs)).toEqual(['none', 'none']);

      await keyboardFocus(jobs);
      expect(getComputedStyle(label).borderTopColor).toBe(tokenColor('--line-focus'));
      expect(drawn(label)).toEqual(['none', 'none']);
      expect(drawn(jobs)).toEqual(['none', 'none']);
    }
    await screen.unmount();
  });

  it('what_takes_focus_without_being_a_control_draws_nothing', async () => {
    // A heading, a section or a status line that a screen moves focus to (tabIndex -1) isn't a control, so even
    // when the keyboard led there it draws no edge, ring or outline. A control in a roving group, a button with
    // tabIndex -1 until the arrow keys reach it, still shows its edge.
    const screen = await render(
      <AfterStart>
        <h2 tabIndex={-1}>Dana Whitfield</h2>
        <section tabIndex={-1} aria-label="Needs you">
          Held requests
        </section>
        <span role="status" tabIndex={-1}>
          Sending your answer
        </span>
        <button type="button" tabIndex={-1}>
          Ask me first
        </button>
      </AfterStart>,
    );
    const probe = screen.container.querySelector('[data-focus-probe]') as HTMLElement;
    const [heading, section, status, roving] = [...probe.querySelectorAll<HTMLElement>('[tabindex="-1"]')] as [HTMLElement, HTMLElement, HTMLElement, HTMLElement];
    for (const el of [heading, section, status]) {
      await keyboardFocus(el);
      expect([el.localName, getComputedStyle(el).outlineStyle, getComputedStyle(el).boxShadow]).toEqual([el.localName, 'none', 'none']);
    }
    await keyboardFocus(roving);
    expect([getComputedStyle(roving).outlineStyle, getComputedStyle(roving).boxShadow]).toEqual(['none', insetEdge(tokenColor('--line-focus'))]);
    await screen.unmount();
  });

  it('a_button_inside_the_composer_shows_its_edge_and_the_box_goes_back_to_rest', async () => {
    // The box's stronger edge belongs to its text box: when a button inside the composer takes focus,
    // that button shows its own edge and the box's goes back to the hairline.
    const screen = await render(<AfterStart><Composer variant="owner" label="Ask Claude" placeholder="Ask Claude" onSend={noop} onAttach={noop} /></AfterStart>);
    const field = screen.container.querySelector<HTMLElement>('[data-focus-probe] textarea');
    const box = field?.closest<HTMLElement>('.cd-composer__box');
    if (!field || !box) throw new Error('no composer');
    await userEvent.click(field);
    expect(getComputedStyle(box).boxShadow).toContain(tokenColor('--line-field'));
    await userEvent.tab();
    const button = document.activeElement as HTMLElement;
    expect(button.tagName).toBe('BUTTON');
    expect(box.contains(button)).toBe(true);
    expect([getComputedStyle(button).outlineStyle, getComputedStyle(button).boxShadow]).toEqual(['none', insetEdge(tokenColor('--line-focus'))]);
    expect(getComputedStyle(box).boxShadow).toContain(tokenColor('--line-hairline'));
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(field);
    expect(getComputedStyle(box).boxShadow).toContain(tokenColor('--line-field'));
    await screen.unmount();
  });
});
