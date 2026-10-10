import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { countCompilerCallSites } from './lib/compiler-output';

const ROOT = join(import.meta.dirname, '..');
const ASSETS_DIR = join(ROOT, 'out', 'renderer', 'assets');

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

  const { totalCalls, chunksWithCalls } = countCompilerCallSites(
    files.map((f) => readFileSync(join(ASSETS_DIR, f), 'utf8')),
  );

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
