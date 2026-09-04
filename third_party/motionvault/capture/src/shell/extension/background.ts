/**
 * background.ts —— MotionLens MV3 service worker。
 * 职责：
 *  - 消息路由：ML_START_CAPTURE / ML_START_RECORD（popup）→ 注入并唤醒 content script；
 *    ML_CAPTURE_DONE（content）→ 读设置 → analyzeCapture（LLM fetch 在 SW，规避页面 CSP/CORS）
 *    → 存库（chrome.storage.local）→ ML_TOAST 回传页内反馈。
 *  - 录制兜底：tabCapture 在 SW 内直接取流，MediaStreamTrackProcessor + OffscreenCanvas
 *    每 500ms 抽一帧（720p jpeg q0.7，3 秒共 6 帧）→ chrome.storage.session 持久化
 *    （SW 可能被回收，跨消息状态一律落 storage，不依赖内存变量）。
 */
import { analyzeCapture } from '../../analyze/index';
import type { AnalyzerOptions, CaptureReport, EffectDraft } from '../../core/types';

declare const chrome: any;

// TS DOM lib 尚未内置（Chrome 94+ 运行时可用）
declare class MediaStreamTrackProcessor {
  constructor(init: { track: MediaStreamTrack });
  readonly readable: ReadableStream<VideoFrame>;
}

const SETTINGS_KEY = 'ml_settings';
const PENDING_KEY = 'ml_pending_capture';
const ITEM_PREFIX = 'ml_item_';

const RECORD_FRAME_COUNT = 6;
const RECORD_FRAME_INTERVAL_MS = 500;
const RECORD_W = 1280;
const RECORD_H = 720;

interface PendingCapture {
  mode: 'pick' | 'record';
  tabId: number;
  at: number;
  frames?: string[];
}

interface StoredItem {
  id: string;
  savedAt: string;
  domain: string;
  unanalyzed?: boolean;
  error?: string;
  draft?: EffectDraft;
  /** 原始报告（抽帧 frames 体积大，入库前剥离，仅保留 frameCount） */
  report: Omit<CaptureReport, 'frames'> & { frameCount?: number };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function domainOf(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

function sanitizeId(s: string): string {
  return (s || 'unanalyzed').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'item';
}

async function getSettings(): Promise<AnalyzerOptions | null> {
  const got = await chrome.storage.sync.get(SETTINGS_KEY);
  const s = got?.[SETTINGS_KEY];
  if (!s || !s.apiKey) return null;
  return {
    provider: s.provider ?? 'openai',
    apiKey: s.apiKey,
    ...(s.model ? { model: s.model } : {}),
    ...(s.baseUrl ? { baseUrl: s.baseUrl } : {}),
  };
}

async function getPending(): Promise<PendingCapture | null> {
  const got = await chrome.storage.session.get(PENDING_KEY);
  return got?.[PENDING_KEY] ?? null;
}

async function setPending(p: PendingCapture | null): Promise<void> {
  if (p) await chrome.storage.session.set({ [PENDING_KEY]: p });
  else await chrome.storage.session.remove(PENDING_KEY);
}

async function toastTab(tabId: number, text: string, kind: 'info' | 'ok' | 'error' = 'info'): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'ML_TOAST', text, kind });
  } catch {
    /* 页面可能已跳转/关闭 */
  }
}

/** 确保 content script 已注入（guard 防重复），返回是否就绪 */
async function ensureContentScript(tabId: number): Promise<boolean> {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: 'ML_PING' });
    if (pong?.ok) return true;
  } catch {
    /* 未注入 */
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return true;
  } catch (err) {
    console.warn('MotionLens: 无法注入 content script', err);
    return false;
  }
}

function drawCover(ctx: OffscreenCanvasRenderingContext2D, frame: VideoFrame): void {
  const sw = frame.displayWidth;
  const sh = frame.displayHeight;
  const scale = Math.max(RECORD_W / sw, RECORD_H / sh);
  const dw = sw * scale;
  const dh = sh * scale;
  ctx.drawImage(frame, (RECORD_W - dw) / 2, (RECORD_H - dh) / 2, dw, dh);
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error ?? new Error('FileReader 失败'));
    fr.readAsDataURL(blob);
  });
}

/**
 * 路径 A：tabCapture 流抽帧（首选，对齐规格）。
 * Chrome 94+ worker 环境具备 MediaStreamTrackProcessor / VideoFrame /
 * OffscreenCanvas.convertToBlob，无需 offscreen document（少一个页面与 streamId 转移环节）。
 */
