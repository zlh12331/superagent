/**
 * bookmarklet.e2e.mjs —— MotionLens bookmarklet 端到端测试（node 脚本，playwright）。
 *
 * 覆盖点：
 *  1. CSS keyframes loader：无 key → 设置面板「跳过，仅提取数据」→ 点选 → 数据 tab ≥1 条动画（source=css）
 *  2. WAAPI hover 卡片：预置 key + page.route 拦截 api.openai.com 返回固定 EffectDraft
 *     → Prompt tab 渲染标题 / category 徽章 / 中英文 prompt
 *  3. rAF 内联样式脉冲：getAnimations 隐身 → 采样兜底 → 数据 tab 出现 sampled 摘要
 *  4. analyze 失败（mock 500）→ 错误提示 + 降级数据展示，不白屏
 *
 * 运行：node capture/test/bookmarklet.e2e.mjs（需先 node capture/scripts/build-bookmarklet.mjs）
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const captureDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureFile = path.join(captureDir, 'test/fixtures/animations.html');
const bundleFile = path.join(captureDir, 'dist/motionlens.bookmarklet.js');

// ---------------------------------------------------------------- 工具

function resolveChromium() {
  const home = os.homedir();
  const candidates = [
    process.env.CHROMIUM_PATH,
    '/usr/bin/chromium',
    ...['1234', '1194'].flatMap((v) => [
      `${home}/.cache/ms-playwright/chromium_headless_shell-${v}/chrome-headless-shell-linux64/chrome-headless-shell`,
      `${home}/.cache/ms-playwright/chromium_headless_shell-${v}/chrome-linux/headless_shell`,
      `${home}/.cache/ms-playwright/chromium-${v}/chrome-linux64/chrome`,
      `${home}/.cache/ms-playwright/chromium-${v}/chrome-linux/chrome`,
    ]),
  ].filter(Boolean);
  for (const p of candidates) if (existsSync(p)) return p;
  throw new Error('找不到 chromium 可执行文件，请设置 CHROMIUM_PATH');
}

async function startServer() {
  const html = await readFile(fixtureFile);
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

/** 在 closed shadow root 里按 selector 找元素（经测试钩子 __shadow） */
async function shadowEl(page, selector, { timeout = 15000 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const handle = await page.evaluateHandle(
      (sel) => window.__motionlens_loaded?.__shadow?.()?.querySelector(sel) ?? null,
      selector,
    );
    const el = handle.asElement();
    if (el) return el;
    if (Date.now() > deadline) throw new Error(`shadow 元素未出现: ${selector}`);
    await page.waitForTimeout(100);
  }
}

/** 在 shadow 内按文本找 button */
async function shadowButton(page, text, opts) {
  const deadline = Date.now() + (opts?.timeout ?? 15000);
  for (;;) {
    const handle = await page.evaluateHandle((t) => {
      const root = window.__motionlens_loaded?.__shadow?.();
      if (!root) return null;
      return [...root.querySelectorAll('button')].find((b) => b.textContent.includes(t)) ?? null;
    }, text);
    const el = handle.asElement();
    if (el) return el;
    if (Date.now() > deadline) throw new Error(`shadow 按钮未出现: ${text}`);
    await page.waitForTimeout(100);
  }
}

async function shadowText(page) {
  return page.evaluate(() => window.__motionlens_loaded?.__shadow?.()?.textContent ?? '');
}

async function pickerActive(page) {
  return page.evaluate(() => document.documentElement.hasAttribute('data-motionlens-picker-active'));
}

async function waitPicker(page) {
  const deadline = Date.now() + 10000;
  while (!(await pickerActive(page))) {
    if (Date.now() > deadline) throw new Error('picker 未激活');
    await page.waitForTimeout(100);
  }
}

