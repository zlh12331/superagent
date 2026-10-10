// app.ts：app 域 IPC payload 契约单一真源（getStatus / getInfo 响应、协议唤起事件、诊断导出、开机自启读写与变更事件）
// 边界：只定义形状与值域——OS 登录项读写、诊断包组装、协议 URL 解析分别在 src/main 的
// infra/autostart/autostart.ts、diagnostics.ts、deep-link.ts，本文件不含平台分支与安全策略

import { z } from 'zod';

// ────────── 应用状态与环境信息（app:getStatus / app:getInfo）──────────

/** app:getStatus 响应 zod schema（就绪标记 + IPC 协议版本） */
export const AppStatusResSchema = z.object({
  /** 主进程就绪标记（handler 恒返回 true） */
  ready: z.boolean(),
  /** IPC 契约版本，非应用版本号；渲染层与 packages/shared/src/constants/protocol.ts 的
   * IPC_PROTOCOL_VERSION 比对，不一致（自动更新后单侧先更新）只提示重启，不阻断功能 */
  protocolVersion: z.number().int().positive(),
});

/**
 * app:getInfo 响应 zod schema——wrap 在 handler 返回后据它校验响应形状
 * （防手写 Res 接口与实现漂移）；定义表另以下方 AppInfoRes 作类型标记，两者需手工保持同构。
 *
 * 存在理由：渲染层读不到主进程的运行时版本与环境，只能经此一处取（「关于」对话框的数据源）。
 * 后三个字段是构建期信息（scripts/generate-build-info.mjs 写 resources/build-info.json）；
 * dev 直跑无该文件，主进程只回 channel='dev'——三者一律可选，消费方须各自兜底。
 */
export const AppInfoResSchema = z.object({
  /** 应用版本号（app.getVersion()，即 package.json version） */
  version: z.string(),
  /** Electron 运行时版本 */
  electron: z.string(),
  /** Node.js 运行时版本 */
  node: z.string(),
  /** Chromium 版本 */
  chrome: z.string(),
  /** 平台（process.platform：win32 / darwin / linux） */
  platform: z.string(),
  /** 架构（process.arch：x64 / arm64） */
  arch: z.string(),
  /** 用户数据目录（dev 下重定向到仓库内 .electron-user-data/） */
  userDataPath: z.string(),
  /** 发布渠道（stable / beta / dev；打包侧由构建脚本读 BUILD_CHANNEL 环境变量写入，缺省 stable） */
  channel: z.string().optional(),
  /** 构建时间（ISO 8601，构建脚本生成） */
  buildTime: z.string().optional(),
  /** 源码提交短哈希（构建脚本 git rev-parse --short；取不到时字段整体缺席而非 null） */
  commitSha: z.string().optional(),
});

/** app:getInfo 响应 payload：应用版本与环境信息（定义表的类型标记；运行时校验由上方 schema 承担） */
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
  /** 发布渠道（stable / beta / dev） */
  readonly channel?: string;
  /** 构建时间（ISO 8601） */
  readonly buildTime?: string;
  /** 源码提交短哈希 */
  readonly commitSha?: string;
}

// ────────── 协议唤起事件（app:event:deepLink）──────────

/**
 * app:event:deepLink 事件 payload（自定义协议唤起）
 *
 * 由主进程 deep-link.ts 解析 `code-agent://` URL 后广播；sessionId 取不到时为 null，
 * 表示「仅唤起/聚焦窗口」而非错误——两种情形渲染层都要消费，故不能是可选字段。
 */
export const DeepLinkPayloadSchema = z.object({
  /** 目标会话 id（路径含 `/session/<id>` 或查询串 `session=<id>` 时非空；否则 null = 仅唤起） */
  sessionId: z.string().nullable(),
  /** 原始协议 URL（保留完整参数供扩展：查询串、附加动作等） */
  url: z.string(),
});

/** app:event:deepLink 事件 payload：深度链接解析结果 */
export interface DeepLinkPayload {
  /** 目标会话 id（路径含 `/session/<id>` 或查询串 `session=<id>` 时非空；null = 仅唤起/聚焦） */
  readonly sessionId: string | null;
  /** 原始协议 URL 全量（保留扩展性） */
  readonly url: string;
}

// ────────── 诊断包导出（app:exportDiagnostics）──────────

/** app:exportDiagnostics 响应 zod schema（诊断包导出结果） */
export const ExportDiagnosticsResSchema = z.object({
  /** 是否已保存（用户取消保存对话框时 false，此时 path 一同缺席） */
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

// ────────── 开机自启读写与变更事件（get / setLoginItemSettings + event:loginItemChanged）──────────

/**
 * app:getLoginItemSettings 响应（开机自启当前状态）
 *
 * 读的是 OS 登录项（Windows HKCU Run / macOS 登录项 / Linux XDG autostart），
 * 不走 SQLite 设置——设置页开关与托盘菜单开关读写同一 OS 状态，天然同步；
 * 主进程对应的读写实现见 src/main/infra/autostart/autostart.ts。
 */
export interface LoginItemSettingsRes {
  /** 是否开机自启（写入后**回读**的 OS 真实状态，非入参回显——注册失败/审批未通过会如实反映） */
  readonly openAtLogin: boolean;
  /** 当前环境是否支持该开关（未打包时一律 false，避免污染开发机；界面据此禁用） */
  readonly supported: boolean;
  /** macOS 13+：已注册但等用户在系统设置批准（界面提示，避免误显示为已生效） */
  readonly requiresApproval: boolean;
}

/** app:getLoginItemSettings 响应 zod schema（值域与上方接口同构，勿单独改） */
export const LoginItemSettingsResSchema = z.object({
  openAtLogin: z.boolean(),
  supported: z.boolean(),
  requiresApproval: z.boolean(),
});

/** app:setLoginItemSettings 入参（只传期望态；可执行路径与 --hidden 启动参数由主进程按平台决定） */
export const SetLoginItemSettingsReqSchema = z.object({
  openAtLogin: z.boolean(),
});

/**
 * app:event:loginItemChanged 事件 payload（开机自启状态的真实回读值）
 *
 * 触发时机：**主进程主动变更**（托盘菜单勾选）之后——渲染层设置页据此刷新回显，
 * 否则托盘改动后设置页会一直显示旧值（2026-09-21 实测缺口）。
 * 渲染层自身发起的写入不回灌（其响应已是写后回读，避免回声）。
 */
export const LoginItemChangedPayloadSchema = LoginItemSettingsResSchema;

/** app:event:loginItemChanged 事件 payload 类型 */
export type LoginItemChangedPayload = LoginItemSettingsRes;
