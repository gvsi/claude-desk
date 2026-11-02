import { expect, it } from 'vitest';

import { contrastRatio } from '../ds/contrast.ts';
import { rivera } from '../ds/fixtures/index.ts';
import { chooseTheme } from '../ds/test/theme.ts';
import { RIVERA } from '../mocks/seed.ts';
import { mockStore } from '../mocks/store.ts';
import { renderRoute } from '../test/renderRoute.tsx';
import { tokenColor } from '../test/screen.ts';

it('public_about_column_grows_on_the_left_with_status_under_its_title', async () => {
  for (const [width, height] of [[900, 768], [1024, 768], [1280, 982], [1512, 982], [1800, 1000], [2000, 1000]] as const) {
    const { screen } = await renderRoute(`/d/${RIVERA.slug}`, { viewport: { width, height }, pollScale: 100 });
    await expect.element(screen.getByRole('textbox', { name: 'Message Turner Plumbing' })).toBeEnabled();
    const about = screen.getByRole('complementary', { name: 'About Turner Plumbing' }).element();
    const column = about.getBoundingClientRect();
    const chat = document.querySelector('.cd-public-shell__chat')!.getBoundingClientRect();
    expect(column.left).toBe(0);
    expect(column.right).toBe(chat.left);
    expect(column.width).toBeCloseTo(Math.min(400, Math.max(300, width * 0.22)), 1);
    expect(getComputedStyle(about).borderRightWidth).toBe('1px');
    expect(getComputedStyle(about).borderLeftWidth).toBe('0px');
    const status = about.querySelector('.cd-public-shell__open-status')!;
    expect(status).not.toBeNull();
    expect(screen.getByRole('banner').element().querySelector('.cd-public-shell__open-status')).toBeNull();
    expect(status.getBoundingClientRect().top - about.querySelector('h2')!.getBoundingClientRect().bottom).toBe(8);
    expect(about.querySelector('.cd-public-shell__blocks')!.getBoundingClientRect().top - status.getBoundingClientRect().bottom).toBe(16);
    const reading = document.querySelector('.cd-public-shell__chat-head')!.getBoundingClientRect();
    expect(reading.width).toBe(Math.min(680, chat.width - 80));
    expect(reading.left + reading.width / 2).toBeCloseTo(chat.left + chat.width / 2, 1);
  }
});

it('about_status_uses_the_themes_ink_and_status_colours_with_readable_contrast', async () => {
  for (const theme of ['dark', 'light'] as const) {
    for (const open of [true, false]) {
      const desk = rivera.publicDesk.en;
      const hours = mockStore.world.desk(RIVERA.deskId)!.openStatus!.en;
      mockStore.inject({ route: 'publicDesk', status: 200, body: {
        ...desk,
        open_status: { ...hours, open, text: open ? hours.text : 'Closed now. Opens Monday at 8:00 am' },
      } });
      const { screen } = await renderRoute(`/d/${RIVERA.slug}`, { viewport: { width: 1512, height: 982 }, pollScale: 100 });
      await expect.element(screen.getByRole('textbox', { name: 'Message Turner Plumbing' })).toBeEnabled();
      chooseTheme(theme);
      const about = screen.getByRole('complementary', { name: 'About Turner Plumbing' }).element();
      const ground = getComputedStyle(about).backgroundColor;
      const words = getComputedStyle(about.querySelector('.cd-public-shell__open-status-text')!);
      expect(words.color).toBe(tokenColor('--text-primary'));
      expect(contrastRatio(words.color, ground)).toBeGreaterThanOrEqual(4.5);
      const dot = getComputedStyle(about.querySelector('.cd-status-dot')!);
      const dotColor = open ? dot.backgroundColor : dot.borderTopColor;
      expect(dotColor).toBe(tokenColor(open ? '--status-handled' : '--text-secondary'));
      expect(contrastRatio(dotColor, ground)).toBeGreaterThanOrEqual(3);
      const help = about.querySelector('.cd-public-shell__still-helps');
      if (open) expect(help).toBeNull();
      else {
        expect(help?.textContent).toBe('Claude can still help.');
        expect(getComputedStyle(help!).color).toBe(tokenColor('--text-secondary'));
        expect(contrastRatio(getComputedStyle(help!).color, ground)).toBeGreaterThanOrEqual(4.5);
      }
    }
  }
});

it('narrow_public_pages_keep_status_on_its_header_line_and_about_below_chat', async () => {
  for (const width of [390, 899]) {
    const { screen } = await renderRoute(`/d/${RIVERA.slug}`, { viewport: { width, height: 844 }, pollScale: 100 });
    await expect.element(screen.getByRole('textbox', { name: 'Message Turner Plumbing' })).toBeEnabled();
    const header = screen.getByRole('banner').element();
    const status = header.querySelector('.cd-public-shell__open-status')!;
    expect(status).not.toBeNull();
    const about = screen.getByRole('complementary', { name: 'About Turner Plumbing' }).element();
    expect(about.querySelector('.cd-public-shell__open-status')).toBeNull();
    expect(about.parentElement?.className).toBe('cd-public-shell__chat');
    expect(about.getBoundingClientRect().width).toBe(width);
    if (width === 390) {
      expect(header.getBoundingClientRect().height).toBe(92);
      expect(status.getBoundingClientRect().left).toBe(16);
      expect(status.getBoundingClientRect().top - header.querySelector('.cd-public-shell__brand-text')!.getBoundingClientRect().bottom).toBe(8);
    }
  }
});

it('the_owners_public_preview_uses_the_same_left_column_below_its_bar', async () => {
  for (const [width, height] of [[1512, 982], [1800, 1000]] as const) {
    const { screen } = await renderRoute(`/d/${RIVERA.slug}?preview=${RIVERA.deskId}`, { viewport: { width, height }, pollScale: 100 });
    await expect.element(screen.getByRole('textbox', { name: 'Message Turner Plumbing' })).toBeEnabled();
    await expect.element(screen.getByText('Your public page, as customers see it', { exact: true })).toBeVisible();
    const column = screen.getByRole('complementary', { name: 'About Turner Plumbing' }).element();
    const box = column.getBoundingClientRect();
    expect(box.left).toBe(0);
    expect(box.width).toBeCloseTo(width * 0.22, 1);
    expect(box.right).toBe(document.querySelector('.cd-public-shell__chat')!.getBoundingClientRect().left);
    expect(box.top).toBe(screen.getByRole('banner').element().getBoundingClientRect().bottom);
    expect(column.querySelector('.cd-public-shell__open-status')).not.toBeNull();
    expect(screen.getByRole('banner').element().querySelector('.cd-public-shell__open-status')).toBeNull();
  }
});
