import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { CopyField } from './CopyField.tsx';
import { CopyList } from '../CopyList/CopyList.tsx';
import { CopyLink } from '../../../owner/share/CopyLink.tsx';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('shows only the latest copy, announces each press, and keeps the confirmation until another press', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const writeText = vi.fn(async () => {});
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const copied = () => [...host.querySelectorAll('[role="status"]')].filter((el) => el.textContent === 'Copied.');
  const press = async (label: string) => {
    const button = [...host.querySelectorAll('button')].find((el) => el.textContent === label)!;
    await act(async () => button.click());
  };
  try {
    await act(async () => root.render(createElement('div', null,
      createElement(CopyLink, { url: 'https://desk.example/d/turner', look: 'text' }),
      createElement(CopyList, { label: 'Ready-made words', items: [
        { title: 'Google profile', text: 'Google words' },
        { title: 'Email signature', text: 'Email words' },
      ], onCopy: writeText }),
      createElement(CopyField, { value: 'https://desk.example/api/a2a/turner', copyLabel: 'Copy address', onCopy: writeText, language: 'en' }),
    )));
    await press('Copy link');
    expect(copied()).toHaveLength(1);
    const linkStatus = copied()[0]!;
    act(() => vi.advanceTimersByTime(1_500));
    await press('Copy Google profile');
    expect(copied()).toHaveLength(1);
    expect(linkStatus.textContent).toBe('');
    expect(copied()[0]?.closest('li')?.textContent).toContain('Google profile');
    act(() => vi.advanceTimersByTime(100));
    expect(copied()).toHaveLength(1);
    await press('Copy Email signature');
    expect(copied()).toHaveLength(1);
    expect(copied()[0]?.closest('li')?.textContent).toContain('Email signature');
    await press('Copy address');
    expect(copied()).toHaveLength(1);
    const status = copied()[0]!;
    expect(status.closest('.cd-copy-field')).not.toBeNull();
    // role=status is implicitly polite. A repeated press must change its content too,
    // so assistive technology gets one fresh confirmation, with no duplicate live region.
    const announcements: string[] = [];
    const observer = new MutationObserver(() => {
      if (status.textContent) announcements.push(status.textContent);
    });
    observer.observe(status, { childList: true, characterData: true, subtree: true });
    try {
      act(() => vi.advanceTimersByTime(1_599));
      await press('Copy address');
      expect(announcements).toEqual(['Copied.']);
      expect(copied()).toHaveLength(1);
      act(() => vi.advanceTimersByTime(1_599));
      expect(copied()).toHaveLength(1);
      act(() => vi.advanceTimersByTime(1));
      expect(copied()).toHaveLength(1);
      act(() => vi.advanceTimersByTime(60_000));
      expect(copied()).toHaveLength(1);
    } finally {
      observer.disconnect();
    }
    expect(writeText.mock.calls).toHaveLength(5);
    await press('Copy link');
    act(() => root.unmount());
    // Let React/jsdom's next-task work finish.
    act(() => vi.advanceTimersByTime(0));
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    if (host.hasChildNodes()) act(() => root.unmount());
    host.remove();
  }
});
