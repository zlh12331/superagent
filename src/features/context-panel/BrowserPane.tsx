/**
 * BrowserPane — 浏览器预览面板（browser tab）
 *
 * 对应 prototype.html `#crpPaneBrowser`。
 * 提供地址栏、导航按钮、设备工具栏及 iframe 预览区。
 *
 * 参考样式: prototype.html `.br-toolbar`, `.br-url-wrapper`, `.br-device-bar`,
 *           `.br-content`, `.br-empty`, `.br-iframe`, `.br-loading`
 */

import { useState, useEffect, useRef, type CSSProperties } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Brush,
  ChevronDown,
  Code2,
  Copy,
  ExternalLink,
  Link2,
  MonitorSmartphone,
  MousePointer2,
  RotateCw,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

/** 设备预设类型 */
type DevicePreset = 'responsive' | 'desktop' | 'laptop' | 'tablet' | 'mobile'

/** BrowserPane 组件 props —— 预留供后续真实数据接入 */
export interface BrowserPaneProps {
  /** 初始预览 URL；为空则显示空状态 */
  initialUrl?: string
}

/** 设备预设 → 默认宽高映射 */
const DEVICE_DIMENSIONS: Record<DevicePreset, { width: number; height: number }> = {
  responsive: { width: 1194, height: 790 },
  desktop: { width: 1920, height: 1080 },
  laptop: { width: 1366, height: 768 },
  tablet: { width: 768, height: 1024 },
  mobile: { width: 375, height: 667 },
}

/** 工具栏按钮基础样式 */
const TOOLBAR_BTN_CLASS =
  'flex h-6 w-6 flex-shrink-0 items-center justify-center rounded border-none bg-transparent p-0 text-[var(--text-dim)] transition-colors hover:bg-[var(--bg-elev-3)] hover:text-[var(--text)] disabled:cursor-not-allowed disabled:opacity-30'

/**
 * P0 修复：工具栏按钮 active 状态样式（对齐原型 .br-toolbar-btn.active）
 * 原型：{ color: var(--accent); background: var(--accent-soft); }
 */
const TOOLBAR_BTN_ACTIVE_CLASS = 'text-[var(--accent)] bg-[var(--accent-soft)]'

/**
 * 浏览器预览面板组件
 *
 * 内部管理 URL 输入、浏览历史（后退/前进）、加载状态与设备工具栏。
 * 当前用 mock 数据填充，后续可接入真实预览服务。
 */
