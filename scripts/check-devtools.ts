// scripts/check-devtools.ts
// devtools 产物零残留门禁：断言 out/ 全部产物无 react-query devtools 痕迹。
// dev 调试面板按设计只存在于 dev 构建链（QueryProvider 的 dev 门 + 动态 import），生产构建应整体
// DCE 出产物图；三条回归路径（dev 门改运行时条件 / 动态 import 变静态 / 字面串落进常驻模块）不挡在
// 任何其它闸上，故需本机器闸。判据 = `react-query-devtools|ReactQueryDevtools` 零命中——模块一旦
// 回到产物图，包名串经 sourcemap sourcesContent 必然出现，哪怕只在死分支/注释里；范围刻意不含
// electron-devtools-installer（主进程 dev 工具，静态导入），不属本门禁。
// 产物不存在（本地未构建）时仅提示跳过、不卡关；CI 中 build 后与 check:compiler 同位运行。
// 运行：pnpm build && pnpm check:devtools

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
