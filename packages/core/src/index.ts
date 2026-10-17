// SPDX-License-Identifier: Apache-2.0
export {
  canTransition,
  RUN_TRIGGERS,
  transition,
  type RunTrigger,
  type TransitionResult,
} from "./state-machine.js";
export {
  CorruptLogError,
  foldRunState,
  type ApprovalRequestedEvent,
  type RunState,
  type ToolIntentEvent,
} from "./run-state.js";
export {
  BudgetTracker,
  type BudgetCheck,
  type BudgetKind,
  type BudgetViolation,
} from "./budgets.js";
export {
  LeaseLostError,
  RunRecorder,
  SpanContextMissingError,
  type Clock,
  type EventPartial,
  type StepSpanOptions,
} from "./recorder.js";
export { cancelRun, type CancelRunResult } from "./cancel.js";
export { Checkpointer, NoActiveSpanError, type CheckpointerOptions } from "./checkpoint.js";
export {
  ApprovalAlreadyResolvedError,
  ApprovalEditsRequiredError,
  ApprovalNotFoundError,
  ApprovalRequestStateError,
  ApprovalResolutionConflictError,
  ApprovalRunNotSuspendedError,
  applyResolvedApprovals,
  requestApproval,
  resolveApproval,
  type ApprovalDecision,
  type ApprovalResolutionMetadata,
  type ApprovalSuspensionResult,
  type RequestApprovalOptions,
} from "./approvals.js";
export {
  APPROVAL_WAIT_SPAN,
  APP_CONTENT_SPAN,
  CHECKPOINT_SPAN,
  COMPACTION_SPAN,
  MODEL_CALL_SPAN,
  RUN_SPAN,
  TOOL_CALL_SPAN,
} from "./spans.js";
export { runLoop, type RunLoopOptions, type RunLoopResult } from "./loop.js";
export {
  ContinuationChainTooLongError,
  RunNotTerminalError,
  continueRun,
  loadContinuationChain,
  type ContinueRunOptions,
} from "./continue.js";
export {
  installShutdownHandler,
  type ShutdownHandlerOptions,
  type ShutdownProcessLike,
} from "./shutdown.js";
export {
  ResumeConflictError,
  RunAwaitingApprovalError,
  RunAlreadyTerminalError,
  RunNotResumableError,
  resumeRun,
  type ResumeRunOptions,
} from "./resume.js";
export { modelStep, type ModelStepOptions, type ModelStepResult } from "./steps/model-step.js";
export {
  compactionStep,
  ModelPortSummarizer,
  SummarizerResponseError,
  type CompactionStepOptions,
  type CompactionRuntimeOptions,
} from "./steps/compaction-step.js";
export { toolStep, type ResumeToolStepOptions, type ToolStepOptions } from "./steps/tool-step.js";
export {
  applyDanglingIntents,
  resolveDanglingIntentApproval,
  ResumeActionMismatchError,
} from "./steps/resume-tool-step.js";
export {
  planDanglingIntents,
  type DanglingIntentAction,
  type ResumePolicy,
} from "./resume-policy.js";
export type {
  ContextBuildMetadata,
  ContextBuildResult,
  ContextPort,
  IdGenerator,
  ModelCompletion,
  ModelPort,
  ModelRequest,
  ModelToolCall,
  ModelUsage,
  NewRunMetadata,
  PolicyContext,
  PolicyDecision,
  PolicyPort,
  RunContext,
  Summarizer,
  ToolDescription,
  ToolExecutionResult,
  ToolPort,
} from "./ports.js";
export { StrategyContextPort, type StrategyContextPortOptions } from "./context/context-port.js";
export { NaiveContext } from "./context/naive-context.js";
export {
  createRuntime,
  type Runtime,
  type RuntimeConfig,
  type RuntimeOverrides,
  type RuntimeResumeOptions,
} from "./runtime.js";
export {
  BUILTIN_ROLE_DEFAULTS,
  RoleRegistry,
  RoleRegistryError,
  resolveRole,
  type ResolvedRole,
  type RoleRegistryOptions,
  type RoleRegistryWarning,
  type RoleSchemaLoader,
} from "./roles.js";
export {
  DEFAULT_DOCTOR_TIMEOUT_MS,
  doctorChecks,
  registerDoctorCheck,
  runDoctor,
  type DoctorCheck,
  type DoctorContext,
} from "./doctor.js";
export { resolveDataDir } from "./runtime-data-dir.js";
export {
  migrateConfiguredStore,
  openConfiguredKeyRotation,
  openConfiguredVaultAdmin,
  openConfiguredStore,
  type ConfiguredKeyRotation,
  type ConfiguredKeyRotationOptions,
  type ConfiguredVaultAdmin,
  type ConfiguredVaultOptions,
  type ConfiguredStoreOptions,
} from "./runtime-store.js";
export { RunScopeConflictError, RunScopeRegistry } from "./subagent/scope.js";
export { ChildBudgetExceededError, deriveChildBudgets } from "./subagent/budgets.js";
export { finalizeChild, SubagentResultSchema, type SubagentResult } from "./subagent/result.js";
export { AgentSpawnInputSchema, AgentSpawnTool } from "./subagent/spawn-tool.js";
export {
  restrictToolPort,
  SubagentError,
  SubagentSupervisor,
  type SubagentErrorCode,
  type SubagentRunRequest,
  type SubagentRunner,
  type SubagentSpawnInput,
  type SubagentSupervisorOptions,
} from "./subagent/supervisor.js";
