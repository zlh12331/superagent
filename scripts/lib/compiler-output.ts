// scripts/lib/compiler-output.ts
// React Compiler 产物调用点统计核（纯函数层，供 check-compiler.ts CLI 调用）
// ──────────────────────────────────────────────────────────────
// 从 check-compiler.ts 抽出的原因：判据此前内联零测试（外部审计点名）。
// 反例 fixture 测试见 compiler-output.test.ts——「编译器真失效」（0 调用点）、
// vendor 定义混入（假阳性剔除）、「大面积失效」（低于下限）三态都有断言。
// ──────────────────────────────────────────────────────────────

/** interop 函数名（下划线，来自模块路径 react-compiler-runtime.production 的映射；
 * 连字符的 'compiler-runtime' 只是 vendor 内路径字符串——用它过滤会把应用 chunk 全漏掉） */
const INTEROP_NAME = 'require_compiler_runtime';
/** 顶层调用点：`require_compiler_runtime()`（每应用 chunk 一处，供后续 useMemoCache 使用） */
const CALL_SITE_RE = /\brequire_compiler_runtime\(\)/g;
/** vendor 模块包装定义形态（非编译调用，从调用计数中剔除） */
const DEFINITION_RE = /\bfunction\s+require_compiler_runtime\(/g;

/** 统计结果 */
export interface CompilerStats {
  /** 净调用点总数（应用 chunk 的 require_compiler_runtime() 减 vendor 定义形态） */
  readonly totalCalls: number;
  /** 含净调用点的 chunk 数 */
  readonly chunksWithCalls: number;
  /** 扫描的 chunk 总数 */
  readonly scannedChunks: number;
}

/**
 * 统计产物 chunk 的编译器调用点（rolldown CJS interop 实测形态，2026-09-24）：
 * - 应用 chunk：`var import_compiler_runtime = require_compiler_runtime();`（顶层的本名调用）
 * - vendor（react 包自身）：`function require_compiler_runtime(...)` 模块包装定义
 *   （非编译调用，剔除——否则 vendor 也计数，编译器真失效时旧判据可能仍通过）
 *
 * @param contents 各 chunk 的文件内容
 */
export function countCompilerCallSites(contents: readonly string[]): CompilerStats {
  let totalCalls = 0;
  let chunksWithCalls = 0;
  for (const content of contents) {
    if (!content.includes(INTEROP_NAME)) continue;
    const calls = content.match(CALL_SITE_RE)?.length ?? 0;
    const defs = content.match(DEFINITION_RE)?.length ?? 0;
    const net = calls - defs;
    if (net > 0) chunksWithCalls += 1;
    totalCalls += Math.max(net, 0);
  }
  return { totalCalls, chunksWithCalls, scannedChunks: contents.length };
}
