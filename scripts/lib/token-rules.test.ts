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

  it('反例：css 硬编码 rgba() → 命中（D7 收口后 rgba 必卡关）', () => {
    expect(rulesOf(scanCss('.x { background: rgba(139, 69, 19, 0.15); }', 'a.css'))).toContain(
      'rgb-color',
    );
    expect(rulesOf(scanCss('.x { color: rgb(1, 2, 3); }', 'a.css'))).toContain('rgb-color');
  });

  it('豁免：var(--x) 与 color-mix 效果形态不误报', () => {
    expect(
      scanCss(
        '.x { color: var(--brand); background: color-mix(in srgb, var(--ink-brown) 15%, transparent); }',
        'a.css',
      ),
    ).toHaveLength(0);
    expect(
      scanCss(
        '.y { box-shadow: inset 0 1px 0 color-mix(in srgb, white 30%, transparent); }',
        'a.css',
      ),
    ).toHaveLength(0);
  });

  it('豁免：块注释与行内尾注释中的 hex', () => {
    const content = ['/* #ffffff */', '.x { color: var(--brand); /* #ffffff */ }'].join('\n');
    expect(scanCss(content, 'a.css')).toHaveLength(0);
  });
});

describe('font-size-literal（字号轴收口）', () => {
  it('反例：TSX 任意值 text-[9px] → 命中', () => {
    expect(rulesOf(scanTsLike('className="text-[9px] text-muted-foreground"', 'a.tsx'))).toContain(
      'font-size-literal',
    );
  });

  it('正例：命名阶梯类 text-2xs → 无命中', () => {
    expect(scanTsLike('className="text-2xs text-muted-foreground"', 'a.tsx')).toHaveLength(0);
  });

  it('反例：CSS 裸 px 字号 font-size: 10px → 命中', () => {
    expect(rulesOf(scanCss('.x { font-size: 10px; }', 'a.css'))).toContain('font-size-literal');
  });

  it('正例：var 令牌引用与 em 相对形式 → 无命中', () => {
    expect(
      scanCss('.x { font-size: var(--font-size-sm); } .y { font-size: 1.4em; }', 'a.css'),
    ).toHaveLength(0);
  });
});

describe('css-z-index-literal（CSS 侧 z 层级收口）', () => {
  it('反例：CSS 裸 z-index: 9999（曾静默越过 --z-boundary）→ 命中', () => {
    expect(rulesOf(scanCss('.overlay { z-index: 9999; }', 'a.css'))).toContain(
      'css-z-index-literal',
    );
  });

  it('正例：var(--z-*) 令牌引用 → 无命中', () => {
    expect(scanCss('.x { z-index: var(--z-popover); }', 'a.css')).toHaveLength(0);
  });
});

describe('text-base-color（语义基色禁作文字色）', () => {
  it('反例：四个语义基色作 color: → 命中', () => {
    expect(rulesOf(scanCss('.x { color: var(--error); }', 'a.css'))).toContain('text-base-color');
    expect(rulesOf(scanCss('.x { color: var(--success); }', 'a.css'))).toContain('text-base-color');
    expect(rulesOf(scanCss('.x { color: var(--warning); }', 'a.css'))).toContain('text-base-color');
    expect(rulesOf(scanCss('.x { color: var(--amber); }', 'a.css'))).toContain('text-base-color');
  });

  it('正例：*-text 文字层（含 --warn-text）→ 无命中', () => {
    expect(
      scanCss(
        '.x { color: var(--error-text); } .y { color: var(--success-text); } .z { color: var(--warn-text); }',
        'a.css',
      ),
    ).toHaveLength(0);
  });

  it('边界：background/border 用基色合法（图形/边框/氛围分工）→ 无命中', () => {
    expect(
      scanCss(
        '.x { background: var(--error); border-color: var(--success); background-color: var(--amber); }',
        'a.css',
      ),
    ).toHaveLength(0);
  });

  it('边界：caret-color / accent-color 等复合属性中的 color 字尾不误报', () => {
    expect(
      scanCss('.x { caret-color: var(--error); accent-color: var(--success); }', 'a.css'),
    ).toHaveLength(0);
  });
});

describe('font-cjk-fallback（字体栈 CJK 回退不变量）', () => {
  it('反例：TSX fontFamily 字面量无 CJK → 命中（xterm 终端实测形态）', () => {
    const v = scanTsLike(
      `const term = new Terminal({ fontFamily: '"Cascadia Code", monospace' });`,
      'a.tsx',
    );
    expect(rulesOf(v)).toContain('font-cjk-fallback');
  });

  it('反例：TSX 双引号值无 CJK → 命中', () => {
    const v = scanTsLike(`const style = { fontFamily: "Segoe UI", monospace };`, 'a.tsx');
    expect(rulesOf(v)).toContain('font-cjk-fallback');
  });

  it('反例：CSS font-family 无 CJK → 命中', () => {
    expect(rulesOf(scanCss('.x { font-family: Consolas, monospace; }', 'a.css'))).toContain(
      'font-cjk-fallback',
    );
  });

  it('正例：字面量栈含 CJK 回退 → 无命中（修复后 TerminalView 形态）', () => {
    expect(
      scanTsLike(
        `const term = new Terminal({ fontFamily: '"Cascadia Code", "Microsoft YaHei", monospace' });`,
        'a.tsx',
      ),
    ).toHaveLength(0);
  });

  it('正例：var(--font-*) 令牌引用（TSX 与 CSS）→ 无命中', () => {
    expect(scanTsLike(`const style = { fontFamily: 'var(--font-mono)' };`, 'a.tsx')).toHaveLength(
      0,
    );
    expect(scanCss('.x { font-family: var(--font-mono); }', 'a.css')).toHaveLength(0);
  });

  it('正例：inherit 跟随父级 → 无命中', () => {
    expect(scanCss('.x { font-family: inherit; }', 'a.css')).toHaveLength(0);
  });

  it('正例：修复后的三栈定义（含 CJK）→ 无命中', () => {
    expect(
      scanCss(
        [
          '--font-sans: "SF Pro Text", "PingFang SC", system-ui, "Segoe UI", Roboto, "Microsoft YaHei", sans-serif;',
          '--font-mono: "JetBrains Mono", ui-monospace, Consolas, "Noto Sans SC", "Microsoft YaHei", monospace;',
        ].join('\n'),
        'a.css',
      ),
    ).toHaveLength(0);
  });
});
