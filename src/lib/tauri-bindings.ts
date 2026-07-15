/**
 * 按项目约定重新导出生成的 Tauri 绑定。
 *
 * 该文件提供对所有 Tauri 命令的类型安全访问。
 * 类型由 tauri-specta 从 Rust 侧自动生成。
 *
 * @example
 * ```typescript
 * import { commands } from '@/lib/tauri-bindings'
 *
 * // 在事件处理器中 — 显式处理错误
 * const result = await commands.savePreferences(prefs)
 * if (result.status === 'error') {
 *   toast.error(result.error.message)
 * }
 * ```
 *
 * @see docs/developer/tauri-commands.en.md 完整文档
 */

export { commands } from './bindings'
export type {
  AppError,
  AppPreferences,
  CrashReportData,
  RecoveryError,
  TrayIconState,
  TrayPosition,
  // === Codex thread 域 DTO 类型（36 个，对齐协议层全量命令） ===
  ThreadStartArgs,
  ThreadListArgs,
  ThreadReadArgs,
  ThreadUnsubscribeArgs,
  // 生命周期
  ThreadResumeArgs,
  ThreadForkArgs,
  ThreadArchiveArgs,
  ThreadUnarchiveArgs,
  ThreadDeleteArgs,
  ThreadRollbackArgs,
  ThreadSetNameArgs,
  // 元数据 + Goal
  ThreadMetadataUpdateArgs,
  ThreadGoalSetArgs,
  ThreadGoalGetArgs,
  ThreadGoalClearArgs,
  // 列表查询
  ThreadLoadedListArgs,
  ThreadSearchArgs,
  ThreadTurnsListArgs,
  ThreadItemsListArgs,
  ThreadInjectItemsArgs,
  // 操作
  ThreadCompactStartArgs,
  ThreadShellCommandArgs,
  ThreadApproveGuardianDeniedActionArgs,
  // 实验性功能
  ThreadIncrementElicitationArgs,
  ThreadDecrementElicitationArgs,
  ThreadSettingsUpdateArgs,
  ThreadMemoryModeSetArgs,
  // 后台终端
  ThreadBackgroundTerminalsCleanArgs,
  ThreadBackgroundTerminalsListArgs,
  ThreadBackgroundTerminalsTerminateArgs,
  // 实时语音对话
  ThreadRealtimeStartArgs,
  ThreadRealtimeAppendAudioArgs,
  ThreadRealtimeAppendTextArgs,
  ThreadRealtimeAppendSpeechArgs,
  ThreadRealtimeStopArgs,
  ThreadRealtimeListVoicesArgs,
  // === Codex turn 域 DTO 类型 ===
  TurnStartArgs,
  TurnSteerArgs,
  TurnInterruptArgs,
  // === Codex fs 域 DTO 类型 ===
  FsReadFileArgs,
  FsWriteFileArgs,
  FsCreateDirectoryArgs,
  FsGetMetadataArgs,
  FsReadDirectoryArgs,
  FsRemoveArgs,
  FsCopyArgs,
  FsWatchArgs,
  FsUnwatchArgs,
  // === Codex mcp 域 DTO 类型 ===
  McpServerOauthLoginArgs,
  McpServerStatusListArgs,
  McpResourceReadArgs,
  McpServerToolCallArgs,
  McpServerRefreshArgs,
  // === Codex config 域 DTO 类型 ===
  ConfigReadArgs,
  ConfigValueWriteArgs,
  ConfigBatchWriteArgs,
  // === Codex account 域 DTO 类型 ===
  LoginAccountArgs,
  CancelLoginAccountArgs,
  LogoutAccountArgs,
  GetAccountArgs,
  // === Codex command_exec 域 DTO 类型 ===
  CommandExecArgs,
  CommandExecWriteArgs,
  CommandExecTerminateArgs,
  CommandExecResizeArgs,
  // === Codex plugin 域 DTO 类型 ===
  PluginListArgs,
  PluginInstallArgs,
  PluginUninstallArgs,
  PluginReadArgs,
  // === Codex process 域 DTO 类型 ===
  ProcessSpawnArgs,
  ProcessWriteStdinArgs,
  ProcessKillArgs,
  ProcessResizePtyArgs,
} from './bindings'
