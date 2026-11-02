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
  AGENT_START_LOST_COPY,
  AGENT_START_RETRY_COPY,
  CHANGED_REFRESHED,
  CHAT_ENDED_COPY,
  DEMO_BUDGET_COPY,
  NEW_CHAT_LABEL,
  RATE_LIMITED_COPY,
  RELOAD_PAGE_LABEL,
  SETUP_START_LOST_COPY,
  SETUP_START_RETRY_COPY,
  SETUP_START_SLOW_COPY,
  SETUP_START_SPENT_COPY,
  UNREACHABLE_COPY,
  errorCopy,
  evErrorCopy,
  type CopyLanguage,
  type CopyPair,
} from './components/Notice/errorCopy.ts';
export { EmptyState, type EmptyStateProps } from './components/EmptyState/EmptyState.tsx';
export { DisclosureLine, type DisclosureLineProps } from './components/DisclosureLine/DisclosureLine.tsx';
export { LoadingLine, type LoadingLineProps } from './components/LoadingLine/LoadingLine.tsx';
export {
  Skeleton,
  SkeletonCard,
  type SkeletonCardProps,
  type SkeletonProps,
  type SkeletonText,
} from './components/Skeleton/Skeleton.tsx';
export { useControlWidth } from './components/Skeleton/useControlWidth.ts';
export { SKELETON_DELAY_MS, SkeletonScreen, type SkeletonScreenProps } from './components/Skeleton/SkeletonScreen.tsx';

// Controls
export { Switch, type SwitchProps } from './components/Switch/Switch.tsx';
export { ACTING_SWITCH_COPY } from './components/Switch/copy.ts';
export {
  SegmentedControl,
  type SegmentedControlProps,
  type SegmentedOption,
} from './components/SegmentedControl/SegmentedControl.tsx';
export { Composer, type ComposerFailed, type ComposerProps, type ComposerVariant } from './components/Composer/Composer.tsx';
export { SuggestionChips, type SuggestionChipsProps } from './components/SuggestionChips/SuggestionChips.tsx';
export { TextField, type TextFieldProps } from './components/TextField/TextField.tsx';