async function framesFromStream(): Promise<string[]> {
  if (typeof MediaStreamTrackProcessor === 'undefined' || typeof OffscreenCanvas === 'undefined') {
    throw new Error('当前环境不支持 SW 内流抽帧（MediaStreamTrackProcessor/OffscreenCanvas 缺失）');
  }
  const stream: MediaStream = await new Promise((resolve, reject) => {
    chrome.tabCapture.capture({ audio: false, video: true }, (s: MediaStream | undefined) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(`tabCapture 失败：${err.message}`));
      else if (!s) reject(new Error('tabCapture 返回空流'));
      else resolve(s);
    });
  });
  const track = stream.getVideoTracks()[0];
  if (!track) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error('tabCapture 流中没有视频轨');
  }
  try {
    const processor = new MediaStreamTrackProcessor({ track });
    const reader = processor.readable.getReader();
    const canvas = new OffscreenCanvas(RECORD_W, RECORD_H);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('OffscreenCanvas 2d 上下文不可用');
    const frames: string[] = [];
    for (let i = 0; i < RECORD_FRAME_COUNT; i++) {
      const { value: frame } = (await reader.read()) as { value?: VideoFrame };
      if (!frame) break;
      drawCover(ctx, frame);
      frame.close();
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
      frames.push(await blobToDataUrl(blob));
      if (i < RECORD_FRAME_COUNT - 1) await sleep(RECORD_FRAME_INTERVAL_MS);
    }
    reader.releaseLock();
    return frames;
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}

/**
 * 路径 B（兜底）：captureVisibleTab 定时截屏。
 * 覆盖 WebCodecs 在 SW 不可用的浏览器（如无 WebCodecs 的 Chromium 构建）。
 * 依赖 activeTab 授权（popup 按钮点击即视为 invocation）。
 */
async function framesFromVisibleTab(): Promise<string[]> {
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') {
    throw new Error('当前环境不支持截屏缩放（OffscreenCanvas/createImageBitmap 缺失）');
  }
  const canvas = new OffscreenCanvas(RECORD_W, RECORD_H);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('OffscreenCanvas 2d 上下文不可用');
  const frames: string[] = [];
  for (let i = 0; i < RECORD_FRAME_COUNT; i++) {
    const dataUrl: string = await new Promise((resolve, reject) => {
      chrome.tabs.captureVisibleTab(null, { format: 'jpeg', quality: 70 }, (d: string | undefined) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(`captureVisibleTab 失败：${err.message}`));
        else if (!d) reject(new Error('captureVisibleTab 返回空'));
        else resolve(d);
      });
    });
    const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const scale = Math.max(RECORD_W / bmp.width, RECORD_H / bmp.height);
    const dw = bmp.width * scale;
    const dh = bmp.height * scale;
    ctx.drawImage(bmp, (RECORD_W - dw) / 2, (RECORD_H - dh) / 2, dw, dh);
    bmp.close();
    frames.push(await blobToDataUrl(await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 })));
    if (i < RECORD_FRAME_COUNT - 1) await sleep(RECORD_FRAME_INTERVAL_MS);
  }
  return frames;
}

/** 录制入口：优先 tabCapture 流抽帧，不可用时截屏兜底，两者皆失败则抛错由调用方降级 */
async function recordFrames(): Promise<string[]> {
  try {
    return await framesFromStream();
  } catch (err) {
    console.warn('MotionLens: 流抽帧不可用，尝试截屏兜底 —', err);
    return await framesFromVisibleTab();
  }
}

async function getActiveTab(): Promise<any | null> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs?.[0] ?? null;
}

/** 点选模式：注入 content → 触发 ML_START_CAPTURE */
async function startPick(tabId: number): Promise<void> {
  await setPending({ mode: 'pick', tabId, at: Date.now() });
  const ok = await ensureContentScript(tabId);
  if (!ok) {
    await setPending(null);
    throw new Error('无法注入 content script（chrome:// 或受限页面不可捕捉）');
  }
  await chrome.tabs.sendMessage(tabId, { type: 'ML_START_CAPTURE' });
}

