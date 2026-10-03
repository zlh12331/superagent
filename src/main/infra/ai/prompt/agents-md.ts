// src/main/infra/ai/prompt/agents-md.ts
// AGENTS.md 分层发现：从工作目录向上查找 AGENTS.md 文件
// ──────────────────────────────────────────────────────────────
// 设计参考 codex-rs 的 agents_md.rs：
// - 从 cwd 向上逐级目录查找 AGENTS.md
// - 收集路径上所有 AGENTS.md 内容并拼接
// - 字节预算控制（避免上下文爆炸）
//
// 与 codex 的区别：
// - codex 用 Rust 实现，这里用 Node.js fs API
// - codex 向上查找直到文件系统根目录，这里同样
// - codex 有字节预算（默认 8192），这里同样限制
// ──────────────────────────────────────────────────────────────

import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * AGENTS.md 文件名
 *
 * codex 同名 AGENTS.md 约定（Cursor 的 .cursorrules 是同类机制的对应物）。
 * 支持大写（AGENTS.md）和小写（agents.md）两种形式，优先匹配大写。
 */
const AGENTS_MD_FILENAME = 'AGENTS.md';
const AGENTS_MD_FILENAME_LOWER = 'agents.md';

/**
 * 字节预算（8KB）
 *
 * 参考 codex 的 DEFAULT_BYTE_BUDGET = 8192。
 * 多个 AGENTS.md 拼接后总长度不超过此值，避免占用过多上下文窗口。
 */
const BYTE_BUDGET = 8192;

/**
 * 查找结果
 */
export interface FoundAgentsMd {
  /** 文件绝对路径 */
  readonly path: string;
  /** 文件内容 */
  readonly content: string;
}

/**
 * 检查文件是否存在
 */
