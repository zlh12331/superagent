// src/main/infra/file/tree-ignore.ts
// 文件树忽略规则：用户配置的名称模式过滤（file:list 每次调用现读设置，改后即生效）
// ──────────────────────────────────────────────────────────────
// 职责（纯函数，不依赖 DB——设置读取在 handler 层薄封装）：
// - matchIgnorePattern：名称级匹配（精确 / * 通配任意非分隔符序列 / ? 单字符）
// - normalizeTreeIgnorePatterns：用户配置归一化（trim / 去空 / 限长限量）
//
// 设计原则：
// - 匹配作用于 basename（用户心智模型：node_modules / dist / *.log），不做路径 glob
// - 内置基线 node_modules（与 watch ignored 对齐；此前 list 不过滤导致大目录卡顿）
// - 零依赖自写通配转换（* → [^\\]*，? → 单字符；Windows/POSIX 分隔符均不跨）
// ──────────────────────────────────────────────────────────────

/** 内置忽略基线（始终生效，叠加在用户配置之上） */
export const DEFAULT_TREE_IGNORE_PATTERNS: readonly string[] = ['node_modules'];

/** 用户模式上限（防御性） */
const MAX_PATTERNS = 32;
const MAX_PATTERN_LENGTH = 64;

/**
 * 名称是否命中忽略模式
 *
 * @param name 条目名（basename）
 * @param patterns 忽略模式列表（空 = 不忽略任何项）
 */
export function matchIgnorePattern(name: string, patterns: readonly string[]): boolean {
  for (const raw of patterns) {
    const pattern = raw.trim();
    if (pattern.length === 0) {
      continue;
    }
    if (pattern.includes('*') || pattern.includes('?')) {
      if (wildcardToRegExp(pattern).test(name)) {
        return true;
      }
    } else if (name === pattern) {
      return true;
    }
  }
  return false;
}

/** 通配模式 → 全名正则（* 匹配任意非分隔符序列，? 匹配单个字符） */
function wildcardToRegExp(pattern: string): RegExp {
  let source = '';
  for (const char of pattern) {
    if (char === '*') {
      source += '[^\\\\/]*';
    } else if (char === '?') {
      source += '[^\\\\/]';
    } else {
      // 其余字符按字面量转义
      source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

/**
 * 归一化用户配置的忽略模式列表（trim / 去空 / 截断；非法输入降级为仅内置基线）
 *
 * @param raw 原始值（来自 app_settings 的 workspace.treeIgnorePatterns）
 */
export function normalizeTreeIgnorePatterns(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && item.length <= MAX_PATTERN_LENGTH)
    .slice(0, MAX_PATTERNS);
}
