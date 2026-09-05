// scripts/check-ui-consistency.ts
// 渲染层写法一致性门禁（工程化强制）· 2026-09 一致性审计收敛项 ④
// ──────────────────────────────────────────────────────────────
// 背景：渲染层标准设施（unwrap/confirm() store/useCopy/AsyncSection）已建成，
// 但存量采用率停在中位——本门禁用静态信号阻止「离群写法回潮」。
// 可程序化检测的结构信号（规则 1-4）：
//   1. 数组索引直接作 React key（key={index}/key={i}/key={idx}）
//   2. join(' ') 手工拼接 className（条件类应统一走 cn()）
//   3. 手写 'data' in 判别解包 IPC 响应（应统一 unwrap()）
//   4. components/** 内裸 <button>（应用 ui/button 的 Button，icon 钮用 size="icon"）
// 级别：全部 error（卡关），存量计数走棘轮基线（只允许下降）。
// 基线：scripts/ui-consistency-baseline.json（--update-baseline 重写）
//
// 运行：pnpm check:ui-consistency
// ──────────────────────────────────────────────────────────────

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const SRC = join(ROOT, 'src', 'renderer');
const BASELINE_PATH = join(import.meta.dirname, 'ui-consistency-baseline.json');
const UPDATE_BASELINE = process.argv.includes('--update-baseline');

interface Rule {
  readonly id: string;
  readonly desc: string;
  /** 命中计数正则（逐行匹配） */
  readonly pattern: RegExp;
  /** 适用文件过滤（相对 src/renderer 的路径） */
  readonly fileFilter?: (relFile: string) => boolean;
}

const RULES: readonly Rule[] = [
  {
    id: 'index-key',
    desc: '数组索引直接作 React key（骨架屏/静态拆分用上一行 biome-ignore noArrayIndexKey 豁免）',
    pattern: /key=\{(index|i|idx)\}/,
  },
  {
    id: 'join-class',
    desc: "className 内 join(' ') 手工拼接（条件类统一走 cn()）",
    // 限定 className 上下文：命令参数等业务拼接（如 args.join(' ')）不属样式
    pattern: /className.*\.join\(' '\)|\.join\(' '\).*"/,
    fileFilter: (relFile) => relFile.endsWith('.tsx'),
  },
  {
    id: 'manual-unwrap',
    desc: "手写 'data' in 判别解包 IPC 响应（统一 unwrap()，见 src/renderer/lib/ipc.ts）",
    pattern: /'data' in (res|response|result)\b/,
  },
  {
    id: 'raw-button',
    desc: 'components/** 内裸 <button>（应用 ui/button 的 Button；已归属 globals.css 按钮类体系的除外）',
    pattern: /<button\b/,
    fileFilter: (relFile) =>
      relFile.startsWith(join('components')) && !relFile.startsWith(join('components', 'ui')),
  },
];

/**
 * 已归属 globals.css 按钮类体系的钮（icon-btn/tab/树节点/segmented 等
 * 有专属 CSS 类控制的场景），不属于 raw-button 规则目标——
 * 它们的收敛路径是 globals.css 组件类 utility 化专项，而非套 Button。
 */
const OWNED_CSS_BUTTON_CLASSES = [
  'icon-btn',
  'sidebar-tab',
  'dev-sub-tab',
  'ft-row',
  'ft-dir',
  'ft-file',
  'sft-back',
  'sft-more-btn',
  'cpb-select',
  'model-item',
  'fdm-item',
  'fdm-action-btn',
  'fl-add-btn',
  'folder-label',
  'file-viewer-mode-btn',
  'file-viewer-save-btn',
  'file-viewer-copy-btn',
  'composer-tool-btn',
  'msg-action-btn',
  'card-head',
  'rh-chevron',
];

interface Violation {
  readonly rule: string;
  readonly file: string;
  readonly line: number;
}

function collectFiles(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      // coverage/ 构建产物不入扫描（其内容是源码的历史快照）
      if (name === 'coverage' || name === '__tests__') continue;
      collectFiles(full, out);
    } else if (name.endsWith('.tsx') || name.endsWith('.ts')) {
      out.push(full);
    }
  }
}

const files: string[] = [];
collectFiles(SRC, files);

const violations: Violation[] = [];
for (const full of files) {
  const relFile = relative(SRC, full);
  const lines = readFileSync(full, 'utf8').split('\n');
  for (const rule of RULES) {
    if (rule.fileFilter !== undefined && !rule.fileFilter(relFile)) {
      continue;
    }
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined || !rule.pattern.test(line)) {
        continue;
      }
      // 上一行含 noArrayIndexKey biome-ignore 的豁免（与 Biome 同步：
      // 骨架屏/静态拆分等 index 稳定且无重排的合理场景）
      const prev = i > 0 ? lines[i - 1] : '';
      if (prev !== undefined && prev.includes('noArrayIndexKey')) {
        continue;
      }
      // raw-button 规则：className 已含 globals.css 按钮类体系归属的豁免；
      // 类名在 JSX 起始行或后续 className 行（向前探 3 行）——检测当前按钮
      // 开标签块（回溯至 <button 行）内是否出现归属类名
      if (rule.id === 'raw-button') {
        const blockStart = Math.max(0, i - 3);
        const block = lines.slice(blockStart, i + 4).join('\n');
        if (OWNED_CSS_BUTTON_CLASSES.some((cls) => block.includes(cls))) {
          continue;
        }
      }
      violations.push({ rule: rule.id, file: relFile, line: i + 1 });
    }
  }
}

// 按规则聚合计数，对照棘轮基线
const counts: Record<string, number> = {};
for (const v of violations) {
  counts[v.rule] = (counts[v.rule] ?? 0) + 1;
}

if (UPDATE_BASELINE) {
  writeFileSync(BASELINE_PATH, `${JSON.stringify(counts, null, 2)}\n`);
  console.log(`[check-ui-consistency] 基线已更新：${JSON.stringify(counts)}`);
  process.exit(0);
}

if (!existsSync(BASELINE_PATH)) {
  console.error('[check-ui-consistency] ❌ 缺少基线文件 scripts/ui-consistency-baseline.json');
  process.exit(1);
}

const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Record<string, number>;
const errors: string[] = [];
for (const rule of RULES) {
  const now = counts[rule.id] ?? 0;
  const allowed = baseline[rule.id] ?? 0;
  if (now > allowed) {
    errors.push(`[${rule.id}] 棘轮劣化 ${allowed}→${now}：${rule.desc}`);
  }
}

if (errors.length > 0) {
  console.error('[check-ui-consistency] ❌ 一致性棘轮违规：');
  for (const e of errors) {
    console.error(`  ${e}`);
  }
  console.error(
    '[check-ui-consistency] 修复指引：AGENTS.md「渲染层写法标准」；已收敛请跑 --update-baseline 收紧基线',
  );
  process.exit(1);
}

console.log(
  `[check-ui-consistency] ✅ 通过：${files.length} 个文件，${violations.length} 处命中（均在棘轮基线内：${JSON.stringify(baseline)}）`,
);
for (const v of violations) {
  console.log(`  [${v.rule}] ${v.file}:${v.line}`);
}
