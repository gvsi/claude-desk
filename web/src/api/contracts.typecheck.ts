// Compile-time checks on contracts.ts, run by `npm run typecheck`: it fails when a contract type
// the design system or the web app relies on is missing, or when a dictionary is generated as a
// closed object. Nothing imports this file at runtime.

import type * as C from './contracts';
import type { CLAUSE_TEMPLATES, DECISION_STATES, EV_ERROR_CODES, KERNEL_ERROR_CODES } from './contracts';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

/** One closed interface per `$defs` entry of contracts.schema.json, named by its key. */
export type Models = [
  C.A2ARequest, C.A2AResponse, C.AgentAuth, C.AnswerRequest, C.Approval, C.ApprovalResult,
  C.BusinessSeed, C.CalendarSlot, C.CancelRequest, C.CardOption, C.CheckReplyRequest, C.Claim,
  C.Clause, C.ContextClock, C.CopyCreated, C.CreateCopyRequest, C.CreateDeskRequest, C.CreateSessionRequest,
  C.DecideRequest, C.Decision, C.DemoAgentIssued, C.DemoAgentRequest, C.DemoInboxEntry,
  C.DeskAnsweringRequest, C.DeskBusinessRequest, C.DeskCalendarRequest, C.DeskCharterRequest,
  C.DeskCreated, C.DeskHoursRequest, C.DeskNotificationsRequest, C.DeskPeopleRequest,
  C.DeskPricesRequest, C.DeskSeed, C.DeskUpdated, C.DocumentCreated, C.DocumentUploadRequest,
  C.EvDemoInbox, C.EvError, C.EvHeld, C.EvMessage, C.EvOwnerJoined, C.EvOwnerLeft, C.EvOwnerTyping,
  C.EvReceipt, C.EvResolved, C.EvTurnEnd, C.EvWriting, C.ExecResult, C.ExecuteRequest, C.Fact, C.Health,
  C.HoursWindow, C.InboxNotice, C.KernelError, C.KnowledgeItem, C.KnowledgeRequest, C.Label,
  C.LedgerAppendRequest, C.LedgerEntry, C.LedgerEvent, C.LedgerPage, C.Mandate, C.ModeRequest,
  C.NormalizedAction, C.NotificationDefaults, C.OwnerMessageRequest, C.OwnerMessageResult,
  C.PaymentLinkActionRequest, C.PaymentLinkStateResult, C.PaymentLinkView, C.PersonUpsert,
  C.PolicyConfirmRequest, C.PolicyDraftRequest, C.PolicyProbeRequest, C.PolicyVersion, C.PriceItem,
  C.Probe, C.ProbeResult, C.ProofCheck, C.ProofReport, C.PublicDesk, C.RenderedBlock, C.ReplayedEvent,
  C.ReplyDraft, C.ReplyVerdict, C.ResourceRef, C.Review, C.ReviewThresholds, C.RuleCard, C.SeedDocument,
  C.SeedPerson, C.SessionContext, C.SessionCreated, C.SessionState, C.SseEvent, C.ToolCall,
  C.ToolConfirmed, C.ToolProfile, C.ToolsConfirmRequest, C.ToolsConnectRequest,
  C.ToolsSimulateChangeRequest, C.TurnRequest, C.TurnStarted, C.VerifyCheckRequest, C.VerifyStartRequest,
  C.VerifyStarted,
  C.Violation, C.WhoAmI,
];

/** The names contracts.ts gives the unions the schema writes inline. */
export type Aliases = [
  C.ActorKind, C.ToolName, C.ClauseTemplate, C.ApprovalAnswer, C.DecisionState, C.Outcome,
  C.Effect, C.ToolStatus, C.Assurance, C.SessionMode, C.InboxKind, C.PaymentLinkState,
  C.KernelErrorCode, C.EvErrorCode, C.CardBlock, C.StatusEvent,
];

export type Checks = [
  Assert<Equal<C.ReplayedEvent['author'], 'claude' | 'desk' | undefined>>,
  // A Desk's brand is a dictionary of colors: a closed object would reject this read.
  Assert<Equal<C.PublicDesk['brand']['primary'], string>>,
  // The SSE union has its eleven members, discriminated by `type`.
  Assert<
    Equal<
      C.SseEvent['type'],
      | 'writing' | 'message' | 'turn_end' | 'receipt' | 'held' | 'resolved'
      | 'owner_joined' | 'owner_typing' | 'owner_left' | 'demo_inbox' | 'error'
    >
  >,
  Assert<Equal<Extract<C.SseEvent, C.StatusEvent>, C.StatusEvent>>,
  // The exhaustive lists hold their union's members.
  Assert<Equal<(typeof CLAUSE_TEMPLATES)[number], C.ClauseTemplate>>,
  Assert<Equal<(typeof DECISION_STATES)[number], C.DecisionState>>,
  Assert<Equal<(typeof KERNEL_ERROR_CODES)[number], C.KernelErrorCode>>,
  Assert<Equal<(typeof EV_ERROR_CODES)[number], C.EvErrorCode>>,
];
