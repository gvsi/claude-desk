import type { Meta, StoryObj } from '@storybook/react-vite';
import type { CSSProperties, ReactNode } from 'react';

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
  clay: 'The mark',
  scrim: 'Scrim',
  illustration: 'The intro illustration',
};

const SAMPLES: Record<string, string> = {
  greeting: 'Good morning, Maria',
  'page-title': 'Conversations',
  'intro-title': 'A Claude front desk for your business',
  wordmark: 'Claude Desk',
  summary: 'Dana wants to move her drain cleaning to the weekend.',
  reply: 'I can book that for you. Which of these times works best?',
  'illustration-reply': 'You’re booked, Dana. Maria will text you when she’s on her way.',
  body: 'Claude answers for your business when you can’t.',
  control: 'Allow this time',
  section: 'Needs you',
  message: 'Can someone come look at a leaking pipe?',
  meta: 'Web chat, a few minutes ago',
  caption: 'Reply checked against your rules.',
  pill: 'Plumbing',
  count: '3',
  beta: 'Beta',
  'brand-name': 'Rivera Plumbing',
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

function ColorSheet() {
  const groups = new Map<string, typeof tokens.color.tokens>();
  for (const token of tokens.color.tokens) {
    const stem = token.name.split('-')[0] ?? token.name;
    const title = STEMS[stem] ?? stem;
    groups.set(title, [...(groups.get(title) ?? []), token]);
  }
  return (
    <Sheet title="Colors" intro="One dark theme. Translucent colors are shown over the app background, where they are used.">
      {[...groups].map(([title, colors]) => (
        <Group key={title} title={title}>
          <ul style={list}>
            {colors.map((token) => (
              <Entry
                key={token.name}
                name={token.name}
                value={token.value.dark}
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
      intro="Claude speaks in serif. The interface is sans. Mono appears only inside a full trace."
    >
      {tokens.type.groups.map((group) => (
        <Group key={group.name} title={group.name} note={tokens.type.families[group.family as keyof typeof tokens.type.families]}>
          <ul style={{ ...list, gap: 'var(--space-20)' }}>
            {group.styles.map((style) => {
              const spec = [
                `${style.fontSize} on ${style.lineHeight}`,
                `weight ${style.fontWeight}`,
                'opticalSize' in style ? `optical size ${style.opticalSize}` : null,
                'letterSpacing' in style ? `tracking ${style.letterSpacing}` : null,
              ]
                .filter(Boolean)
                .join(', ');
              return (
                <li key={style.name} style={{ display: 'grid', gap: 'var(--space-4)' }}>
                  <span className={`cd-type-${style.name}`}>{SAMPLES[style.name] ?? style.name}</span>
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

export const Colors: Story = { render: () => <ColorSheet /> };

export const Type: Story = { render: () => <TypeSheet /> };

export const Spacing: Story = { render: () => <SpacingSheet /> };
