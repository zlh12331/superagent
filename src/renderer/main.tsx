// src/renderer/main.tsx
// React 19.2 渲染层入口
// 设计文档 §2.3 React 19.2 + React Compiler

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
// 渲染层错误上报 + 全局兜底（必须在 React render 之前安装，尽早捕获初始化期异常）
// 错误经 electron-log renderer 转发主进程落盘，诊断包从此包含渲染层现场
import { initRendererErrorHandlers } from '@/lib/error-report';

initRendererErrorHandlers();

// 前端独立开发模式（pnpm dev:web）：无 Electron preload 时注入完整 mock window.api
// - 仅当 vite 以 --mode web 运行时生效（import.meta.env.MODE === 'web'）
// - 动态 import：生产构建与 electron-vite dev（E2E 模式）不加载 mock 代码
// - 真实 Electron 环境由 preload 注入 window.api，本分支永不执行
if (import.meta.env.MODE === 'web') {
  const { installMockApi } = await import('@/dev/mock-api');
  installMockApi();
}

import { LANGUAGE_STORAGE_KEY } from '@/i18n/config';
// S1（settings 下沉 SQLite）：render 前拉取设置快照（顶层 await）
// - Electron：settings:getAll 读 SQLite；空库时一次性迁移 legacy localStorage
// - 浏览器模式：回退 localStorage（mock window.api 由上一分支注入）
import { bootstrapSettings } from '@/lib/settings-bootstrap';
// 在 React 渲染前同步应用初始主题，消除首屏闪烁（FOUC 防护）
// 必须在 createRoot(...).render() 之前调用
import { applyInitialTheme } from '@/lib/theme-init';
import { applySettingsSnapshot, flushPendingSettings } from '@/stores/persistent/settings-store';

// 2026-09-08 可靠性修复：退出前等待在途设置写入落库
// （settings-store 写穿透是 fire-and-forget，改设置后立即关窗会丢最后一次变更）
window.addEventListener('pagehide', () => {
  void flushPendingSettings();
});

const { theme, snapshot } = await bootstrapSettings();
applySettingsSnapshot(snapshot);
applyInitialTheme(theme);
// P2 修复：语言真源在 SQLite（settings-store），但 i18next LanguageDetector
// 初始化只读 localStorage——render 前把快照语言镜像进 detector 键，
// 保证首帧即为用户选择的语言（无 SQLite 时回落 detector 默认行为）
const snapshotLanguage = snapshot['language'];
if (typeof snapshotLanguage === 'string') {
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, snapshotLanguage);
  } catch {
    // 无痕模式等场景静默
  }
}
// React 19 createRoot API
const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('根节点 #root 未找到');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
