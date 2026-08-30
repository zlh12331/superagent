// scripts/lib/ratchet.test.ts
// 棘轮基线工具单测：三类违规（新增 / 变大 / 陈旧）+ 单向收紧
import { describe, expect, it } from 'vitest';
import {
  evaluateRatchet,
  formatMetrics,
  parseBaseline,
  proposeBaseline,
  renderProblems,
  serializeBaseline,
  wantsBaselineUpdate,
  wantsForce,
} from './ratchet';

const METRICS = ['raw', 'net'] as const;

describe('parseBaseline', () => {
  it('接受合法结构并保留指标', () => {
    const base = parseBaseline('{"a.ts":{"raw":700,"net":650}}', METRICS);
    expect(base['a.ts']).toEqual({ raw: 700, net: 650 });
  });

  it('缺指标字段时报错（宁可不放行）', () => {
    expect(() => parseBaseline('{"a.ts":{"raw":700}}', METRICS)).toThrow(/raw|net/);
  });

  it('非对象顶层 / 非数值条目报错', () => {
    expect(() => parseBaseline('[]', METRICS)).toThrow(/顶层必须是对象/);
    expect(() => parseBaseline('{"a.ts":"700"}', METRICS)).toThrow(/必须是指标对象/);
    expect(() => parseBaseline('{"a.ts":{"raw":"700","net":1}}', METRICS)).toThrow(/a\.ts/);
  });
});

describe('serializeBaseline', () => {
  it('key 与指标排序稳定（跨平台 diff 友好）', () => {
    const text = serializeBaseline({
      'z/b.ts': { net: 2, raw: 1 },
      'a.ts': { net: 4, raw: 3 },
    });
    expect(text.indexOf('a.ts')).toBeLessThan(text.indexOf('z/b.ts'));
    expect(text.indexOf('"net"')).toBeLessThan(text.indexOf('"raw"'));
    expect(text.endsWith('\n')).toBe(true);
  });

  it('序列化后可被 parseBaseline 回读（往返一致）', () => {
    const base = { 'a.ts': { raw: 933, net: 841 } };
    expect(parseBaseline(serializeBaseline(base), METRICS)).toEqual(base);
  });
});

describe('evaluateRatchet', () => {
  const baseline = { 'a.ts': { raw: 700, net: 650 } };

  it('基线外新增超限 → new', () => {
    const current = new Map([
      ['a.ts', { raw: 700, net: 650 }],
      ['b.ts', { raw: 601, net: 100 }],
    ]);
    const problems = evaluateRatchet(current, baseline, METRICS);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.kind).toBe('new');
    expect(problems[0]?.key).toBe('b.ts');
  });

  it('任一指标变大 → grown', () => {
    const current = new Map([['a.ts', { raw: 701, net: 10 }]]);
    const problems = evaluateRatchet(current, baseline, METRICS);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.kind).toBe('grown');
    expect(problems[0]?.detail).toContain('raw 700→701');
  });

  it('全部指标变小 → 通过（棘轮允许收紧）', () => {
    const current = new Map([['a.ts', { raw: 690, net: 640 }]]);
    expect(evaluateRatchet(current, baseline, METRICS)).toEqual([]);
  });

  it('基线条目不再超限 → stale（陈旧豁免必须清理）', () => {
    expect(evaluateRatchet(new Map(), baseline, METRICS)[0]?.kind).toBe('stale');
  });

  it('基线与实测完全一致 → 无问题', () => {
    const current = new Map([['a.ts', { raw: 700, net: 650 }]]);
    expect(evaluateRatchet(current, baseline, METRICS)).toEqual([]);
  });
});

describe('proposeBaseline', () => {
  const baseline = { 'a.ts': { raw: 700, net: 650 }, 'gone.ts': { raw: 900, net: 900 } };

  it('默认丢弃已消解条目且不写高数值', () => {
    const current = new Map([
      ['a.ts', { raw: 800, net: 100 }],
      ['b.ts', { raw: 610, net: 605 }],
    ]);
    const next = proposeBaseline(current, baseline, METRICS);
    expect(next['gone.ts']).toBeUndefined();
    expect(next['a.ts']).toEqual({ raw: 700, net: 100 }); // raw 劣化不写高
    expect(next['b.ts']).toEqual({ raw: 610, net: 605 });
  });

  it('force 时如实写入实测（显式承认放宽）', () => {
    const current = new Map([['a.ts', { raw: 800, net: 100 }]]);
    expect(proposeBaseline(current, baseline, METRICS, true)['a.ts']).toEqual({
      raw: 800,
      net: 100,
    });
  });
});

describe('renderProblems / helpers', () => {
  it('按 grown → new → stale 分组并截断超长列表', () => {
    const problems = [
      { kind: 'stale' as const, key: 's.ts', detail: 'x' },
      { kind: 'new' as const, key: 'n.ts', detail: 'x' },
      ...Array.from({ length: 30 }, (_, i) => ({
        kind: 'grown' as const,
        key: `g${i}.ts`,
        detail: 'x',
      })),
    ];
    const lines = renderProblems(problems, 25);
    expect(lines[0]).toContain('劣化 30 处');
    expect(lines.some((l) => l.includes('其余 5 处省略'))).toBe(true);
    expect(lines.at(-2)?.startsWith('— stale')).toBe(false);
    expect(lines.some((l) => l.includes('陈旧基线条目 1 处'))).toBe(true);
  });

  it('formatMetrics 按声明顺序渲染', () => {
    expect(formatMetrics({ net: 3, raw: 9 }, METRICS)).toBe('raw 9 / net 3');
  });

  it('flag 识别', () => {
    expect(wantsBaselineUpdate(['--update-baseline'])).toBe(true);
    expect(wantsBaselineUpdate([])).toBe(false);
    expect(wantsForce(['a', '--force'])).toBe(true);
  });
});
