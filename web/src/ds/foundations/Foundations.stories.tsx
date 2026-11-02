import type { Meta, StoryObj } from '@storybook/react-vite';
import type { CSSProperties, ReactNode } from 'react';
import { expect, within } from 'storybook/test';

import { expectComputed } from '../test/expectComputed.ts';
import tokens from '../tokens.json' with { type: 'json' };

const STEMS: Record<string, string> = {
  bg: 'Backgrounds',
  text: 'Text',
  line: 'Lines',
  fill: 'Fills',
  button: 'Buttons',
  accent: 'Accent and focus',
  ring: 'Accent and focus',
  status: 'Status',
  mark: 'The mark',
  clay: 'The intro illustration',
  scrim: 'Scrim',
  illustration: 'The intro illustration',
};

const SAMPLES: Record<string, string> = {
  greeting: 'Good morning, Mike',
  'page-title': 'Conversations',
  'intro-title': 'A Claude front desk for your business',
  wordmark: 'Claude Desk',
  summary: 'Dana wants to move her drain cleaning to the weekend.',
  reply: 'I can book that for you. Which of these times works best?',
  'illustration-reply': 'You’re booked, Dana. Mike will text you when he’s on his way.',
  body: 'Claude answers for your business when you can’t.',
  control: 'Allow this time',
  section: 'Needs you',
  message: 'Can someone come look at a leaking pipe?',
  meta: 'Web chat, a few minutes ago',
  caption: 'Reply checked against your rules.',
  pill: 'Plumbing',
  count: '3',
  'badge-caps': 'Preview',
  'brand-name': 'Turner Plumbing',
  amount: '$20.00',
  figure: '$1,860',
  'figure-small': '14',
  'article-title': 'Product proposal',
  'article-body': 'A public, always-on Claude that strangers and their agents can talk to.',
  'article-body-phone': 'A public, always-on Claude that strangers and their agents can talk to.',
  'article-heading': 'Rules decide, models advise',
  'article-heading-phone': 'Rules decide, models advise',
  'article-quote': 'Claude only proposes; code decides what runs.',
  'article-caption': 'Every MCP tool is pinned by the hash of its definition.',
  trace: 'prev_hash 9f2c41d07a',
};

const page: CSSProperties = {
  padding: 'var(--space-40) clamp(var(--space-16), 5vw, var(--space-40))',
  maxWidth: 'var(--size-content)',
  display: 'grid',
  gap: 'var(--space-32)',
};
const header: CSSProperties = { display: 'grid', gap: 'var(--space-4)', margin: 0 };
const list: CSSProperties = { listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 'var(--space-12)' };
// Swatch, name and usage on one line; the usage wraps under them on a phone.
const row: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  columnGap: 'var(--space-16)',
  rowGap: 'var(--space-4)',
};
const secondary: CSSProperties = { color: 'var(--text-secondary)', margin: 0 };

function Sheet({ title, intro, children }: { title: string; intro: string; children: ReactNode }) {
  return (
    <main style={page}>
      <header style={header}>
        <h1 className="cd-type-page-title" style={{ margin: 0 }}>
          {title}
        </h1>
        <p className="cd-type-meta" style={secondary}>
          {intro}
        </p>
      </header>
      {children}
    </main>
  );
}

function Group({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section style={{ display: 'grid', gap: 'var(--space-12)' }}>
      <h2 className="cd-type-section" style={{ margin: 0 }}>
        {title}
      </h2>
      {note ? (
        <p className="cd-type-meta" style={secondary}>
          {note}
        </p>
      ) : null}
      {children}
    </section>
  );
}

function Entry({ visual, name, value, usage }: { visual: ReactNode; name: string; value: string; usage: string }) {
  return (
    <li style={row}>
      <span aria-hidden="true" style={{ flex: '0 0 48px' }}>
        {visual}
      </span>
      <span style={{ display: 'grid', flex: '0 0 200px' }}>
        <span className="cd-type-control">{name}</span>
        <span className="cd-type-caption" style={secondary}>
          {value}
        </span>
      </span>
      <span className="cd-type-meta" style={{ ...secondary, flex: '1 1 280px', minWidth: 0 }}>
        {usage}
      </span>
    </li>
  );
}

