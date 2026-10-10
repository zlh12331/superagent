export const DEFAULT_TREE_IGNORE_PATTERNS: readonly string[] = ['node_modules'];

const MAX_PATTERNS = 32;
const MAX_PATTERN_LENGTH = 64;

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
