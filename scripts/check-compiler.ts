// scripts/check-compiler.ts
// React Compiler 生效门禁：断言渲染层产物含 react/compiler-runtime 编译痕迹
// ──────────────────────────────────────────────────────────────
// 背景：React Compiler 曾以 babel.plugins 形式"存在"数月而被 Vite 8（Rolldown）
// 链路静默忽略（产物 0 处 compiler-runtime 引用、0 个 'use memo'），2026-08-30 才查明。
// 现经 oxc-transform-react 启用（electron.vite.config.ts / vite.web.config.ts 的
// react({ compiler: ... })）；oxc-transform-react 是 plugin-react v6 的可选 peerDep，
// 缺失或被移除时 compiler 选项会再次静默失效。本脚本把"编译器必须真的在跑"变成机器闸：
// 编译产物会 import react/compiler-runtime（useMemoCache 实现），该模块被打进 bundle
// 即为生效证据；编译器未运行时该模块被 tree-shake，产物中不可见。
//
// 产物不存在时仅提示（本地未构建场景不卡关）；CI 中 build 后与 check:bundle 同位运行。
//
// 运行：pnpm build && pnpm check:compiler
// ──────────────────────────────────────────────────────────────

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const ASSETS_DIR = join(ROOT, 'out', 'renderer', 'assets');

/** 编译痕迹指纹：react-compiler-runtime（useMemoCache）被编译产物 import 后打进 bundle */
const EVIDENCE = 'compiler-runtime';

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

  const hits = files.filter((f) => readFileSync(join(ASSETS_DIR, f), 'utf8').includes(EVIDENCE));
  if (hits.length === 0) {
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

  console.log(
    `[check-compiler] ✅ 通过：${hits.length}/${files.length} 个 chunk 含 react-compiler-runtime 痕迹，React Compiler 在构建中生效`,
  );
  return 0;
}

process.exitCode = main();
