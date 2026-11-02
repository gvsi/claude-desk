import type { IconName } from '../ds/index.ts';

/** A future way to reach a Desk, shared by setup's Live step and the owner's Share page. */
export interface ComingLaterChannel {
  /** Unique in the list, stable across copy changes. */
  key: string;
  name: string;
  line: string;
  /** Its neutral line icon on Share's connector tile (board REV-CHAN A), never a brand's mark. */
  icon: IconName;
}

/** Setup keeps the website embed in Share it, beside its QR code. */
export const WEBSITE_EMBED: ComingLaterChannel = {
  key: 'website_embed', name: 'Website embed', line: 'The same chat on your own site.', icon: 'app-window',
};

/** Setup's More channels, in the signed order. */
export const COMING_LATER_CHANNELS: readonly ComingLaterChannel[] = [
  { key: 'whatsapp', name: 'WhatsApp', line: 'Customers message your Desk from WhatsApp.', icon: 'message-circle' },
  { key: 'imessage', name: 'iMessage', line: 'The same chat in Messages on iPhone.', icon: 'message-square' },
  { key: 'phone_calls', name: 'Phone calls', line: 'Your Desk answers your business line by voice.', icon: 'phone' },
];

/** Share lists every future channel together. */
export const SHARE_CHANNELS: readonly ComingLaterChannel[] = [WEBSITE_EMBED, ...COMING_LATER_CHANNELS];
