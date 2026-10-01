// scripts/lib/css-vars.ts
// CSS 变量引用完整性规则核（纯函数层，供 check-css-vars.ts CLI 调用）
// ──────────────────────────────────────────────────────────────
// 从 check-css-vars.ts 抽出的原因：判据此前内联零测试（外部审计点名）。
// 反例 fixture 测试见 css-vars.test.ts。
// ──────────────────────────────────────────────────────────────

/**
 * 允许「被引用但不在本仓定义」的变量前缀（运行时注入，静态扫描必然看不到定义）：
 * - --radix-：Radix UI 运行时注入尺寸（如 --radix-select-trigger-width）
 * - --spacing：Tailwind v4 动态 spacing 前缀（--spacing-md 等在 @theme 计算生成）
 */
export const RUNTIME_INJECTED_PREFIXES: readonly string[] = ['--radix-', '--spacing'];

/**
 * 提取一行中的 var(--x) 引用
 *
 * 带 fallback 的写法（var(--x, #fff)）**不计入**：即使 --x 未定义也有确定取值。
 * 注释行整体跳过：说明文字里常写 `var(--x)` 举例（实测 terminal.tsx 头注释即如此），
 * 那不是真实引用。
 */
export function extractRefs(line: string): string[] {
  const trimmed = line.trim();
  // 单行注释 / 块注释续行（* 开头）/ CSS 注释内容行
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
    return [];
  }
  const refs: string[] = [];
  for (const match of line.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)\s*([,)])/g)) {
    const name = match[1];
    const next = match[2];
    if (name === undefined) continue;
    // 紧跟 ',' 说明有 fallback → 跳过
    if (next === ',') continue;
    refs.push(name);
  }
  return refs;
}

/** 是否为运行时注入（豁免） */
export function isRuntimeInjected(name: string): boolean {
  return RUNTIME_INJECTED_PREFIXES.some((p) => name.startsWith(p));
}

/** 单文件扫描结果：定义集 + 引用清单（line 为 1-based 行号） */
export interface CssVarScan {
  readonly defined: ReadonlySet<string>;
  readonly references: ReadonlyArray<{ name: string; line: number }>;
}

/** 扫描单个文件内容：`--name:` 声明为定义，var(--x) 为引用 */
export function scanCssVars(content: string): CssVarScan {
  const defined = new Set<string>();
  const references: Array<{ name: string; line: number }> = [];
  content.split(/\r?\n/).forEach((line, i) => {
    // 定义：`--name:` 形态（CSS 自定义属性声明）
    for (const m of line.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) {
      if (m[1] !== undefined) defined.add(m[1]);
    }
    for (const name of extractRefs(line)) {
      references.push({ name, line: i + 1 });
    }
  });
  return { defined, references };
}

/** 引用中有定义/豁免之外的缺口即返回（defined 为**全仓**定义集——两遍扫描，CLI 先并集所有文件的定义再判缺失） */
export function findMissingVars(
  references: ReadonlyArray<{ name: string; line: number }>,
  defined: ReadonlySet<string>,
): ReadonlyArray<{ name: string; line: number }> {
  return references.filter((r) => !defined.has(r.name) && !isRuntimeInjected(r.name));
}
