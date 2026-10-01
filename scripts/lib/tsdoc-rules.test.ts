// scripts/lib/tsdoc-rules.test.ts
// TSDoc 覆盖门禁规则核反例 fixture 测试：违规命中 / 干净放过 / 边界形态
// ──────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';

import { scanTsdoc } from './tsdoc-rules';

const namesOf = (content: string): string[] =>
  scanTsdoc(content, 'a.ts').missing.map((m) => m.name);

describe('目标声明 · 无 TSDoc 必命中', () => {
  it('export function 无注释 → 命中', () => {
    expect(namesOf('export function f(a: string): number { return 1; }')).toEqual(['f']);
  });

  it('export class / interface / type / enum 无注释 → 全部命中', () => {
    const content = [
      'export class C {}',
      'export interface I { x: number }',
      'export type T = string;',
      'export enum E { A }',
    ].join('\n');
    expect(namesOf(content)).toEqual(['C', 'I', 'T', 'E']);
  });

  it('export default function 无注释 → 命中', () => {
    expect(namesOf('export default function f() { return 1; }')).toEqual(['f']);
  });

  it('注释是普通块注释（非 /**）→ 视为无 TSDoc', () => {
    const content = ['/* 说明但不是 TSDoc */', 'export function f() {}'].join('\n');
    expect(namesOf(content)).toEqual(['f']);
  });

  it('JSDoc 与声明之间隔了代码 → 不算前置（间隔含非空白）', () => {
    const content = ['/** 给别的声明 */', 'const x = 1;', 'export function f() {}'].join('\n');
    expect(namesOf(content)).toEqual(['f']);
  });

  it('JSDoc 与声明之间仅隔 biome-ignore 指令行 → 视为前置（I 前缀接口既有形态）', () => {
    const content = [
      '/** 描述 */',
      '// biome-ignore lint/style/useNamingConvention: I 前缀惯例',
      'export interface IFoo { x: number }',
    ].join('\n');
    expect(namesOf(content)).toEqual([]);
  });
});

describe('正例与豁免形态', () => {
  it('带 JSDoc 的 function → 放过', () => {
    const content = ['/** 描述 */', 'export function f(a: string): number { return 1; }'].join(
      '\n',
    );
    const scan = scanTsdoc(content, 'a.ts');
    expect(scan.missing).toHaveLength(0);
    expect(scan.documented).toBe(1);
  });

  it('多行 JSDoc（@param 等）→ 放过', () => {
    const content = [
      '/**',
      ' * 描述',
      ' * @param a - 参数',
      ' * @returns 返回值',
      ' */',
      'export function f(a: string): number { return 1; }',
    ].join('\n');
    expect(scanTsdoc(content, 'a.ts').missing).toHaveLength(0);
  });

  it('重载签名 TSDeclareFunction → 跳过（文档责任在实现签名）', () => {
    const content = [
      'export function f(a: string): number;',
      'export function f(a: string | number): number { return 1; }',
    ].join('\n');
    // 重载声明跳过；实现声明仍需注释 → 命中实现
    expect(namesOf(content)).toEqual(['f']);
  });

  it('export { x } / export * from → 跳过（责任在被指向声明）', () => {
    const content = ['export { helper } from "./b";', 'export * from "./c";'].join('\n');
    expect(scanTsdoc(content, 'a.ts').missing).toHaveLength(0);
  });

  it('非 export 的内部函数 → 不扫描（规范只管 export）', () => {
    expect(namesOf('function internal() { return 1; }')).toEqual([]);
  });

  it('export const → 不计入 missing（规范 18.1 未列），仅统计 constMissing', () => {
    const scan = scanTsdoc('export const K = 1;', 'a.ts');
    expect(scan.missing).toHaveLength(0);
    expect(scan.constMissing).toBe(1);
  });

  it('空文件 → 无命中', () => {
    expect(scanTsdoc('', 'a.ts').missing).toHaveLength(0);
  });
});

describe('行号与命名', () => {
  it('missing.line 指向声明所在行（1-based）', () => {
    const content = ['const a = 1;', '', 'export function f() {}'].join('\n');
    const scan = scanTsdoc(content, 'a.ts');
    expect(scan.missing[0]?.line).toBe(3);
    expect(scan.missing[0]?.kind).toBe('function');
  });
});
