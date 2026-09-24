// scripts/check-compiler.ts
// React Compiler 生效门禁：断言渲染层产物含 react/compiler-runtime 编译痕迹
// ──────────────────────────────────────────────────────────────
// 背景：React Compiler 曾以 babel.plugins 形式"存在"数月而被 Vite 8（Rolldown）
// 链路静默忽略（产物 0 处 compiler-runtime 引用、0 个 'use memo'），2026-08-30 才查明。
// 现经 oxc-transform-react 启用（electron.vite.config.ts / vite.web.config.ts 的
// react({ compiler: ... })）；oxc-transform-react 是 plugin-react v6 的可选 peerDep，
// 缺失或被移除时 compiler 选项会再次静默失效。本脚本把"编译器必须真的在跑"变成机器闸。
//
// 判据（2026-09-24 升级）：不止断言"字符串存在"——`compiler-runtime` 字符串在 React 包
// 自身（react/compiler-runtime.js 被打进 vendor chunk）也存在，编译器真失效时旧判据
// 可能仍通过。现统计 **useMemoCache 运行时调用点**（`require_compiler_runtime(` 在
// minified 产物中的形态）与含调用点的 chunk 数，双下限拦截：
//   MIN_COMPILER_CHUNKS = 20 —— 2026-09-24 实测 28（对照 require_react 35 chunk），
//   留 ~30% 余量容忍组件重构波动；复核流程：React 大版本升级或产物结构变化时
//   重新实测并调整常量（只会从"通过"变"失败"提示复核，fail-closed 方向）。
//
// 产物不存在时仅提示（本地未构建场景不卡关）；CI 中 build 后与 check:bundle 同位运行。
//
// 运行：pnpm build && pnpm check:compiler
// ──────────────────────────────────────────────────────────────

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const ASSETS_DIR = join(ROOT, 'out', 'renderer', 'assets');

/** interop 函数名（下划线，来自模块路径 react-compiler-runtime.production 的映射；
 * 连字符的 'compiler-runtime' 只是 vendor 内路径字符串——用它过滤会把应用 chunk 全漏掉） */
const INTEROP_NAME = 'require_compiler_runtime';
/** 顶层调用点：`require_compiler_runtime()`（每应用 chunk 一处，供后续 useMemoCache 使用） */
const CALL_SITE_RE = /\brequire_compiler_runtime\(\)/g;
/** vendor 模块包装定义形态（非编译调用，从调用计数中剔除） */
const DEFINITION_RE = /\bfunction\s+require_compiler_runtime\(/g;
/** 含调用点的 chunk 数下限（2026-09-24 实测 28；复核流程见头注释） */
const MIN_COMPILER_CHUNKS = 20;

function main(): number {
  let files: string[];
  try {
    files = readdirSync(ASSETS_DIR).filter((f) => f.endsWith('.js'));
  } catch {
    console.log('[check-compiler] ⏭️ 无构建产物（out/renderer/assets），跳过（CI 中 build 后生效）');
    return 0;
  }
  if (files.length === 0) {
    console.log('[check-compiler] ⏭️ assets 目录无 .js 产物，跳过（异常构建请检查 build 输出）');
    return 0;
  }

  // 统计调用点（rolldown CJS interop 实测形态，2026-09-24）：
  //   应用 chunk：`var import_compiler_runtime = require_compiler_runtime();`（顶层的本名调用）
  //   vendor（react 包自身）：`function require_compiler_runtime(...)` 模块包装定义（非编译调用，剔除）
  let totalCalls = 0;
  let chunksWithCalls = 0;
  for (const f of files) {
    const content = readFileSync(join(ASSETS_DIR, f), 'utf8');
    if (!content.includes(INTEROP_NAME)) continue;
    const calls = content.match(CALL_SITE_RE)?.length ?? 0;
    const defs = content.match(DEFINITION_RE)?.length ?? 0;
    const net = calls - defs;
    if (net > 0) chunksWithCalls += 1;
    totalCalls += Math.max(net, 0);
  }

  if (chunksWithCalls === 0) {
    console.error('[check-compiler] ❌ 渲染层产物无 react/compiler-runtime 编译痕迹：');
    console.error('  React Compiler 实际未参与构建（静默失效）——排查顺序：');
    console.error(
      '  1. oxc-transform-react 是否安装（plugin-react v6 可选 peerDep，缺失即静默跳过）',
    );
    console.error(
      '  2. electron.vite.config.ts / vite.web.config.ts 的 react({ compiler: ... }) 是否还在',
    );
    console.error('  3. pnpm build 日志中应出现 "vite:react-compiler transform" 插件调用计时');
    return 1;
  }
  if (chunksWithCalls < MIN_COMPILER_CHUNKS) {
    console.error(
      `[check-compiler] ❌ 含编译器调用点的 chunk 仅 ${chunksWithCalls} 个（下限 ${MIN_COMPILER_CHUNKS}）：`,
    );
    console.error('  编译器疑似大面积失效或产物结构骤变——若是 React 升级/重构所致，');
    console.error('  重新实测后调整 scripts/check-compiler.ts 的 MIN_COMPILER_CHUNKS 并说明理由。');
    return 1;
  }

  console.log(
    `[check-compiler] ✅ 通过：${chunksWithCalls}/${files.length} 个 chunk 含编译器调用点（共 ${totalCalls} 处，下限 ${MIN_COMPILER_CHUNKS}），React Compiler 在构建中生效`,
  );
  return 0;
}

process.exitCode = main();
