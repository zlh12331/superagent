// scripts/lib/coverage-floors.test.ts
// 覆盖率门槛真源（SSOT）读取/校验/收紧的单元测试
// ──────────────────────────────────────────────────────────────
// 这组测试的意义：门槛数字对外声称「按 80/75/80/80 卡关」而配置里其实是
// 59/50/54/59（甚至注释谎报实测）。自洽性、棘轮、过期、config 接线
// 四条规则必须有回归测试，否则下一个改配置的人仍可各写一套。
// ──────────────────────────────────────────────────────────────

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  applyTighten,
  type CoverageFloorsFile,
  FLOORS_TABLE_HEADER,
  formatMetricSet,
  LAYER_CONFIGS,
  LAYER_KEYS,
  type LayerFloors,
  loadCoverageFloors,
  MEASURE_BUFFER,
  parseCoverageFloors,
  proposeTighten,
  raiseSet,
  renderFloorsTable,
  thresholdsOf,
  validateConfigWiring,
  validateCoverageFloors,
} from './coverage-floors';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const TODAY = new Date('2026-08-30T00:00:00Z');

function set(statements: number, branches: number, functions: number, lines: number) {
  return { statements, branches, functions, lines };
}

function layer(over: Partial<LayerFloors> = {}): LayerFloors {
  return {
    specTarget: set(80, 75, 80, 80),
    floor: set(80, 75, 80, 80),
    ratchet: set(80, 75, 80, 80),
    measured: set(90, 85, 88, 90),
    measuredAt: '2026-08-27',
    ...over,
  };
}

function fixture(over: Partial<Record<keyof CoverageFloorsFile['layers'], LayerFloors>> = {}) {
  return {
    maxStaleDays: 60,
    layers: {
      shared: layer(),
      main: layer(),
      renderer: layer(),
      ...over,
    },
  };
}

function parseJson(value: unknown): CoverageFloorsFile {
  return parseCoverageFloors(JSON.stringify(value));
}

describe('parseCoverageFloors：结构非法必须抛错', () => {
  it('解析合法真源', () => {
    const file = parseJson(fixture());
    expect(LAYER_KEYS.every((l) => l in file.layers)).toBe(true);
    expect(file.maxStaleDays).toBe(60);
  });

  it.each([
    ['顶层不是对象', '{"layers": []}'],
    ['缺少 layers', '{"maxStaleDays": 60}'],
    [
      '缺少层级 renderer',
      JSON.stringify({ maxStaleDays: 60, layers: { shared: layer(), main: layer() } }),
    ],
    ['缺少 maxStaleDays', JSON.stringify({ layers: fixture().layers })],
  ])('%s → 抛错', (_name, raw) => {
    expect(() => parseCoverageFloors(raw)).toThrow();
  });

  it('门槛越界（>100）→ 抛错', () => {
    const bad = fixture({ renderer: layer({ floor: set(120, 75, 80, 80) }) });
    expect(() => parseJson(bad)).toThrow(/statements 必须是 0–100/);
  });

  it('floor 缺字段 → 抛错（不允许靠“未设置”绕过卡关）', () => {
    const raw = JSON.stringify(fixture());
    const broken = raw.replace('"floor":{"statements"', '"floor":{"x"');
    expect(() => parseCoverageFloors(broken)).toThrow();
  });

  it('measuredAt 非法日期 → 抛错', () => {
    expect(() => parseJson(fixture({ main: layer({ measuredAt: '去年' }) }))).toThrow(/measuredAt/);
  });
});

describe('thresholdsOf：vitest 只从 floor 取值', () => {
  it('四项均来自 floor 且无多余键', () => {
    const file = parseJson(fixture({ renderer: layer({ floor: set(59, 50, 54, 59) }) }));
    expect(thresholdsOf(file, 'renderer')).toEqual({
      statements: 59,
      branches: 50,
      functions: 54,
      lines: 59,
    });
  });
});

