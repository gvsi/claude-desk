/**
 * Reading Server-Sent Events from a response body that arrives in pieces: events by name with their
 * data, keepalive comments dropped, and lines split anywhere between pieces.
 */
import { describe, expect, it } from 'vitest';

import { SseParser } from './sse.ts';

function readAll(...chunks: string[]) {
  const parser = new SseParser();
  return chunks.flatMap((chunk) => parser.push(chunk));
}

describe('SseParser', () => {
  it('reads_named_events_with_their_data', () => {
    expect(readAll('event: delta\ndata: {"text":"Yes"}\n\nevent: final\ndata: {"answer":"Yes"}\n\n')).toEqual([
      { event: 'delta', data: '{"text":"Yes"}' },
      { event: 'final', data: '{"answer":"Yes"}' },
    ]);
  });

  it('drops_keepalive_comments', () => {
    expect(readAll(': ping\n\n', 'event: reset\ndata: {}\n\n', ':ping\n\n')).toEqual([{ event: 'reset', data: '{}' }]);
  });

  it('joins_lines_split_between_pieces', () => {
    expect(readAll('eve', 'nt: del', 'ta\nda', 'ta: {"text":"Ye', 's"}\n', '\n')).toEqual([{ event: 'delta', data: '{"text":"Yes"}' }]);
  });

  it('reads_every_line_ending', () => {
    expect(readAll('event: a\r\ndata: 1\r\n\r\nevent: b\rdata: 2\r\revent: c\ndata: 3\n\n')).toEqual([
      { event: 'a', data: '1' },
      { event: 'b', data: '2' },
      { event: 'c', data: '3' },
    ]);
  });

  it('keeps_a_crlf_split_between_pieces_as_one_line_end', () => {
    expect(readAll('event: a\r', '\ndata: 1\r', '\n\r', '\n')).toEqual([{ event: 'a', data: '1' }]);
  });

  it('keeps_a_crlf_whole_across_an_empty_piece', () => {
    expect(readAll('event: a\r', '', '\ndata: 1\r', '', '\n\r', '', '\n')).toEqual([{ event: 'a', data: '1' }]);
  });

  it('joins_data_lines_and_names_an_unnamed_event_message', () => {
    expect(readAll('data: one\ndata:two\n\n')).toEqual([{ event: 'message', data: 'one\ntwo' }]);
  });

  it('dispatches_nothing_for_an_event_with_no_data', () => {
    expect(readAll('event: delta\n\n', 'id: 4\nretry: 10\n\n')).toEqual([]);
  });

  it('waits_for_the_blank_line_before_dispatching', () => {
    const parser = new SseParser();
    expect(parser.push('event: delta\ndata: {"text":"Yes"}\n')).toEqual([]);
    expect(parser.push('\n')).toEqual([{ event: 'delta', data: '{"text":"Yes"}' }]);
  });

  it('strips_a_leading_byte_order_mark', () => {
    expect(readAll('\uFEFFevent: reset\ndata: {}\n\n')).toEqual([{ event: 'reset', data: '{}' }]);
  });

  it('resets_the_event_name_after_each_dispatch', () => {
    expect(readAll('event: delta\ndata: 1\n\ndata: 2\n\n')).toEqual([
      { event: 'delta', data: '1' },
      { event: 'message', data: '2' },
    ]);
  });
});
