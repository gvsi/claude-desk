/**
 * The still preview of Rivera Plumbing's Today behind the intro dialog, from the design system's
 * Rivera fixtures. Fixed props only: the preview reads nothing from the API, so no demo data loads
 * before the passcode is accepted.
 */
import type { Decision } from '../../api/contracts.ts';
import { rivera } from '../../ds/fixtures/index.ts';

export interface TodayPreviewProps {
  business: string;
  ownerName: string;
  /** The first word of the owner's name, as Today greets her. */
  greetingName: string;
  /** Rivera's time zone, so the preview greets the same as Today will. */
  timezone: string;
  desk: { id: string; name: string };
  /** The seeded hold: a visitor not on record asking for 15% off. */
  held: Decision;
  heldBy: string;
  /** The visitor's own words. */
  fromTheVisitor: string;
  waiting: string;
}

/** The visitor's message that the seeded hold answers. */
function heldMessage(): string {
  const turn = rivera.conversations.visitor.turns.find((t) => t.kind === 'visitor');
  return turn?.kind === 'visitor' ? turn.text : '';
}

export const TODAY_PREVIEW: TodayPreviewProps = {
  business: rivera.business.name,
  ownerName: rivera.business.ownerName,
  greetingName: rivera.business.ownerName.split(' ')[0] ?? rivera.business.ownerName,
  timezone: 'America/Los_Angeles',
  desk: { id: 'preview-desk', name: rivera.business.deskName },
  held: rivera.decisions.held,
  heldBy: rivera.ruleCards['rv-quote'].reason,
  fromTheVisitor: heldMessage(),
  waiting: 'Web chat, 2 min ago',
};
