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

// Layout
export { Mark, Wordmark, type MarkProps, type WordmarkProps } from './components/Mark/Mark.tsx';
export { MARK_GEOMETRY } from './components/Mark/markGeometry.ts';
export { ConceptFooter, type ConceptFooterProps } from './components/ConceptFooter/ConceptFooter.tsx';

// Icons
export { Icon, ICON_NAMES, type IconName, type IconProps, type IconSize } from './icons/index.tsx';