describe('validateCoverageFloors：棘轮与自洽', () => {
  it('自洽真源通过', () => {
    expect(validateCoverageFloors(parseJson(fixture()), TODAY)).toEqual([]);
  });

  it('floor 低于 ratchet → 静默降级被拦', () => {
    const file = parseJson(fixture({ renderer: layer({ floor: set(59, 50, 54, 59) }) }));
    const problems = validateCoverageFloors(file, TODAY);
    expect(problems.map((p) => p.key)).toContain('renderer.statements');
    expect(problems[0]?.detail).toMatch(/棘轮下限/);
  });

  it('measured 低于 floor → 美化实测被拦', () => {
    const file = parseJson(fixture({ main: layer({ measured: set(70, 85, 88, 90) }) }));
    const problems = validateCoverageFloors(file, TODAY);
    expect(problems.map((p) => p.key)).toEqual(['main.statements']);
    expect(problems[0]?.detail).toMatch(/数字不自洽/);
  });

  it('实测过期 → 拦并要求重跑', () => {
    const file = parseJson(fixture({ shared: layer({ measuredAt: '2026-01-01' }) }));
    const problems = validateCoverageFloors(file, TODAY);
    expect(problems[0]?.key).toBe('shared.measuredAt');
    expect(problems[0]?.detail).toMatch(/已过期/);
  });

  it('实测时间在未来 → 拦', () => {
    const file = parseJson(fixture({ shared: layer({ measuredAt: '2027-01-01' }) }));
    expect(validateCoverageFloors(file, TODAY)[0]?.detail).toMatch(/未来/);
  });
});

describe('proposeTighten / raiseSet：只能升', () => {
  it('实测有余量时升到 min(规范目标, 实测−缓冲)', () => {
    const entry = layer({
      specTarget: set(80, 75, 80, 80),
      floor: set(60, 50, 54, 59),
      ratchet: set(60, 50, 54, 59),
      measured: set(90, 85, 88, 90),
    });
    expect(proposeTighten(entry)).toEqual(set(80, 75, 80, 80));
  });

  it('实测贴着门槛时不动（不得凭空上调）', () => {
    const entry = layer({
      floor: set(59, 50, 54, 59),
      ratchet: set(59, 50, 54, 59),
      measured: set(60, 51, 55, 60),
    });
    expect(proposeTighten(entry)).toEqual(set(59, 50, 54, 59));
  });

  it('实测小数向下取整，避免把门槛写成不可能复现的精度', () => {
    const entry = layer({
      specTarget: set(100, 100, 100, 100),
      floor: set(1, 1, 1, 1),
      ratchet: set(1, 1, 1, 1),
      measured: set(72.9, 72.1, 72.5, 72.99),
    });
    const floor = proposeTighten(entry);
    expect(floor.statements).toBe(Math.floor(72.9 - MEASURE_BUFFER));
    expect(floor.functions).toBe(67);
  });

  it('raiseSet 逐项取大', () => {
    expect(raiseSet(set(1, 9, 3, 4), set(5, 2, 3, 9))).toEqual(set(5, 9, 3, 9));
  });
});

describe('applyTighten：文本级回填，保留治理注释', () => {
  const raw = [
    '{',
    '  "$comment": "治理说明不得丢失",',
    '  "maxStaleDays": 60,',
    '  "layers": {',
    '    "shared": {',
    '      "$comment": "类型包定位",',
    '      "specTarget": { "statements": 80, "branches": 30, "functions": 40, "lines": 80 },',
    '      "floor": { "statements": 80, "branches": 30, "functions": 39, "lines": 80 },',
    '      "ratchet": { "statements": 80, "branches": 30, "functions": 39, "lines": 80 },',
    '      "measured": { "statements": 89.06, "branches": 44.44, "functions": 44.82, "lines": 88.95 },',
    '      "measuredAt": "2026-08-27"',
    '    },',
    '    "main": {',
    '      "specTarget": { "statements": 80, "branches": 75, "functions": 80, "lines": 80 },',
    '      "floor": { "statements": 70, "branches": 70, "functions": 70, "lines": 70 },',
    '      "ratchet": { "statements": 70, "branches": 70, "functions": 70, "lines": 70 },',
    '      "measured": { "statements": 92, "branches": 91, "functions": 90, "lines": 93 },',
    '      "measuredAt": "2026-08-27"',
    '    },',
    '    "renderer": {',
    '      "specTarget": { "statements": 80, "branches": 75, "functions": 80, "lines": 80 },',
    '      "floor": { "statements": 59, "branches": 50, "functions": 54, "lines": 59 },',
    '      "ratchet": { "statements": 59, "branches": 50, "functions": 54, "lines": 59 },',
    '      "measured": { "statements": 64.06, "branches": 55.91, "functions": 59.96, "lines": 64.87 },',
    '      "measuredAt": "2026-08-27"',
    '    }',
    '  }',
    '}',
    '',
  ].join('\n');

  it('只升有实测余量的层，其他层保持不动', () => {
    const file = parseCoverageFloors(raw);
    const { text, changed } = applyTighten(raw, file);
    expect(changed).toEqual(['main: floor 70/70/70/70 → 80/75/80/80，ratchet → 80/75/80/80']);
    expect(text).toContain(
      '"floor": { "statements": 80, "branches": 75, "functions": 80, "lines": 80 }',
    );
    expect(text).toContain(
      '"floor": { "statements": 59, "branches": 50, "functions": 54, "lines": 59 }',
    );
    expect(text).toContain(
      '"floor": { "statements": 80, "branches": 30, "functions": 39, "lines": 80 }',
    );
  });

  it('保留 $comment 与 measured 原值（不整体 stringify）', () => {
    const { text } = applyTighten(raw, parseCoverageFloors(raw));
    expect(text).toContain('"$comment": "类型包定位"');
    expect(text).toContain('"measured": { "statements": 89.06');
    expect(text.endsWith('}\n')).toBe(true);
  });

  it('回填结果再解析仍自洽（floor ≥ ratchet、measured ≥ floor）', () => {
    const { text } = applyTighten(raw, parseCoverageFloors(raw));
    expect(validateCoverageFloors(parseCoverageFloors(text), TODAY)).toEqual([]);
  });

  it('幂等：二次回填无变更', () => {
    const once = applyTighten(raw, parseCoverageFloors(raw)).text;
    expect(applyTighten(once, parseCoverageFloors(once)).changed).toEqual([]);
  });
});

