// packages/shared/src/schemas/app.ts
// 应用域响应 payload（app:getInfo）
// ──────────────────────────────────────────────────────────────
// 提供「关于」对话框所需的版本与环境信息（渲染层无法直接读取主进程版本）
// ──────────────────────────────────────────────────────────────

import { z } from 'zod';

/** app:getStatus 响应 zod schema（就绪标记 + IPC 协议版本） */
export const AppStatusResSchema = z.object({
  ready: z.boolean(),
  protocolVersion: z.number().int().positive(),
});

/** app:getInfo 响应 zod schema（响应契约校验用） */
export const AppInfoResSchema = z.object({
  /** 应用版本号（package.json version） */
  version: z.string(),
  /** Electron 运行时版本 */
  electron: z.string(),
  /** Node.js 运行时版本 */
  node: z.string(),
  /** Chromium 版本 */
  chrome: z.string(),
  /** 平台（win32 / darwin / linux） */
  platform: z.string(),
  /** 架构（x64 / arm64） */
  arch: z.string(),
  /** 用户数据目录 */
  userDataPath: z.string(),
});

/** app:getInfo 响应 payload：应用版本与环境信息 */
export interface AppInfoRes {
  /** 应用版本号（package.json version） */
  readonly version: string;
  /** Electron 运行时版本 */
  readonly electron: string;
  /** Node.js 运行时版本 */
  readonly node: string;
  /** Chromium 版本 */
  readonly chrome: string;
  /** 平台（win32 / darwin / linux） */
  readonly platform: string;
  /** 架构（x64 / arm64） */
  readonly arch: string;
  /** 用户数据目录 */
  readonly userDataPath: string;
}

/** app:event:deep-link 事件 payload（自定义协议唤起） */
export const DeepLinkPayloadSchema = z.object({
  /** 目标会话 id（`code-agent://session/<id>` 时非空；否则为 null 表示仅唤起） */
  sessionId: z.string().nullable(),
  /** 原始协议 URL（保留完整参数供扩展：查询串、附加动作等） */
  url: z.string(),
});

/** app:event:deep-link 事件 payload：深度链接解析结果 */
export interface DeepLinkPayload {
  /** 目标会话 id（`code-agent://session/<id>` 时非空；null = 仅唤起/聚焦） */
  readonly sessionId: string | null;
  /** 原始协议 URL 全量（保留扩展性） */
  readonly url: string;
}

/** app:exportDiagnostics 响应 zod schema（诊断包导出结果） */
export const ExportDiagnosticsResSchema = z.object({
  /** 是否已保存（用户取消时 false） */
  saved: z.boolean(),
  /** 诊断包保存路径（saved=true 时提供） */
  path: z.string().optional(),
});

/** app:exportDiagnostics 响应 payload */
export interface ExportDiagnosticsRes {
  /** 是否已保存（用户取消时 false） */
  readonly saved: boolean;
  /** 诊断包保存路径（saved=true 时提供） */
  readonly path?: string;
}
