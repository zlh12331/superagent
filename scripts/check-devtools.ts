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
