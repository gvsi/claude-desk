import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { expectComputed } from '../../test/expectComputed.ts';
import { FactCard } from './FactCard.tsx';

const meta = {
  title: 'Vision/FactCard',
  component: FactCard,
  args: {
    label: 'Customer history',
    icon: 'document',
    title: 'Ana Ruiz, customer since 2023',
    lines: ['Water heater replaced, March 2024; under warranty until 2030', 'Kitchen drain cleared, September 12; camera inspection declined'],
  },
  render: (args) => (
    <div style={{ maxWidth: 680 }}>
      <FactCard {...args} />
    </div>
  ),
  parameters: { layout: 'padded', canvas: 'N-R2-Vision-TeamDesk' },
} satisfies Meta<typeof FactCard>;

export default meta;

type Story = StoryObj<typeof meta>;

export const CustomerHistory: Story = {
  play: async ({ canvas, canvasElement }) => {
    // fact_card_shows_its_props_as_given: an article named by its label, then the fact, line by line.
    const card = canvas.getByRole('article', { name: 'Customer history' });
    await expect(card.textContent).toBe(
      'Customer historyAna Ruiz, customer since 2023Water heater replaced, March 2024; under warranty until 2030Kitchen drain cleared, September 12; camera inspection declined',
    );
    // The card's look: the card fill and border at the card radius, padded 12 px 14 px, at most 420 px wide.
    expectComputed(card, {
      backgroundColor: 'rgba(250, 249, 245, 0.03)',
      borderTopWidth: '1px',
      borderTopColor: 'rgba(250, 249, 245, 0.14)',
      borderTopLeftRadius: '12px',
    });
    const body = canvasElement.querySelector<HTMLElement>('.cd-fact-card__body')!;
    expectComputed(body, { paddingTop: '12px', paddingRight: '14px', paddingBottom: '12px', paddingLeft: '14px' });
    await expect(card.getBoundingClientRect().width).toBe(420);

    // The label in a secondary caption beside a 14 px icon, hidden from screen readers.
    const label = canvas.getByText('Customer history');
    expectComputed(label.parentElement!, { fontSize: '13px', lineHeight: '18px', color: 'rgba(250, 249, 245, 0.64)', columnGap: '6px' });
    const icon = card.querySelector('svg')!;
    await expect(icon).toHaveAttribute('aria-hidden', 'true');
    await expect(icon.getBoundingClientRect().width).toBe(14);
    // The fact 6 px under the label, 14 px weight 520 in primary ink; each line 2 px under it in secondary meta.
    const title = canvas.getByText('Ana Ruiz, customer since 2023');
    expectComputed(title, { fontSize: '16px', lineHeight: '22px', fontWeight: '520', color: 'rgba(250, 249, 245, 0.92)', marginTop: '6px' });
    for (const text of ['Water heater replaced, March 2024; under warranty until 2030', 'Kitchen drain cleared, September 12; camera inspection declined']) {
      expectComputed(canvas.getByText(text), { fontSize: '14px', lineHeight: '19px', color: 'rgba(250, 249, 245, 0.64)', marginTop: '2px' });
    }
    // A fact card is read, not used: no link and no button.
    await expect(canvas.queryByRole('link')).toBeNull();
    await expect(canvas.queryByRole('button')).toBeNull();
  },
};

/** A fact with no lines: the label, then the one line of the fact. */
export const TitleOnly: Story = {
  args: { label: 'Document, only for Luis', icon: 'document', title: 'Water heater warranty, Ana Ruiz', lines: undefined },
  parameters: { canvas: 'N-R2-Vision-TeamDesk' },
  play: async ({ canvas }) => {
    const card = canvas.getByRole('article', { name: 'Document, only for Luis' });
    await expect(card.textContent).toBe('Document, only for LuisWater heater warranty, Ana Ruiz');
    await expect(card.querySelectorAll('p')).toHaveLength(2);
  },
};

/** In Spanish: the card says its language, so a screen reader reads it as Spanish. */
export const Spanish: Story = {
  args: {
    label: 'Historial del cliente',
    icon: 'document',
    title: 'Ana Ruiz, clienta desde 2023',
    lines: ['Calentador de agua cambiado en marzo de 2024'],
    language: 'es',
  },
  parameters: {
    canvas: 'none',
    canvasNote: 'The Customer history card of N-R2-Vision-TeamDesk in Spanish: no vision board draws a fact in Spanish yet.',
  },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole('article', { name: 'Historial del cliente' })).toHaveTextContent('Calentador de agua cambiado en marzo de 2024');
    await expect(canvasElement.querySelector('.cd-fact-card')).toHaveAttribute('lang', 'es');
  },
};

/** On a phone's 358 px line the card takes the line's width, and long lines wrap inside it. */
export const PhoneLine: Story = {
  args: { label: 'Job card', icon: 'calendar', title: 'Friday, October 30, 10:30 am', lines: ['Ana Ruiz, Eastshore: water heater check', 'Gate code 2580, at the side gate'] },
  render: (args) => (
    <div style={{ width: 358 }}>
      <FactCard {...args} />
    </div>
  ),
  parameters: {
    canvas: 'none',
    canvasNote: 'The Job card of N-R2-Vision-TeamDesk on a phone’s line; no vision board draws a fact card on a phone, where a booking is the kernel’s booking card.',
  },
  play: async ({ canvas }) => {
    const card = canvas.getByRole('article', { name: 'Job card' });
    await expect(card.getBoundingClientRect().width).toBe(358);
    await expect(card.scrollWidth).toBe(card.clientWidth);
  },
};
