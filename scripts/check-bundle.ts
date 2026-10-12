// check-bundle.ts：构建产物体积门槛（工程闸）——检查 out/ 下的产物，超限即 exit 1。
// 边界：无构建产物（本地未 build）时跳过不卡关；主进程 bundle 与环比趋势只告警不卡关。
// 门槛依据 docs/design/12-performance-spec.md §1.2；运行 pnpm build && pnpm check:bundle（CI 在 build 后卡关）。

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

// ───── 卡关门槛（依据 docs/design/12-performance-spec.md §1.2，随重构后体积下降同步收紧） ─────
const CHUNK_LIMIT_KB = 5 * 1024;
const TOTAL_LIMIT_KB = 16 * 1024;
/** 首载同步体积上限 KB：index.html 引用的 chunk 合计（Electron 首帧必须下载的 JS），防重依赖被静态打回主入口 */
const INITIAL_LOAD_LIMIT_KB = 3 * 1024;

/** out/renderer/assets 下的单个 JS 产物 */
interface ChunkInfo {
  readonly name: string;
  readonly sizeKib: number;
}

// ───── 历史趋势：门槛通过后追加 stats/bundle-history.json，输出环比（参考值，不卡关） ─────

/** 包体积历史记录项 */
interface BundleHistoryEntry {
  readonly timestamp: number;
  readonly totalKib: number;
  readonly chunkCount: number;
  readonly largestKib: number;
}

/**
 * 追加本次记录到 stats/bundle-history.json 并返回上一条（无历史返回 null，供环比用）。
 * 历史文件损坏时按空历史重建——趋势仅作参考，不值得因此让门禁失败。
 */
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
  } catch {}
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

// ───── 主进程 bundle 告警（渲染层门槛测不到主进程的运行时重依赖） ─────
// 只告警不卡关：真实 asar 门禁需要依赖清单基线，先让膨胀可见再谈收紧。
const MAIN_ENTRY = join(ROOT, 'out', 'main', 'index.js');
/** 主进程 bundle 告警线 KB（超出仅提示，不卡关） */
const MAIN_WARN_KB = 5 * 1024;

/** 返回进程退出码：0 = 通过或跳过（无产物），1 = 存在超限项 */
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

  // 边界：assets 存在但无 .js 产物（异常构建）——早退跳过，避免历史把最大 chunk 记成 -Infinity（Math.max 空集）
  if (chunks.length === 0) {
    console.log('[check-bundle] ⏭️ assets 目录无 .js 产物，跳过（异常构建请检查 build 输出）');
    return 0;
  }

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

  // 首载同步体积 = index.html 的 script/modulepreload 所引 chunk 合计，
  // 即 Vite/Rollup 入口可达链中 Electron 首帧必须下载的 JS 集。
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
  // 收集全部超限项后统一报告：一次列出全部问题，便于一轮修复
  const problems: string[] = [];

  for (const c of chunks) {
    if (c.sizeKib > CHUNK_LIMIT_KB) {
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
    // 门槛通过才写历史：失败的体积不写入，避免污染环比基线
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
