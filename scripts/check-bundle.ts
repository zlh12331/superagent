// scripts/check-bundle.ts
// Bundle 体积门槛（工程化强制）：检查构建产物，超限即卡关（exit 1）
// ──────────────────────────────────────────────────────────────
// 依据 docs/design/12-performance-spec.md §1.2：
//   单 chunk ≤ 5MB、渲染层总包 ≤ 16MB（2026-08-11 基线门槛：当前产物 14.5MB，渐进收紧）
// 产物不存在时仅提示（本地未构建场景不卡关）；CI 中 build 后运行。
//
// 运行：pnpm build && pnpm check:bundle
// ──────────────────────────────────────────────────────────────

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const ASSETS_DIR = join(ROOT, 'out', 'renderer', 'assets');

// 基线门槛（依据 12-performance-spec §1.2，渐进收紧）：
const CHUNK_LIMIT_KB = 5 * 1024;
const TOTAL_LIMIT_KB = 16 * 1024;

interface ChunkInfo {
  readonly name: string;
  readonly sizeKib: number;
}

function main(): number {
  let chunks: ChunkInfo[];
  try {
    chunks = readdirSync(ASSETS_DIR)
      .filter((f) => f.endsWith('.js'))
      .map((f) => {
        const sizeKib = statSync(join(ASSETS_DIR, f)).size / 1024;
        return { name: f, sizeKib };
      });
  } catch {
    console.log('[check-bundle] ⏭️ 无构建产物（out/renderer/assets），跳过（CI 中 build 后生效）');
    return 0;
  }

  const totalKib = chunks.reduce((sum, c) => sum + c.sizeKib, 0);
  const problems: string[] = [];

  for (const c of chunks) {
    if (c.sizeKib > CHUNK_LIMIT_KB) {
      problems.push(`${c.name}: ${c.sizeKB.toFixed(0)}KB > ${CHUNK_LIMIT_KB}KB（单 chunk 超限）`);
    }
  }
  if (totalKib > TOTAL_LIMIT_KB) {
    problems.push(`渲染层总包 ${totalKib.toFixed(0)}KB > ${TOTAL_LIMIT_KB}KB（总包超限）`);
  }

  if (problems.length === 0) {
    console.log(
      `[check-bundle] ✅ 通过：${chunks.length} 个 chunk，合计 ${totalKib.toFixed(0)}KB（门槛：单 ${CHUNK_LIMIT_KB}KB / 总 ${TOTAL_LIMIT_KB}KB）`,
    );
    return 0;
  }

  console.error(`[check-bundle] ❌ ${problems.length} 个问题：`);
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    '[check-bundle] 修复指引：docs/design/12-performance-spec.md（动态 import 拆分 / 依赖纪律）',
  );
  return 1;
}

process.exitCode = main();
