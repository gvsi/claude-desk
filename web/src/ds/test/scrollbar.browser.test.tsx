import { expect, it, onTestFinished } from 'vitest';
import { page, userEvent } from 'vitest/browser';

import { tokenColor } from '../../test/screen.ts';
import { chooseTheme } from './theme.ts';

/** Both axes overflow, as a transcript or a code block does. */
function scrollArea() {
  const area = document.createElement('div');
  area.id = 'scrollbar-probe';
  area.style.cssText = 'position: fixed; top: 100px; left: 100px; width: 200px; height: 200px; overflow: auto';
  const content = document.createElement('div');
  content.style.cssText = 'width: 1000px; height: 1000px';
  area.append(content);
  document.body.append(area);
  onTestFinished(() => area.remove());
  return area;
}

async function expectStandardScrollbar(area: HTMLElement) {
  await userEvent.hover(page.elementLocator(document.body), { position: { x: 1, y: 1 } });
  expect(getComputedStyle(area).scrollbarWidth).toBe('thin');
  expect(getComputedStyle(area).scrollbarColor).toBe(`${tokenColor('--line-control')} rgba(0, 0, 0, 0)`);
  const gutter = area.offsetWidth - area.clientWidth;
  await userEvent.hover(page.elementLocator(area));
  await expect.poll(() => getComputedStyle(area).scrollbarColor).toBe(`${tokenColor('--text-tertiary')} rgba(0, 0, 0, 0)`);
  expect(area.offsetWidth - area.clientWidth).toBe(gutter);
}