/** A color's value in `theme`: its light value in the light theme, or its dark one where it keeps it. */
function themeValue(value: { dark: string; light?: string | undefined }, theme: 'dark' | 'light'): string {
  return theme === 'light' ? (value.light ?? value.dark) : value.dark;
}

function ColorSheet({ theme }: { theme: 'dark' | 'light' }) {
  const groups = new Map<string, typeof tokens.color.tokens>();
  for (const token of tokens.color.tokens) {
    const stem = token.name.split('-')[0] ?? token.name;
    const title = STEMS[stem] ?? stem;
    groups.set(title, [...(groups.get(title) ?? []), token]);
  }
  return (
    <Sheet
      title="Colors"
      intro="Two themes: dark, the base, and light on warm paper. Each value is the theme's that the toolbar draws, and a color with no light value keeps its dark one. Translucent colors are shown over the app background, where they are used."
    >
      {[...groups].map(([title, colors]) => (
        <Group key={title} title={title}>
          <ul style={list}>
            {colors.map((token) => (
              <Entry
                key={token.name}
                name={token.name}
                value={themeValue(token.value, theme)}
                usage={token.usage}
                visual={
                  <span
                    style={{
                      display: 'block',
                      width: 48,
                      height: 32,
                      borderRadius: 'var(--radius-control)',
                      border: '1px solid var(--line-card)',
                      background: `var(--${token.name})`,
                    }}
                  />
                }
              />
            ))}
          </ul>
        </Group>
      ))}
    </Sheet>
  );
}

function TypeSheet() {
  return (
    <Sheet
      title="Type"
      intro="Claude speaks in serif. The interface is sans. The reading pages set their body in serif too. Mono appears only inside a full trace."
    >
      {tokens.type.groups.map((group) => (
        <Group key={group.name} title={group.name} note={tokens.type.families[group.family as keyof typeof tokens.type.families]}>
          <ul style={{ ...list, gap: 'var(--space-20)' }}>
            {group.styles.map((style) => {
              const spec = [
                // A style set in another family than its group's names its own: "Hanken Grotesk".
                'family' in style
                  ? tokens.type.families[style.family as keyof typeof tokens.type.families].split(',')[0]?.replaceAll('"', '')
                  : null,
                `${style.fontSize} on ${style.lineHeight}`,
                `weight ${style.fontWeight}`,
                'fontStyle' in style ? style.fontStyle : null,
                'opticalSize' in style ? `optical size ${style.opticalSize}` : null,
                'letterSpacing' in style ? `tracking ${style.letterSpacing}` : null,
                'textTransform' in style ? 'in capitals' : null,
                'fontVariantNumeric' in style ? 'tabular figures' : null,
              ]
                .filter(Boolean)
                .join(', ');
              return (
                <li key={style.name} style={{ display: 'grid', gap: 'var(--space-4)' }}>
                  {/* The badge's style draws capitals, so its sample is the badge itself, the one all-caps label. */}
                  <span className={`cd-type-${style.name}`} data-ds={style.name === 'badge-caps' ? 'preview-badge' : undefined}>
                    {SAMPLES[style.name] ?? style.name}
                  </span>
                  <span className="cd-type-caption" style={secondary}>
                    {`cd-type-${style.name}, ${spec}. ${style.usage}`}
                  </span>
                </li>
              );
            })}
          </ul>
        </Group>
      ))}
    </Sheet>
  );
}

// The reading page's flow: the title over its summary, then each part of the text a step apart.
const flow: CSSProperties = { display: 'grid', gap: 'var(--space-24)', margin: 0 };
const flush: CSSProperties = { margin: 0 };

