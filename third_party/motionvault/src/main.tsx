import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import './index.css'
import App from './App.tsx'

// 新版本部署后，缓存中的旧 entry 仍会引用已被删除的懒加载分包
// （404 → 动态 import 失败 → 白屏）。捕获后整页刷新一次，reload 会
// 绕过文档缓存拿到新 entry；sessionStorage 标记保证最多重试一次，不循环。
window.addEventListener('error', (e) => {
  if (!/dynamically imported module/i.test(e.message ?? '')) return
  let reloaded = true
  try {
    reloaded = sessionStorage.getItem('mv:chunk-reloaded') === '1'
    sessionStorage.setItem('mv:chunk-reloaded', '1')
  } catch {
    // 隐私模式等场景读不到 sessionStorage：仍然刷新一次
  }
  if (!reloaded) location.reload()
})

// 站点可能部署在 GitHub Pages 子路径（/<仓库名>/）下，BrowserRouter 需要
// basename 才能生成带前缀的 URL；基路径由 index.html 在路由还原脚本
// 改写地址前探测写入（见 index.html 与 public/404.html）。
const basename = (window as { __MV_BASE__?: string }).__MV_BASE__ || '/'

// No StrictMode: it double-invokes effects and restarts canvas/rAF previews.
createRoot(document.getElementById('root')!).render(
  <BrowserRouter basename={basename}>
    <App />
  </BrowserRouter>,
)
