// sidebar-utils.ts（自 Sidebar 拆分）
// 侧边栏纯函数与数据类型
// ──────────────────────────────
// 拆分背景：Sidebar 641 行，纯函数与组件混合，按职责提取。
// 2026-09-12 二次提取：搜索过滤 / 文件夹分组 / 列表扁平化（置顶 + 覆盖排序 +
// 折叠语义）从组件迁入——这些是 Sidebar 变更最频繁、最易回归的逻辑，
// 提取为纯函数后可无 React 环境单测（此前 0 测试）。
// ──────────────────────────────

/** 侧边栏条目所需的会话字段子集（结构化兼容 SessionMeta 等更富类型） */
export interface SidebarSession {
  readonly id: string;
  readonly title: string;
  readonly lastMessage: string | undefined;
  readonly updatedAt: number;
  readonly workingDir: string;
  readonly pinned: boolean;
}

/** 虚拟化列表条目：文件夹标签 | 会话项 */
export type SidebarEntry =
  | { readonly type: 'label'; readonly name: string }
  | { readonly type: 'item'; readonly session: SidebarSession };

export function getFolderName(workingDir: string): string {
  const basename = workingDir.split(/[\\/]/).pop();
  return basename && basename.length > 0 ? basename : '';
}

/**
 * 搜索过滤：标题或工作目录匹配（大小写不敏感）。
 *
 * 即时生效（无防抖——防抖只作用于高亮计算）；关键词为空白时原样返回。
 *
 * @param sessions 全量会话
 * @param keyword 用户输入（未 trim/未小写化，函数内部处理）
 */
export function filterSessions<T extends { title: string; workingDir: string }>(
  sessions: readonly T[],
  keyword: string,
): T[] {
  const q = keyword.trim().toLowerCase();
  if (q.length === 0) return [...sessions];
  return sessions.filter(
    (s) => s.title.toLowerCase().includes(q) || s.workingDir.toLowerCase().includes(q),
  );
}

/**
 * 按 workingDir 的 basename 分组（保持输入顺序；同文件夹的会话依次追加）。
 *
 * 空文件夹名（workingDir 为空或仅分隔符）会归入 '' 键——调用方语义上视作
 * 「未分组」，本函数不做特殊处理。
 */
export function groupSessionsByFolder<T extends { workingDir: string }>(
  sessions: readonly T[],
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const session of sessions) {
    const folderName = getFolderName(session.workingDir);
    const existing = grouped.get(folderName) ?? [];
    grouped.set(folderName, [...existing, session]);
  }
  return grouped;
}

/**
 * 列表扁平化：置顶会话置顶 + 文件夹标签 + 覆盖排序 + 折叠语义。
 *
 * 规则（与提取前 Sidebar 内联实现逐条对应，含一处 bug 修正）：
 * - 置顶会话直接排列表最前（无独立分组标签），内部按 updatedAt 倒序
 *   （后置顶的排更前，对齐主进程 pin 刷新 updatedAt 的排序）
 * - 每个文件夹先推 label，再推其成员
 * - 搜索时忽略折叠态（匹配组自动展开）；非搜索时折叠文件夹只推 label 不推成员
 * - 文件夹段跳过置顶会话（已提前到最前，避免重复出现）
 * - 覆盖序中的陈旧 id（会话已删除）安全跳过
 * - **覆盖序不排他**：覆盖后新建的会话按默认序追加在末尾。原实现用
 *   `override ?? default` 整体替换——拖拽一次后，新落到该文件夹的会话 id
 *   不在覆盖里就永远不渲染（再次拖拽也无法修复，current 读的就是旧覆盖），
 *   用户表现为「新建的会话在侧栏消失」
 *
 * @returns entries（渲染列表）与 sortableIds（dnd-kit SortableContext 所需的
 *          可见会话 id，按展示顺序；折叠文件夹的成员不在其中）
 */
