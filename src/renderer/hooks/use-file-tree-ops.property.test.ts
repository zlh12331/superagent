import { fc } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';

import { joinPath } from '@/hooks/use-file-tree-ops';

const segmentArb = fc.stringMatching(/[A-Za-z0-9_.]+/);
const sepArb = fc.constantFrom('/', '\\');

const parentDirArb = fc
  .array(fc.oneof(segmentArb, sepArb), { minLength: 1, maxLength: 8 })
  .map((parts) => parts.join(''));

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
          expect(result.startsWith('/') || result.startsWith('\\')).toBe(true);
          expect(result.length).toBe(name.replace(/^[\\/]+/, '').length + 1);
          expect(result.endsWith(name.replace(/^[\\/]+/, ''))).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });
});
