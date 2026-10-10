// tree-ignore.ts：文件树忽略模式——用户可配 glob（*/?）或字面名，超限防滥用
export const DEFAULT_TREE_IGNORE_PATTERNS: readonly string[] = ['node_modules'];

// 用户可配模式的上限：32 条 × 64 字符——这是渲染给 glob→RegExp 的用户输入面，防灾难性回溯
const MAX_PATTERNS = 32;
const MAX_PATTERN_LENGTH = 64;

/** 名称是否命中任一忽略模式（星号/问号通配或字面相等；分隔符统一按正反斜杠处理） */
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

// 手写 glob→RegExp：* 与 ? 不跨目录分隔符（与 .gitignore 直觉一致），其余字符全量转义
function wildcardToRegExp(pattern: string): RegExp {
  let source = '';
  for (const char of pattern) {
    if (char === '*') {
      source += '[^\\\\/]*';
    } else if (char === '?') {
      source += '[^\\\\/]';
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

/** 用户配置清洗：非字符串/空白/超长剔除，条数截断（不可信输入面） */
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