/** The About this prototype documents' type, set as a reading page sets it, in its text column. */
function ReadingSheet() {
  return (
    <Sheet
      title="Reading pages"
      intro="The About this prototype documents read in serif, with sans headings and captions, in a column size-article-measure wide."
    >
      <article aria-labelledby="reading-title" style={{ ...flow, maxWidth: 'var(--size-article-measure)' }}>
        <header style={{ display: 'grid', gap: 'var(--space-16)' }}>
          <h2 id="reading-title" className="cd-type-article-title" style={flush}>
            Product proposal
          </h2>
          <p className="cd-type-article-body" style={flush}>
            A public, always-on Claude for a person or small business. Strangers and their agents can talk to it, and it
            answers, books, quotes and takes payments under the owner’s rules.
          </p>
        </header>
        <h3 className="cd-type-article-heading" style={flush}>
          Rules decide, models advise
        </h3>
        <p className="cd-type-article-body" style={flush}>
          Every tool call is checked against the owner’s rules before it runs. The rules compile to Cedar policies, and SymCC
          proves what they allow, so a clever message can’t talk Claude into something the owner never allowed.
        </p>
        <figure style={{ ...flow, gap: 'var(--space-8)' }}>
          <blockquote className="cd-type-article-quote" style={flush}>
            Claude only proposes; code decides what runs and what gets said.
          </blockquote>
          <figcaption className="cd-type-article-caption" style={secondary}>
            From the design: each MCP tool is pinned by the hash of its definition, and the reply check reads every answer.
          </figcaption>
        </figure>
      </article>
      <section aria-labelledby="reading-phone" style={{ ...flow, gap: 'var(--space-12)', maxWidth: 'var(--size-article-measure)' }}>
        <h2 id="reading-phone" className="cd-type-section" style={flush}>
          On a phone
        </h2>
        <p className="cd-type-meta" style={secondary}>
          Below the reading page’s breakpoint, article-heading-phone and article-body-phone take the headings’ and the
          body’s places.
        </p>
        <h3 className="cd-type-article-heading-phone" style={flush}>
          Rules decide, models advise
        </h3>
        <p className="cd-type-article-body-phone" style={flush}>
          Every tool call is checked against the owner’s rules before it runs, and nothing runs that they don’t allow.
        </p>
      </section>
    </Sheet>
  );
}

function SpacingSheet() {
  return (
    <Sheet title="Spacing" intro="Spacing steps, corner radii and fixed sizes, in pixels.">
      <Group title="Spacing">
        <ul style={list}>
          {tokens.spacing.tokens.map((token) => (
            <Entry
              key={token.name}
              name={token.name}
              value={token.value}
              usage={token.usage}
              visual={
                <span
                  style={{
                    display: 'block',
                    width: `var(--${token.name})`,
                    height: 'var(--space-8)',
                    background: 'var(--text-secondary)',
                  }}
                />
              }
            />
          ))}
        </ul>
      </Group>
      <Group title="Radius">
        <ul style={list}>
          {tokens.radius.tokens.map((token) => (
            <Entry
              key={token.name}
              name={token.name}
              value={token.value}
              usage={token.usage}
              visual={
                <span
                  style={{
                    display: 'block',
                    width: 40,
                    height: 32,
                    borderRadius: `var(--${token.name})`,
                    border: '1px solid var(--line-control)',
                    background: 'var(--fill-card)',
                  }}
                />
              }
            />
          ))}
        </ul>
      </Group>
      <Group title="Sizes">
        <ul style={list}>
          {tokens.size.tokens.map((token) => (
            <Entry key={token.name} name={token.name} value={token.value} usage={token.usage} visual={null} />
          ))}
        </ul>
      </Group>
    </Sheet>
  );
}

