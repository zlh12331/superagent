import type {
  AgentApprovalRequestPayload,
  ApprovalMode,
  WhitelistEntry,
} from '@code-agent/shared/main';
import type { WebContents } from 'electron';

import type { Tool } from './tool';

export interface PermissionDecision {
  readonly permission: 'auto' | 'ask' | 'deny';
  readonly description: string;
}

export type ApprovalDecisionOutcome = 'approved' | 'denied' | 'timed-out' | 'aborted';

export interface ApprovalLifecycleListener {
  onRequested(payload: {
    readonly sessionId: string;
    readonly approvalId: string;
    readonly toolName: string;
  }): void;
  onResolved(payload: {
    readonly sessionId: string;
    readonly approvalId: string;
    readonly decision: ApprovalDecisionOutcome;
  }): void;
}

export interface IPermissionService {
  decide(
    tool: Tool,
    input: unknown,
    userPrompt?: string,
    options?: { readonly pathBoundary?: string },
  ): Promise<PermissionDecision>;

  requestApproval(
    payload: AgentApprovalRequestPayload,
    tool: Tool,
    input: unknown,
    webContents?: WebContents,
    abortSignal?: AbortSignal,
  ): Promise<boolean>;

  handleApprovalResponse(approvalId: string, approved: boolean, rememberDecision: boolean): void;

  expireApproval(approvalId: string): void;

  dispose(): void;

  setApprovalMode(mode: ApprovalMode): void;

  getApprovalMode(): ApprovalMode;

  recordUserDenial(): void;

  onApprovalLifecycle(listener: ApprovalLifecycleListener): () => void;

  recordUserAllowance(): void;

  listWhitelist(): readonly WhitelistEntry[];

  addWhitelistEntry(entry: WhitelistEntry): Promise<void>;

  removeWhitelistEntry(entry: WhitelistEntry): Promise<void>;
}
