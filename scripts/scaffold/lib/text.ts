// scripts/scaffold/lib/text.ts
// 文本插入工具：以锚点/块为目标的源码修改（零 AST 依赖，幂等校验由调用方负责）
// ──────────────────────────────────────────────
// 适用场景：
// - 向 meta.ts / definitions.ts 的对象字面量块内追加方法行
// - 向 tools/index.ts 按字典序插入 import / export 行
// - 向函数体末尾追加注册行
// ──────────────────────────────────────────────

/** 转义正则特殊字符（防御外部输入进入 RegExp 构造） */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 克隆正则并确保带 global 标志（matchAll 要求） */
function withGlobalFlag(pattern: RegExp): RegExp {
  return pattern.flags.includes('g') ? pattern : new RegExp(pattern.source, `${pattern.flags}g`);
}

/**
 * 在锚点首次出现位置之前插入文本
 *
 * @param source 原文本
 * @param anchor 锚点子串（如 `} as const;`）
 * @param block 要插入的文本（含结尾换行）
 * @returns 插入后的文本；锚点不存在返回 null
 */
export function insertBeforeAnchor(source: string, anchor: string, block: string): string | null {
  const idx = source.indexOf(anchor);
  if (idx === -1) {
    return null;
  }
  return source.slice(0, idx) + block + source.slice(idx);
}

/**
 * 在对象字面量块内（`  domain: {` 与 `  },` 之间）尾部插入新行
 *
 * @param source 原文本
 * @param headerLine 块头行（含缩进，如 `  app: {`）
 * @param newEntryLine 新方法行（含 4 空格缩进与结尾逗号，如 `    getInfo: request('app:getInfo'),`）
 * @returns 插入后的文本；块未找到返回 null
 */
export function insertIntoObjectBlock(
  source: string,
  headerLine: string,
  newEntryLine: string,
): string | null {
  const pattern = new RegExp(`^${escapeRegExp(headerLine)}([\\s\\S]*?)\\n  \\},$`, 'm');
  const match = pattern.exec(source);
  if (match === null) {
    return null;
  }
  const [full, inner] = match;
  return source.replace(full, `${headerLine}${inner}\n${newEntryLine}\n  },`);
}

/**
 * 在最后一个匹配行之后插入多行文本
 *
 * @param source 原文本
 * @param linePattern 逐行匹配的正则（须含 ^ $ 与 m 标志，匹配整行）
 * @param lines 要插入的文本（以 \n 开头）
 * @returns 插入后的文本；无匹配返回 null
 */
export function insertAfterLastLine(
  source: string,
  linePattern: RegExp,
  lines: string,
): string | null {
  const matches = [...source.matchAll(withGlobalFlag(linePattern))];
  const last = matches.at(-1);
  if (last === undefined || last.index === undefined) {
    return null;
  }
  const pos = last.index + last[0].length;
  return source.slice(0, pos) + lines + source.slice(pos);
}

/**
 * 在匹配行集合中按字典序插入新行（用于 import / export 排序）
 *
 * @param source 原文本
 * @param linePattern 逐行匹配的正则（须含 ^ $ 与 m 标志，匹配整行）
 * @param newLine 待插入的行（不含换行）
 * @param keyOf 提取排序键（如 import 行 → 文件路径）
 * @returns 插入后的文本；无匹配行时返回 null
 */
export function insertSortedLine(
  source: string,
  linePattern: RegExp,
  newLine: string,
  keyOf: (line: string) => string,
): string | null {
  const matches = [...source.matchAll(withGlobalFlag(linePattern))];
  if (matches.length === 0) {
    return null;
  }
  const newKey = keyOf(newLine);
  for (const match of matches) {
    if (match.index === undefined) {
      continue;
    }
    const line = match[0];
    if (keyOf(line) > newKey) {
      // 插在该行之前（该行是第一个排序键大于新行的行）
      return `${source.slice(0, match.index)}${newLine}\n${source.slice(match.index)}`;
    }
  }
  // 全部小于：追加到最后一个匹配行之后
  const last = matches.at(-1);
  if (last === undefined || last.index === undefined) {
    return null;
  }
  const pos = last.index + last[0].length;
  return `${source.slice(0, pos)}\n${newLine}${source.slice(pos)}`;
}
