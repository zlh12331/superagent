// src/renderer/main.tsx
// React 19.2 渲染层入口
// 设计文档 §2.3 React 19.2 + React Compiler

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

// 在 React 渲染前同步应用初始主题，消除首屏闪烁（FOUC 防护）
// 必须在 createRoot(...).render() 之前调用
import { applyInitialTheme } from '@/lib/theme-init';

applyInitialTheme();

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
