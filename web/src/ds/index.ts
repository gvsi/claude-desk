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
  CHANGED_REFRESHED,
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
export { DisclosureLine, type DisclosureLineProps } from './components/DisclosureLine/DisclosureLine.tsx';
export { LoadingLine, type LoadingLineProps } from './components/LoadingLine/LoadingLine.tsx';

// Controls
export { Switch, type SwitchProps } from './components/Switch/Switch.tsx';
export {
  SegmentedControl,
  type SegmentedControlProps,
  type SegmentedOption,
} from './components/SegmentedControl/SegmentedControl.tsx';
export { Composer, type ComposerProps, type ComposerVariant } from './components/Composer/Composer.tsx';
export { SuggestionChips, type SuggestionChipsProps } from './components/SuggestionChips/SuggestionChips.tsx';
export { TextField, type TextFieldProps } from './components/TextField/TextField.tsx';

// Layout
export { Card, type CardProps } from './components/Card/Card.tsx';
export { SectionHeader, type SectionHeaderProps } from './components/SectionHeader/SectionHeader.tsx';
export { Mark, Wordmark, type MarkProps, type WordmarkProps } from './components/Mark/Mark.tsx';
export { MARK_GEOMETRY } from './components/Mark/markGeometry.ts';
export { ConceptFooter, type ConceptFooterProps } from './components/ConceptFooter/ConceptFooter.tsx';
export { AppShell, type AppShellProps } from './components/AppShell/AppShell.tsx';
export {
  Sidebar,
  type NavCount,
  type NavKey,
  type SidebarAbout,
  type SidebarAboutLink,
  type SidebarHrefs,
  type SidebarLinkProps,
  type SidebarProps,
} from './components/Sidebar/Sidebar.tsx';
export { PageHeader, type PageHeaderProps } from './components/PageHeader/PageHeader.tsx';
export { Greeting, type GreetingProps, type PresenceGlyph } from './components/Greeting/Greeting.tsx';
export { ReviewerBar, type ReviewerBarProps } from './components/ReviewerBar/ReviewerBar.tsx';
export { PublicShell, type PublicBrand, type PublicOpenStatus, type PublicShellProps } from './components/PublicShell/PublicShell.tsx';
export { PublicBrandHeader, type PublicBrandHeaderProps } from './components/PublicShell/PublicBrandHeader.tsx';
export { Dialog, type DialogProps } from './components/Dialog/Dialog.tsx';

// Navigation
export {
  SwitcherMenu,
  type SwitcherBusiness,
  type SwitcherMenuProps,
  type SwitcherPick,
} from './components/SwitcherMenu/SwitcherMenu.tsx';
export {
  ConversationListItem,
  type ConversationListItemProps,
} from './components/ConversationListItem/ConversationListItem.tsx';
export {
  LeadRow,
  PersonRow,
  type LeadRowProps,
  type PersonRowProps,
} from './components/PersonRow/PersonRow.tsx';

// First visit
export {
  IntroDialog,
  type IntroDialogProps,
  type IntroErrorCode,
  type IntroThing,
} from './components/IntroDialog/IntroDialog.tsx';
export { INTRO_ERROR_COPY } from './components/IntroDialog/introCopy.ts';

// Verification
export {
  VerifyCodeForm,
  type VerifyCodeFormProps,
  type VerifyCodeState,
} from './components/VerifyCodeForm/VerifyCodeForm.tsx';
export { VerifiedLine, type VerifiedLineProps } from './components/VerifyCodeForm/VerifiedLine.tsx';
export {
  DemoInboxPanel,
  shownItems,
  type DemoInboxItem,
  type DemoInboxPanelProps,
} from './components/DemoInboxPanel/DemoInboxPanel.tsx';
export { DemoInboxSheet, type DemoInboxSheetProps } from './components/DemoInboxSheet/DemoInboxSheet.tsx';

// Setup
export { SituationRow, type SituationRowProps } from './components/SituationRow/SituationRow.tsx';
export { SafetyCheckRow, type SafetyCheckRowProps } from './components/SafetyCheckRow/SafetyCheckRow.tsx';

