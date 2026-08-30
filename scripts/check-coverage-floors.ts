// scripts/check-coverage-floors.ts
// 覆盖率门槛门禁：门槛必须有唯一真源、只升不降、且与实际强制值一致
// ──────────────────────────────────────────────────────────────
// 背景（2026-08-30 审计）：三张 vitest.config.ts 各自内联一套数字
//   main 80/75/80/80、renderer 59/50/54/59、shared 80/30/39/80
// 而对外口径统一自称「按规范值 80/75/80/80 卡关」，渲染层注释还曾声称
// 实测 92.87（真实 64.06）。这类漂移靠人盯注释防不住。
//
// 本门禁把「门槛数字」收敛到 scripts/coverage-floors.json，并机械校验：
//   A. 每层 config 必须从真源读 thresholds，config 里不得再出现门槛数字
//   B. floor ≥ ratchet：已批准的门槛不得静默下调（降级必须显式改 ratchet）
//   C. measured ≥ floor：记录的实测必须支撑记录的门槛，否则数字是编的
//   D. measuredAt 未超过 maxStaleDays：实测必须定期重跑，禁止「一次测量吃三年」
//   E. 逐层打印 floor 与 specTarget 的真实差距（不再用「以 CI 报告为准」糊过去）
//
// 运行：pnpm exec tsx scripts/check-coverage-floors.ts
//       --tighten  按 §3.3 机制（min(规范目标, 实测−5)）只升不降回填 floor/ratchet
// ──────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyTighten,
  LAYER_KEYS,
  loadCoverageFloors,
  renderFloorsTable,
  validateConfigWiring,
  validateCoverageFloors,
} from './lib/coverage-floors';

const ROOT = join(import.meta.dirname, '..');
const FLOORS_PATH = join(import.meta.dirname, 'coverage-floors.json');

function main(): number {
  const argv = process.argv.slice(2);
  const file = loadCoverageFloors(FLOORS_PATH);

  if (argv.includes('--tighten')) {
    const { text, changed } = applyTighten(readFileSync(FLOORS_PATH, 'utf-8'), file);
    if (changed.length === 0) {
      console.log('[check-coverage-floors] 无需收紧：各层 floor 已到 §3.3 允许的上限');
      return 0;
    }
    writeFileSync(FLOORS_PATH, text, 'utf-8');
    for (const line of changed) console.log(`[check-coverage-floors] ${line}`);
    console.log(
      '[check-coverage-floors] 已回填真源，请复核 diff；实测过期需重跑 pnpm test:coverage',
    );
    return 0;
  }

  const problems = [...validateConfigWiring(ROOT), ...validateCoverageFloors(file, new Date())];
  console.log('[check-coverage-floors] 覆盖率门槛（唯一真源 scripts/coverage-floors.json）：');
  for (const line of renderFloorsTable(file)) console.log(line);

  if (problems.length > 0) {
    console.error(`[check-coverage-floors] ❌ ${problems.length} 处问题：`);
    for (const p of problems) console.error(`  ${p.key}: ${p.detail}`);
    console.error(
      '[check-coverage-floors] 修复指引：门槛只能改 scripts/coverage-floors.json；下调需同时改 ratchet 并在 PR 说明理由；实测过期请跑 pnpm test:coverage 后回填 measured/measuredAt',
    );
    return 1;
  }
  console.log(
    `[check-coverage-floors] ✅ 通过：${LAYER_KEYS.length} 层门槛均来自真源，无静默降级，实测在有效期内且支撑门槛`,
  );
  return 0;
}

process.exitCode = main();
