import { createContext } from 'react';

/**
 * What a message that reveals itself (`ClaudeMessage`'s `reveal`) tells the `TranscriptRow` it
 * arrived in, so what is attached under it comes in after it, in order. Only a row drawn `live`
 * listens; anywhere else nothing hears it.
 */
export interface RowArrival {
  /** The message's words are being revealed: what is attached waits, unseen. */
  wait: () => void;
  /**
   * The message's words are whole and its own cards take the beats before `beat` (`motion-follow`
   * apart): what is attached fades and rises in from that beat on, one by one.
   */
  follow: (beat: number) => void;
}

export const RowArrivalContext = createContext<RowArrival | null>(null);
