// scripts/check-tokens-sync.ts
// 令牌生成物 ↔ 令牌源一致性闸：tokens.css 必须就是 aurora.json 的产物
// 判据与提交状态无关：快照磁盘 → 重新生成 → 前后比对。不用 git diff 对 HEAD
// （原实现）：本地「已重新生成未提交」必然误报，且漏检手改（build 会覆盖手改、
// 与 HEAD 相同即放行——恰是该闸该拦的场景）；CI 干净检出下两判据等价

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** 令牌源（Style Dictionary 输入，单一真源） */
export const TOKENS_SOURCE = 'tokens/aurora.json';

/** 令牌产物（Style Dictionary 输出，禁止手改） */
export const TOKENS_OUTPUT = 'src/renderer/styles/tokens.css';

/** 生成脚本（Style Dictionary 5） */
const BUILD_SCRIPT = 'scripts/build-tokens.mjs';

/** 取首个不一致行的行号（1-based），用于定位；无差异返回 -1 */
export function firstDiffLine(before: string, after: string): number {
  const a = before.split('\n');
  const b = after.split('\n');
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i += 1) {
    if (a[i] !== b[i]) {
      return i + 1;
    }
  }
  return -1;
}

function main(): void {
  let before: string;
  try {
    before = readFileSync(TOKENS_OUTPUT, 'utf8');
  } catch (error) {
    console.error(`[check-tokens-sync] ❌ 读不到生成物 ${TOKENS_OUTPUT}：${String(error)}`);
    process.exit(1);
  }

  try {
    execFileSync(process.execPath, [BUILD_SCRIPT], { stdio: 'pipe' });
  } catch (error) {
    console.error(`[check-tokens-sync] ❌ 生成失败（${BUILD_SCRIPT}）：${String(error)}`);
    process.exit(1);
  }

  const after = readFileSync(TOKENS_OUTPUT, 'utf8');
  if (before === after) {
    console.log(
      `[check-tokens-sync] ✅ 通过：${TOKENS_OUTPUT} 与 ${TOKENS_SOURCE} 一致（${after.split('\n').length} 行）`,
    );
    return;
  }

  const line = firstDiffLine(before, after);
  console.error('[check-tokens-sync] ❌ 生成物与令牌源不一致：');
  console.error(`  生成物：${TOKENS_OUTPUT}`);
  console.error(`  令牌源：${TOKENS_SOURCE}`);
  console.error(`  首个差异行：第 ${line} 行`);
  console.error('');
  console.error('  处置：运行 `pnpm tokens:build` 重新生成，并把产物一并提交。');
  console.error('  ⚠️ 禁止手改 tokens.css——它是生成物，改动会在下次构建时被覆盖。');
  process.exit(1);
}

main();
