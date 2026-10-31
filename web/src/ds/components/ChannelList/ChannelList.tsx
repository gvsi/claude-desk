import type { ReactNode } from 'react';

import { Card } from '../Card/Card.tsx';
import { Pill } from '../Pill/Pill.tsx';
import { StatusDot } from '../StatusDot/StatusDot.tsx';

import './ChannelList.css';

/** A channel that isn't built: its name, and how someone is known there, in the owner's words. */
export interface ChannelView {
  name: string;
  /** How identity works on this channel, and what still needs a code. */
  how: string;
}

/**
 * The channels a Desk could answer on, after its public link, each with how someone is known there.
 * They are statements of the always-on baseline (an address or a number is a hint until it matches
 * the contact on record, and private data needs a code), so they are fixed copy, not data.
 */
export const LATER_CHANNELS: readonly ChannelView[] = [
  { name: 'Email', how: 'Replies to your business address. The sender’s address is a hint, never proof: private data still needs a code.' },
  { name: 'Website embed', how: 'The same chat on your own site, with the same rules and the same disclosure.' },
  {
    name: 'WhatsApp and iMessage',
    how: 'The phone number is the contact on record when it matches; otherwise a code goes to the number you have.',
  },
  { name: 'Slack', how: 'For team Desks. A workspace member is known by their Slack account, within the rules you set.' },
  { name: 'Voice', how: 'Calls answered by Claude, an AI, which says so first. Private data still needs a code.' },
];

export interface ChannelListProps {
  /** The Desk's public link as the owner reads it: "desk.example/rivera". */
  publicLink: string;
}

/**
 * Where visitors reach a Desk, one row each: the public link, on, then Email, Website embed,
 * WhatsApp and iMessage, Slack and Voice, each "Coming later". Every row says how someone is known
 * on that channel. Nothing here is a control.
 */
export function ChannelList({ publicLink }: ChannelListProps) {
  return (
    <Card as="section" label="Channels" padding={0}>
      <ul role="list" className="cd-channel-list">
        <ChannelRow
          name="Public link"
          how={`${publicLink}. Visitors confirm who they are with a code sent to their contact on record.`}
          status={
            <span className="cd-channel-list__on cd-type-meta">
              <StatusDot tone="handled" />
              On
            </span>
          }
        />
        {LATER_CHANNELS.map((channel) => (
          <ChannelRow key={channel.name} name={channel.name} how={channel.how} status={<Pill>Coming later</Pill>} />
        ))}
      </ul>
    </Card>
  );
}

function ChannelRow({ name, how, status }: ChannelView & { status: ReactNode }) {
  return (
    <li className="cd-channel-list__row">
      <div className="cd-channel-list__text">
        <p className="cd-channel-list__name cd-type-body">{name}</p>
        <p className="cd-channel-list__how cd-type-meta">{how}</p>
      </div>
      {status}
    </li>
  );
}
