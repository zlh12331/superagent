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
const STYLE_FILES = [
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

function rel(file: string): string {
  return file.replace(`${ROOT}\\`, '').replace(`${ROOT}/`, '').split('\\').join('/');
}

function main(): void {
  const refs: AnimationRef[] = [];
  const defined = new Set<string>();

  for (const stylePath of STYLE_FILES) {
    const css = readFileSync(join(ROOT, stylePath), 'utf8');
    for (const name of extractKeyframeNames(css)) defined.add(name);
    for (const { name, line } of extractCssAnimationRefsWithLines(css)) {
      refs.push({ name, file: stylePath, line });
    }
  }

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
