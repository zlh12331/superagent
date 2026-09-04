#!/usr/bin/env node
/**
 * run.mjs — MotionLens benchmark harness：对 MotionVault 站内效果自动跑提取引擎。
 *
 * 用法：
 *   node capture/benchmark/run.mjs            # 默认每分类 6 张卡
 *   node capture/benchmark/run.mjs --all      # 全量（200 张）
 *   node capture/benchmark/run.mjs --per 3 --category buttons
 *   node capture/benchmark/run.mjs --settle 2200 --sample-ms 3000 --port 4850
 *
 * 流程：构建/检查 dist → vite preview（PID 杀）→ esbuild 打包 inject.ts 注入 →
 * playwright 逐页逐卡：scroll 挂载 → 结构化提取 → hover 提取 → 采样兜底 → 报告。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RESULTS_DIR = path.join(ROOT, 'capture', 'benchmark', 'results');

const CARD_SELECTOR = 'article.group';
const PREVIEW_SELECTOR = 'div[class*="aspect-["]';

const ROUTES = [
  ['text', '/text'],
  ['cards', '/cards'],
  ['layout', '/layout'],
  ['3d', '/3d'],
  ['particles', '/particles'],
  ['backgrounds', '/backgrounds'],
  ['buttons', '/buttons'],
  ['scroll', '/scroll'],
  ['svg', '/svg'],
  ['loaders', '/loaders'],
  ['spring', '/spring'],
  ['lab', '/lab'],
];

const CARD_TIMEOUT_MS = 60_000;
const PAGE_TIMEOUT_MS = 180_000;
let INJECT_CODE = '';

// ---------- args ----------
function parseArgs(argv) {
  const o = { all: false, per: 6, category: null, port: 4850, settle: 2200, sampleMs: 3000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') o.all = true;
    else if (a === '--per') o.per = Number(argv[++i]);
    else if (a === '--category') o.category = argv[++i];
    else if (a === '--port') o.port = Number(argv[++i]);
    else if (a === '--settle') o.settle = Number(argv[++i]);
    else if (a === '--sample-ms') o.sampleMs = Number(argv[++i]);
    else if (a === '--help' || a === '-h') {
      console.log('node capture/benchmark/run.mjs [--all] [--per N] [--category name] [--port 4850] [--settle ms] [--sample-ms ms]');
      process.exit(0);
    }
  }
  return o;
}

// ---------- dist ----------
function ensureDist() {
  if (existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    console.log('[bench] dist/ 已存在，跳过构建');
    return;
  }
  console.log('[bench] dist/ 不存在，执行 npm run build（约 30s）…');
  const r = spawnSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) throw new Error('站点构建失败');
}

// ---------- vite preview（用 PID 杀，严禁 pkill）----------
let previewChild = null;
function startPreview(port) {
  const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  previewChild = spawn(process.execPath, [viteBin, 'preview', '--port', String(port), '--strictPort'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  previewChild.stderr.on('data', (d) => process.stderr.write(`[preview] ${d}`));
  previewChild.on('exit', (code) => {
    if (code !== null && code !== 0) console.error(`[bench] vite preview 退出 code=${code}`);
  });
}
function stopPreview() {
  if (!previewChild) return;
  const pid = previewChild.pid;
  try {
    process.kill(pid, 'SIGTERM');
  } catch { /* already dead */ }
  // 同步等 600ms（exit handler 里不能异步），还活着则补 SIGKILL
  spawnSync('sleep', ['0.6']);
  try {
    process.kill(pid, 'SIGKILL');
  } catch { /* dead */ }
  previewChild = null;
}
process.on('exit', stopPreview);
process.on('SIGINT', () => { stopPreview(); process.exit(130); });
process.on('SIGTERM', () => { stopPreview(); process.exit(143); });

async function waitServer(port, timeoutMs = 30_000) {
  const url = `http://localhost:${port}/`;
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(url, { method: 'HEAD' });
      if (r.ok) return;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`vite preview ${timeoutMs}ms 内未就绪`);
}

// ---------- bundle inject.ts / report.ts ----------
function bundleInject() {
  const out = esbuild.buildSync({
    entryPoints: [path.join(ROOT, 'capture', 'benchmark', 'inject.ts')],
    bundle: true,
    format: 'iife',
    write: false,
    target: 'chrome120',
    logLevel: 'silent',
  });
  return out.outputFiles[0].text;
}

