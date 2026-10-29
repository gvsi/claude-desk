/**
 * The design system's one import path. Each component is exported here with its `<Comp>Props`;
 * `guards.test.ts` fails when a `components/<Comp>/` folder is not.
 */

// Actions
export { Button, type ButtonProps, type ButtonVariant } from './components/Button/Button.tsx';
export { IconButton, type IconButtonProps } from './components/IconButton/IconButton.tsx';
export { Chip, type ChipProps } from './components/Chip/Chip.tsx';
export { TextLink, type TextLinkProps } from './components/TextLink/TextLink.tsx';

// Status
export { Pill, type PillProps } from './components/Pill/Pill.tsx';
export { CountPill, type CountPillProps } from './components/CountPill/CountPill.tsx';
export {
  StatusDot,
  StatusLabel,
  type StatusDotProps,
  type StatusLabelProps,
  type StatusTone,
} from './components/StatusDot/StatusDot.tsx';

export { Notice, type NoticeProps, type NoticeTone } from './components/Notice/Notice.tsx';
export {
  CHAT_ENDED_COPY,
  NEW_CHAT_LABEL,
  RATE_LIMITED_COPY,
  UNREACHABLE_COPY,
  errorCopy,
  evErrorCopy,
  type CopyLanguage,
  type CopyPair,
} from './components/Notice/errorCopy.ts';
export { EmptyState, type EmptyStateProps } from './components/EmptyState/EmptyState.tsx';

// Controls
export { Switch, type SwitchProps } from './components/Switch/Switch.tsx';
export {
  SegmentedControl,
  type SegmentedControlProps,
  type SegmentedOption,
} from './components/SegmentedControl/SegmentedControl.tsx';

// Layout
export { Card, type CardProps } from './components/Card/Card.tsx';
export { SectionHeader, type SectionHeaderProps } from './components/SectionHeader/SectionHeader.tsx';
export { Mark, Wordmark, type MarkProps, type WordmarkProps } from './components/Mark/Mark.tsx';
export { MARK_GEOMETRY } from './components/Mark/markGeometry.ts';
export { ConceptFooter, type ConceptFooterProps } from './components/ConceptFooter/ConceptFooter.tsx';

// Reply cards
export { ReplyCard, type ReplyCardProps } from './components/ReplyCard/ReplyCard.tsx';
export { cardView, type CardView } from './components/ReplyCard/cardView.ts';
export { CARD_CHROME, type CardChrome } from './components/ReplyCard/chrome.ts';

// Icons
export { Icon, ICON_NAMES, type IconName, type IconProps, type IconSize } from './icons/index.tsx';
