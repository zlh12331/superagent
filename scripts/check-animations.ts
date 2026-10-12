// check-animations.ts：动画引用完整性门禁——animation 声明与组件里的 animate-[…] 任意值引用的名字，
// 必须能在白名单样式文件里找到 @keyframes 定义（运行：pnpm check:animations）。
// 为什么要单独设闸：keyframes 被删/改名后 CSS 依旧合法，浏览器不报错、元素只是默默不再动，而 lint /
// typecheck 与组件测试（JSDOM 不执行动画，断言的是类名与 DOM 结构）都发现不了
// ——与 check:css-vars 同属「防静默失效」家族。
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
/** 受管辖的样式文件白名单：定义集与 CSS 侧引用集都只来自这些文件（新增样式文件须登记，否则本闸管不到） */
const STYLE_FILES = [
  // 渲染层根入口（Tailwind import + 少量全局规则）也在管辖内：.search-highlight 的 animation 引用
  // 就在此文件，漏掉它则该引用对应的 keyframe 被删时无人报警
  'src/renderer/index.css',
  'src/renderer/styles/index.css',
  'src/renderer/styles/base.css',
  'src/renderer/styles/layout.css',
  'src/renderer/styles/welcome.css',
  'src/renderer/styles/chat.css',
  'src/renderer/styles/composer.css',
  'src/renderer/styles/cards.css',
  'src/renderer/styles/diff.css',
  'src/renderer/styles/file-tree.css',
  'src/renderer/styles/fuzzy.css',
  'src/renderer/styles/motion.css',
  'src/renderer/styles/tokens.css',
];
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

/** 报错行的路径统一为相对 ROOT 的正斜杠形式（Windows 下 walk 出来的是反斜杠，需归一才跨平台一致） */
function rel(file: string): string {
  return file.replace(`${ROOT}\\`, '').replace(`${ROOT}/`, '').split('\\').join('/');
}

function main(): void {
  const refs: AnimationRef[] = [];
  const defined = new Set<string>();

  // CSS 侧：样式文件既供定义（@keyframes 进 defined），也供引用（animation 声明进 refs）
  for (const stylePath of STYLE_FILES) {
    const css = readFileSync(join(ROOT, stylePath), 'utf8');
    for (const name of extractKeyframeNames(css)) defined.add(name);
    for (const { name, line } of extractCssAnimationRefsWithLines(css)) {
      refs.push({ name, file: stylePath, line });
    }
  }

  // 组件侧：只认 Tailwind 任意值动画类（animate-[…]）；逐行扫描以带出行号，报错可直接定位源文件
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
      '[check-animations] 修复：在 src/renderer/styles/*（按域） 补 @keyframes ' +
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
