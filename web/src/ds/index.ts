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
  type SidebarLinkProps,
  type SidebarProps,
} from './components/Sidebar/Sidebar.tsx';
export { PageHeader, type PageHeaderProps } from './components/PageHeader/PageHeader.tsx';
export { Greeting, type GreetingProps, type PresenceGlyph } from './components/Greeting/Greeting.tsx';
export { ReviewerBar, type ReviewerBarProps } from './components/ReviewerBar/ReviewerBar.tsx';
export { PublicShell, type PublicBrand, type PublicOpenStatus, type PublicShellProps } from './components/PublicShell/PublicShell.tsx';
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
export { Breadcrumb, type BreadcrumbItem, type BreadcrumbProps } from './components/Breadcrumb/Breadcrumb.tsx';
export { Steps, type StepsProps } from './components/Steps/Steps.tsx';
export { SubNav, type SubNavItem, type SubNavProps } from './components/SubNav/SubNav.tsx';

// First visit
export {
  IntroDialog,
  type IntroDialogProps,
  type IntroErrorCode,
  type IntroThing,
} from './components/IntroDialog/IntroDialog.tsx';
export { INTRO_ERROR_COPY } from './components/IntroDialog/introCopy.ts';

// Reply cards
export { ReplyCard, type ReplyCardProps } from './components/ReplyCard/ReplyCard.tsx';
export { cardView, type CardView } from './components/ReplyCard/cardView.ts';
export { CARD_CHROME, MONEY_TEMPLATES, type CardChrome } from './components/ReplyCard/chrome.ts';

// Conversation
export { Transcript, type TranscriptProps } from './components/Transcript/Transcript.tsx';
export { VisitorMessage, type VisitorMessageProps } from './components/VisitorMessage/VisitorMessage.tsx';
export { ClaudeMessage, type ClaudeMessageProps } from './components/ClaudeMessage/ClaudeMessage.tsx';
export { PersonMessage, type PersonMessageProps } from './components/PersonMessage/PersonMessage.tsx';
export { AgentMessage, type AgentMessageProps } from './components/AgentMessage/AgentMessage.tsx';
export { Whisper, type WhisperProps } from './components/Whisper/Whisper.tsx';
export { SystemLine, type SystemLineProps } from './components/SystemLine/SystemLine.tsx';
export { WritingIndicator, type WritingIndicatorProps } from './components/WritingIndicator/WritingIndicator.tsx';
export { ToolLabel, type ToolLabelProps } from './components/ToolLabel/ToolLabel.tsx';

// Margin receipts
export {
  TranscriptHeader,
  TranscriptRow,
  type TranscriptHeaderProps,
  type TranscriptRowProps,
} from './components/TranscriptRow/TranscriptRow.tsx';
export { MarginReceipt, type MarginReceiptProps } from './components/MarginReceipt/MarginReceipt.tsx';
export {
  receiptFromEvent,
  receiptTone,
  type ReceiptSource,
  type ReceiptView,
} from './components/MarginReceipt/receiptTone.ts';
export { MarginNote, type MarginNoteProps } from './components/MarginNote/MarginNote.tsx';

// Owner decisions
export { ApprovalCard, type ApprovalCardProps } from './components/ApprovalCard/ApprovalCard.tsx';
export { TakeOverBar, type TakeOverBarProps } from './components/TakeOverBar/TakeOverBar.tsx';

// Rules and connectors
export {
  OUTCOME_TONE,
  OUTCOME_WORDS,
  PRESET_WORDS,
  outcomePhrase,
  type RuleMode,
  type RulesPreset,
} from './components/OutcomeMenu/outcomeWords.ts';
export { OutcomeMenu, type OutcomeMenuProps } from './components/OutcomeMenu/OutcomeMenu.tsx';
export { RuleRow, type RuleRowProps, type RuleWord } from './components/RuleRow/RuleRow.tsx';
export { ToolRulesCard, type RulesLinkProps, type ToolRulesCardProps } from './components/ToolRulesCard/ToolRulesCard.tsx';
export { rulesForTool, type RulesTool } from './components/ToolRulesCard/toolRules.ts';
export { ConnectorIcon, type ConnectorIconName, type ConnectorIconProps } from './components/ConnectorIcon/ConnectorIcon.tsx';
export { ConnectorName, type ConnectorNameProps, type ConnectorView } from './components/ConnectorName/ConnectorName.tsx';
export {
  ConnectorSection,
  type ConnectorSectionProps,
  type ToolSummaryView,
} from './components/ConnectorSection/ConnectorSection.tsx';
export { describeEffects } from './components/ConnectorSection/describeEffects.ts';
export { ConnectorList, type ConnectorListProps } from './components/ConnectorList/ConnectorList.tsx';
export { AlwaysOnList, type AlwaysOnListProps } from './components/AlwaysOnList/AlwaysOnList.tsx';
export {
  ChangeReview,
  type ChangeReviewProps,
  type ChangeRowView,
  type ChangeSide,
} from './components/ChangeReview/ChangeReview.tsx';
export { ruleDiff, type RuleDiffRow, type RuleField } from './components/ChangeReview/ruleDiff.ts';
export { AskClaudePanel, type AskClaudePanelProps } from './components/AskClaudePanel/AskClaudePanel.tsx';

// Connector and tool pages, adding a connector, and a changed tool
export {
  ConnectorHeader,
  type ConnectorHeaderProps,
  type ConnectorStatus,
} from './components/ConnectorHeader/ConnectorHeader.tsx';
export { ConnectorPromise, type ConnectorPromiseProps } from './components/ConnectorHeader/ConnectorPromise.tsx';
export {
  ConnectionPanel,
  type ConnectionAlwaysOn,
  type ConnectionDetail,
  type ConnectionPanelProps,
  type ConnectionTurnOff,
} from './components/ConnectionPanel/ConnectionPanel.tsx';
export { ToolPageHeader, type ToolPageHeaderProps } from './components/ToolPageHeader/ToolPageHeader.tsx';
export {
  RecentRequests,
  type RecentRequestView,
  type RecentRequestsProps,
} from './components/RecentRequests/RecentRequests.tsx';
export { ConnectorPicker, type ConnectorPickerProps, type PickerItem } from './components/ConnectorPicker/ConnectorPicker.tsx';
export { ConnectorSignIn, type ConnectorSignInProps, type SignInChoice } from './components/ConnectorSignIn/ConnectorSignIn.tsx';
export {
  ConnectorReview,
  type ConnectorReviewProps,
  type ReviewCoverage,
  type ReviewToolView,
} from './components/ConnectorReview/ConnectorReview.tsx';
export {
  ConnectorOfferCard,
  type ConnectorOfferAction,
  type ConnectorOfferCardProps,
} from './components/ConnectorOfferCard/ConnectorOfferCard.tsx';
export { ToolChangedItem, type ToolChangedItemProps } from './components/ToolChangedItem/ToolChangedItem.tsx';
export { ToolReviewCard, type ToolReviewCardProps, type ToolRowView } from './components/ToolReviewCard/ToolReviewCard.tsx';

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
