import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';

import type { EvMessage, PublicDesk, SseEvent, StatusEvent } from '../../../api/contracts.ts';
import { contrastRatio } from '../../contrast.ts';
import { rivera } from '../../fixtures/index.ts';
import { expectComputed } from '../../test/expectComputed.ts';
import { ClaudeMessage } from '../ClaudeMessage/ClaudeMessage.tsx';
import { Composer } from '../Composer/Composer.tsx';
import { MarginReceipt } from '../MarginReceipt/MarginReceipt.tsx';
import { receiptFromEvent } from '../MarginReceipt/receiptTone.ts';
import { Transcript } from '../Transcript/Transcript.tsx';
import { TranscriptRow } from '../TranscriptRow/TranscriptRow.tsx';
import { VisitorMessage } from '../VisitorMessage/VisitorMessage.tsx';
import { PublicShell, type PublicBrand } from './PublicShell.tsx';

const ownerName = rivera.business.ownerName;
const desk = rivera.publicDesk;
const ACCENT = 'rgb(184, 115, 51)';
const DISCLOSURE = {
  en: "You're chatting with Claude, an AI answering for Rivera Plumbing. Ask for Maria Rivera anytime.",
  es: 'Estás hablando con Claude, una IA que responde por Rivera Plumbing. Puedes pedir hablar con Maria Rivera cuando quieras.',
};

/** The public page's brand, as the screen maps `PublicDesk` to it: the seed's field and accent, the text tokens as inks. */
function brandOf(publicDesk: PublicDesk): PublicBrand {
  return {
    name: publicDesk.business_name,
    tagline: publicDesk.desk_name,
    monogram: Array.from(publicDesk.business_name)[0] ?? '',
    field: publicDesk.brand.primary ?? '',
    ink: 'var(--text-primary)',
    inkSecondary: 'var(--text-secondary)',
    accent: publicDesk.brand.accent ?? '',
  };
}

/** A fixture part the stories need, or a thrown error naming what the fixture lost. */
function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`the Rivera fixture has no ${what}`);
  return value;
}

/** The visitor's question and Claude's checked quote, with the receipts a visitor reads beside it. */
function Conversation({ language }: { language: 'en' | 'es' }) {
  const turns = language === 'en' ? rivera.conversations.danaLive.turns : rivera.conversations.lucia.turns;
  const question = required(
    turns.flatMap((turn) => (turn.kind === 'visitor' ? [turn.text] : []))[0],
    `${language} question`,
  );
  const events: SseEvent[] = language === 'en' ? rivera.events.quoteTurn : rivera.events.quoteTurnEs;
  const receipt = required(
    events.find((event): event is StatusEvent => event.type === 'receipt'),
    `${language} quote receipt`,
  );
  const reply = required(
    events.find((event): event is EvMessage => event.type === 'message'),
    `${language} quote reply`,
  );
  return (
    <Transcript label={language === 'en' ? 'Conversation with Rivera Plumbing' : 'Conversación con Rivera Plumbing'}>
      <TranscriptRow align="bubble">
        <VisitorMessage text={question} />
      </TranscriptRow>
      <TranscriptRow
        margin={[receiptFromEvent(receipt), receiptFromEvent(reply)].map((view) => (
          <MarginReceipt key={view.ledgerSeq} {...view} />
        ))}
      >
        <ClaudeMessage blocks={reply.blocks} language={reply.language} ownerName={ownerName} />
      </TranscriptRow>
    </Transcript>
  );
}

const composer = {
  en: <Composer variant="visitor" label="Message Rivera Plumbing" placeholder="Message Rivera Plumbing" maxLength={2000} onSend={fn()} />,
  es: (
    <Composer
      variant="visitor"
      label="Escribe a Rivera Plumbing"
      placeholder="Escribe a Rivera Plumbing"
      sendLabel="Enviar"
      maxLength={2000}
      onSend={fn()}
    />
  ),
};

const meta = {
  title: 'Layout/PublicShell',
  component: PublicShell,
  args: {
    brand: brandOf(desk.en),
    ownerName,
    language: 'en',
    onAskForOwner: fn(),
    about: desk.en.charter,
    composer: composer.en,
    children: <Conversation language="en" />,
  },
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-Public-Rivera',
    canvasNote:
      "The board's teal and copper are the seed's field and accent here. The accent is only the rule under the header, not the monogram's ring; the header's phone link and opening hours are the about column's cards; and the about column shows the charter's cards, not the board's free text and quote.",
  },
} satisfies Meta<typeof PublicShell>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The one line (`p`) under `root` that reads `text` in full, names included. */
function lineReading(root: HTMLElement, text: string): HTMLElement {
  const lines = [...root.querySelectorAll<HTMLElement>('p')].filter((line) => line.textContent === text);
  if (lines.length !== 1) throw new Error(`expected one line reading "${text}", found ${lines.length}`);
  return lines[0] as HTMLElement;
}

