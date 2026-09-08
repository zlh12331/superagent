// scripts/lib/function-metrics.test.ts
// 函数度量单测：形参计数（解构不再豁免）+ 花括号深度函数体行数
import { describe, expect, it } from 'vitest';
import {
  countParams,
  findBodyOpen,
  measureBodyLines,
  scanFunctions,
  splitTopLevelParams,
  stripGenerics,
} from './function-metrics';

describe('stripGenerics', () => {
  it('多层嵌套泛型全部剔除', () => {
    expect(stripGenerics('a: Map<string, Map<number, string>>')).toBe('a: Map');
  });
  it('无泛型时原样返回', () => {
    expect(stripGenerics('a: string, b: number')).toBe('a: string, b: number');
  });
});

describe('splitTopLevelParams', () => {
  it('嵌套括号/花括号内的逗号不切分', () => {
    expect(splitTopLevelParams('a, { b, c }, (d, e) => f, [g, h]')).toHaveLength(4);
  });
  it('尾随逗号不产生空参数', () => {
    expect(splitTopLevelParams('a, b,')).toHaveLength(2);
  });
  it('空参数表返回空数组', () => {
    expect(splitTopLevelParams('')).toEqual([]);
  });
});

describe('countParams', () => {
  it('解构对象参数按 1 计（对象封装是合规写法，不是整函数豁免）', () => {
    expect(countParams('{ a, b, c }, d')).toEqual({ count: 2, destructured: true });
  });
  it('数组解构同样识别为首参解构', () => {
    expect(countParams('[a, b], c').count).toBe(2);
    expect(countParams('[a, b], c').destructured).toBe(true);
  });
  it('泛型逗号不误计', () => {
    expect(countParams('m: Map<string, number>, n: number').count).toBe(2);
  });
  it('默认值与可选参数按声明个数计', () => {
    expect(countParams('a?: string, b = 1, ...rest: number[]').count).toBe(3);
  });
  it('无参函数计 0', () => {
    expect(countParams('').count).toBe(0);
  });
  it('非解构首参时 destructured=false', () => {
    expect(countParams('a: number, { b }: B').destructured).toBe(false);
  });
});

describe('measureBodyLines', () => {
  const src = (body: string): string => `function f() {\n${body}\n}`;
  const idxOf = (s: string): number => s.indexOf('{');

  it('基本花括号深度', () => {
    expect(measureBodyLines(src('  const a = 1;\n  return a;'), idxOf(src('x')))).toBe(4);
  });
  it('嵌套块不提前闭合', () => {
    const s = src('  if (a) {\n    if (b) {\n      c();\n    }\n  }');
    expect(measureBodyLines(s, idxOf(s))).toBe(7);
  });
  it('字符串与模板串中的花括号不计深度', () => {
    const s = src('  const a = "{{{";\n  const b = `}}`;\n  return a + b;');
    expect(measureBodyLines(s, idxOf(s))).toBe(5);
  });
  it('注释中的花括号不计深度', () => {
    const s = src('  // }}}\n  /* {{{ */\n  return 1;');
    expect(measureBodyLines(s, idxOf(s))).toBe(5);
  });
  it('跨行模板串按物理行计数', () => {
    const s = src('  const t = `a\nb\nc`;');
    expect(measureBodyLines(s, idxOf(s))).toBe(5);
  });
  it('未闭合时返回到文件末尾（不误返回 0）', () => {
    const s = 'function f() {\n  a();\n  b();';
    expect(measureBodyLines(s, s.indexOf('{'))).toBe(3);
  });
  it('起始下标非法返回 0', () => {
    expect(measureBodyLines('abc', -1)).toBe(0);
    expect(measureBodyLines('abc', 99)).toBe(0);
  });
});

describe('findBodyOpen', () => {
  it('签名后第一个非空白字符是花括号才认定为函数体', () => {
    const s = 'const f = (a) =>\n  {\n  b();\n}';
    expect(findBodyOpen(s, 17)).toBe(19);
  });
  it('表达式体（返回对象字面量）不算函数体', () => {
    const s = 'const f = (a) => ({ ok: true });';
    expect(findBodyOpen(s, 17)).toBe(-1);
  });
});