export function BrowserPane({ initialUrl = '' }: BrowserPaneProps) {
  // URL 输入框当前值
  const [urlInput, setUrlInput] = useState(initialUrl)
  // 已加载的 URL（null 表示未加载，显示空状态）
  const [loadedUrl, setLoadedUrl] = useState<string | null>(
    initialUrl || null
  )
  // 浏览历史栈
  const [history, setHistory] = useState<string[]>(initialUrl ? [initialUrl] : [])
  // 当前历史指针（-1 表示无历史）
  const [historyIndex, setHistoryIndex] = useState(initialUrl ? 0 : -1)
  // 加载状态（控制顶部进度条）
  const [loading, setLoading] = useState(false)
  // 设备工具栏是否可见
  const [showDeviceBar, setShowDeviceBar] = useState(false)
  // 设备预设
  const [devicePreset, setDevicePreset] = useState<DevicePreset>('responsive')
  // 设备宽高
  const [deviceWidth, setDeviceWidth] = useState(1194)
  const [deviceHeight, setDeviceHeight] = useState(790)
  // 缩放比例
  const [deviceZoom, setDeviceZoom] = useState(100)
  // 检查元素模式（toggle，激活时按钮高亮）
  const [inspectActive, setInspectActive] = useState(false)
  // 开发者工具（toggle，激活时按钮高亮）
  const [devtoolsActive, setDevtoolsActive] = useState(false)
  // CSS 检查器（toggle，激活时按钮高亮）
  const [cssActive, setCssActive] = useState(false)

  // ---- 未清理 timer 的句柄（组件卸载时统一清理）----
  // navigateTo 的 1.5s loading 模拟 timer
  const loadingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // refresh 的 100ms 重新加载 timer
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 组件卸载时清理所有未完成 timer，避免对已卸载组件 setState
  useEffect(() => {
    return () => {
      if (loadingTimerRef.current !== null) {
        clearTimeout(loadingTimerRef.current)
        loadingTimerRef.current = null
      }
      if (refreshTimerRef.current !== null) {
        clearTimeout(refreshTimerRef.current)
        refreshTimerRef.current = null
      }
    }
  }, [])

  /** 规范化 URL：缺少协议时自动补 https:// */
  const normalizeUrl = (raw: string): string => {
    const trimmed = raw.trim()
    if (!trimmed) return ''
    if (/^https?:\/\//i.test(trimmed)) return trimmed
    return `https://${trimmed}`
  }

  /** 加载指定 URL，更新历史栈与加载状态 */
  const navigateTo = (rawUrl: string) => {
    const normalized = normalizeUrl(rawUrl)
    if (!normalized) return

    setUrlInput(normalized)
    setLoadedUrl(normalized)
    setLoading(true)

    // 截断当前指针之后的历史，追加新 URL
    const newHistory = [...history.slice(0, historyIndex + 1), normalized]
    setHistory(newHistory)
    setHistoryIndex(newHistory.length - 1)

    // 模拟加载完成（真实场景由 iframe onLoad 触发）
    // 保存到 ref 以便卸载时清理
    if (loadingTimerRef.current !== null) {
      clearTimeout(loadingTimerRef.current)
    }
    loadingTimerRef.current = setTimeout(() => {
      setLoading(false)
      loadingTimerRef.current = null
    }, 1500)
  }

  /** 后退：指针前移，加载历史 URL */
  const goBack = () => {
    if (historyIndex <= 0) return
    const newIndex = historyIndex - 1
    const targetUrl = history[newIndex]
    if (targetUrl) {
      setHistoryIndex(newIndex)
      setUrlInput(targetUrl)
      setLoadedUrl(targetUrl)
    }
  }

  /** 前进：指针后移，加载历史 URL */
  const goForward = () => {
    if (historyIndex >= history.length - 1) return
    const newIndex = historyIndex + 1
    const targetUrl = history[newIndex]
    if (targetUrl) {
      setHistoryIndex(newIndex)
      setUrlInput(targetUrl)
      setLoadedUrl(targetUrl)
    }
  }

  /** 刷新：重新加载当前 URL */
  const refresh = () => {
    if (!loadedUrl) return
    setLoading(true)
    // 通过 key 变化强制 iframe 重新加载
    setLoadedUrl(null)
    // 保存到 ref 以便卸载时清理
    if (refreshTimerRef.current !== null) {
      clearTimeout(refreshTimerRef.current)
    }
    refreshTimerRef.current = setTimeout(() => {
      setLoadedUrl(urlInput)
      setLoading(false)
      refreshTimerRef.current = null
    }, 100)
  }

  /** 切换设备预设时更新宽高 */
  const handlePresetChange = (preset: DevicePreset) => {
    setDevicePreset(preset)
    const dims = DEVICE_DIMENSIONS[preset]
    if (dims) {
      setDeviceWidth(dims.width)
      setDeviceHeight(dims.height)
    }
  }

  // iframe 容器样式：非 responsive 预设时应用固定宽高与缩放
  const iframeWrapperStyle: CSSProperties =
    devicePreset === 'responsive'
      ? {}
      : {
          width: deviceWidth,
          height: deviceHeight,
          transform: `scale(${deviceZoom / 100})`,
          transformOrigin: 'top left',
        }

  return (
    <div className="flex h-full flex-col">
      {/* P0 修复：注入 br-loading-bar 关键帧动画（对齐原型 @keyframes br-loading-bar） */}
      {/* 静态 CSS 字符串，无安全风险 */}
      <style dangerouslySetInnerHTML={{
        __html: `
        @keyframes br-loading-bar {
          0% { transform: scaleX(0.1); transform-origin: left; }
          50% { transform: scaleX(0.6); transform-origin: left; }
          51% { transform: scaleX(0.6); transform-origin: right; }
          100% { transform: scaleX(0.1); transform-origin: right; }
        }`,
      }} />
      {/* === 工具栏：导航 + 地址栏 + 操作按钮 === */}
      <div className="flex h-8 flex-shrink-0 items-center gap-1.5 border-b border-[var(--border)] bg-[var(--bg-elev-2)] px-2">
        {/* 导航组：后退 / 前进 / 刷新 */}
        <div className="flex items-center gap-0">
          <button
            type="button"
            title="后退"
            aria-label="后退"
            onClick={goBack}
            disabled={historyIndex <= 0}
            className={TOOLBAR_BTN_CLASS}
          >
            <ArrowLeft size={14} />
          </button>
          <button
            type="button"
            title="前进"
            aria-label="前进"
            onClick={goForward}
            disabled={historyIndex >= history.length - 1}
            className={TOOLBAR_BTN_CLASS}
          >
            <ArrowRight size={14} />
          </button>
          <button
            type="button"
            title="刷新"
            aria-label="刷新"
            onClick={refresh}
            disabled={!loadedUrl}
            className={TOOLBAR_BTN_CLASS}
          >
            <RotateCw size={14} />
          </button>
        </div>

        {/* 地址栏：图标 + 输入框 + 操作（group 用于控制复制按钮 hover 显示） */}
        <div className="group flex h-6 min-w-0 flex-1 items-center rounded-full border border-transparent bg-[var(--bg-elev-3)] px-2.5 transition-colors focus-within:border-[var(--accent)]">
          <Link2 size={12} className="mr-1.5 flex-shrink-0 text-[var(--text-faint)]" />
          <input
            type="text"
            value={urlInput}
            onChange={e => setUrlInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') navigateTo(urlInput)
            }}
            placeholder="输入 URL 进行预览"
            spellCheck={false}
            aria-label="预览 URL"
            className="h-full min-w-0 flex-1 border-none bg-transparent text-xs text-[var(--text)] outline-none placeholder:text-[var(--text-faint)]"
          />
          <div className="ml-1 flex flex-shrink-0 items-center">
            <button
              type="button"
              title="复制网址"
              aria-label="复制网址"
              onClick={() => {
                if (loadedUrl) {
                  void navigator.clipboard?.writeText(loadedUrl)
                }
              }}
              // P0 修复：[.br-url-wrapper:hover_&] 选择器找不到类名（wrapper 用的是 group 而非 br-url-wrapper）
              //   → 改为 group-hover:opacity-100（父级 div 已有 group 类）
              className="flex h-5 w-5 items-center justify-center rounded-[3px] text-[var(--text-faint)] opacity-0 transition-opacity hover:text-[var(--text)] focus:opacity-100 group-hover:opacity-100"
            >
              <Copy size={12} />
            </button>
            <button
              type="button"
              title="选择正在运行的服务"
            aria-label="选择正在运行的服务"
              // 对齐原型 #brDropdown 行为：点击等同于按 Enter，导航到当前 URL 输入框的值。
              // 原型 line 10752: dropdownBtn.addEventListener('click', () => navigate(urlInput.value, true))
              onClick={() => navigateTo(urlInput)}
              className="flex h-5 w-5 items-center justify-center rounded-[3px] text-[var(--text-faint)] transition-colors hover:bg-[var(--bg-elev-3)] hover:text-[var(--text)]"
            >
              <ChevronDown size={10} />
            </button>
          </div>
        </div>

        {/* 操作组：检查元素 / 外部浏览器 / 设备工具栏 / 开发者工具 / CSS 检查器 */}
        <div className="flex items-center gap-0">
          <button
            type="button"
            title="选择元素模式"
            aria-label="选择元素模式"
            onClick={() => {
              const next = !inspectActive
              setInspectActive(next)
              toast.info(next ? 'Inspect 模式已启用' : 'Inspect 模式已关闭')
            }}
            className={cn(TOOLBAR_BTN_CLASS, inspectActive && TOOLBAR_BTN_ACTIVE_CLASS)}
          >
            <MousePointer2 size={14} />
          </button>
          <button
            type="button"
            title="在外部浏览器中打开"
            aria-label="在外部浏览器中打开"
            className={TOOLBAR_BTN_CLASS}
            onClick={() => {
              if (loadedUrl) window.open(loadedUrl, '_blank')
            }}
          >
            <ExternalLink size={14} />
          </button>
          <button
            type="button"
            title="显示设备工具栏"
            aria-label="显示设备工具栏"
            onClick={() => setShowDeviceBar(v => !v)}
            className={cn(TOOLBAR_BTN_CLASS, showDeviceBar && TOOLBAR_BTN_ACTIVE_CLASS)}
          >
            <MonitorSmartphone size={14} />
          </button>
          <button
            type="button"
            title="打开开发者工具"
            aria-label="打开开发者工具"
            onClick={() => {
              const next = !devtoolsActive
              setDevtoolsActive(next)
              toast.info(next ? 'DevTools 已打开' : 'DevTools 已关闭')
            }}
            className={cn(TOOLBAR_BTN_CLASS, devtoolsActive && TOOLBAR_BTN_ACTIVE_CLASS)}
          >
            <Code2 size={14} />
          </button>
          <button
            type="button"
            title="CSS 检查器"
            aria-label="CSS 检查器"
            onClick={() => {
              const next = !cssActive
              setCssActive(next)
              toast.info(next ? 'CSS 检查器已启用' : 'CSS 检查器已关闭')
            }}
            className={cn(TOOLBAR_BTN_CLASS, cssActive && TOOLBAR_BTN_ACTIVE_CLASS)}
          >
            <Brush size={14} />
          </button>
        </div>
      </div>

      {/* === 设备工具栏（可切换显示） === */}
      {showDeviceBar && (
        <div className="flex h-[30px] flex-shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--bg-elev-2)] px-2.5">
          {/* 设备预设下拉 */}
          <select
            value={devicePreset}
            onChange={e => handlePresetChange(e.target.value as DevicePreset)}
            aria-label="设备预设"
            className="h-[22px] cursor-pointer rounded border border-transparent bg-[var(--bg-elev-3)] px-1.5 text-[11px] text-[var(--text-dim)] outline-none focus:border-[var(--accent)]"
          >
            <option value="responsive">Responsive</option>
            <option value="desktop">Desktop</option>
            <option value="laptop">Laptop</option>
            <option value="tablet">Tablet</option>
            <option value="mobile">Mobile</option>
          </select>

          {/* 宽高输入 */}
          <div className="flex items-center gap-0.5">
            <input
              type="number"
              value={deviceWidth}
              onChange={e => setDeviceWidth(Number(e.target.value))}
              min={200}
              max={3000}
              aria-label="设备宽度"
              className="h-[22px] w-[52px] rounded border border-transparent bg-[var(--bg-elev-3)] text-center font-mono text-[11px] text-[var(--text-dim)] outline-none focus:border-[var(--accent)]"
            />
            <span className="px-0.5 font-mono text-[11px] text-[var(--text-faint)]">×</span>
            <input
              type="number"
              value={deviceHeight}
              onChange={e => setDeviceHeight(Number(e.target.value))}
              min={200}
              max={3000}
              aria-label="设备高度"
              className="h-[22px] w-[52px] rounded border border-transparent bg-[var(--bg-elev-3)] text-center font-mono text-[11px] text-[var(--text-dim)] outline-none focus:border-[var(--accent)]"
            />
          </div>

          {/* 缩放比例下拉 */}
          <select
            value={deviceZoom}
            onChange={e => setDeviceZoom(Number(e.target.value))}
            aria-label="缩放比例"
            className="h-[22px] cursor-pointer rounded border border-transparent bg-[var(--bg-elev-3)] px-1.5 text-[11px] text-[var(--text-dim)] outline-none focus:border-[var(--accent)]"
          >
            <option value={25}>25%</option>
            <option value={50}>50%</option>
            <option value={75}>75%</option>
            <option value={100}>100%</option>
            <option value={125}>125%</option>
            <option value={150}>150%</option>
            <option value={200}>200%</option>
          </select>

          {/* 关闭设备工具栏 */}
          <button
            type="button"
            title="关闭设备工具栏"
            onClick={() => setShowDeviceBar(false)}
            className={cn(TOOLBAR_BTN_CLASS, 'ml-auto')}
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* === 内容区：加载进度条 + 空状态 / iframe 预览 === */}
      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-white">
        {/* 顶部加载进度条 */}
        {/* P0 修复：animate-pulse → animate-[br-loading-bar_1.5s_ease-in-out_infinite]（对齐原型 .br-loading 动画） */}
        {loading && (
          <div className="absolute left-0 right-0 top-0 z-[2] h-0.5 origin-left animate-[br-loading-bar_1.5s_ease-in-out_infinite] bg-[var(--accent)]" />
        )}

        {/* 空状态：未加载任何 URL 时显示 */}
        {!loadedUrl && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 bg-[var(--bg)]">
            <Link2 size={48} className="text-[var(--text-faint)] opacity-50" />
            <div className="text-center text-xs text-[var(--text-dim)]">
              浏览器预览
            </div>
            {/* P0 修复：补 -mt-0.5（对齐原型 .br-empty-hint { margin-top:-2px }） */}
            <div className="-mt-0.5 text-[11px] text-[var(--text-faint)]">
              在地址栏输入 URL 以预览网页内容
            </div>
          </div>
        )}

        {/* iframe 预览区 */}
        {loadedUrl && (
          <div
            className="absolute inset-0 overflow-auto"
            style={iframeWrapperStyle}
          >
            <iframe
              key={loadedUrl}
              src={loadedUrl}
              title="浏览器预览"
              className="h-full w-full border-none bg-white"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            />
          </div>
        )}
      </div>
    </div>
  )
}