/** Every element that draws text of its own: a text node with something in it. */
function textElements(root: HTMLElement): HTMLElement[] {
  return [root, ...root.querySelectorAll<HTMLElement>('*')].filter((el) =>
    [...el.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== ''),
  );
}

/** The opaque color under `el`: its own background, or the nearest ancestor's. */
function groundOf(el: HTMLElement): string {
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    const ground = getComputedStyle(node).backgroundColor;
    if (ground !== 'rgba(0, 0, 0, 0)' && ground !== 'transparent') return ground;
  }
  throw new Error('no ground under the element');
}

export const Rivera: Story = {
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    // The brand header in the business's colors: field, inks and the accent's 2 px rule.
    const header = canvas.getByRole('banner');
    expectComputed(header, {
      minHeight: '76px',
      backgroundColor: 'rgb(31, 78, 74)',
      borderBottomWidth: '2px',
      borderBottomColor: ACCENT,
    });
    const name = within(header).getByRole('heading', { level: 1, name: 'Rivera Plumbing' });
    const tagline = within(header).getByText('Main line');
    const monogram = header.querySelector('.cd-public-shell__monogram');
    await expect(monogram).toHaveAttribute('aria-hidden', 'true');
    await expect(monogram).toHaveTextContent('R');

    // brand_text_meets_contrast: both inks keep 4.5:1 over the field (axe checks the same).
    for (const text of [name, tagline]) {
      const ratio = contrastRatio(getComputedStyle(text).color, groundOf(text));
      await expect(ratio).toBeGreaterThanOrEqual(4.5);
    }

    // accent_is_decorative: no element with text has the accent as its color or its ground.
    const accented = textElements(canvasElement).filter((el) => {
      const style = getComputedStyle(el);
      return style.color === ACCENT || style.backgroundColor === ACCENT;
    });
    await expect(accented).toEqual([]);

    // public_shell_always_discloses_ai: under the chat's title, in words.
    const main = canvas.getByRole('main');
    await expect(within(main).getByRole('heading', { level: 2, name: 'Chat with Rivera Plumbing' })).toBeVisible();
    await expect(lineReading(main, DISCLOSURE.en)).toBeVisible();
    await expect(main).toHaveTextContent('an AI answering for Rivera Plumbing');

    // ask_for_owner_calls_back. Its words are one run of text, so the button's gap can't open up
    // between "Ask for" and the name.
    const ask = within(main).getByRole('button', { name: 'Ask for Maria Rivera' });
    await expect([...ask.childNodes].map((node) => node.textContent)).toEqual(['Ask for Maria Rivera']);
    await userEvent.click(ask);
    await expect(args.onAskForOwner).toHaveBeenCalledTimes(1);

    // The conversation, then the composer and the footer under it.
    const log = within(main).getByRole('log', { name: 'Conversation with Rivera Plumbing' });
    const input = within(main).getByRole('textbox', { name: 'Message Rivera Plumbing' });
    await expect(input.getBoundingClientRect().top).toBeGreaterThan(log.getBoundingClientRect().bottom);
    const footer = within(main).getByText('Concept prototype by Giovanni Alcantara, not an Anthropic product');
    await expect(footer.getBoundingClientRect().top).toBeGreaterThan(input.getBoundingClientRect().bottom);
    await expect(within(main).getByText('Claude Desk')).toBeVisible();

    // The about column at the right: the charter's cards, in order, in the page's language.
    const about = canvas.getByRole('complementary', { name: 'About Rivera Plumbing' });
    await expect(within(about).getByRole('heading', { level: 2, name: 'About Rivera Plumbing' })).toBeVisible();
    const cards = [...about.querySelectorAll<HTMLElement>('.cd-reply-card')];
    await expect(cards).toHaveLength(desk.en.charter.length);
    for (const [index, card] of cards.entries()) {
      await expect(card).toHaveAttribute('lang', 'en');
      await expect(card).toHaveTextContent(desk.en.charter[index]?.title ?? '');
    }
    await expect(about.getBoundingClientRect().left).toBeGreaterThanOrEqual(main.getBoundingClientRect().right);
    expectComputed(about, { width: '300px', backgroundColor: 'rgb(34, 34, 32)', borderLeftWidth: '1px' });
    await expect(canvasElement.querySelector('.cd-public-shell')).toHaveAttribute('lang', 'en');
  },
};

export const RiveraEs: Story = {
  args: {
    brand: brandOf(desk.es),
    language: 'es',
    about: desk.es.charter,
    composer: composer.es,
    children: <Conversation language="es" />,
  },
  parameters: {
    canvasNote: 'The board is in English; the same page in Spanish, as a visitor whose browser asks for it reads it.',
  },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    await expect(canvasElement.querySelector('.cd-public-shell')).toHaveAttribute('lang', 'es');
    const main = canvas.getByRole('main');
    // public_shell_always_discloses_ai, in Spanish.
    await expect(within(main).getByRole('heading', { level: 2, name: 'Chatea con Rivera Plumbing' })).toBeVisible();
    await expect(lineReading(main, DISCLOSURE.es)).toBeVisible();
    await expect(main).toHaveTextContent('una IA que responde por Rivera Plumbing');
    await userEvent.click(within(main).getByRole('button', { name: 'Pedir hablar con Maria Rivera' }));
    await expect(args.onAskForOwner).toHaveBeenCalledTimes(1);
    const about = canvas.getByRole('complementary', { name: 'Sobre Rivera Plumbing' });
    for (const card of about.querySelectorAll('.cd-reply-card')) await expect(card).toHaveAttribute('lang', 'es');
    await expect(canvasElement).not.toHaveTextContent('Chat with');
  },
};

