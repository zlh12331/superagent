// scripts/lib/animations.test.ts
// 动画引用完整性（纯函数）单元测试
// ──────────────────────────────────────────────────────────────
// 这组测试守的是「引用不存在的 keyframes」这一类静默失效：
// 浏览器会丢弃整条 animation 声明，而 lint/typecheck/组件测试全绿。
// ──────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AnimationRef,
  extractAnimationNamesFromValue,
  extractArbitraryAnimateNames,
  extractCssAnimationRefs,
  extractCssAnimationRefsWithLines,
  extractKeyframeNames,
  findMissingAnimations,
} from './animations';

const REPO_ROOT = join(import.meta.dirname, '../..');

describe('extractAnimationNamesFromValue', () => {
  it('正向：名字在前段（后跟时长/缓动/迭代）', () => {
    expect(extractAnimationNamesFromValue('pulse-soft 2s var(--ease-soft) infinite')).toEqual([
      'pulse-soft',
    ]);
    expect(extractAnimationNamesFromValue('blink 1s steps(2) infinite')).toEqual(['blink']);
  });

  it('正向：逗号分隔多条动画各取一个名字', () => {
    expect(extractAnimationNamesFromValue('fadein 0.2s, spin 1s linear')).toEqual([
      'fadein',
      'spin',
    ]);
  });

  it('边界：none / 纯关键字值不产生名字', () => {
    expect(extractAnimationNamesFromValue('none')).toEqual([]);
    expect(extractAnimationNamesFromValue('')).toEqual([]);
    expect(extractAnimationNamesFromValue('   ')).toEqual([]);
  });

  it('边界：var() 与缓动函数不会被误当名字', () => {
    expect(extractAnimationNamesFromValue('var(--anim) 1s')).toEqual([]);
    expect(extractAnimationNamesFromValue('cubic-bezier(0.34, 1.56, 0.64, 1) 1s')).toEqual([]);
  });

  it('边界：值尾带分号仍能取出名字', () => {
    expect(extractAnimationNamesFromValue('runningBar 1.5s ease-in-out infinite;')).toEqual([
      'runningBar',
    ]);
  });
});

describe('extractArbitraryAnimateNames', () => {
  it('正向：animate-[name_1s_ease-in-out_infinite]', () => {
    expect(
      extractArbitraryAnimateNames(
        'className="bg-primary h-0.5 animate-[browser-loading-bar_1.5s_ease-in-out_infinite]"',
      ),
    ).toEqual(['browser-loading-bar']);
  });

  it('边界：无任意值动画 → 空数组', () => {
    expect(extractArbitraryAnimateNames('className="animate-spin animate-in"')).toEqual([]);
  });

  it('边界：shadow-* 任意值不误检（只认 animate-[）', () => {
    expect(extractArbitraryAnimateNames('shadow-[0_0_8px_var(--accent-glow)]')).toEqual([]);
  });
});

describe('extractKeyframeNames', () => {
  it('收集全部 @keyframes 名（含大小写混合与连字符）', () => {
    const css = `
      @keyframes blink { 50% { opacity: 0 } }
      @keyframes browser-loading-bar { from { opacity: 0 } }
      @keyframes runningBar { to { opacity: 1 } }
    `;
    expect(extractKeyframeNames(css).sort()).toEqual([
      'blink',
      'browser-loading-bar',
      'runningBar',
    ]);
  });
});

describe('extractCssAnimationRefs', () => {
  it('正向：animation 简写与 animation-name 都能取名字', () => {
    const css = '.a { animation: fadein 0.15s ease; }\n.b { animation-name: modalin; }';
    expect(extractCssAnimationRefs(css).sort()).toEqual(['fadein', 'modalin']);
  });

  it('边界：注释行里的举例不算引用', () => {
    const css = '// 注意：animation: nonexistent 1s 只是举例\n.a { animation: blink 1s; }';
    expect(extractCssAnimationRefs(css)).toEqual(['blink']);
  });

  it('边界：animation: none 不产生引用', () => {
    expect(extractCssAnimationRefs('.a { animation: none; }')).toEqual([]);
  });
});

describe('extractCssAnimationRefsWithLines', () => {
  it('行号准确（报错信息可点击跳转）', () => {
    const css = [
      '.a {',
      '  animation: fadein 0.15s;',
      '}',
      '.b {',
      '  animation-name: modalin;',
      '}',
    ].join('\n');
    expect(extractCssAnimationRefsWithLines(css)).toEqual([
      { name: 'fadein', line: 2 },
      { name: 'modalin', line: 5 },
    ]);
  });

  it('边界：同一行多条动画都带同一行号', () => {
    const css = '.a { animation: one 1s, two 2s; }';
    expect(extractCssAnimationRefsWithLines(css)).toEqual([
      { name: 'one', line: 1 },
      { name: 'two', line: 1 },
    ]);
  });
});

describe('findMissingAnimations', () => {
  it('正向：未定义的名字被挑出，已定义的保留', () => {
    const refs: AnimationRef[] = [
      { name: 'blink', file: 'a.css', line: 1 },
      { name: 'ghost', file: 'b.css', line: 2 },
    ];
    const missing = findMissingAnimations(refs, new Set(['blink']));
    expect(missing).toEqual([{ name: 'ghost', file: 'b.css', line: 2 }]);
  });

  it('边界：全部有定义 → 空', () => {
    const refs: AnimationRef[] = [{ name: 'blink', file: 'a.css', line: 1 }];
    expect(findMissingAnimations(refs, new Set(['blink']))).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────
// 仓库现状回归锚：本次修复前这里有 3 处失效引用（br-loading-bar /
// fadein / modalin）。该断言把「仓库当前无失效动画引用」固化下来——
// 无此锚点，将来再删 keyframes 而漏改引用不会被任何门禁拦住。
// ──────────────────────────────────────────────────────────────

describe('仓库现状（styles/globals.css + renderer components）', () => {
  const Styles = ['src/renderer/styles/globals.css', 'src/renderer/styles/tokens.css'];

  function readAll(paths: readonly string[]): string {
    return paths.map((p) => readFileSync(join(REPO_ROOT, p), 'utf8')).join('\n');
  }

  it('globals.css 的 animation 引用全部有 @keyframes 定义', () => {
    const css = readAll(Styles);
    const defined = new Set(extractKeyframeNames(css));
    const refs = extractCssAnimationRefs(css).map(
      (name, i): AnimationRef => ({ name, file: 'globals.css', line: i }),
    );
    expect(findMissingAnimations(refs, defined)).toEqual([]);
  });

  it('browser-pane 的加载条动画名在 globals.css 中有定义', () => {
    const pane = readFileSync(
      join(REPO_ROOT, 'src/renderer/components/browser/browser-pane.tsx'),
      'utf8',
    );
    const defined = new Set(extractKeyframeNames(readAll(Styles)));
    for (const name of extractArbitraryAnimateNames(pane)) {
      expect(defined.has(name)).toBe(true);
    }
  });
});