it.each(['dark', 'light'] as const)('S1_keeps_its_size_and_uses_the_theme_tokens_in_%s', async (theme) => {
  chooseTheme(theme);
  const area = scrollArea();
  await userEvent.hover(page.elementLocator(document.body), { position: { x: 1, y: 1 } });
  if (!CSS.supports('selector(::-webkit-scrollbar)')) {
    await expectStandardScrollbar(area);
    return;
  }
  const bar = () => getComputedStyle(area, '::-webkit-scrollbar');
  const thumb = () => getComputedStyle(area, '::-webkit-scrollbar-thumb');
  expect([bar().width, bar().height]).toEqual(['12px', '12px']);
  expect(getComputedStyle(area).scrollbarWidth).toBe('auto');
  expect(getComputedStyle(area).scrollbarColor).toBe('auto');
  expect(thumb().backgroundColor).toBe(tokenColor('--line-control'));
  expect(thumb().borderWidth).toBe('3px');
  expect(thumb().borderColor).toBe('rgba(0, 0, 0, 0)');
  expect(thumb().backgroundClip).toBe('padding-box');
  expect(thumb().borderRadius).toBe('999px');
  expect([thumb().minWidth, thumb().minHeight]).toEqual(['32px', '32px']);
  for (const part of ['track', 'corner']) {
    expect(getComputedStyle(area, `::-webkit-scrollbar-${part}`).backgroundColor).toBe('rgba(0, 0, 0, 0)');
  }
  expect(getComputedStyle(area, '::-webkit-scrollbar-button').display).toBe('none');
  await userEvent.hover(page.elementLocator(area));
  await expect.poll(() => area.matches(':hover')).toBe(true);
  // Chromium's CSSOM reports the thumb's base style even while its area matches :hover.
  // Check the browser-parsed state rule and its matching host, as well as unchanged geometry.
  const hoverRule = [...document.styleSheets].flatMap(sheet => {
    try { return [...sheet.cssRules]; } catch { return []; }
  }).find((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule && rule.selectorText.includes(':hover::-webkit-scrollbar-thumb'))!;
  expect(area.matches(hoverRule.selectorText.replace(/::-webkit-scrollbar-thumb(?::active)?/g, ':is(*)'))).toBe(true);
  expect(hoverRule.style.backgroundColor).toBe('var(--text-tertiary)');
  expect(hoverRule.selectorText).toContain('::-webkit-scrollbar-thumb:active');
  expect([bar().width, bar().height, thumb().borderWidth]).toEqual(['12px', '12px', '3px']);
});

it.each(['dark', 'light'] as const)('standard_scrollbar_fallback_uses_hover_ink_and_excludes_About_in_%s', async (theme) => {
  chooseTheme(theme);
  if (CSS.supports('selector(::-webkit-scrollbar)')) {
    // Exercise Firefox's otherwise inactive branch in the Chromium test project too.
    // Chromium supports both standard properties; only the feature gate differs.
    const fallback = [...document.styleSheets].flatMap(sheet => {
      try { return [...sheet.cssRules]; } catch { return []; }
    }).find((rule): rule is CSSSupportsRule => rule instanceof CSSSupportsRule && rule.conditionText === 'not selector(::-webkit-scrollbar)')!;
    const enabled = document.createElement('style');
    enabled.textContent = [...fallback.cssRules].map(rule => rule.cssText).join('\n');
    document.head.append(enabled);
    onTestFinished(() => enabled.remove());
  }
  const area = scrollArea();
  await expectStandardScrollbar(area);
  for (const rootClass of ['cd-about-paper', 'cd-vision-frame']) {
    area.className = rootClass;
    await userEvent.hover(page.elementLocator(area));
    for (const element of [document.documentElement, document.body, area, area.firstElementChild!]) {
      expect(getComputedStyle(element).scrollbarWidth).toBe('auto');
      expect(getComputedStyle(element).scrollbarColor).toBe('auto');
    }
  }
});

it.each(['cd-about-paper', 'cd-vision-frame'])('About_and_vision_keep_native_scrollbars_on_the_page_and_nested_areas_at_%s', (rootClass) => {
  const area = scrollArea();
  const native = document.createElement('iframe');
  document.body.append(native);
  onTestFinished(() => native.remove());
  // An unstyled document supplies the browser's native values on this platform.
  const nativeArea = native.contentDocument!.createElement('div');
  native.contentDocument!.body.append(nativeArea);
  nativeArea.style.cssText = 'width: 200px; height: 200px; overflow: scroll';
  nativeArea.append(document.createElement('div'));
  nativeArea.firstElementChild!.setAttribute('style', 'width: 1000px; height: 1000px');
  area.classList.add(rootClass);
  const nested = area.firstElementChild as HTMLElement;
  nested.style.cssText = 'width: 1000px; height: 1000px; overflow: scroll';
  nested.append(document.createElement('div'));
  nested.firstElementChild!.setAttribute('style', 'width: 2000px; height: 2000px');
  if (CSS.supports('selector(::-webkit-scrollbar)')) {
    // Reverting pseudo styles still opts Chromium into an invisible custom scrollbar.
    // Compare rendered gutters with an unstyled document, with scrollbars visible.
    const nativeGutter = nativeArea.offsetWidth - nativeArea.clientWidth;
    expect(nativeGutter).toBeGreaterThan(0);
    for (const element of [area, nested]) {
      expect(element.offsetWidth - element.clientWidth).toBe(nativeGutter);
    }
    const root = document.documentElement;
    const overflow = root.style.overflow;
    root.style.overflow = 'scroll';
    native.contentDocument!.documentElement.style.overflow = 'scroll';
    onTestFinished(() => { root.style.overflow = overflow; });
    expect(window.innerWidth - root.clientWidth).toBe(native.contentWindow!.innerWidth - native.contentDocument!.documentElement.clientWidth);
  }
  for (const element of [document.documentElement, document.body, area, nested]) {
    if (CSS.supports('selector(::-webkit-scrollbar)')) {
      // Equal gutters alone miss the blank custom track: no app pseudo rule may opt this
      // scroller into WebKit's custom rendering, even one that reverts every declaration.
      const matchingScrollbarRules = [...document.styleSheets].flatMap(sheet => {
        try { return [...sheet.cssRules]; } catch { return []; }
      }).filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule && rule.selectorText.includes('::-webkit-scrollbar'))
        .filter(rule => element.matches(rule.selectorText.replace(/::-webkit-scrollbar(?:-thumb|-track|-corner|-button)?(?::active)?/g, ':is(*)')));
      expect(matchingScrollbarRules.map(rule => rule.selectorText)).toEqual([]);
    }
    expect(getComputedStyle(element, '::-webkit-scrollbar').width).toBe(getComputedStyle(nativeArea, '::-webkit-scrollbar').width);
    expect(getComputedStyle(element, '::-webkit-scrollbar-thumb').backgroundColor).toBe(getComputedStyle(nativeArea, '::-webkit-scrollbar-thumb').backgroundColor);
    expect(getComputedStyle(element).scrollbarWidth).toBe('auto');
    expect(getComputedStyle(element).scrollbarColor).toBe('auto');
  }
});