/** 点选页面元素中心（picker 捕获阶段接管 click） */
async function pickTarget(page, selector) {
  await waitPicker(page);
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`目标元素不可见: ${selector}`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

let passed = 0;
let failed = 0;
function ok(name) {
  passed++;
  console.log(`  ✔ ${name}`);
}
function assert(cond, msg) {
  if (!cond) throw new Error(`断言失败: ${msg}`);
}

const MOCK_DRAFT = {
  title: '磁吸悬浮卡片',
  titleEn: 'hover-lift-card',
  category: 'card',
  description: '鼠标悬停时卡片上浮并放大，阴影加深。',
  techTags: ['waapi', 'hover'],
  principle: '通过 mouseenter 触发 WAAPI el.animate()，transform 从 translateY(0) 过渡到 translateY(-10px) scale(1.04)，配合 cubic-bezier(0.22,1,0.36,1) 缓动与 boxShadow 插值，营造轻盈上浮感。',
  prompt: '请实现一个鼠标悬停上浮卡片：悬停时卡片在 600ms 内以 cubic-bezier(0.22,1,0.36,1) 缓动上移 10px 并放大到 1.04 倍，同时阴影从 0 1px 3px 加深到 0 12px 30px，使用 WAAPI element.animate，fill 设为 backwards。',
  promptEn: 'Implement a hover-lift card: on mouseenter, animate the card with WAAPI element.animate over 600ms using cubic-bezier(0.22,1,0.36,1), translating Y by -10px and scaling to 1.04 while deepening the box-shadow from 0 1px 3px to 0 12px 30px; use fill: backwards.',
  difficulty: 'easy',
  confidence: 0.92,
  sourceUrl: 'https://example.com/',
};

// ---------------------------------------------------------------- 主流程

const { server, url } = await startServer();
const executablePath = resolveChromium();
console.log(`chromium: ${executablePath}`);
const browser = await chromium.launch({ executablePath });

try {
  // ---- 用例 1：CSS loader 提取（跳过设置）--------------------------------
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(url);
    await page.addScriptTag({ path: bundleFile });

    // 无 key → 设置面板出现，点「跳过，仅提取数据」
    await (await shadowButton(page, '跳过')).click();
    await pickTarget(page, '#loader');

    // 观察窗口 ~2.6s 后结果面板（无 key → 直接落数据 tab）
    await shadowEl(page, '.anim-row', { timeout: 20000 });
    const rows = await page.evaluate(
      () => window.__motionlens_loaded.__shadow().querySelectorAll('.anim-row').length,
    );
    assert(rows >= 1, '数据 tab 应提取到 ≥1 条动画');
    const text = await shadowText(page);
    assert(text.includes('css'), '应包含 css 来源徽章');
    assert(await shadowButton(page, '复制 CaptureReport JSON'), '应有复制 CaptureReport 按钮');
    ok('CSS keyframes loader：跳过设置 → 点选 → 数据 tab ≥1 条 css 动画');
    await ctx.close();
  }

  // ---- 用例 2：WAAPI 卡片 + mock OpenAI → Prompt tab ----------------------
  {
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => {
      window.localStorage.setItem(
        'motionlens:settings',
        JSON.stringify({ provider: 'openai', apiKey: 'sk-test-mock' }),
      );
    });
    const page = await ctx.newPage();
    let apiHit = 0;
    await page.route('https://api.openai.com/**', (route) => {
      apiHit++;
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          choices: [{ message: { role: 'assistant', content: JSON.stringify(MOCK_DRAFT) } }],
        }),
      });
    });

    await page.goto(url);
    await page.addScriptTag({ path: bundleFile });

    // 已有 key → 跳过设置面板，直接进 picker
    await pickTarget(page, '#waapi-card');

    // loading → Prompt tab
    await shadowEl(page, 'h3', { timeout: 30000 });
    const text = await shadowText(page);
    assert(apiHit === 1, `OpenAI 应被调用 1 次（实际 ${apiHit}）`);
    assert(text.includes('磁吸悬浮卡片'), 'Prompt tab 应渲染 draft 标题');
    assert(text.includes('card'), '应渲染 category 徽章');
    assert(text.includes('鼠标悬停时卡片上浮'), '应渲染中文 prompt');
    assert(text.includes('Implement a hover-lift card'), '应渲染英文 prompt');
    assert(await shadowButton(page, '复制中文 Prompt'), '应有中文复制按钮');
    assert(await shadowButton(page, '复制英文 Prompt'), '应有英文复制按钮');
    ok('WAAPI 卡片 + mock OpenAI：Prompt tab 渲染标题/徽章/中英文 prompt');
    await ctx.close();
  }

  // ---- 用例 3：rAF 脉冲 → 采样兜底 ----------------------------------------
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(url);
    await page.addScriptTag({ path: bundleFile });
    await (await shadowButton(page, '跳过')).click();
    await pickTarget(page, '#raf-pulse');

    // 结构化提取为空 → 采样 ~3s → 数据 tab 出现 sampled 摘要
    const deadline = Date.now() + 30000;
    let text = '';
    while (Date.now() < deadline) {
      text = await shadowText(page);
      if (text.includes('样式采样兜底')) break;
      await page.waitForTimeout(200);
    }
    assert(text.includes('样式采样兜底'), 'rAF 动画应走采样兜底（sampled）');
    assert(text.includes('提取到 0 条动画'), 'getAnimations 对 rAF 内联样式隐身');
    ok('rAF 内联样式脉冲：结构化为空 → 采样兜底展示 sampled 摘要');
    await ctx.close();
  }

  // ---- 用例 4：analyze 失败 → 错误 + 降级，不白屏 -------------------------
  {
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => {
      window.localStorage.setItem(
        'motionlens:settings',
        JSON.stringify({ provider: 'openai', apiKey: 'sk-bad' }),
      );
    });
    const page = await ctx.newPage();
    await page.route('https://api.openai.com/**', (route) => {
      route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"bad key"}' });
    });
    await page.goto(url);
    await page.addScriptTag({ path: bundleFile });
    await pickTarget(page, '#loader');

    const deadline = Date.now() + 30000;
    let text = '';
    while (Date.now() < deadline) {
      text = await shadowText(page);
      if (text.includes('AI 分析失败')) break;
      await page.waitForTimeout(200);
    }
    assert(text.includes('AI 分析失败'), '应显示 analyze 失败提示');
    assert(text.includes('401'), '应包含 HTTP 状态信息');
    // 降级：切到数据 tab 仍有提取数据
    await (await shadowButton(page, '查看提取数据')).click();
    await shadowEl(page, '.anim-row');
    ok('analyze 401 失败：错误提示 + 降级展示提取数据，不白屏');
    await ctx.close();
  }

  // ---- 用例 5：防重复注入 --------------------------------------------------
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(url);
    await page.addScriptTag({ path: bundleFile });
    await shadowButton(page, '跳过'); // 第一次注入：设置面板出现
    await page.addScriptTag({ path: bundleFile }); // 再次注入
    await page.waitForTimeout(300);
    const hosts = await page.evaluate(
      () => document.querySelectorAll('[data-motionlens-panel]').length,
    );
    assert(hosts === 1, `重复注入不应出现第二个面板（实际 ${hosts} 个）`);
    const ctrl = await page.evaluate(() => !!window.__motionlens_loaded);
    assert(ctrl, 'window.__motionlens_loaded 应存在');
    ok('防重复注入：二次执行仅重新打开同一面板');
    await ctx.close();
  }
} catch (err) {
  failed++;
  console.error('  ✘', err.message);
} finally {
  await browser.close();
  server.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
