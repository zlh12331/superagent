// scripts/check-bundle.ts
// Bundle 体积门槛（工程化强制）：检查构建产物，超限即卡关（exit 1）
// ──────────────────────────────────────────────────────────────
// 依据 docs/design/12-performance-spec.md §1.2：
//   单 chunk ≤ 5MB、渲染层总包 ≤ 16MB（2026-08-11 基线门槛：当前产物 14.5MB，渐进收紧）
// 产物不存在时仅提示（本地未构建场景不卡关）；CI 中 build 后运行。
//
// 运行：pnpm build && pnpm check:bundle
// ──────────────────────────────────────────────────────────────

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const ASSETS_DIR = join(ROOT, 'out', 'renderer', 'assets');
/** 渲染层入口 HTML（其 script/modulepreload 集 = 首载同步可达 chunk） */
const RENDERER_HTML = join(ROOT, 'out', 'renderer', 'index.html');
/** 包体积历史记录（趋势对比用，stats/ 已 gitignore） */
const HISTORY_PATH = join(ROOT, 'stats', 'bundle-history.json');
/** 历史保留条数 */
const HISTORY_KEEP = 30;
/** 环比告警阈值（相比上次总包变化，超过即提示，不卡关——门槛已卡关） */
const TREND_ALERT_RATIO = 0.15;

// 基线门槛（依据 12-performance-spec §1.2，渐进收紧）：
const CHUNK_LIMIT_KB = 5 * 1024;
const TOTAL_LIMIT_KB = 16 * 1024;
// 首载同步体积门槛（12-performance-spec §1.2，2026-09 新增）：
// index.html 的 script/modulepreload 所列 chunk 合计（Electron 首帧需下载的 JS）。
// shiki 按需加载后 index 4.4MB → ~0.8MB；此门槛防语言包被误打回主入口。
const INITIAL_LOAD_LIMIT_KB = 3 * 1024;

interface ChunkInfo {
  readonly name: string;
  readonly sizeKib: number;
}

/** 包体积历史记录项 */
interface BundleHistoryEntry {
  readonly timestamp: number;
  readonly totalKib: number;
  readonly chunkCount: number;
  readonly largestKib: number;
}

/** 追加本次记录到历史并返回上一次（无历史返回 null） */
function recordHistory(totalKib: number, chunks: readonly ChunkInfo[]): BundleHistoryEntry | null {
  const entry: BundleHistoryEntry = {
    timestamp: Date.now(),
    totalKib: Math.round(totalKib),
    chunkCount: chunks.length,
    largestKib: Math.round(Math.max(...chunks.map((c) => c.sizeKib))),
  };

  let history: BundleHistoryEntry[] = [];
  try {
    if (existsSync(HISTORY_PATH)) {
      history = JSON.parse(readFileSync(HISTORY_PATH, 'utf8')) as BundleHistoryEntry[];
    }
  } catch {
    // 历史损坏时重置（不影响门禁）
  }
  const previous = history.at(-1) ?? null;

  history.push(entry);
  if (history.length > HISTORY_KEEP) {
    history = history.slice(-HISTORY_KEEP);
  }
  mkdirSync(join(HISTORY_PATH, '..'), { recursive: true });
  writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2), 'utf8');
  return previous;
}

/** 输出环比趋势（超阈值告警，不卡关） */
function reportTrend(previous: BundleHistoryEntry | null, totalKib: number): void {
  if (previous === null) {
    console.log(
      `[check-bundle] 首次记录历史 → stats/bundle-history.json（${HISTORY_KEEP} 条上限）`,
    );
    return;
  }
  const delta = ((totalKib - previous.totalKib) / previous.totalKib) * 100;
  const direction = delta >= 0 ? '📈 +' : '📉 ';
  console.log(
    `[check-bundle] 趋势：上次 ${previous.totalKib}KB → 本次 ${Math.round(totalKib)}KB（${direction}${Math.abs(delta).toFixed(1)}%，阈值 ±${TREND_ALERT_RATIO * 100}%）`,
  );
  if (Math.abs(delta) > TREND_ALERT_RATIO * 100) {
    console.warn(
      `[check-bundle] ⚠️ 体积环比变化超 ${TREND_ALERT_RATIO * 100}%：请审查本次改动（新依赖/静态导入膨胀）`,
    );
  }
}

// P5 修复：主进程产物体积报告（此前门槛只测渲染层，主进程 ~250MB 运行时依赖
// 完全无监控——@cursorless/tree-sitter-wasms 48MB、gpt-tokenizer 50MB、lark SDK 28MB 等）。
// 第一阶段：out/main/index.js 体积告警不卡关（真实 asar 门禁需依赖清单基线，
// 避免新门槛误伤 CI；先让膨胀可见，再收紧为卡关门禁）
const MAIN_ENTRY = join(ROOT, 'out', 'main', 'index.js');
const MAIN_WARN_KB = 5 * 1024;

