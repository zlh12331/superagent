// src/renderer/main.tsx
// React 19.2 渲染层入口
// 设计文档 §2.3 React 19.2 + React Compiler

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'

// React 19 createRoot API
const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('根节点 #root 未找到')
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
