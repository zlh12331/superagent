// scripts/lib/css-vars.test.ts
// CSS 变量引用完整性规则核反例 fixture 测试
// ──────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';

import { extractRefs, findMissingVars, isRuntimeInjected, scanCssVars } from './css-vars';

describe('extractRefs（引用提取）', () => {
  it('反例：var(--x) → 提取', () => {
    expect(extractRefs('color: var(--brand);')).toEqual(['--brand']);
  });

  it('豁免：var(--x, #fff) 带 fallback → 不提取（有确定取值）', () => {
    expect(extractRefs('color: var(--maybe-missing, #fff);')).toEqual([]);
  });

  it('豁免：注释行（// /* *）不提取（说明文字中的示例非真实引用）', () => {
    expect(extractRefs('// var(--doc-example)')).toEqual([]);
    expect(extractRefs('/* var(--doc-example)')).toEqual([]);
    expect(extractRefs(' * var(--doc-example)')).toEqual([]);
  });
});

describe('isRuntimeInjected（运行时注入豁免）', () => {
  it('--radix-* / --spacing 前缀 → 豁免', () => {
    expect(isRuntimeInjected('--radix-select-width')).toBe(true);
    expect(isRuntimeInjected('--spacing-md')).toBe(true);
  });

  it('普通令牌 → 不豁免', () => {
    expect(isRuntimeInjected('--brand')).toBe(false);
  });
});

describe('scanCssVars + findMissingVars（定义收集与缺口判定）', () => {
  it('反例：引用未定义变量 → 缺口', () => {
    const scan = scanCssVars('.x { color: var(--never-defined); }');
    expect(findMissingVars(scan.references, scan.defined)).toHaveLength(1);
  });

  it('正例：同文件先定义后引用 → 无缺口', () => {
    const scan = scanCssVars(':root { --brand: red; }\n.x { color: var(--brand); }');
    expect(findMissingVars(scan.references, scan.defined)).toHaveLength(0);
  });

  it('两遍扫描口径：定义在另一文件（tokens.css）→ 以并集判定无缺口', () => {
    const tokens = scanCssVars(':root { --brand: red; }');
    const component = scanCssVars('.x { color: var(--brand); }');
    const globalDefined = new Set([...tokens.defined, ...component.defined]);
    expect(findMissingVars(component.references, globalDefined)).toHaveLength(0);
  });

  it('运行时注入前缀 → 缺口判定豁免', () => {
    const scan = scanCssVars('.x { width: var(--radix-trigger-width); }');
    expect(findMissingVars(scan.references, scan.defined)).toHaveLength(0);
  });
});