/** A phone's width. */
const PHONE = 390;

export const Compact: Story = {
  decorators: [
    (Story) => (
      <div data-testid="phone" style={{ width: PHONE }}>
        <Story />
      </div>
    ),
  ],
  parameters: {
    canvas: 'none',
    canvasNote: 'No board shows the public page on a phone; the about column of N-Public-Rivera moves under the chat, and the gutters are 16 px.',
  },
  play: async ({ canvas, canvasElement }) => {
    const phone = canvas.getByTestId('phone');
    // Nothing reaches past the phone's width.
    await expect(phone.scrollWidth).toBeLessThanOrEqual(PHONE);
    for (const el of canvasElement.querySelectorAll('.cd-public-shell *')) {
      await expect(el.getBoundingClientRect().right).toBeLessThanOrEqual(phone.getBoundingClientRect().right + 0.5);
    }
    // 16 px gutters, the disclosure still under the chat's title.
    expectComputed(canvas.getByRole('banner'), { paddingLeft: '16px', paddingRight: '16px' });
    const main = canvas.getByRole('main');
    expectComputed(main, { paddingLeft: '16px', paddingRight: '16px' });
    await expect(lineReading(main, DISCLOSURE.en)).toBeVisible();
    // The about column comes after the chat, full width.
    const about = canvas.getByRole('complementary', { name: 'About Rivera Plumbing' });
    const footer = within(main).getByText('Concept prototype by Giovanni Alcantara, not an Anthropic product');
    await expect(about.getBoundingClientRect().top).toBeGreaterThanOrEqual(footer.getBoundingClientRect().bottom);
    await expect(about.getBoundingClientRect().width).toBe(PHONE);
  },
};

export const Embedded: Story = {
  args: { footer: false },
  decorators: [
    (Story) => (
      <div data-testid="panel" style={{ width: 420, height: 820, overflowY: 'auto', background: 'var(--bg-app)' }}>
        <Story />
      </div>
    ),
  ],
  parameters: {
    canvas: 'none',
    canvasNote:
      "No board shows the public page inside Today; it is N-Public-Rivera in the owner's 420 px panel, without the footer, which the owner screen has its own of.",
  },
  play: async ({ canvas, canvasElement }) => {
    // No footer of its own, and no page landmarks: the owner screen has its own.
    await expect(canvasElement.querySelector('[data-ds="concept-footer"]')).toBeNull();
    await expect(canvas.queryByRole('main')).toBeNull();
    await expect(canvas.queryByRole('banner')).toBeNull();
    await expect(canvas.queryByRole('complementary')).toBeNull();
    await expect(canvas.queryByRole('heading', { level: 1 })).toBeNull();
    // The disclosure can't be left out.
    await expect(lineReading(canvasElement, DISCLOSURE.en)).toBeVisible();
    await expect(canvas.getByRole('heading', { level: 2, name: 'Chat with Rivera Plumbing' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Ask for Maria Rivera' })).toBeVisible();
    await expect(canvas.getByRole('region', { name: 'About Rivera Plumbing' })).toBeVisible();
    const panel = canvas.getByTestId('panel');
    await expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth);
  },
};

export const WithAgentLinks: Story = {
  args: {
    aboutLinks: [
      { label: 'What agents can do here', href: `/d/${rivera.business.slug}/agents` },
      { label: 'Send an agent', href: `/d/${rivera.business.slug}/agents#send` },
    ],
  },
  parameters: {
    canvasNote: 'The board has no agent links; they sit under the charter cards in the about column, under their own heading.',
  },
  play: async ({ canvas }) => {
    const about = canvas.getByRole('complementary', { name: 'About Rivera Plumbing' });
    const heading = within(about).getByRole('heading', { level: 3, name: 'For AI agents' });
    const links = within(about).getAllByRole('link');
    await expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['What agents can do here', `/d/${rivera.business.slug}/agents`],
      ['Send an agent', `/d/${rivera.business.slug}/agents#send`],
    ]);
    // Under the heading, after the last card.
    const cards = about.querySelectorAll('.cd-reply-card');
    const lastCard = cards[cards.length - 1] as HTMLElement;
    await expect(heading.getBoundingClientRect().top).toBeGreaterThan(lastCard.getBoundingClientRect().bottom);
    await expect(links[0]?.getBoundingClientRect().top).toBeGreaterThan(heading.getBoundingClientRect().bottom);
  },
};
