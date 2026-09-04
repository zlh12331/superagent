/**
 * extension.smoke.mjs —— headless Chromium 加载扩展冒烟测试。
 * 用法：node capture/test/extension.smoke.mjs
 * 前置：node capture/scripts/build-extension.mjs；npm install --no-save playwright
 *
 * 断言：
 *  1. service worker 注册成功（persistent context 出现 background SW）
 *  2. popup.html 直接打开渲染无报错（主按钮存在、无 pageerror/console error）
 *  3. content script 可注入 example 页（executeScript + ML_PING 回包 + guard 标记）
 *  4. tabCapture：feature-detect，headless 下不可用则 SKIP（不算失败）
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const extPath = join(here, '../dist/extension');

if (!existsSync(join(extPath, 'manifest.json'))) {
  console.error('dist/extension 不存在，请先运行 node capture/scripts/build-extension.mjs');
  process.exit(1);
}

const results = [];
const record = (name, ok, note = '') => {
  results.push({ name, ok, note });
  console.log(`${ok === 'skip' ? '⊘ SKIP' : ok ? '✓ PASS' : '✗ FAIL'}  ${name}${note ? ` — ${note}` : ''}`);
};

// 本地 example 页（含一个持续 CSS 动画元素）
const exampleHtml = `<!DOCTYPE html><html><head><style>
@keyframes bob { from { transform: translateY(0); } to { transform: translateY(40px); } }
#target { width: 80px; height: 80px; background: #18181b; border-radius: 12px;
  animation: bob 0.8s ease-in-out infinite alternate; }
</style></head><body><div id="target"></div></body></html>`;

const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(exampleHtml);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const exampleUrl = `http://127.0.0.1:${server.address().port}/`;

const userDataDir = mkdtempSync(join(tmpdir(), 'motionlens-smoke-'));
let context;
let failed = false;

try {
  context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: '/usr/bin/chromium',
    headless: false, // 用 --headless=new（headless shell 对扩展支持差）
    args: [
      '--headless=new',
      '--no-sandbox',
      `--disable-extensions-except=${extPath}`,
      `--load-extension=${extPath}`,
    ],
  });

  // 1) service worker 注册
  let sw = context.serviceWorkers()[0];
  if (!sw) {
    try {
      sw = await context.waitForEvent('serviceworker', { timeout: 10_000 });
    } catch {
      /* handled below */
    }
  }
  if (!sw || !sw.url().includes('background.js')) {
    record('service worker 注册', false, sw ? sw.url() : '未出现 service_worker target');
    throw new Error('fatal: no service worker');
  }
  record('service worker 注册', true, sw.url());
  const extId = new URL(sw.url()).host;

  // 2) popup.html 直接打开渲染无报错
  const popup = await context.newPage();
  const popupErrors = [];
  popup.on('pageerror', (e) => popupErrors.push(String(e)));
  popup.on('console', (m) => { if (m.type() === 'error') popupErrors.push(m.text()); });
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForSelector('#capture', { timeout: 5000 });
  const captureBtnText = await popup.textContent('#capture');
  const countText = await popup.textContent('#lib-count');
  record(
    'popup.html 渲染',
    popupErrors.length === 0 && (captureBtnText ?? '').includes('捕捉动效'),
    popupErrors.length ? popupErrors.join(' | ') : `count=${(countText ?? '').trim()}`,
  );
  await popup.close();

  // library.html 顺带渲染检查（非硬性要求，渲染错则失败）
  const lib = await context.newPage();
  const libErrors = [];
  lib.on('pageerror', (e) => libErrors.push(String(e)));
  lib.on('console', (m) => { if (m.type() === 'error') libErrors.push(m.text()); });
  await lib.goto(`chrome-extension://${extId}/library.html`);
  await lib.waitForSelector('#search', { timeout: 5000 });
  record('library.html 渲染', libErrors.length === 0, libErrors.join(' | '));
  await lib.close();

  // 3) content script 注入 example 页
  // 注意：content script 运行在隔离世界，window guard 在主世界不可见；
  // 用 ML_PING 回包（监听就绪）+ ML_TOAST 落 DOM（DOM 操作能力）双重断言。
  const page = await context.newPage();
  await page.goto(exampleUrl);
  const tabId = await sw.evaluate(async (urlPrefix) => {
    const tabs = await chrome.tabs.query({});
    const t = tabs.find((x) => (x.url ?? '').startsWith(urlPrefix));
    return t?.id ?? null;
  }, `http://127.0.0.1:${server.address().port}`);
  if (tabId == null) {
    record('content script 注入', false, 'SW 中找不到 example 页 tab');
  } else {
    await sw.evaluate((id) => chrome.scripting.executeScript({ target: { tabId: id }, files: ['content.js'] }), tabId);
    const pong = await sw.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'ML_PING' }), tabId);
    await sw.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'ML_TOAST', text: 'smoke-toast', kind: 'info' }), tabId);
    const toastVisible = await page.waitForSelector('#__motionlens-toast', { timeout: 5000 }).then(() => true).catch(() => false);
    record('content script 注入', pong?.ok === true && toastVisible, `ping=${JSON.stringify(pong)} toastDOM=${toastVisible}`);
  }

  // 4) tabCapture feature-detect（headless 下多半不可用 → SKIP）
  const canCapture = await sw.evaluate(
    () => typeof chrome !== 'undefined' && !!chrome.tabCapture && typeof MediaStreamTrackProcessor !== 'undefined',
  );
  if (!canCapture) {
    record('tabCapture 抽帧', 'skip', '环境缺少 tabCapture/MediaStreamTrackProcessor');
  } else {
    try {
      await sw.evaluate(
        () => new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('tabCapture 5s 超时')), 5000);
          chrome.tabCapture.capture({ audio: false, video: true }, (s) => {
            clearTimeout(timer);
            const err = chrome.runtime.lastError;
            if (err) reject(new Error(err.message));
            else if (!s) reject(new Error('空流'));
            else {
              s.getTracks().forEach((t) => t.stop());
              resolve(true);
            }
          });
        }),
      );
      record('tabCapture 抽帧', true, '成功取流');
    } catch (err) {
      record('tabCapture 抽帧', 'skip', `headless 下不可用（不视为失败）：${err instanceof Error ? err.message : err}`);
    }
  }
} catch (err) {
  failed = true;
  console.error('冒烟测试异常：', err);
} finally {
  await context?.close().catch(() => {});
  server.close();
}

const hardFails = results.filter((r) => r.ok === false);
const skipped = results.filter((r) => r.ok === 'skip').length;
console.log(`\n结果：${results.filter((r) => r.ok === true).length} 通过，${hardFails.length} 失败，${skipped} 跳过`);
if (failed || hardFails.length > 0) process.exit(1);
console.log('SMOKE_OK');
