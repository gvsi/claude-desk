import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { rivera } from '../../fixtures/index.ts';
import { expectComputed } from '../../test/expectComputed.ts';
import { PublicBrandHeader } from './PublicBrandHeader.tsx';
import type { PublicBrand } from './PublicShell.tsx';

/** Turner Plumbing's brand, as the screen maps `PublicDesk` to it. */
const BRAND: PublicBrand = {
  name: rivera.publicDesk.en.business_name,
  tagline: rivera.publicDesk.en.desk_name,
  monogram: 'T',
  field: rivera.publicDesk.en.brand.primary ?? '',
  ink: 'var(--text-on-brand)',
  inkSecondary: 'var(--text-on-brand-secondary)',
  accent: rivera.publicDesk.en.brand.accent ?? '',
};

const meta = {
  title: 'Layout/PublicBrandHeader',
  component: PublicBrandHeader,
  args: { brand: BRAND, language: 'en', nameAsHeading: false },
  render: (args) => (
    <>
      <PublicBrandHeader {...args} />
      <main style={{ padding: 'var(--space-24) var(--space-40)' }}>
        <h1 className="cd-type-page-title" style={{ margin: 0 }}>
          Turner Plumbing for AI agents
        </h1>
      </main>
    </>
  ),
  parameters: { layout: 'fullscreen', canvas: 'N-R2-Agents-01-Page' },
} satisfies Meta<typeof PublicBrandHeader>;

export default meta;

type Story = StoryObj<typeof meta>;

export const AgentsPage: Story = {
  parameters: { canvasNote: 'The public page’s brand header on its own, as the agents page draws it over its own title.' },
  play: async ({ canvas, canvasElement }) => {
    // standalone_header_keeps_the_brand: the page's banner in the business's field, 76 px high,
    // with the 2 px accent rule, the monogram and the name, as on the public page.
    const banner = canvas.getByRole('banner');
    expectComputed(banner, {
      backgroundColor: 'rgb(31, 78, 74)',
      minHeight: '76px',
      paddingTop: '12px',
      paddingLeft: '40px',
      borderBottomWidth: '2px',
    });
    await expect(Math.round(banner.getBoundingClientRect().height)).toBe(76);
    await expect(canvasElement.querySelector('.cd-public-shell__monogram')).toHaveAttribute('aria-hidden', 'true');
    // The name isn't the page's heading here: the page's own title is its one h1.
    await expect(canvas.getAllByRole('heading', { level: 1 }).map((heading) => heading.textContent)).toEqual(['Turner Plumbing for AI agents']);
    await expect(canvas.getByText('Turner Plumbing', { selector: 'p' })).toBeVisible();
  },
};

export const Phone: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  parameters: { canvas: 'none', canvasNote: 'N-R2-Agents-06-Phone’s header: the same, with the 16 px gutters the public page takes below 720 px.' },
  play: async ({ canvas }) => {
    expectComputed(canvas.getByRole('banner'), { paddingLeft: '16px', paddingRight: '16px' });
  },
};
