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
//       pnpm check:ui-consistency --update-baseline   # 收敛后收紧基线
// ──────────────────────────────────────────────────────────────

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  evaluateRatchet,
  type Metrics,
  parseBaseline,
  proposeBaseline,
  renderProblems,
  serializeBaseline,
  wantsBaselineUpdate,
  wantsForce,
} from './lib/ratchet';

const ROOT = join(import.meta.dirname, '..');
const SRC = join(ROOT, 'src', 'renderer');
const BASELINE_PATH = join(import.meta.dirname, 'ui-consistency-baseline.json');
/**
 * 棘轮指标名（2026-09-08 收敛到 lib/ratchet.ts）
 *
 * 本门禁的「违规」是每条规则的命中计数，故 key = 规则 id、指标 = count。
 * 此前自建读写/比对逻辑与 lib/ratchet.ts 完全重复（同样读 JSON、同样
 * 单向收紧、同样 --update-baseline），现统一复用，行为一致且少 30 行重复。
 */
const METRICS = ['count'] as const;

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
  'reasoning-head',
  'scroll-to-bottom',
  'jump-item',
  'ask-option',
  'fuzzy-result',
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
        // segmented/tab/折叠选择器语义（aria-pressed/aria-selected/aria-expanded/
        // role="tab"）豁免：这些是选择器交互形态，收敛路径是 ToggleGroup/Tabs
        if (
          block.includes('aria-pressed=') ||
          block.includes('aria-selected=') ||
          block.includes('aria-expanded=') ||
          block.includes('role="tab"')
        ) {
          continue;
        }
      }
      violations.push({ rule: rule.id, file: relFile, line: i + 1 });
    }
  }
}

// 按规则聚合计数，对照棘轮基线（统一走 lib/ratchet.ts）
// ratchet 语义：current 只含**超限**条目。本门禁的「超限」= 该规则命中数 > 0
// （基线里没有该规则即视为允许 0 处）；命中 0 的规则不入 current，
// 其历史基线条目会被 ratchet 判为 stale，提示收紧。
const counts: Record<string, number> = {};
for (const v of violations) {
  counts[v.rule] = (counts[v.rule] ?? 0) + 1;
}
const current = new Map<string, Metrics>();
for (const [ruleId, count] of Object.entries(counts)) {
  if (count > 0) current.set(ruleId, { count });
}

function loadBaseline(): Record<string, Metrics> {
  if (!existsSync(BASELINE_PATH)) {
    console.error('[check-ui-consistency] ❌ 缺少基线文件 scripts/ui-consistency-baseline.json');
    process.exit(1);
  }
  try {
    return parseBaseline(readFileSync(BASELINE_PATH, 'utf8'), METRICS);
  } catch (error: unknown) {
    console.error(
      `[check-ui-consistency] ❌ 基线读取失败：${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  }
}

const baseline = loadBaseline();

if (wantsBaselineUpdate(process.argv.slice(2))) {
  const next = proposeBaseline(current, baseline, METRICS, wantsForce(process.argv.slice(2)));
  writeFileSync(BASELINE_PATH, serializeBaseline(next), 'utf8');
  console.log(
    `[check-ui-consistency] 基线已更新：${Object.keys(baseline).length} → ${Object.keys(next).length} 条`,
  );
  process.exit(0);
}

const problems = evaluateRatchet(current, baseline, METRICS);
if (problems.length > 0) {
  console.error(`[check-ui-consistency] ❌ 一致性棘轮违规 ${problems.length} 处：`);
  for (const line of renderProblems(problems)) console.error(line);
  for (const rule of RULES) console.error(`  规则 ${rule.id}：${rule.desc}`);
  console.error(
    '[check-ui-consistency] 修复指引：AGENTS.md「渲染层写法标准」；已收敛请跑 --update-baseline 收紧基线',
  );
  process.exit(1);
}

console.log(
  `[check-ui-consistency] ✅ 通过：${files.length} 个文件，${violations.length} 处命中（均在棘轮基线内）`,
);
for (const v of violations) {
  console.log(`  [${v.rule}] ${v.file}:${v.line}`);
}
