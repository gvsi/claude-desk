/**
 * Server-Sent Events read from a response body as it arrives, for a stream that `EventSource`
 * can't open (it only sends GET): the owner's Ask Claude answer, posted with
 * `Accept: text/event-stream`. It reads the format as browsers do: lines end with CRLF, LF or CR,
 * possibly split between pieces; a line starting with ":" is a comment, such as the keepalive
 * `: ping`, and is dropped; `data:` lines join with a newline; a blank line ends an event, and an
 * event with no data is dropped. `id` and `retry` are read and ignored: a post is never resumed.
 */

/** One event: its name (`message` when the server named none) and its data. */
export interface SseMessage {
  event: string;
  data: string;
}

export class SseParser {
  /** The part of a line that hasn't ended yet. */
  private line = '';
  /** The last piece ended on a CR, so a LF that starts the next one ends no other line. */
  private afterCr = false;
  private started = false;
  private event = '';
  private data: string[] = [];

  /** Reads the next piece of the body and returns the events it completed, in order. */
  push(chunk: string): SseMessage[] {
    // An empty piece changes nothing, a CR waiting for its LF included.
    if (chunk === '') return [];
    let text = chunk;
    if (!this.started && text !== '') {
      this.started = true;
      if (text.startsWith('\uFEFF')) text = text.slice(1);
    }
    if (this.afterCr && text.startsWith('\n')) text = text.slice(1);
    this.afterCr = false;
    const out: SseMessage[] = [];
    let from = 0;
    for (let at = 0; at < text.length; at += 1) {
      const char = text[at];
      if (char !== '\n' && char !== '\r') continue;
      this.readLine(this.line + text.slice(from, at), out);
      this.line = '';
      if (char === '\r') {
        if (at + 1 === text.length) this.afterCr = true;
        else if (text[at + 1] === '\n') at += 1;
      }
      from = at + 1;
    }
    this.line += text.slice(from);
    return out;
  }

  private readLine(line: string, out: SseMessage[]): void {
    if (line === '') {
      if (this.data.length > 0) out.push({ event: this.event === '' ? 'message' : this.event, data: this.data.join('\n') });
      this.event = '';
      this.data = [];
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.event = value;
    else if (field === 'data') this.data.push(value);
  }
}
