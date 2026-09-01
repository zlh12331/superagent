// src/renderer/hooks/__tests__/use-file-tree-ops.property.test.ts
// fast-check 属性测试试点 2/2：joinPath 路径拼接不变量
// ──────────────────────────────────────────────────────────────
// 试点背景（2026-08 讨论收敛）：仅对强纯函数引入属性测试。joinPath 是
// 纯字符串函数（无 IO、无 DOM），语义为「智能拼接路径，消除双分隔符」，
// 手写用例覆盖不了任意分隔符组合，属性测试可系统扫描。
//
// 覆盖的不变量（独立于实现细节的语义约束）：
// 1. 空 parentDir：直接返回 name（原样透传，不凭空加分隔符）
// 2. 前缀保真：parentDir 剥离尾部冗余分隔符后，必须是结果的前缀
// 3. 后缀保真：name 剥离前导分隔符后，必须是结果的后缀
// 4. 连接处恰一个分隔符（核心语义）：
//    result.length === trimmedParent.length + 1 + trimmedName.length
//    —— 即「父 + 单个分隔符 + 名」，既不重复也不缺分隔符。
//    注意：parentDir 中部既有的连续分隔符（如 'a//b'）不在本函数职责内
//    （输入来自规范化文件树），故不纳入不变量。
// ──────────────────────────────────────────────────────────────

import { fc } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';

import { joinPath } from '@/hooks/use-file-tree-ops';

// 路径段：字母数字下划线点（无分隔符，保证 name 内部不引入 / 或 \）
const segmentArb = fc.stringMatching(/[A-Za-z0-9_.]+/);
const sepArb = fc.constantFrom('/', '\\');

// parentDir：段与分隔符的任意交错（允许以分隔符结尾 —— 双分隔符风险的主要来源）
const parentDirArb = fc
  .array(fc.oneof(segmentArb, sepArb), { minLength: 1, maxLength: 8 })
  .map((parts) => parts.join(''));

// name：可选一个前导分隔符 + 非空段（避免 name 全为分隔符的畸形输入）
const nameArb = fc.record({
  leadingSep: fc.boolean(),
  segments: fc.array(segmentArb, { minLength: 1, maxLength: 3 }),
});

/** 三元不变量：前缀/后缀保真 + 连接处恰一个分隔符 */
function assertJoinShape(result: string, parentDir: string, name: string): void {
  const trimmedParent = parentDir.replace(/[\\/]+$/, '');
  const trimmedName = name.replace(/^[\\/]+/, '');
  expect(result.startsWith(trimmedParent)).toBe(true);
  expect(result.endsWith(trimmedName)).toBe(true);
  expect(result.length).toBe(trimmedParent.length + 1 + trimmedName.length);
}

function buildName(leadingSep: boolean, segments: string[]): string {
  return `${leadingSep ? '/' : ''}${segments.join('/')}`;
}

describe('joinPath 属性不变量（fast-check）', () => {
  it('空 parentDir：原样返回 name', () => {
    fc.assert(
      fc.property(nameArb, ({ leadingSep, segments }) => {
        const name = buildName(leadingSep, segments);
        expect(joinPath('', name)).toBe(name);
      }),
      { numRuns: 300 },
    );
  });

  it('前缀/后缀保真 + 连接处恰一个分隔符（相对/绝对/重复尾分隔统一）', () => {
    fc.assert(
      fc.property(parentDirArb, nameArb, (parentDir, { leadingSep, segments }) => {
        assertJoinShape(
          joinPath(parentDir, buildName(leadingSep, segments)),
          parentDir,
          buildName(leadingSep, segments),
        );
      }),
      { numRuns: 800 },
    );
  });

  it('name 无前导分隔符时：结果仅以单个分隔符衔接 parent 与 name', () => {
    fc.assert(
      fc.property(
        parentDirArb,
        fc.array(segmentArb, { minLength: 1, maxLength: 3 }),
        (parentDir, segments) => {
          assertJoinShape(joinPath(parentDir, segments.join('/')), parentDir, segments.join('/'));
        },
      ),
      { numRuns: 500 },
    );
  });

  it('混合分隔符：Windows 反斜杠与 POSIX 正斜杠同串可共存', () => {
    fc.assert(
      fc.property(
        fc
          .array(fc.constantFrom('a', 'b', '\\', '/'), { minLength: 1, maxLength: 8 })
          .map((s) => s.join('')),
        nameArb,
        (parentDir, { leadingSep, segments }) => {
          const name = buildName(leadingSep, segments);
          assertJoinShape(joinPath(parentDir, name), parentDir, name);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('纯分隔符 parentDir（如 \\\\ 或 //）：剥离后空前缀，结果 = 分隔符 + name', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('/', '\\'), { minLength: 1, maxLength: 4 }).map((s) => s.join('')),
        nameArb,
        (parentDir, { leadingSep, segments }) => {
          const name = buildName(leadingSep, segments);
          const result = joinPath(parentDir, name);
          // 全部剥离 → trimmedParent 为空 → 结果仅剩「1 个分隔符 + name」
          // （joinPath 语义：以 parentDir 最后一个分隔符类型衔接，不重不漏）
          expect(result.startsWith('/') || result.startsWith('\\')).toBe(true);
          expect(result.length).toBe(name.replace(/^[\\/]+/, '').length + 1);
          expect(result.endsWith(name.replace(/^[\\/]+/, ''))).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });
});