function main(): number {
  let chunks: ChunkInfo[];
  try {
    chunks = readdirSync(ASSETS_DIR)
      .filter((f) => f.endsWith('.js'))
      .map((f) => {
        const sizeKib = statSync(join(ASSETS_DIR, f)).size / 1024;
        return { name: f, sizeKib };
      });
  } catch {
    console.log('[check-bundle] ⏭️ 无构建产物（out/renderer/assets），跳过（CI 中 build 后生效）');
    return 0;
  }

  // 边界：assets 目录存在但无 .js 产物（异常构建）——跳过历史记录避免写入 -Infinity 趋势数据
  if (chunks.length === 0) {
    console.log('[check-bundle] ⏭️ assets 目录无 .js 产物，跳过（异常构建请检查 build 输出）');
    return 0;
  }

  // 主进程产物报告（告警不卡关）
  if (existsSync(MAIN_ENTRY)) {
    const mainKib = statSync(MAIN_ENTRY).size / 1024;
    if (mainKib > MAIN_WARN_KB) {
      console.warn(
        `[check-bundle] ⚠️ 主进程 bundle ${mainKib.toFixed(0)}KB > ${MAIN_WARN_KB}KB（告警不卡关）：` +
          '主进程运行时依赖（@cursorless/tree-sitter-wasms/gpt-tokenizer/lark SDK 等）体积需收敛',
      );
    } else {
      console.log(
        `[check-bundle] 主进程 bundle ${mainKib.toFixed(0)}KB（告警线 ${MAIN_WARN_KB}KB）`,
      );
    }
  }

  const totalKib = chunks.reduce((sum, c) => sum + c.sizeKib, 0);

  // 首载同步体积（12-performance-spec §1.2，2026-09 新增）：
  // 解析 index.html 的 <script> / <link rel="modulepreload">，汇总其引用的 chunk——
  // 即 Electron 首帧必须下载的 JS 集（Vite/Rollup 生成的入口可达链）。
  // shiki 按需加载后 index 4.4MB → ~0.8MB；此门槛防语言包被误打回主入口。
  let initialLoadKib = 0;
  if (existsSync(RENDERER_HTML)) {
    const html = readFileSync(RENDERER_HTML, 'utf8');
    const refs = [...html.matchAll(/(?:src|href)="\.\/assets\/([a-zA-Z0-9_-]+)\.js"/g)].map(
      (m) => m[1],
    );
    initialLoadKib = refs.reduce((sum, name) => {
      const f = chunks.find((c) => c.name === `${name}.js`);
      return sum + (f?.sizeKib ?? 0);
    }, 0);
  }
  const problems: string[] = [];

  for (const c of chunks) {
    if (c.sizeKib > CHUNK_LIMIT_KB) {
      // U1 修复：ChunkInfo 只有 sizeKib 字段，此前引用不存在的 sizeKB——
      // 单 chunk 超限时抛 TypeError 而非报警（恰在最需要报警时失效）
      problems.push(`${c.name}: ${c.sizeKib.toFixed(0)}KB > ${CHUNK_LIMIT_KB}KB（单 chunk 超限）`);
    }
  }
  if (totalKib > TOTAL_LIMIT_KB) {
    problems.push(`渲染层总包 ${totalKib.toFixed(0)}KB > ${TOTAL_LIMIT_KB}KB（总包超限）`);
  }
  if (!existsSync(RENDERER_HTML)) {
    console.log('[check-bundle] ⏭️ 无 renderer/index.html，首载体积指标跳过（构建后生效）');
  } else if (initialLoadKib > INITIAL_LOAD_LIMIT_KB) {
    problems.push(
      `首载同步体积 ${initialLoadKib.toFixed(0)}KB > ${INITIAL_LOAD_LIMIT_KB}KB` +
        '（首帧下载量超限——检查是否有重依赖被静态打回主入口）',
    );
  } else {
    console.log(
      `[check-bundle] 首载同步体积 ${initialLoadKib.toFixed(0)}KB（门槛 ${INITIAL_LOAD_LIMIT_KB}KB）`,
    );
  }

  if (problems.length === 0) {
    // 记录历史趋势（门槛通过后写，避免失败时污染趋势）
    const previous = recordHistory(totalKib, chunks);
    reportTrend(previous, totalKib);
    console.log(
      `[check-bundle] ✅ 通过：${chunks.length} 个 chunk，合计 ${totalKib.toFixed(0)}KB（门槛：单 ${CHUNK_LIMIT_KB}KB / 总 ${TOTAL_LIMIT_KB}KB）`,
    );
    return 0;
  }

  console.error(`[check-bundle] ❌ ${problems.length} 个问题：`);
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    '[check-bundle] 修复指引：docs/design/12-performance-spec.md（动态 import 拆分 / 依赖纪律）',
  );
  return 1;
}

process.exitCode = main();
