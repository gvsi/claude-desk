/**
 * Where an About this prototype page's way back into the prototype goes: the last Desk this browser opened, or
 * the start of the prototype when it has opened none. It reads only the Desk's id the owner app stored in this
 * browser, never the Desk's name, and makes no request, so the page reads the same for anyone.
 */
import { readLocal } from '../lib/storage.ts';

export function prototypeHref(): string {
  const lastDesk = readLocal('lastDesk');
  return lastDesk ? `/app/${encodeURIComponent(lastDesk)}/today` : '/';
}
