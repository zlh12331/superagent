// src/renderer/lib/working-dir.ts
// 会话工作目录解析（纯函数，可单测）
// ──────────────────────────────────────────────────────────────
// 唯一权威来源：会话元数据的 workingDir（后端落库值）。
// 其余出现 workingDir 的地方都必须经此函数派生，不允许各组件自行读镜像：
// - fileTreeStore.rootPath 是文件树内部缓存（仅 FileTreePanel 挂载时同步），
//   终端 / Git 面板曾直接读它，导致侧栏未停留在文件视图时拿到 null
// - welcomeStore.pendingWorkingDir 是「会话创建前的草稿目录」，不是会话属性
// ──────────────────────────────────────────────────────────────

/** 解析入参 */
export interface WorkingDirSources {
  /** 调用方已持有的权威目录（如路由层从会话详情拿到的 session.workingDir） */
  readonly knownDir: string | null | undefined;
  /** 会话 id → workingDir 索引（由会话列表缓存派生） */
  readonly dirBySession: ReadonlyMap<string, string>;
  /** 目标会话 id（null / 空 = 无激活会话） */
  readonly sessionId: string | null | undefined;
}

/**
 * 解析会话工作目录
 *
 * @returns 非空目录字符串；无会话或目录未知时 null（调用方据此禁用相关能力）
 */
export function resolveWorkingDir({
  knownDir,
  dirBySession,
  sessionId,
}: WorkingDirSources): string | null {
  if (typeof knownDir === 'string' && knownDir.length > 0) return knownDir;
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
  const listed = dirBySession.get(sessionId);
  return listed !== undefined && listed.length > 0 ? listed : null;
}