/**
 * 单个文件夹段的最终会话顺序
 *
 * 规则（对齐原内联实现，语义见测试）：
 * - 有拖拽覆盖序：按覆盖序排列，再**追加**覆盖后新建的会话（覆盖序不排他，
 *   否则新会话在该文件夹永久不可见）
 * - 无覆盖：保持服务端默认序
 * - 置顶会话一律排除（已提前到列表最前，不重复出现在文件夹段）
 *
 * @param folderSessions 该文件夹的会话（服务端序）
 * @param orderOverrides 拖拽覆盖序（folderName → id 列表）
 * @param folderName 当前文件夹名（查覆盖序的键）
 */
function resolveFolderOrder(
  folderSessions: readonly SidebarSession[],
  orderOverrides: Readonly<Record<string, readonly string[]>>,
  folderName: string,
): SidebarSession[] {
  const isNonPinned = (s: SidebarSession): boolean => s.pinned !== true;
  const ordered = orderOverrides[folderName];
  if (ordered === undefined) {
    return folderSessions.filter(isNonPinned);
  }
  const byId = new Map(folderSessions.map((s) => [s.id, s]));
  const orderedIds = new Set(ordered);
  const result: SidebarSession[] = [];
  for (const id of ordered) {
    const session = byId.get(id);
    if (session !== undefined && isNonPinned(session)) {
      result.push(session);
    }
  }
  for (const session of folderSessions) {
    if (!orderedIds.has(session.id) && isNonPinned(session)) {
      result.push(session);
    }
  }
  return result;
}

/**
 * 构建侧边栏虚拟化列表条目
 *
 * 段顺序：置顶会话（updatedAt 倒序）→ 各文件夹（label + 会话）。
 * 折叠语义：搜索时忽略折叠态（自动展开匹配组）。
 *
 * @returns entries（渲染列表）与 sortableIds（dnd-kit SortableContext 所需的
 *          可见会话 id，按展示顺序；折叠文件夹的成员不在其中）
 */
export function buildSidebarEntries(args: {
  /** 全量会话（置顶段的数据源——刻意不过滤，保持与原实现一致） */
  readonly sessions: readonly SidebarSession[];
  /** 按文件夹分组后的会话（通常来自 filterSessions + groupSessionsByFolder） */
  readonly groupedSessions: ReadonlyMap<string, readonly SidebarSession[]>;
  readonly collapsedFolders: readonly string[];
  readonly isSearching: boolean;
  readonly orderOverrides: Readonly<Record<string, readonly string[]>>;
}): { entries: SidebarEntry[]; sortableIds: string[] } {
  const { sessions, groupedSessions, collapsedFolders, isSearching, orderOverrides } = args;

  const entries: SidebarEntry[] = [];
  // 置顶会话直接排列表最前（用户选择：ChatGPT 式，无独立分组标签；带图钉图标标识）
  // 置顶内部按 updatedAt 倒序：后置顶的排更前（pin 操作会刷新 updatedAt，对齐主进程排序）
  const pinnedSessions = sessions
    .filter((s) => s.pinned === true)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  for (const session of pinnedSessions) {
    entries.push({ type: 'item', session });
  }
  for (const [folderName, folderSessions] of groupedSessions) {
    entries.push({ type: 'label', name: folderName });
    // 搜索时忽略折叠态（自动展开匹配组，对齐参考项目 clearCollapsedFolders 语义）
    if (collapsedFolders.includes(folderName) && !isSearching) {
      continue;
    }
    for (const session of resolveFolderOrder(folderSessions, orderOverrides, folderName)) {
      entries.push({ type: 'item', session });
    }
  }

  // dnd-kit SortableContext 所需的可见会话 id（仅未折叠文件夹）
  const sortableIds = entries
    .filter((entry): entry is Extract<SidebarEntry, { type: 'item' }> => entry.type === 'item')
    .map((entry) => entry.session.id);
  return { entries, sortableIds };
}