describe('renderFloorsTable：真实差距必须可见', () => {
  it('已达目标的指标显示 ✓，缺口显示 -Npp', () => {
    const file = parseJson(
      fixture({ renderer: layer({ floor: set(59, 50, 54, 59), ratchet: set(59, 50, 54, 59) }) }),
    );
    const rows = renderFloorsTable(file);
    expect(rows[0]).toBe(FLOORS_TABLE_HEADER);
    expect(rows.length).toBe(1 + LAYER_KEYS.length);
    expect(rows[1]).toContain('✓');
    const rendererRow = rows.find((r) => r.startsWith('  renderer'));
    expect(rendererRow).toContain('59/50/54/59');
    expect(rendererRow).toContain('-21pp');
  });
});

describe('真实仓库接线（回归防护）', () => {
  it('scripts/coverage-floors.json 自身通过全部校验', () => {
    const file = loadCoverageFloors(join(REPO_ROOT, 'scripts/coverage-floors.json'));
    expect(validateCoverageFloors(file, new Date())).toEqual([]);
  });

  it('三张 vitest.config.ts 都从真源取门槛，且不再内联数字', () => {
    expect(validateConfigWiring(REPO_ROOT)).toEqual([]);
  });

  it.each(LAYER_KEYS)('%s 层门槛与 vitest 读取的键一致', (layerKey) => {
    const text = readFileSync(join(REPO_ROOT, LAYER_CONFIGS[layerKey]), 'utf-8');
    expect(text).toContain(`layers.${layerKey}.floor`);
    const file = loadCoverageFloors(join(REPO_ROOT, 'scripts/coverage-floors.json'));
    expect(Object.keys(thresholdsOf(file, layerKey)).sort()).toEqual([
      'branches',
      'functions',
      'lines',
      'statements',
    ]);
  });

  it('渲染层门槛不得被伪造成业务层规范值', () => {
    const file = loadCoverageFloors(join(REPO_ROOT, 'scripts/coverage-floors.json'));
    const rendererFloor = formatMetricSet(file.layers.renderer.floor);
    expect(rendererFloor === '80/75/80/80').toBe(false);
  });
});

describe('接线校验能抓到真实回归', () => {
  it('config 内联数字被抓；缺失配置被报', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'cov-floors-'));
    try {
      mkdirSync(join(tmp, 'src/main'), { recursive: true });
      const good = readFileSync(join(REPO_ROOT, LAYER_CONFIGS.main), 'utf-8');
      writeFileSync(
        join(tmp, LAYER_CONFIGS.main),
        good.replace('thresholds: {', 'thresholds: { statements: 42,'),
        'utf-8',
      );
      const problems = validateConfigWiring(tmp);
      expect(problems.some((p) => p.key === 'main.config' && /内联数字/.test(p.detail))).toBe(true);
      expect(
        problems.some((p) => p.key === 'shared.config' && /读不到配置文件/.test(p.detail)),
      ).toBe(true);
      expect(problems.filter((p) => p.key === 'main.config')).toHaveLength(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