/** 录制模式：先 tabCapture 抽 3 秒帧落 storage.session，再走点选流程 */
async function startRecord(tabId: number): Promise<string> {
  await setPending({ mode: 'record', tabId, at: Date.now() });
  let frames: string[] = [];
  try {
    frames = await recordFrames();
  } catch (err) {
    // 抽帧不可用（如 headless / 权限被拒）：降级为普通点选，不视为致命错误
    console.warn('MotionLens: 录制降级为普通点选 —', err);
    await setPending({ mode: 'pick', tabId, at: Date.now() });
    await startPickFromPending(tabId);
    return `录制不可用（${err instanceof Error ? err.message : String(err)}），已降级为普通点选`;
  }
  await setPending({ mode: 'record', tabId, at: Date.now(), frames });
  await startPickFromPending(tabId);
  return '录制完成（6 帧），请点击要捕捉的元素';
}

async function startPickFromPending(tabId: number): Promise<void> {
  const ok = await ensureContentScript(tabId);
  if (!ok) {
    await setPending(null);
    throw new Error('无法注入 content script（chrome:// 或受限页面不可捕捉）');
  }
  await chrome.tabs.sendMessage(tabId, { type: 'ML_START_CAPTURE' });
}

function shouldUseVision(report: CaptureReport, pending: PendingCapture | null): pending is PendingCapture & { frames: string[] } {
  if (pending?.mode !== 'record' || !pending.frames?.length) return false;
  if (report.animations.length > 0) return false;
  // sampleFallback 无结果：sampled 缺失或拟合不出任何片段
  const sampledOk = !!report.sampled && report.sampled.segments.length > 0;
  return !sampledOk;
}

async function storeItem(report: CaptureReport, draft: EffectDraft | undefined, error?: string): Promise<StoredItem> {
  const titleEn = sanitizeId(draft?.titleEn ?? 'unanalyzed');
  const id = `${ITEM_PREFIX}${Date.now()}_${titleEn}`;
  const { frames, ...rest } = report;
  const item: StoredItem = {
    id,
    savedAt: new Date().toISOString(),
    domain: domainOf(report.url),
    ...(draft ? { draft } : { unanalyzed: true }),
    ...(error ? { error } : {}),
    report: { ...rest, ...(frames?.length ? { frameCount: frames.length } : {}) },
  };
  await chrome.storage.local.set({ [id]: item });
  return item;
}

async function handleCaptureDone(report: CaptureReport, tabId: number): Promise<void> {
  const pending = await getPending();
  await setPending(null);

  const useVision = shouldUseVision(report, pending);
  const settings = await getSettings();

  if (!settings) {
    await storeItem(report, undefined, '未配置 API Key');
    await toastTab(tabId, 'MotionLens：已保存原始数据（未配置 API Key，跳过分析）', 'info', );
    return;
  }

  try {
    const opts: AnalyzerOptions = useVision ? { ...settings, frames: pending.frames } : settings;
    const draft = await analyzeCapture(report, opts);
    await storeItem(report, draft);
    await toastTab(tabId, `已入库：${draft.title}`, 'ok');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // vision 兜底尝试失败也同样存原始 report
    await storeItem(report, undefined, message);
    await toastTab(tabId, `分析失败（已存原始数据）：${message}`, 'error');
  }
}

async function libraryCount(): Promise<number> {
  const all = await chrome.storage.local.get(null);
  return Object.keys(all).filter((k) => k.startsWith(ITEM_PREFIX)).length;
}

chrome.runtime.onMessage.addListener((msg: any, sender: any, sendResponse: (v?: any) => void) => {
  if (!msg || typeof msg.type !== 'string') return false;

  const run = (p: Promise<unknown>) =>
    p.then((v) => sendResponse({ ok: true, value: v }))
      .catch((err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));

  switch (msg.type) {
    case 'ML_START_CAPTURE':
      run((async () => {
        const tab = await getActiveTab();
        if (!tab?.id) throw new Error('找不到活动标签页');
        await startPick(tab.id);
        return '请点击要捕捉的动效元素';
      })());
      return true;

    case 'ML_START_RECORD':
      run((async () => {
        const tab = await getActiveTab();
        if (!tab?.id) throw new Error('找不到活动标签页');
        return await startRecord(tab.id);
      })());
      return true;

    case 'ML_CAPTURE_DONE':
      run(handleCaptureDone(msg.report as CaptureReport, sender?.tab?.id ?? 0));
      return true;

    case 'ML_CAPTURE_CANCELLED':
      run(setPending(null));
      return true;

    case 'ML_CAPTURE_ERROR':
      run(setPending(null));
      return true;

    case 'ML_GET_STATE':
      run((async () => ({ count: await libraryCount() }))());
      return true;

    case 'ML_OPEN_LIBRARY':
      run(chrome.tabs.create({ url: chrome.runtime.getURL('library.html') }));
      return true;

    default:
      return false;
  }
});