// Layout
export { Card, type CardProps } from './components/Card/Card.tsx';
export { SectionHeader, type SectionHeaderProps } from './components/SectionHeader/SectionHeader.tsx';
export { Mark, MarkAppIcon, Wordmark, type MarkAppIconProps, type MarkProps, type WordmarkProps } from './components/Mark/Mark.tsx';
export { MARK_GEOMETRY } from './components/Mark/markGeometry.ts';
export { AUTHOR_NAME, AUTHOR_URL, ConceptFooter, type ConceptFooterProps } from './components/ConceptFooter/ConceptFooter.tsx';
export { AppShell, type AppShellProps } from './components/AppShell/AppShell.tsx';
export {
  NAV_LABELS,
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
export {
  PUBLIC_SHELL_SCROLLER_EVENT,
  PublicShell,
  type PublicBrand,
  type PublicOpenStatus,
  type PublicShellProps,
  type PublicShellScrollerDetail,
} from './components/PublicShell/PublicShell.tsx';
export { PublicBrandHeader, type PublicBrandHeaderProps } from './components/PublicShell/PublicBrandHeader.tsx';
export { PublicShellSkeleton } from './components/PublicShell/PublicShellSkeleton.tsx';
export { PublicBrandHeaderSkeleton } from './components/PublicShell/PublicBrandHeaderSkeleton.tsx';
export { Dialog, type DialogProps } from './components/Dialog/Dialog.tsx';

// Vision pages
export { VISION_LINE, VisionBar, type VisionBarProps } from './components/VisionBar/VisionBar.tsx';
export { VISION_INERT_LINE } from './components/VisionBar/visionInert.tsx';
export {
  PhoneFrame,
  PhoneTabBar,
  type PhoneFrameProps,
  type PhoneTab,
  type PhoneTabBarProps,
} from './components/PhoneFrame/PhoneFrame.tsx';
export { AccessPanel, type AccessPanelProps } from './components/AccessPanel/AccessPanel.tsx';
// FactCard is for the vision pages' sample facts only: a conversation's facts are the kernel's ReplyCards.
export { FactCard, type FactCardProps } from './components/FactCard/FactCard.tsx';

// Settings
export { DetailList, type DetailItem, type DetailListProps } from './components/DetailList/DetailList.tsx';
export { AlertList, type AlertListItem, type AlertListProps } from './components/AlertList/AlertList.tsx';
export { ChannelList, LATER_CHANNELS, type ChannelListProps, type ChannelView } from './components/ChannelList/ChannelList.tsx';

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
export { INBOX_COPY, type InboxCopy } from './components/DemoInboxPanel/inboxCopy.ts';

// Setup
export { SituationRow, type SituationRowProps } from './components/SituationRow/SituationRow.tsx';
export { SafetyCheckRow, type SafetyCheckRowProps } from './components/SafetyCheckRow/SafetyCheckRow.tsx';
export { SetupToolsList, type SetupToolsListProps, type SetupToolsRow, type SetupJobRow } from './components/SetupToolsList/SetupToolsList.tsx';

// Agents
export { CodeBlock, type CodeBlockProps } from './components/CodeBlock/CodeBlock.tsx';
export { CopyField, type CopyFieldProps } from './components/CopyField/CopyField.tsx';
export { COPIED_FOR_MS, COPY_RESULT_COPY, copyResultLine, useCopyText, type CopyState, type CopyWhat } from './components/CopyField/useCopyText.ts';
export { CopyResult, type CopyResultProps } from './components/CopyResult/CopyResult.tsx';
export { SignedLimitPanel, type SignedLimitPanelProps } from './components/SignedLimitPanel/SignedLimitPanel.tsx';
export { SIGNED_LIMIT_COPY } from './components/SignedLimitPanel/signedLimitCopy.ts';

// Knowledge
export { KnowledgeList, type KnowledgeListProps, type KnowledgeRowView } from './components/KnowledgeList/KnowledgeList.tsx';
export { KnowledgeAdd, type KnowledgeAddProps, type KnowledgeAddedView } from './components/KnowledgeAdd/KnowledgeAdd.tsx';

// Share
export { SHARE_CARD_QR_COLORS, ShareCard, type ShareCardProps } from './components/ShareCard/ShareCard.tsx';
export { CopyList, type CopyListItem, type CopyListProps } from './components/CopyList/CopyList.tsx';

// Payments
export { MockCheckout, type MockCheckoutProps } from './components/MockCheckout/MockCheckout.tsx';

// Reply cards
export { ReplyCard, type ReplyCardProps } from './components/ReplyCard/ReplyCard.tsx';
export { cardView, type CardView } from './components/ReplyCard/cardView.ts';
export { CARD_CHROME, cardChrome, MONEY_TEMPLATES, type CardChrome } from './components/ReplyCard/chrome.ts';

// Conversation
export { Transcript, type TranscriptProps } from './components/Transcript/Transcript.tsx';
export { VisitorMessage, type VisitorMessageProps } from './components/VisitorMessage/VisitorMessage.tsx';
export { ClaudeMessage, PROSE_LINKS, type ClaudeMessageProps } from './components/ClaudeMessage/ClaudeMessage.tsx';
export { ChatMarkdown, type ChatMarkdownProps } from './components/ChatMarkdown/ChatMarkdown.tsx';
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
export { RulesReceipt, type RulesReceiptProps } from './components/MarginReceipt/RulesReceipt.tsx';
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

// Rules and connectors
export {
  OUTCOME_GROUP_WORDS,
  OUTCOME_TONE,
  OUTCOME_WORDS,
  PRESET_WORDS,
  outcomePhrase,
  type RuleMode,
  type RulesPreset,
} from './components/OutcomeMenu/outcomeWords.ts';
export { OutcomeMenu, type OutcomeMenuProps } from './components/OutcomeMenu/OutcomeMenu.tsx';
export { OutcomeGroups, type OutcomeGroupRow, type OutcomeGroupsProps } from './components/OutcomeGroups/OutcomeGroups.tsx';
export { RuleRow, ruleWordsLine, type RuleRowProps, type RuleWord } from './components/RuleRow/RuleRow.tsx';
export { ToolTitleList, type ToolTitles } from './components/RuleRow/ToolTitles.tsx';
export { RuleSentence, type RuleMeta, type RuleSentenceProps, type SentencePart } from './components/RuleSentence/RuleSentence.tsx';
export { EffectTags, effectTags, type EffectTagsProps } from './components/EffectTags/EffectTags.tsx';
export { PersonRules, type PersonRuleView, type PersonRulesProps } from './components/PersonRules/PersonRules.tsx';
export { ToolRulesCard, type RulesLinkProps, type ToolRulesCardProps } from './components/ToolRulesCard/ToolRulesCard.tsx';
export { rulesForTool, type RulesTool } from './components/ToolRulesCard/toolRules.ts';
export { ConnectorIcon, type ConnectorIconName, type ConnectorIconProps } from './components/ConnectorIcon/ConnectorIcon.tsx';
export { ConnectorName, type ConnectorNameProps, type ConnectorView } from './components/ConnectorName/ConnectorName.tsx';
export { ConnectorSummary, type ConnectorSummaryProps } from './components/ConnectorName/ConnectorSummary.tsx';
export {
  ConnectorSection,
  type ConnectorSectionProps,
  type ToolSummaryView,
} from './components/ConnectorSection/ConnectorSection.tsx';
export { describeEffects } from './components/ConnectorSection/describeEffects.ts';
export { ConnectorList, type ConnectorListProps } from './components/ConnectorList/ConnectorList.tsx';
export {
  ConnectorDirectory,
  type ConnectorDirectoryProps,
  type DirectoryRowView,
} from './components/ConnectorDirectory/ConnectorDirectory.tsx';
export { ALWAYS_ON, AlwaysOnList, type AlwaysOnListProps } from './components/AlwaysOnList/AlwaysOnList.tsx';
export {
  ChangeReview,
  type ChangeReviewProps,
  type ChangeRowView,
  type ChangeSide,
  type RuleTarget,
} from './components/ChangeReview/ChangeReview.tsx';
export { ruleDiff, type RuleDiffRow, type RuleField } from './components/ChangeReview/ruleDiff.ts';
export { reviewChanges, type ReviewChange } from './components/ChangeReview/reviewChanges.ts';
export { AskClaudePanel, useAskClaudeIsSheet, type AskClaudePanelProps } from './components/AskClaudePanel/AskClaudePanel.tsx';
export { clickedControl } from './components/AskClaudePanel/clickedControl.ts';

// The preset menu and the payment limit
export { MoneyLimit, type MoneyLimitProps } from './components/MoneyLimit/MoneyLimit.tsx';
export { LimitChange, type LimitChangeProps } from './components/LimitChange/LimitChange.tsx';
export { PresetMenu, type PresetMenuProps } from './components/PresetMenu/PresetMenu.tsx';

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
export { chainLine, entriesLabel } from './components/ChainStatus/chainLine.ts';
export { AttemptRow, type AttemptRowProps } from './components/AttemptRow/AttemptRow.tsx';
export {
  CheckpointMeter,
  type Checkpoint,
  type CheckpointMeterProps,
} from './components/AttemptRow/CheckpointMeter.tsx';

// Icons
export { Icon, ICON_NAMES, type IconName, type IconProps, type IconSize } from './icons/index.tsx';

export { SidebarSkeleton } from './components/Sidebar/SidebarSkeleton.tsx';
export { ReviewerBarSkeleton } from './components/ReviewerBar/ReviewerBarSkeleton.tsx';
export { PageHeaderSkeleton, type PageHeaderSkeletonProps } from './components/PageHeader/PageHeaderSkeleton.tsx';
