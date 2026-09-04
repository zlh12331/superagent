/**
 * content.ts —— MotionLens 内容脚本（懒注入）。
 * 职责：
 *  - 监听 background 消息 ML_START_CAPTURE → dynamic import 已打包 core → capture()
 *    → 把 CaptureReport 通过 ML_CAPTURE_DONE 发回 background。
 *  - 监听 ML_TOAST → 页内右上角轻量 toast（分析成功/失败反馈）。
 *  - ML_PING 用于 background 探测脚本是否已注入（防重复初始化 guard）。
 *
 * 点选提示条由 core picker 自带（opts.hint），这里不重复实现。
 */
import type { CaptureReport } from '../../core/types';

// 无 @types/chrome 依赖：模块内最小声明
declare const chrome: any;

const GUARD_KEY = '__motionlensContentLoaded';
const TOAST_ID = '__motionlens-toast';

let capturing = false;

function toast(text: string, kind: 'info' | 'ok' | 'error' = 'info', ms = 3600): void {
  document.getElementById(TOAST_ID)?.remove();
  const el = document.createElement('div');
  el.id = TOAST_ID;
  el.textContent = text;
  const accent = kind === 'ok' ? '#16a34a' : kind === 'error' ? '#dc2626' : '#18181b';
  Object.assign(el.style, {
    position: 'fixed',
    top: '16px',
    right: '16px',
    zIndex: '2147483647',
    maxWidth: '360px',
    padding: '10px 14px',
    background: '#ffffff',
    color: '#18181b',
    border: '1px solid #e4e4e7',
    borderLeft: `3px solid ${accent}`,
    borderRadius: '10px',
    boxShadow: '0 8px 24px rgba(0,0,0,.10)',
    font: '13px/1.5 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
    pointerEvents: 'none',
    transition: 'opacity .25s ease',
  } as CSSStyleDeclaration);
  (document.body ?? document.documentElement).appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 300);
  }, ms);
}

async function runCapture(): Promise<void> {
  if (capturing) {
    toast('正在捕捉中，请先完成当前点选', 'info');
    return;
  }
  capturing = true;
  try {
    // 懒加载：core 由 esbuild 与本脚本一并打包，dynamic import 仅为语义边界
    const core = await import('../../core/index');
    const report: CaptureReport | null = await core.capture({
      hint: 'MotionLens · 点击要捕捉的动效元素（Esc 取消）',
    });
    if (!report) {
      chrome.runtime.sendMessage({ type: 'ML_CAPTURE_CANCELLED' });
      return;
    }
    await chrome.runtime.sendMessage({ type: 'ML_CAPTURE_DONE', report });
    // 结果/失败 toast 由 background 分析完成后通过 ML_TOAST 回传
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    chrome.runtime.sendMessage({ type: 'ML_CAPTURE_ERROR', error: message });
    toast(`MotionLens 捕捉失败：${message}`, 'error', 5000);
  } finally {
    capturing = false;
  }
}

function main(): void {
  chrome.runtime.onMessage.addListener(
    (msg: any, _sender: any, sendResponse: (v?: any) => void) => {
      if (!msg || typeof msg.type !== 'string') return false;
      switch (msg.type) {
        case 'ML_PING':
          sendResponse({ ok: true });
          return false;
        case 'ML_START_CAPTURE':
          void runCapture();
          sendResponse({ ok: true });
          return false;
        case 'ML_TOAST':
          toast(String(msg.text ?? ''), msg.kind ?? 'info');
          return false;
        default:
          return false;
      }
    },
  );
}

const w = window as unknown as Record<string, unknown>;
if (!w[GUARD_KEY]) {
  w[GUARD_KEY] = true;
  main();
}
