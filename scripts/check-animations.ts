// scripts/check-animations.ts
// 动画引用完整性门禁：断言 animation 引用的名字都有 @keyframes 定义
// ──────────────────────────────────────────────────────────────
// 背景（2026-09 修复）：实测发现 3 处失效动画引用——浏览器静默丢弃整条
// animation 声明（元素退化为无动画），而 lint / typecheck / 组件测试全绿
// （组件测试只断言「有该类名」，类名再错也通过）：
//   - browser-pane.tsx 的 animate-[br-loading-bar_…]（定义随 prototype-v2.html
//     在 4980885 删除，类名在其后的 82bc2d6 才引入）
//   - globals.css 的 .palette-overlay / .palette 的 animation: fadein / modalin
// 与 check:css-vars（var(--x) 未定义）同属「防静默失效」家族。
//
// 运行：pnpm check:animations
// ──────────────────────────────────────────────────────────────

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  type AnimationRef,
  extractArbitraryAnimateNames,
  extractCssAnimationRefsWithLines,
  extractKeyframeNames,
  findMissingAnimations,
} from './lib/animations';

const ROOT = join(import.meta.dirname, '..');
const STYLE_FILES = ['src/renderer/styles/globals.css', 'src/renderer/styles/tokens.css'];
const COMPONENT_DIR = join(ROOT, 'src/renderer/components');
/** 扫描时跳过的目录名 */
const SKIP_DIRS: ReadonlySet<string> = new Set(['node_modules', 'out', 'coverage', '.vite']);

/** 递归收集 tsx 文件（测试文件不扫描：测试里的类名断言不代表产线样式） */
function collectTsx(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTsx(full, acc);
    } else if (entry.name.endsWith('.tsx') && !/\.test\.tsx$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

function rel(file: string): string {
  return file.replace(`${ROOT}\\`, '').replace(`${ROOT}/`, '').split('\\').join('/');
}

function main(): void {
  const refs: AnimationRef[] = [];
  const defined = new Set<string>();

  // 定义：全部样式文件的 @keyframes
  for (const stylePath of STYLE_FILES) {
    const css = readFileSync(join(ROOT, stylePath), 'utf8');
    for (const name of extractKeyframeNames(css)) defined.add(name);
    for (const { name, line } of extractCssAnimationRefsWithLines(css)) {
      refs.push({ name, file: stylePath, line });
    }
  }

  // 引用：组件里的 Tailwind 任意值动画（行号按行定位，便于报错时点击跳转）
  let tsxCount = 0;
  for (const file of collectTsx(COMPONENT_DIR)) {
    tsxCount += 1;
    readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .forEach((line, index) => {
        for (const name of extractArbitraryAnimateNames(line)) {
          refs.push({ name, file: rel(file), line: index + 1 });
        }
      });
  }

  const missing = findMissingAnimations(refs, defined);
  if (missing.length > 0) {
    console.error(`[check-animations] ❌ ${missing.length} 处动画引用无 @keyframes 定义：`);
    for (const m of missing) {
      console.error(`  ${m.file}:${m.line}  animation: ${m.name}`);
    }
    console.error(
      '[check-animations] 修复：在 src/renderer/styles/globals.css 补 @keyframes ' +
        '（原型 prototype-v2.html 已删，可查 git 历史取回原定义），或改用已有动画名',
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `[check-animations] ✅ 通过：${refs.length} 处动画引用均有 @keyframes 定义` +
      `（${defined.size} 个 keyframes，扫描 ${STYLE_FILES.length} 样式 + ${tsxCount} 组件）`,
  );
}

main();
