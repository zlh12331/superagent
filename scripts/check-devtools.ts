// scripts/check-devtools.ts
// devtools 产物零残留门禁：断言 out/ 无 react-query devtools 任何痕迹
// ──────────────────────────────────────────────────────────────
// 背景：dev 调试面板（@tanstack/react-query-devtools）按设计只允许存在于
// dev 构建链——QueryProvider 以 `DEV && MODE!=='web' && !VITEST` 门 +
// 动态 import 挂载，生产构建应整体 DCE 出产物图。2026-09-27 查询层改造时
// 做过一次性 rg 零命中实证，但判据未固化（外部审计点名）：回归（dev 门改
// 运行时条件 / 动态 import 变静态 / 字面串落进常驻模块）不会挡在任何闸上。
// 本脚本把该判据变成机器闸。
//
// 判据：`react-query-devtools|ReactQueryDevtools` 在 out/ 全部产物文件零命中
// （与 query-devtools.tsx 头注释记录的权威命令同源；模块一旦回到产物图，
// 包名串经 sourcemap sourcesContent 必然出现，哪怕只在死分支/注释里）。
// 范围刻意不含 electron-devtools-installer——主进程 dev 工具（静态导入），
// 不属于本门禁。
//
// 产物不存在时仅提示（本地未构建场景不卡关）；CI 中 build 后与 check:compiler
// 同位运行（ci.yml e2e-electron job + verify:local:full 产物层）。
//
// 运行：pnpm build && pnpm check:devtools
// ──────────────────────────────────────────────────────────────

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { findDevtoolsResidue } from './lib/devtools-residue';

const ROOT = join(import.meta.dirname, '..');
const OUT_DIR = join(ROOT, 'out');

/** 递归收集产物文件绝对路径（镜像 check-docs-scripts 的遍历写法） */
function collectFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

function main(): number {
  let files: string[];
  try {
    files = collectFiles(OUT_DIR);
  } catch {
    console.log('[check-devtools] ⏭️ 无构建产物（out/），跳过（CI 中 build 后生效）');
    return 0;
  }

  const hits = findDevtoolsResidue(
    files.map((full) => ({
      file: relative(OUT_DIR, full).split(sep).join('/'),
      content: readFileSync(full, 'utf8'),
    })),
  );

  if (hits.length > 0) {
    console.error(
      `[check-devtools] ❌ 产物含 devtools 残留（${hits.length} 个文件命中，要求零命中）：`,
    );
    for (const hit of hits) {
      console.error(`  out/${hit.file}:${hit.line}`);
    }
    console.error('  排查顺序：');
    console.error(
      "  1. QueryProvider.tsx 的 dev 门（DEV && MODE!=='web' && !VITEST）是否被改为运行时条件",
    );
    console.error('  2. ./query-devtools 的动态 import 是否被改成静态导入');
    console.error(
      '  3. 字面串是否落进了常驻模块（query-devtools.tsx 头注释的「字符串只允许在该文件」约束）',
    );
    return 1;
  }

  console.log(
    `[check-devtools] ✅ 通过：out/ 共 ${files.length} 个产物文件，react-query devtools 零残留`,
  );
  return 0;
}

process.exitCode = main();
