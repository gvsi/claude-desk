/**
 * The document's language (`<html lang>`) while a visitor page is open: the language the page is
 * written in, so a screen reader reads what sits outside the page's own `lang` containers, such as
 * the footer, in that language too. The page hands the previous language back when it closes, so
 * the owner app and the About pages stay English, as `index.html` sets it. A layout effect, as a
 * page that names the tab uses, so the language changes in the same commit as the page.
 */
import { useLayoutEffect } from 'react';

export function useDocumentLanguage(language: string): void {
  useLayoutEffect(() => {
    const root = document.documentElement;
    const before = root.lang;
    root.lang = language;
    return () => {
      root.lang = before;
    };
  }, [language]);
}
