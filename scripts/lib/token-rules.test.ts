// scripts/lib/token-rules.test.ts
// 设计令牌规则核反例 fixture 测试：每条铁律「最小违规样本必须命中 + 干净样本必须放过」
// ──────────────────────────────────────────────────────────────
// 背景外部审计点名 check-tokens 判据内联零测试——本文件补齐。
// ──────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';

import { scanCss, scanTsLike } from './token-rules';

const rulesOf = (violations: ReturnType<typeof scanTsLike>): string[] =>
  [...new Set(violations.map((v) => v.rule))].sort();

describe('铁律① bare-color（裸色值）', () => {
  it('反例：bg-red-500 → 命中', () => {
    const v = scanTsLike('<div className="bg-red-500" />', 'a.tsx');
    expect(rulesOf(v)).toContain('bare-color');
  });

  it('反例：无阶白/黑 bg-white → 命中', () => {
    expect(rulesOf(scanTsLike('<div className="bg-white" />', 'a.tsx'))).toContain('bare-color');
  });

  it('豁免：monoExempt 文件（存量基线）bg-white 不命中', () => {
    expect(scanTsLike('<div className="bg-white" />', 'badge.tsx', true)).toHaveLength(0);
  });

  it('正例：语义令牌 bg-primary → 无命中', () => {
    expect(scanTsLike('<div className="bg-primary" />', 'a.tsx')).toHaveLength(0);
  });
});

describe('铁律② dark-override（手动 dark: 双写）', () => {
  it('反例：dark:bg-x → 命中', () => {
    expect(rulesOf(scanTsLike('<div className="text-foreground dark:bg-x" />', 'a.tsx'))).toContain(
      'dark-override',
    );
  });

  it('正例：无 dark: 前缀 → 无命中', () => {
    expect(scanTsLike('<div className="text-foreground" />', 'a.tsx')).toHaveLength(0);
  });
});

describe('铁律④ space-util（space-x/y）', () => {
  it('反例：space-x-4 → 命中', () => {
    expect(rulesOf(scanTsLike('<div className="space-x-4" />', 'a.tsx'))).toContain('space-util');
  });

  it('正例：flex gap-4 → 无命中', () => {
    expect(scanTsLike('<div className="flex gap-4" />', 'a.tsx')).toHaveLength(0);
  });
});

describe('铁律⑤ w-h-double（w-N h-N 双写）', () => {
  it('反例：等值 w-4 h-4 → 命中', () => {
    const v = scanTsLike('<div className="w-4 h-4" />', 'a.tsx');
    expect(rulesOf(v)).toContain('w-h-double');
  });

  it('边界：非等值 w-4 h-5 → 不命中', () => {
    expect(rulesOf(scanTsLike('<div className="w-4 h-5" />', 'a.tsx'))).not.toContain('w-h-double');
  });

  it('正例：size-4 → 无命中', () => {
    expect(scanTsLike('<div className="size-4" />', 'a.tsx')).toHaveLength(0);
  });
});

describe('hex-color / rgb-color（硬编码颜色）', () => {
  it('反例：className 内 #ff0000 → 命中', () => {
    expect(rulesOf(scanTsLike('<div className="text-[#ff0000]" />', 'a.tsx'))).toContain(
      'hex-color',
    );
  });

  it('反例：rgb()/rgba() → 命中（须在类名字符串语境）', () => {
    const content = `<div className="p-2 bg-[rgba(1,2,3,0.5)]" />`;
    expect(rulesOf(scanTsLike(content, 'a.tsx'))).toContain('rgb-color');
  });

  it('豁免：var(--token) 片段内的形态不误报', () => {
    expect(scanTsLike('<div className="text-(--brand)" />', 'a.tsx')).toHaveLength(0);
    expect(scanTsLike("<div style={{ color: 'var(--brand)' }} />", 'a.tsx')).toHaveLength(0);
  });
});

describe('bare-z-index（裸 z 数字）', () => {
  it('反例：z-50 与 hover:z-50 → 命中', () => {
    expect(rulesOf(scanTsLike('<div className="z-50" />', 'a.tsx'))).toContain('bare-z-index');
    expect(rulesOf(scanTsLike('<div className="hover:z-50" />', 'a.tsx'))).toContain(
      'bare-z-index',
    );
  });

  it('正例：z-(--z-popover) 变量形式 → 无命中', () => {
    expect(scanTsLike('<div className="z-(--z-popover)" />', 'a.tsx')).toHaveLength(0);
  });
});

describe('注释行豁免', () => {
  it('边界：// 与 /* 与 * 开头的行不扫', () => {
    const content = [
      '// className="bg-red-500"',
      '/* className="bg-red-500" */',
      '* bg-red-500',
    ].join('\n');
    expect(scanTsLike(content, 'a.tsx')).toHaveLength(0);
  });
});

describe('scanCss（css 硬编码 hex）', () => {
  it('反例：css 语句内 #ffffff → 命中', () => {
    expect(rulesOf(scanCss('.x { color: #ffffff; }', 'a.css'))).toContain('hex-color');
  });

  it('豁免：var(--x) 与 rgba 效果色（debt.md#d7 边界）', () => {
    expect(
      scanCss('.x { color: var(--brand); background: rgba(0,0,0,0.1); }', 'a.css'),
    ).toHaveLength(0);
  });

  it('豁免：块注释与行内尾注释中的 hex', () => {
    const content = ['/* #ffffff */', '.x { color: var(--brand); /* #ffffff */ }'].join('\n');
    expect(scanCss(content, 'a.css')).toHaveLength(0);
  });
});