// Agents
export { CodeBlock, type CodeBlockProps } from './components/CodeBlock/CodeBlock.tsx';
export { CopyField, type CopyFieldProps } from './components/CopyField/CopyField.tsx';
export { COPY_RESULT_COPY, useCopyText, type CopyState } from './components/CopyField/useCopyText.ts';

// Share
export { ShareCard, type ShareCardProps } from './components/ShareCard/ShareCard.tsx';
export { CopyList, type CopyListItem, type CopyListProps } from './components/CopyList/CopyList.tsx';

// Payments
export { MockCheckout, type MockCheckoutProps } from './components/MockCheckout/MockCheckout.tsx';

// Reply cards
export { ReplyCard, type ReplyCardProps } from './components/ReplyCard/ReplyCard.tsx';
export { cardView, type CardView } from './components/ReplyCard/cardView.ts';
export { CARD_CHROME, LINK_CANCELLED_CHROME, MONEY_TEMPLATES, type CardChrome } from './components/ReplyCard/chrome.ts';
export { LinkCancelledCard, type LinkCancelledCardProps } from './components/ReplyCard/LinkCancelledCard.tsx';

// Conversation
export { Transcript, type TranscriptProps } from './components/Transcript/Transcript.tsx';
export { VisitorMessage, type VisitorMessageProps } from './components/VisitorMessage/VisitorMessage.tsx';
export { ClaudeMessage, type ClaudeMessageProps } from './components/ClaudeMessage/ClaudeMessage.tsx';
export { PersonMessage, type PersonMessageProps } from './components/PersonMessage/PersonMessage.tsx';
export { AgentMessage, type AgentMessageProps } from './components/AgentMessage/AgentMessage.tsx';
export { Whisper, type WhisperProps } from './components/Whisper/Whisper.tsx';
export { SystemLine, type SystemLineProps } from './components/SystemLine/SystemLine.tsx';
export { WritingIndicator, type WritingIndicatorProps } from './components/WritingIndicator/WritingIndicator.tsx';

// Margin receipts
export {
  TranscriptHeader,
  TranscriptRow,
  type TranscriptHeaderProps,
  type TranscriptRowProps,
} from './components/TranscriptRow/TranscriptRow.tsx';
export { MarginReceipt, type MarginReceiptProps } from './components/MarginReceipt/MarginReceipt.tsx';
export {
  OWNER_REASON_STATES,
  OWNER_STATE_WORDS,
  receiptFromEvent,
  receiptTone,
  type OwnerReasonState,
  type ReceiptSource,
  type ReceiptView,
} from './components/MarginReceipt/receiptTone.ts';
export { MarginNote, type MarginNoteProps } from './components/MarginNote/MarginNote.tsx';

// Recorded history
export { RecordedTag, type RecordedTagProps } from './components/RecordedTag/RecordedTag.tsx';
export { RecordedNote, type RecordedNoteProps } from './components/RecordedNote/RecordedNote.tsx';
export {
  RecordedHistoryLink,
  type RecordedHistoryLinkProps,
} from './components/RecordedHistoryLink/RecordedHistoryLink.tsx';

// Owner decisions
export { ApprovalCard, type ApprovalCardProps } from './components/ApprovalCard/ApprovalCard.tsx';
export { TakeOverBar, type TakeOverBarProps } from './components/TakeOverBar/TakeOverBar.tsx';

// Safety
export { FullTrace, type FullTraceProps } from './components/FullTrace/FullTrace.tsx';
export { ChainStatus, type ChainStatusProps } from './components/ChainStatus/ChainStatus.tsx';
export { AttemptRow, type AttemptRowProps } from './components/AttemptRow/AttemptRow.tsx';
export {
  CheckpointMeter,
  type Checkpoint,
  type CheckpointMeterProps,
} from './components/AttemptRow/CheckpointMeter.tsx';

// Icons
export { Icon, ICON_NAMES, type IconName, type IconProps, type IconSize } from './icons/index.tsx';