async function loadReportModule() {
  const out = esbuild.buildSync({
    entryPoints: [path.join(ROOT, 'capture', 'benchmark', 'report.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    logLevel: 'silent',
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  });
  mkdirSync(RESULTS_DIR, { recursive: true });
  const tmp = path.join(RESULTS_DIR, '.report.bundled.mjs');
  writeFileSync(tmp, out.outputFiles[0].text);
  return import(pathToFileURL(tmp).href);
}

// ---------- playwright ----------
async function launchBrowser() {
  const { chromium } = await import('playwright');
  try {
    return await chromium.launch({ headless: true });
  } catch (e) {
    console.warn(`[bench] 默认 chromium 启动失败（${e.message}），回退 /usr/bin/chromium`);
    return await chromium.launch({ headless: true, executablePath: '/usr/bin/chromium' });
  }
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout:${label}`)), ms)),
  ]);
}

/** 多张结构化结果合并去重 */
function mergeAnimations(lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const a of list ?? []) {
      const key = `${a.source}|${a.name ?? ''}|${a.targetPath}|${a.timing?.duration}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(a);
    }
  }
  return out;
}

async function newPage(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.warn(`[bench] pageerror: ${e.message}`));
  return page;
}

async function benchCard(page, index, opts) {
  const t0 = Date.now();
  const base = await page.evaluate(
    ([i, settle]) => window.__mlBench.scan(i, settle),
    [index, opts.settle],
  );
  if (!base.ok) return { ...base, phase: 'scan' };
  let animations = base.animations ?? [];

  if (animations.length === 0) {
    // 挂载型动画 settle 后已播完：点「重新播放」remount 预览，立即收集 running 动画
    const r1 = await page.evaluate(([i]) => window.__mlBench.replayScan(i, 200), [index]);
    const r2 = await page.evaluate(([i]) => window.__mlBench.replayScan(i, 600), [index]);
    animations = mergeAnimations([r1.animations, r2.animations]);
  }

  if (animations.length === 0) {
    // 真实 hover（触发 :hover 与 JS 监听），分两次收集以覆盖不同 duration 的 transition
    const box = await page.evaluate(
      ([i, sel]) => {
        const el = document.querySelectorAll('article.group')[i]?.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      },
      [index, PREVIEW_SELECTOR],
    );
    let hovered = false;
    if (box && box.width > 0) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 6 });
      hovered = true;
      const h1 = await page.evaluate(([i]) => window.__mlBench.hoverScan(i, 300), [index]);
      const h2 = await page.evaluate(([i]) => window.__mlBench.hoverScan(i, 450), [index]);
      animations = mergeAnimations([h1.animations, h2.animations]);
    }
    if (animations.length === 0 && box && box.width > 0) {
      // 点击触发型（spring 弹窗/开关、点击波纹、点击展开）：真实 click 后两次收集；
      // 目标优先 preview 内可交互子元素（缩略图/开关/按钮），退化为几何中心
      const urlBefore = page.url();
      const clickPt = await page.evaluate(([i]) => {
        const t = window.__mlBench.clickTargetBox(i);
        return t ?? null;
      }, [index]);
      const cx = clickPt?.x ?? box.x + box.width / 2;
      const cy = clickPt?.y ?? box.y + box.height / 2;
      await page.mouse.click(cx, cy);
      const c1 = await page.evaluate(([i]) => window.__mlBench.clickScan(i, 300), [index]);
      const c2 = await page.evaluate(([i]) => window.__mlBench.clickScan(i, 500), [index]);
      animations = mergeAnimations([c1.animations, c2.animations]);
      if (page.url() !== urlBefore) {
        // 点击导致导航（异常）：回退
        await page.goBack().catch(() => {});
        await page.waitForSelector(CARD_SELECTOR, { timeout: 10_000 }).catch(() => {});
        await page.addScriptTag({ content: INJECT_CODE }).catch(() => {});
      }
    }
    if (animations.length === 0) {
      // 采样兜底：保持 hover + 并发 pointer/scroll 刺激（磁吸/倾斜/滚动叙事类）；
      // 采样开始 400ms 后再补一次真实 click（果冻按钮/弹性开关等按压回弹发生在 pointerdown/up 瞬间）
      const p = page.evaluate(
        ([i, ms]) => window.__mlBench.sample(i, ms, true),
        [index, opts.sampleMs],
      );
      await page.waitForTimeout(400);
      const midClick = await page.evaluate(([i]) => window.__mlBench.clickTargetBox(i) ?? null, [index]);
      const ccx = midClick?.x ?? (box ? box.x + box.width / 2 : 0);
      const ccy = midClick?.y ?? (box ? box.y + box.height / 2 : 0);
      if (ccx > 0) await page.mouse.click(ccx, ccy).catch(() => {});
      const s = await p;
      if (hovered) await page.mouse.move(10, 10, { steps: 3 });
      if (!s.ok) return { title: base.title, sampleError: s.reason, animations: [], segments: [] };
      return { title: base.title, animations: [], segments: s.segments ?? [] };
    }
    if (hovered) await page.mouse.move(10, 10, { steps: 3 });
  }
  return { title: base.title, animations, segments: [] , tookMs: Date.now() - t0 };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  console.log('[bench] opts =', JSON.stringify(opts));
  ensureDist();
  mkdirSync(RESULTS_DIR, { recursive: true });

  const injectCode = bundleInject();
  INJECT_CODE = injectCode;
  console.log(`[bench] inject.ts 打包完成（${(injectCode.length / 1024).toFixed(1)}KB）`);
  const report = await loadReportModule();

  startPreview(opts.port);
  await waitServer(opts.port);
  console.log(`[bench] preview ready @ :${opts.port}`);

  const browser = await launchBrowser();
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const routes = ROUTES.filter(([name]) => !opts.category || opts.category.split(',').includes(name));
  const cards = [];

  try {
    for (const [category, route] of routes) {
      let page = await newPage(browser);
      let crashed = false;
      page.on('crash', () => { crashed = true; });
      try {
        await page.goto(`http://localhost:${opts.port}${route}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await page.waitForSelector(CARD_SELECTOR, { timeout: 15_000 });
        await page.addScriptTag({ content: injectCode });
        const count = await page.evaluate(() => window.__mlBench.cardCount());
        const limit = opts.all ? count : Math.min(opts.per, count);
        console.log(`[bench] ${category} (${route}): ${limit}/${count} 张卡`);
        const pageStart = Date.now();

        for (let i = 0; i < limit; i++) {
          if (Date.now() - pageStart > PAGE_TIMEOUT_MS) {
            console.warn(`[bench] ${category} 页超时 ${PAGE_TIMEOUT_MS}ms，剩余卡片记 page-timeout`);
            for (let j = i; j < limit; j++) {
              cards.push(report.buildCardResult({
                category, route, index: j, id: `${category}-${j}`, title: '',
                status: 'timeout', reason: 'page-timeout', tookMs: 0,
              }));
            }
            break;
          }
          let res;
          try {
            res = await withTimeout(benchCard(page, i, opts), CARD_TIMEOUT_MS, `card-${category}-${i}`);
          } catch (e) {
            res = { error: e.message };
          }
          if (crashed) {
            console.error(`[bench] 页面在 ${category}#${i} 崩溃！重建 page 继续`);
            res = { error: 'page-crash' };
            page = await newPage(browser);
            crashed = false;
            page.on('crash', () => { crashed = true; });
            await page.goto(`http://localhost:${opts.port}${route}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
            await page.addScriptTag({ content: injectCode });
          }
          const title = res.title ?? '';
          const id = `${category}-${i}${title ? '-' + title.replace(/\s+/g, '-').slice(0, 24) : ''}`;
          if (res.error || res.phase) {
            const reason = res.error ?? res.reason ?? 'unknown';
            console.log(`  ✗ ${id}: ${reason}`);
            cards.push(report.buildCardResult({
              category, route, index: i, id, title,
              status: res.error?.startsWith('timeout:') ? 'timeout' : 'error',
              reason, tookMs: CARD_TIMEOUT_MS,
            }));
          } else {
            const anims = res.animations ?? [];
            const segs = res.segments ?? [];
            const status = anims.length > 0 || segs.length > 0 ? 'ok' : 'no-animation';
            const reason = status === 'no-animation'
              ? (res.sampleError ?? '结构化提取为空且采样无有效通道')
              : undefined;
            console.log(`  ${status === 'ok' ? '✓' : '·'} ${id}: anim=${anims.length} seg=${segs.length}${reason ? ' (' + reason + ')' : ''}`);
            cards.push(report.buildCardResult({
              category, route, index: i, id, title, status, reason,
              tookMs: res.tookMs ?? 0, animations: anims, segments: segs,
            }));
          }
        }
      } catch (e) {
        console.error(`[bench] ${category} 页面级失败: ${e.message}`);
        cards.push(report.buildCardResult({
          category, route, index: -1, id: `${category}-page`, title: '',
          status: 'error', reason: `page-level: ${e.message}`, tookMs: 0,
        }));
      } finally {
        await page.context().close().catch(() => {});
      }
    }
  } finally {
    await browser.close().catch(() => {});
    stopPreview();
  }

  const summary = report.summarize({
    startedAt,
    durationMs: Date.now() - t0,
    routes: routes.map(([, r]) => r),
    perCategory: opts.all ? 'all' : opts.per,
    cards,
  });
  writeFileSync(path.join(RESULTS_DIR, 'report.json'), JSON.stringify(summary, null, 2));
  writeFileSync(path.join(RESULTS_DIR, 'report.md'), report.toMarkdown(summary));
  console.log(`[bench] 完成：覆盖 ${summary.covered}/${summary.total} (${(summary.coverage * 100).toFixed(1)}%)`);
  console.log(`[bench] 报告：${path.join('capture', 'benchmark', 'results', 'report.json')} / report.md`);
}

main().catch((e) => {
  console.error('[bench] 致命错误:', e);
  stopPreview();
  process.exit(1);
});