describe('scanFunctions', () => {
  it('function 声明：形参 + 体长', () => {
    const source = ['function add(a: number, b: number): number {', '  return a + b;', '}'].join(
      '\n',
    );
    const [fn] = scanFunctions(source);
    expect(fn).toMatchObject({ name: 'add', params: 2, line: 1, bodyLines: 3 });
  });

  it('箭头函数（括号形参列表）', () => {
    const source = 'export const go = async (a, b, c) => {\n  x();\n};';
    const [fn] = scanFunctions(source);
    expect(fn).toMatchObject({ name: 'go', params: 3, bodyLines: 3 });
  });

  it('裸标识符单参箭头不再被跳过（回归：曾整函数漏测）', () => {
    const body = Array.from({ length: 50 }, (_, i) => `  step${i}();`).join('\n');
    const source = `const render = props => {\n${body}\n};`;
    const [fn] = scanFunctions(source);
    expect(fn).toMatchObject({ name: 'render', params: 1, bodyLines: 52 });
  });

  it('表达式体箭头 bodyLines = 0（不参与长度门禁）', () => {
    const [fn] = scanFunctions('const ok = (a: string) => a.length > 0;');
    expect(fn?.bodyLines).toBe(0);
    expect(fn?.params).toBe(1);
  });

  it('const f = function 表达式', () => {
    const [fn] = scanFunctions('const mk = function (a, b, c) {\n  return 1;\n};');
    expect(fn).toMatchObject({ name: 'mk', params: 3, bodyLines: 3 });
  });

  it('注释行中的伪签名被过滤', () => {
    expect(scanFunctions('// function ghost(a, b, c, d, e) {\n// }')).toEqual([]);
    expect(scanFunctions('/* function ghost(a) {} */')).toEqual([]);
  });

  it('同名函数用出现顺序区分（基线 key 由调用方拼接）', () => {
    const source = 'function dup(a) {\n  b();\n}\nfunction dup2(c) {\n  d();\n}';
    expect(scanFunctions(source).map((f) => f.name)).toEqual(['dup', 'dup2']);
  });

  it('多形参跨行签名正确计数', () => {
    const source = [
      'function wide(',
      '  a: string,',
      '  b: number,',
      '  c: boolean,',
      '  d: object,',
      '  e: unknown,',
      ') {',
      '  return e;',
      '}',
    ].join('\n');
    expect(scanFunctions(source)[0]?.params).toBe(5);
  });

  it('对象字面量方法已被覆盖（2026-09-08 补 class/对象方法度量后）', () => {
    const source = 'const handlers = {\n  snapshot(a, b, c, d, e, f) {\n    return 1;\n  },\n};';
    const fns = scanFunctions(source);
    // 对象字面量方法形参与 class 方法同形，现已被 METHOD_RE 覆盖
    expect(fns.map((f) => [f.name, f.params, f.bodyLines])).toEqual([['snapshot', 6, 3]]);
  });

  it('控制流语句不被误配为方法（2026-09-08 修复 if#N 幽灵条目）', () => {
    const source = [
      'function outer(x: number) {',
      '  if (x > 0) {',
      '    return 1;',
      '  }',
      '  for (let i = 0; i < 3; i++) {',
      '    x += i;',
      '  }',
      '  return x;',
      '}',
    ].join('\n');
    const names = scanFunctions(source).map((f) => f.name);
    expect(names).toEqual(['outer']);
    expect(names).not.toContain('if');
    expect(names).not.toContain('for');
  });

  it('显式返回类型标注的箭头不再跨行吞并（回归：曾误报 params 膨胀）', () => {
    const source = [
      'function makeGuards(rootsProvider: () => Promise<string[]>) {',
      '  const guard = (path: string): Promise<string> => confine(path, rootsProvider);',
      '  const guardRead = (path: string): Promise<string> =>',
      '    confine(path, rootsProvider, { allowUserGrant: true });',
      '  return { guard, guardRead };',
      '}',
      'function next(a, b, c, d, e, f) {',
      '  return 1;',
      '}',
    ].join('\n');
    const fns = scanFunctions(source);
    expect(fns.map((f) => [f.name, f.params, f.bodyLines])).toEqual([
      ['makeGuards', 1, 6],
      ['guard', 1, 0],
      ['guardRead', 1, 0],
      ['next', 6, 3],
    ]);
  });

  it('块体箭头带返回类型：形参与体长各自正确', () => {
    const [fn] = scanFunctions('const wide = (a: number, b: number): Foo => {\n  x();\n};');
    expect(fn).toMatchObject({ name: 'wide', params: 2, bodyLines: 3 });
  });

  it('返回类型本身含函数类型仍能闭合签名', () => {
    const [fn] = scanFunctions('const mk = (): (() => void) => {\n  return f;\n};');
    expect(fn).toMatchObject({ name: 'mk', params: 0, bodyLines: 3 });
  });

  it('解构/对象默认值形参按声明个数计', () => {
    const [fn] = scanFunctions('const f = (opts: { a: number } = {}) => {\n  b();\n};');
    expect(fn).toMatchObject({ name: 'f', params: 1, bodyLines: 3 });
  });
});
