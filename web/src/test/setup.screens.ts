/**
 * Setup for the `screens` project: the app's styles, as `main.tsx` loads them, and a clean slate
 * after every test (poll intervals at real time, the browser's own languages).
 */
import { afterEach } from 'vitest';

import { setPollScale } from '../app/poll.ts';
import { resetBrowserLanguage } from './renderRoute.tsx';

import '../ds/tokens.css';
import '../ds/base.css';

afterEach(() => {
  setPollScale(1);
  resetBrowserLanguage();
});