function fileExists(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * 在指定目录查找 AGENTS.md 文件（大小写不敏感）
 *
 * @param dir 目录绝对路径
 * @returns 找到则返回文件路径，否则返回 null
 */
function findAgentsMdInDir(dir: string): string | null {
  // 优先匹配大写（约定俗成）
  const upperPath = join(dir, AGENTS_MD_FILENAME);
  if (fileExists(upperPath)) {
    return upperPath;
  }
  // 兼容小写
  const lowerPath = join(dir, AGENTS_MD_FILENAME_LOWER);
  if (fileExists(lowerPath)) {
    return lowerPath;
  }
  return null;
}

/**
 * 进程内 memo 条目（P2-32）
 *
 * 每回合 resolvePrompt 都会向上 20 级 statSync 探测 + readFileSync 读取全部
 * AGENTS.md；memo 命中时只需 2–3 次 stat 即可判定新鲜。
 */
interface AgentsMdMemoEntry {
  readonly files: readonly FoundAgentsMd[];
  /** 发现时各命中文件的 mtimeMs（内容修改/删除失效检测） */
  readonly fileMtimes: ReadonlyMap<string, number>;
  /** 发现时解析根目录的 mtimeMs（根目录新增/删除文件失效检测） */
  readonly rootMtime: number;
}

/** memo 缓存：key = 解析根 + 预算（预算不同结果不同，须入 key） */
const memo = new Map<string, AgentsMdMemoEntry>();

/** 清空 memo（测试用；生产常驻进程内复用） */
export function resetAgentsMdMemo(): void {
  memo.clear();
}

/** mtime 读取（stat 失败视为 null——与「文件不存在」同途触发失效） */
function mtimeOf(filePath: string): number | null {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

/** memo 新鲜度：解析根目录 mtime 未变 且 各命中文件 mtime 未变 */
function isMemoFresh(root: string, entry: AgentsMdMemoEntry): boolean {
  if (mtimeOf(root) !== entry.rootMtime) {
    return false;
  }
  for (const [path, mtime] of entry.fileMtimes) {
    if (mtimeOf(path) !== mtime) {
      return false;
    }
  }
  return true;
}

/**
 * 向上逐级扫描 AGENTS.md（发现逻辑本体，独立于 memo 便于控制复杂度）
 *
 * 查找顺序：root → parent → ... → 文件系统根目录（最多 20 级）。
 * 收集路径上所有 AGENTS.md，越靠近 root 的优先级越高（排在前面）。
 */
function walkAgentsMdUpward(root: string, maxBytes: number): FoundAgentsMd[] {
  const results: FoundAgentsMd[] = [];
  let remainingBudget = maxBytes;
  let currentDir = root;

  // 防御：无限循环保护（最多 20 级目录）
  for (let i = 0; i < 20; i += 1) {
    const filePath = findAgentsMdInDir(currentDir);
    if (filePath !== null) {
      try {
        const content = readFileSync(filePath, 'utf-8');
        if (content.trim().length > 0) {
          results.push({ path: filePath, content });
          remainingBudget -= Buffer.byteLength(content, 'utf-8');
          if (remainingBudget <= 0) {
            break;
          }
        }
      } catch {
        // 读取失败（权限不足等），跳过此文件
      }
    }

    // 到达文件系统根目录，停止向上查找
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  return results;
}

/**
 * 从工作目录向上逐级查找 AGENTS.md 文件
 *
 * 查找顺序：workingDir → parent → ... → 文件系统根目录
 * 收集路径上所有 AGENTS.md，越靠近 workingDir 的优先级越高（排在前面）。
 *
 * 消费方：唯一生产调用链 = dynamic-context 的 resolveAgentsMd
 * （注入 {{agentsMd}} 变量）；本模块不感知 prompt 模板。
 *
 * P2-32：按解析根 + 字节预算做进程内 memo，mtime 失效（命中文件内容修改/删除、
 * 根目录新增文件）。已知取舍：在「根目录以外的祖先目录」中新建 AGENTS.md 不会
 * 使 memo 失效（目录 mtime 不变化）——会话中途向上级目录补挂约定的场景极罕见，
 * 重启或工作目录变更（新 memo key）即可刷新。
 *
 * @param workingDir 工作目录绝对路径
 * @param maxBytes 总字节预算（默认 8KB），超出后停止收集
 * @returns 按优先级排序的 FoundAgentsMd 数组（workingDir 的在最前；memo 命中时为缓存实例，调用方不得修改）
 */
export function discoverAgentsMd(
  workingDir: string,
  maxBytes: number = BYTE_BUDGET,
): readonly FoundAgentsMd[] {
  const root = resolve(workingDir);
  const memoKey = `${root}\u0000${maxBytes}`;
  const cached = memo.get(memoKey);
  if (cached !== undefined && isMemoFresh(root, cached)) {
    return cached.files;
  }

  const results = walkAgentsMdUpward(root, maxBytes);
  memo.set(memoKey, {
    files: results,
    fileMtimes: new Map(results.map((file) => [file.path, mtimeOf(file.path) ?? 0])),
    rootMtime: mtimeOf(root) ?? 0,
  });
  return results;
}

/**
 * 格式化 AGENTS.md 内容为 system prompt 注入块
 *
 * 格式：
 * ```
 * # 项目约定（AGENTS.md）
 *
 * ## /path/to/AGENTS.md
 * <content>
 *
 * ## /path/to/parent/AGENTS.md
 * <content>
 * ```
 *
 * @param files 发现的 AGENTS.md 文件列表（discoverAgentsMd 返回的只读数组可直接传入）
 * @returns 格式化后的字符串；无文件时返回空字符串
 */
export function formatAgentsMdSection(files: readonly FoundAgentsMd[]): string {
  if (files.length === 0) {
    return '';
  }

  const sections = files.map((file) => {
    const relativePath = file.path;
    return `## ${relativePath}\n${file.content.trim()}`;
  });

  return `# 项目约定（AGENTS.md）\n\n${sections.join('\n\n')}`;
}

/**
 * 一站式入口：发现并格式化 AGENTS.md
 *
 * @param workingDir 工作目录绝对路径
 * @returns 格式化后的 AGENTS.md 注入块；无文件时返回空字符串
 */
export function resolveAgentsMd(workingDir: string): string {
  const files = discoverAgentsMd(workingDir);
  return formatAgentsMdSection(files);
}