const meta = {
  title: 'Foundations/Tokens',
  parameters: {
    canvas: 'none',
    canvasNote: 'Design system v2 tokens. No board shows them as a sheet; every N- board is built from them.',
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

/** The value `name`'s entry shows on the color sheet. */
function shownValue(canvasElement: HTMLElement, name: string): string | null | undefined {
  return within(canvasElement).getByText(name, { exact: true }).nextElementSibling?.textContent;
}

/** What the sheet shows for three colors in each theme: one that changes, one fixed, one alias. */
const SHOWN: Record<'dark' | 'light', readonly string[]> = {
  dark: ['#1c1b19', '#141413', '{text-secondary}'],
  light: ['#f6f4ee', '#141413', '{text-secondary}'],
};

export const Colors: Story = {
  render: (_, { globals }) => <ColorSheet theme={globals.theme === 'light' ? 'light' : 'dark'} />,
  play: async ({ canvas, canvasElement, globals }) => {
    // Each color's value in the theme the sheet draws in: dark, as Storybook draws unless asked, or
    // light, where a color keeps its dark value if it has no light one.
    const theme = globals.theme === 'light' ? 'light' : 'dark';
    await expect(canvas.getByText(/^Two themes:/)).toBeVisible();
    await expect([shownValue(canvasElement, 'bg-app'), shownValue(canvasElement, 'mark-ink'), shownValue(canvasElement, 'line-focus')]).toEqual([
      ...SHOWN[theme],
    ]);
  },
};

/** The same sheet in the light theme. */
export const ColorsLight: Story = { ...Colors, globals: { theme: 'light' } };

export const Type: Story = { render: () => <TypeSheet /> };

export const Spacing: Story = { render: () => <SpacingSheet /> };

export const Reading: Story = {
  render: () => <ReadingSheet />,
  parameters: {
    canvasNote:
      'The About this prototype reading pages’ type, in their text column. Their boards (page 9 of the canvas) are not reference boards here; the reading page itself is built with the web app.',
  },
  play: async ({ canvas, canvasElement }) => {
    const serif = /^"Source Serif 4"/;
    const sans = /^"Hanken Grotesk"/;
    const article = canvas.getByRole('article', { name: 'Product proposal' });
    // The text column is the reading measure.
    expectComputed(article, { maxWidth: '648px' });

    // Serif reading text, sans headings and captions, italic only on the quote.
    const title = canvas.getByRole('heading', { level: 2, name: 'Product proposal' });
    expectComputed(title, { fontFamily: serif, fontSize: '72px', lineHeight: '78px', fontWeight: '300', fontStyle: 'normal' });
    for (const paragraph of article.querySelectorAll<HTMLElement>('.cd-type-article-body')) {
      expectComputed(paragraph, { fontFamily: serif, fontSize: '18px', lineHeight: '30px', fontWeight: '380', fontStyle: 'normal' });
    }
    const heading = within(article).getByRole('heading', { level: 3 });
    expectComputed(heading, { fontFamily: sans, fontSize: '30px', lineHeight: '36px', fontWeight: '620' });
    const quote = article.querySelector('blockquote') as HTMLElement;
    expectComputed(quote, { fontFamily: serif, fontSize: '32px', lineHeight: '42px', fontWeight: '300', fontStyle: 'italic' });
    const caption = article.querySelector('figcaption') as HTMLElement;
    expectComputed(caption, { fontFamily: sans, fontSize: '13px', lineHeight: '19px', fontWeight: '380', fontStyle: 'normal' });

    // On a phone the body and headings step down.
    const phone = canvas.getByRole('region', { name: 'On a phone' });
    expectComputed(within(phone).getByRole('heading', { level: 3 }), { fontFamily: sans, fontSize: '25px', lineHeight: '31px', fontWeight: '620' });
    expectComputed(phone.querySelector('.cd-type-article-body-phone') as HTMLElement, {
      fontFamily: serif,
      fontSize: '17px',
      lineHeight: '28px',
      fontWeight: '380',
    });

    // Nothing reaches past the page, at any width the story is checked at.
    await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth);
  },
};
