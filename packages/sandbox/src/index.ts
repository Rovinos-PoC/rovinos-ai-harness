// SPDX-License-Identifier: Apache-2.0
export { createSandboxBackend } from "./factory.js";
export type { SandboxBackendDependencies } from "./factory.js";
export {
  createFsTools,
  FsEditInputSchema,
  FsListEntrySchema,
  FsListInputSchema,
  FsOperationErrorCodeSchema,
  FsOperationRequestSchema,
  FsOperationSchema,
  FsReadInputSchema,
  FsSearchInputSchema,
  FsToolResultSchema,
  FsTools,
  FsWriteInputSchema,
  MAX_FS_READ_BYTES,
  MAX_FS_TOOL_TIMEOUT_MS,
  MAX_FS_WRITE_BYTES,
} from "./fs-tools.js";
export type {
  FsEditInput,
  FsListEntry,
  FsListInput,
  FsOperation,
  FsOperationErrorCode,
  FsOperationRequest,
  FsReadInput,
  FsSearchInput,
  FsToolResult,
  FsWriteInput,
  WorkspaceFileToolBackend,
} from "./fs-tools.js";
export { SandboxExecTool, ExecToolInputSchema } from "./exec-tool.js";
export type { SandboxExecToolOptions } from "./exec-tool.js";
export { createWebFetchTool, WebFetchTool } from "./web-fetch-tool.js";
export type { WebFetchBackend, WebFetchToolOptions } from "./web-fetch-tool.js";
export {
  MAX_WEB_FETCH_BYTES,
  MAX_WEB_FETCH_REDIRECTS,
  MAX_WEB_FETCH_TIMEOUT_MS,
  WebFetchRequestSchema,
  WebFetchResultSchema,
} from "./web-fetch-contracts.js";
export type { WebFetchRequest, WebFetchResult } from "./web-fetch-contracts.js";
export {
  InProcessBackend,
  InProcessBackendError,
  resolveWorkspacePath,
  SandboxWorkspacePathError,
} from "./inprocess.js";
export type { InProcessBackendOptions, InProcessLogger } from "./inprocess.js";
export {
  activateRunWorkspace,
  clearRunScratch,
  ensureRunWorkspace,
  FsWorkspace,
  lockRunWorkspace,
  WorkspaceQuotaExceededError,
} from "./workspace.js";
export {
  SnapshotTooLargeError,
  UnsafeWorkspaceSnapshotError,
  WorkspaceSnapshotError,
  WorkspaceSnapshotter,
  purgeWorkspaceSnapshots,
} from "./snapshot.js";
export type {
  RemoteWorkspaceSnapshotPort,
  WorkspaceSnapshotterOptions,
  WorkspaceSnapshotPort,
} from "./snapshot.js";
export { RemoteSandboxBackend, RemoteSandboxError } from "./remote.js";
export type { RemoteSandboxBackendOptions } from "./remote.js";
export { WorkspaceFileError, WorkspaceFileSystem } from "./workspace-files.js";
export { openUrlInBrowser } from "./open-browser.js";
export {
  ExecLimitsSchema,
  ExecResultSchema,
  ExecSpecSchema,
  ExecTimeoutMsSchema,
  MAX_EXEC_TIMEOUT_MS,
  SANDBOX_ENV_FORBIDDEN_CODE,
} from "./types.js";
export type { Clock, ExecLimits, ExecResult, ExecSpec, SandboxBackend } from "./types.js";
