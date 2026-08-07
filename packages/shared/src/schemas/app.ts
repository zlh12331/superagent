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
