// scripts/check-tokens-sync.ts
// 令牌生成物 ↔ 令牌源 一致性闸（生成物一致性维度）
// ──────────────────────────────────────────────────────────────
// 校验：src/renderer/styles/tokens.css 是否就是 tokens/aurora.json 的产物。
//
// 判据（与提交状态无关）：
//   ① 先快照磁盘上的 tokens.css
//   ② 跑 build-tokens 重新生成
//   ③ 前后一致 ⇒ 通过；不一致 ⇒ 失败（改了源却忘了重新生成，或手改了生成物）
//
// 为什么不用 `git diff --exit-code -- tokens.css` 对比 HEAD（原实现）：
//   1. **本地必然误报**：改了 tokens/aurora.json 并已 `pnpm tokens:build`，只要还没
//      提交，生成物就与 HEAD 不同 ⇒ 判定失败。而「已重新生成、尚未提交」正是本地
//      开发中途跑 verify:local 的常态，该闸在本地等于不可用。
//   2. **漏检手改**：build 会把手改内容整体覆盖，结果与 HEAD 相同即放行——
//      也就是说「手改生成物」这个它本该拦的场景，它其实拦不住。
//   本实现的判据只看「磁盘产物是否等于源的产物」，因此对提交状态不敏感，
//   且能捕获手改（手改后不重新生成 ⇒ 前后不一致）。
//
// CI 语义不变：CI 的工作区是干净检出，磁盘产物即已提交版本，
// 故两种判据在 CI 上等价（且本实现额外覆盖了手改）。
// ──────────────────────────────────────────────────────────────

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
