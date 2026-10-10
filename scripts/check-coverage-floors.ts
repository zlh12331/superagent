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
