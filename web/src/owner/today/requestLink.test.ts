import { describe, expect, it } from 'vitest';

import { requestInHash, requestPath } from './requestLink.ts';

describe('request links', () => {
  it('request_link_round_trips_the_decision', () => {
    expect(requestPath('desk-1', 'dec-7')).toBe('/app/desk-1/today#request-dec-7');
    // An id with characters a URL would read otherwise is encoded, and reads back as it was.
    const odd = 'dec 7/#?%';
    const path = requestPath('desk-1', odd);
    expect(path).toBe('/app/desk-1/today#request-dec%207%2F%23%3F%25');
    expect(requestInHash(path.slice(path.indexOf('#')))).toBe(odd);
  });

  it('other_hashes_name_no_request', () => {
    expect(requestInHash('')).toBeNull();
    expect(requestInHash('#')).toBeNull();
    expect(requestInHash('#request-')).toBeNull();
    expect(requestInHash('#needs-you')).toBeNull();
    expect(requestInHash('request-dec-7')).toBeNull();
    // A broken escape names nothing rather than throwing.
    expect(requestInHash('#request-%E0%A4%A')).toBeNull();
  });
});
