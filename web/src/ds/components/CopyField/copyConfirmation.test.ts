import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { CopyField } from './CopyField.tsx';
import { CopyList } from '../CopyList/CopyList.tsx';
import { CopyLink } from '../../../owner/share/CopyLink.tsx';

const cleanups: (() => void)[] = [];

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
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

async function renderControls(writeText: (text: string) => Promise<void> | void) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let mounted = true;
  const unmount = () => {
    if (mounted) act(() => root.unmount());
    mounted = false;
  };
  cleanups.push(() => {
    unmount();
    host.remove();
  });
  await act(async () => root.render(createElement('div', null,
    createElement(CopyLink, { url: 'https://desk.example/d/turner', look: 'text' }),
    createElement(CopyField, { value: 'Address', copyLabel: 'Copy address', onCopy: writeText, language: 'en' }),
  )));
  return {
    host,
    unmount,
    lines: () => [...host.querySelectorAll('[role="status"]')].filter((el) => el.textContent !== ''),
    press: async (label: string) => {
      const button = [...host.querySelectorAll('button')].find((el) => el.textContent === label)!;
      await act(async () => button.click());
    },
  };
}

it('clears a failed line when another control copies successfully', async () => {
  const writeText = vi.fn().mockRejectedValueOnce(new Error('Clipboard unavailable')).mockResolvedValue(undefined);
  const controls = await renderControls(writeText);
  await controls.press('Copy address');
  expect(controls.lines().map((el) => el.textContent)).toEqual(['Copy didn’t work. The text is selected, so copy it yourself.']);
  expect(document.getSelection()?.toString()).toBe('Address');
  await controls.press('Copy link');
  expect(controls.lines().map((el) => el.textContent)).toEqual(['Copied.']);
  expect(controls.lines()[0]?.closest('.cd-copy-link')).not.toBeNull();
});

it('replaces success with failure on the same control and announces repeated failures', async () => {
  const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(new Error('Clipboard unavailable'));
  const controls = await renderControls(writeText);
  await controls.press('Copy address');
  const status = controls.lines()[0]!;
  expect(status.textContent).toBe('Copied.');
  const success = status.firstChild;
  await controls.press('Copy address');
  expect(controls.lines()).toEqual([status]);
  expect(status.textContent).toBe('Copy didn’t work. The text is selected, so copy it yourself.');
  expect(status.firstChild).not.toBe(success);
  const failure = status.firstChild;
  await controls.press('Copy address');
  expect(status.firstChild).not.toBe(failure);
  expect(document.getSelection()?.toString()).toBe('Address');
});

it.each(['resolve', 'reject'] as const)('ignores a copy that finishes after unmount: %s', async (finish) => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const pending = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  const old = await renderControls(() => pending);
  await old.press('Copy address');
  old.unmount();
  const current = await renderControls(async () => {});
  await current.press('Copy link');
  const selection = document.getSelection()?.toString();
  await act(async () => {
    if (finish === 'resolve') resolve();
    else reject(new Error('Clipboard unavailable'));
    await pending.catch(() => {});
  });
  expect(old.host.childNodes).toHaveLength(0);
  expect(current.lines().map((el) => el.textContent)).toEqual(['Copied.']);
  expect(document.getSelection()?.toString()).toBe(selection);
});

it.each(['resolve', 'reject'] as const)('clears on press and ignores an older pending copy: %s', async (finish) => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const pending = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  const writeText = vi.fn().mockResolvedValueOnce(undefined).mockReturnValueOnce(pending).mockResolvedValue(undefined);
  const controls = await renderControls(writeText);
  await controls.press('Copy address');
  expect(controls.lines().map((el) => el.textContent)).toEqual(['Copied.']);
  await controls.press('Copy link');
  expect(controls.lines()).toEqual([]);
  await controls.press('Copy address');
  const status = controls.lines()[0]!;
  const selection = document.getSelection()?.toString();
  await act(async () => {
    if (finish === 'resolve') resolve();
    else reject(new Error('Clipboard unavailable'));
    await pending.catch(() => {});
  });
  expect(controls.lines()).toEqual([status]);
  expect(status.closest('.cd-copy-field')).not.toBeNull();
  expect(status.textContent).toBe('Copied.');
  expect(document.getSelection()?.toString()).toBe(selection);
});
