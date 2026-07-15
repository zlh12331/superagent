/**
 * SettingsPanes — 9 个设置分区组件
 *
 * 参照 prototype.html 设置抽屉各分区实现。
 * 状态持久化到 localStorage（浏览器模式），Tauri 模式下后续接入后端。
 */

import { useState, useCallback } from 'react'
import { toast } from 'sonner'
import {
  Trash2,
  RefreshCw,
  ExternalLink,
  Plus,
  Monitor,
  Terminal,
  Power,
  Download,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useTheme } from '@/hooks/use-theme'
import {
  SectionTitle,
  SettingRow,
  ToggleRow,
  SegControl,
  SettingField,
} from '../shared/SettingsControls'
import { ApiConfigForm } from './ApiConfigForm'
import { ShortcutPicker } from '../ShortcutPicker'
import { McpServerList } from '@/features/mcp-manager'
import { useDialogStore, type DialogState } from '@/store/dialog-store'

// ─── localStorage 辅助函数 ────────────────────────────────────────

/**
 * 基于 localStorage 的状态持久化 hook。
 *
 * 在浏览器/mock 模式下作为简易持久化方案，Tauri 模式下后续接入后端 preferences.json。
 *
 * 实现要点：
 *  - 惰性初始化：从 localStorage 读取并 JSON.parse，失败时回退到 initial
 *  - 更新函数同步写 localStorage，捕获配额错误（QuotaExceededError）忽略
 *  - 返回元组 [state, update]，与 useState API 一致便于替换
 *
 * @param key — localStorage 键名
 * @param initial — 初始值（localStorage 无记录或解析失败时使用）
 * @returns [当前状态, 更新函数]
 *
 * @example
 * const [lang, setLang] = useLocalState('codex-lang', 'zh')
 */
function useLocalState<T>(key: string, initial: T): [T, (v: T) => void] {
  const [state, setState] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw !== null ? (JSON.parse(raw) as T) : initial
    } catch {
      return initial
    }
  })
  const update = useCallback(
    (v: T) => {
      setState(v)
      try {
        localStorage.setItem(key, JSON.stringify(v))
      } catch {
        // 忽略配额错误
      }
    },
    [key]
  )
  return [state, update]
}

/**
 * 包装 toggle 的 onChange，在状态更新后显示 toast 反馈。
 *
 * 由于 ToggleRow 组件定义在 SettingsControls.tsx（不可修改），
 * 无法在其内部统一处理 toast。故在此提供高阶函数，
 * 让各 pane 的 onChange 复用同一套反馈文案：
 *   "{名称} · 已启用" / "{名称} · 已禁用"
 *
 * @param name  开关显示名称（与 ToggleRow 的 name prop 保持一致）
 * @param setter 实际更新状态的函数
 * @returns 包装后的 onChange，先更新状态再弹 toast
 */
function toggleWithToast(
  name: string,
  setter: (v: boolean) => void
): (v: boolean) => void {
  return (v: boolean) => {
    setter(v)
    toast.success(`${name} · ${v ? '已启用' : '已禁用'}`)
  }
}

// ════════════════════════════════════════════════════════════════
// 1. 通用
// ════════════════════════════════════════════════════════════════

/**
 * GeneralSettingsPane 组件 —— 通用设置分区。
 *
 * 渲染逻辑：
 *  - 语言区：SegControl 切换中文/English，切换后 toast 提示
 *  - 显示密度区：compact / comfortable 二选一，切换时同步 body className
 *  - 行为区：自动滚动开关、发送快捷键 Enter/⌘Enter、Token 计数开关
 *
 * 状态依赖：
 *  - 所有配置通过 useLocalState 持久化到 localStorage
 *  - 密度切换时直接操作 document.body.classList（应用全局样式）
 *
 * 副作用：
 *  - handleDensityChange 修改 body class，影响全局消息间距/字号
 *
 * 设计决策：
 *  - 使用 SegControl（分段控件）而非下拉框，便于快速预览选项
 *  - 配置项命名前缀 codex- 避免与其他应用冲突
 */
export function GeneralSettingsPane() {
  const [lang, setLang] = useLocalState('codex-lang', 'zh')
  const [density, setDensity] = useLocalState('codex-density', 'comfortable')
  const [autoScroll, setAutoScroll] = useLocalState(
    'codex-toggle-autoscroll',
    true
  )
  const [sendKey, setSendKey] = useLocalState('codex-sendkey', 'Enter')
  const [tokenCount, setTokenCount] = useLocalState(
    'codex-toggle-tokencount',
    true
  )

  const handleLangChange = (v: string) => {
    setLang(v)
    toast.success(`语言已切换为：${v === 'zh' ? '中文' : 'English'}`)
  }

  const handleDensityChange = (v: string) => {
    setDensity(v)
    document.body.classList.remove('compact', 'comfortable')
    document.body.classList.add(v)
  }

  return (
    <div className="space-y-2">
      <SectionTitle>语言</SectionTitle>
      <SettingRow label="界面语言">
        <SegControl
          value={lang}
          onChange={handleLangChange}
          options={[
            { value: 'zh', label: '中文' },
            { value: 'en', label: 'English' },
          ]}
        />
      </SettingRow>

      <SectionTitle>显示密度</SectionTitle>
      <SettingRow
        label="消息间距与字号"
        description="compact 紧凑 / comfortable 舒适"
      >
        <SegControl
          value={density}
          onChange={handleDensityChange}
          options={[
            { value: 'compact', label: '紧凑' },
            { value: 'comfortable', label: '舒适' },
          ]}
        />
      </SettingRow>

      <SectionTitle>行为</SectionTitle>
      <ToggleRow
        name="自动滚动到底部"
        description="新消息到达时自动滚动"
        checked={autoScroll}
        onChange={toggleWithToast('自动滚动到底部', setAutoScroll)}
      />
      <SettingRow label="发送快捷键" description="选择发送消息的快捷键">
        <SegControl
          value={sendKey}
          onChange={setSendKey}
          options={[
            { value: 'Enter', label: 'Enter' },
            { value: 'CmdEnter', label: '⌘Enter' },
          ]}
        />
      </SettingRow>
      <ToggleRow
        name="显示 Token 计数"
        description="在消息底部显示 token 用量"
        checked={tokenCount}
        onChange={toggleWithToast('显示 Token 计数', setTokenCount)}
      />
    </div>
  )
}

// ════════════════════════════════════════════════════════════════
// 2. 外观
// ════════════════════════════════════════════════════════════════

/**
 * AppearanceSettingsPane 组件 —— 外观设置分区。
 *
 * 渲染逻辑：
 *  - 主题区：dark / light / system 三选一，由 useTheme 统一管理
 *  - 字体区：range 滑块调整字号（11-20px），实时显示当前数值
 *
 * 状态依赖：
 *  - useTheme() 提供 theme/setTheme（来自 ThemeProviderContext）
 *  - fontSize 通过 useLocalState 持久化
 *
 * 设计决策：
 *  - 主题切换走 ThemeProvider 统一入口，自动处理 localStorage + 跨窗口同步
 *  - 字号滑块使用 accent-color 跟随主题强调色
 *
 * @see src/components/ThemeProvider.tsx — 主题上下文实现
 */
export function AppearanceSettingsPane() {
  const { theme, setTheme } = useTheme()
  const [fontSize, setFontSize] = useLocalState('codex-fontsize', 14)

  return (
    <div className="space-y-2">
      <SectionTitle>主题</SectionTitle>
      <SettingRow label="颜色主题" description="选择应用的配色方案">
        <SegControl
          value={theme}
          onChange={v => setTheme(v as 'dark' | 'light' | 'system')}
          options={[
            { value: 'dark', label: '暗色' },
            { value: 'light', label: '浅色' },
            { value: 'system', label: '跟随系统' },
          ]}
        />
      </SettingRow>

      <SectionTitle>字体</SectionTitle>
      <SettingRow label="字体大小" description={`${fontSize}px`}>
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={11}
            max={20}
            value={fontSize}
            onChange={e => setFontSize(Number(e.target.value))}
            aria-label="字体大小"
            className="w-32 accent-[var(--accent)]"
          />
          <span className="w-8 text-right font-mono text-[11px] text-[var(--text-dim)]">
            {fontSize}
          </span>
        </div>
      </SettingRow>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════
// 3. API 配置
// ════════════════════════════════════════════════════════════════

/**
 * ApiConfigSettingsPane 组件 —— API 配置设置分区。
 *
 * 渲染逻辑：
 *  - 模型选择区：原生 select 下拉框（gpt-5 / gpt-5-mini / deepseek-v4 / claude-sonnet-4）
 *  - 模型参数区：思考强度 SegControl、温度 SegControl、最大 Tokens 数字输入
 *  - 模型接入区：嵌入 ApiConfigForm 组件（API Key / Base URL 等敏感配置）
 *
 * 状态依赖：
 *  - model / thinking / temp / maxTokens 均通过 useLocalState 持久化
 *
 * 设计决策：
 *  - 模型选择用 select 而非 SegControl，便于未来扩展更多模型
 *  - 思考强度 / 温度使用 SegControl 限制可选值，避免用户输入非法值
 *  - 敏感配置抽离到 ApiConfigForm 独立组件，便于复用与统一校验
 *
 * @see src/components/preferences/panes/ApiConfigForm.tsx — API 接入表单
 */
export function ApiConfigSettingsPane() {
  const [model, setModel] = useLocalState('codex-model', 'gpt-5')
  const [thinking, setThinking] = useLocalState('codex-thinking', 'medium')
  const [temp, setTemp] = useLocalState('codex-temp', '0.7')
  const [maxTokens, setMaxTokens] = useLocalState('codex-maxtokens', 4096)

  return (
    <div className="space-y-2">
      <SectionTitle>模型选择</SectionTitle>
      <SettingField
        label="当前模型"
        description="选择 codex 使用的底层 AI 模型"
      >
        <select
          value={model}
          onChange={e => setModel(e.target.value)}
          className="w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-elev)] px-2.5 py-1.5 font-mono text-[12px] text-[var(--text)] outline-none focus:border-[var(--accent-dim)]"
        >
          <option value="gpt-5">gpt-5</option>
          <option value="gpt-5-mini">gpt-5-mini</option>
          <option value="deepseek-v4">deepseek-v4</option>
          <option value="claude-sonnet-4">claude-sonnet-4</option>
        </select>
      </SettingField>

      <SectionTitle>模型参数</SectionTitle>
      <SettingRow label="思考强度">
        <SegControl
          value={thinking}
          onChange={setThinking}
          options={[
            { value: 'off', label: 'off' },
            { value: 'low', label: 'low' },
            { value: 'medium', label: 'medium' },
            { value: 'high', label: 'high' },
          ]}
        />
      </SettingRow>
      <SettingRow label="温度 (Temperature)">
        <SegControl
          value={temp}
          onChange={setTemp}
          options={[
            { value: '0.3', label: '0.3' },
            { value: '0.7', label: '0.7' },
            { value: '1.0', label: '1.0' },
          ]}
        />
      </SettingRow>
      <SettingRow label="最大 Tokens">
        <Input
          type="number"
          min={1}
          step={1}
          value={maxTokens}
          onChange={e => setMaxTokens(Number(e.target.value))}
          className="w-24 font-mono text-[12px]"
        />
      </SettingRow>

      <SectionTitle>模型接入</SectionTitle>
      <ApiConfigForm />
    </div>
  )
}

// ════════════════════════════════════════════════════════════════
// 4. 编辑器
// ════════════════════════════════════════════════════════════════

/**
 * EditorSettingsPane 组件 —— 编辑器设置分区。
 *
 * 渲染逻辑：
 *  - 字体大小：range 滑块（10-22px），实时显示当前数值
 *  - Tab 宽度：SegControl 切换 2/4/8 个空格
 *  - 自动换行：ToggleRow 开关
 *  - 行号显示：ToggleRow 开关
 *
 * 状态依赖：
 *  - editorFontSize / tabWidth / wordWrap / lineNumbers 均通过 useLocalState 持久化
 *
 * 设计决策：
 *  - Tab 宽度限制为 2/4/8 三个常见值，避免用户输入奇数值
 *  - 字号范围 10-22 兼顾可读性与可用性
 */
export function EditorSettingsPane() {
  const [editorFontSize, setEditorFontSize] = useLocalState(
    'codex-editor-fontsize',
    13
  )
  const [tabWidth, setTabWidth] = useLocalState('codex-editor-tabwidth', 2)
  const [wordWrap, setWordWrap] = useLocalState('codex-editor-wordwrap', true)
  const [lineNumbers, setLineNumbers] = useLocalState(
    'codex-editor-linenumbers',
    true
  )

  return (
    <div className="space-y-2">
      <SectionTitle>编辑器</SectionTitle>
      <SettingRow label="字体大小" description={`${editorFontSize}px`}>
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={10}
            max={22}
            value={editorFontSize}
            onChange={e => setEditorFontSize(Number(e.target.value))}
            aria-label="编辑器字体大小"
            className="w-32 accent-[var(--accent)]"
          />
          <span className="w-8 text-right font-mono text-[11px] text-[var(--text-dim)]">
            {editorFontSize}
          </span>
        </div>
      </SettingRow>
      <SettingRow label="Tab 宽度" description={`${tabWidth} 个空格`}>
        <SegControl
          value={String(tabWidth)}
          onChange={v => setTabWidth(Number(v))}
          options={[
            { value: '2', label: '2' },
            { value: '4', label: '4' },
            { value: '8', label: '8' },
          ]}
        />
      </SettingRow>
      <ToggleRow
        name="自动换行"
        description="长行自动折行显示"
        checked={wordWrap}
        onChange={toggleWithToast('自动换行', setWordWrap)}
      />
      <ToggleRow
        name="行号"
        description="在编辑器左侧显示行号"
        checked={lineNumbers}
        onChange={toggleWithToast('行号', setLineNumbers)}
      />
    </div>
  )
}

// ════════════════════════════════════════════════════════════════
// 5. 快捷键
// ════════════════════════════════════════════════════════════════

/** 快捷键条目 — 描述一个可自定义的快捷键 */
interface ShortcutEntry {
  /** 唯一标识，用于持久化与查找 */
  key: string
  /** 显示给用户的名称 */
  label: string
  /** 当前快捷键值（null 表示使用默认值） */
  shortcut: string | null
}

/** 默认快捷键列表 — shortcut 为 null 表示尚未自定义 */
const DEFAULT_SHORTCUTS: ShortcutEntry[] = [
  { key: 'toggle-sidebar', label: '切换侧边栏', shortcut: null },
  { key: 'command-palette', label: '命令面板', shortcut: null },
  { key: 'quick-pane', label: '快速面板', shortcut: null },
  { key: 'settings', label: '打开设置', shortcut: null },
  { key: 'new-thread', label: '新建会话', shortcut: null },
]

/**
 * ShortcutsSettingsPane 组件 —— 快捷键自定义设置分区。
 *
 * 渲染逻辑：
 *  - 顶部说明文字：提示用户点击快捷键框并按下组合键，按 Esc 取消
 *  - 快捷键列表：每项一个 SettingRow + ShortcutPicker
 *
 * 状态依赖：
 *  - shortcuts 数组通过 useLocalState 持久化（键名 codex-shortcuts）
 *  - handleChange 按 idx 不可变更新对应条目的 shortcut 字段
 *
 * 设计决策：
 *  - 使用 ShortcutPicker 组件统一捕获按键，跨平台兼容 CommandOrControl
 *  - 不可变更新数组（spread + map）避免 Zustand 引用相等性问题
 *
 * @see src/components/preferences/ShortcutPicker.tsx — 快捷键选择器
 */
export function ShortcutsSettingsPane() {
  const [shortcuts, setShortcuts] = useLocalState<ShortcutEntry[]>(
    'codex-shortcuts',
    DEFAULT_SHORTCUTS
  )

  const handleChange = (idx: number, value: string | null) => {
    const next = [...shortcuts]
    const item = next[idx]
    if (item) {
      next[idx] = { ...item, shortcut: value }
      setShortcuts(next)
    }
  }

  return (
    <div className="space-y-2">
      <SectionTitle>快捷键自定义</SectionTitle>
      <p className="mb-3 text-[11px] leading-[1.5] text-[var(--text-faint)]">
        点击快捷键框并按下组合键来自定义。按 Esc 取消录制。
      </p>
      {shortcuts.map((entry, idx) => (
        <SettingRow key={entry.key} label={entry.label}>
          <ShortcutPicker
            value={entry.shortcut}
            defaultValue="CommandOrControl+Shift+P"
            onChange={v => handleChange(idx, v)}
          />
        </SettingRow>
      ))}
    </div>
  )
}

// ════════════════════════════════════════════════════════════════
// 6. MCP 服务器
// ════════════════════════════════════════════════════════════════

/**
 * McpSettingsPane 组件 —— MCP 服务器设置分区。
 *
 * 渲染逻辑：
 *  - 直接渲染 McpServerList 组件，由其统一管理服务器列表、添加/删除、工具调用界面
 *
 * 状态依赖：
 *  - 所有 MCP 相关状态由 useMcpStore（Zustand）+ useMcpServers（TanStack Query）管理
 *
 * 设计决策：
 *  - 该分区仅作为容器，避免在此处重复实现 MCP 管理逻辑
 *  - MCP 管理功能复杂（CRUD + 工具调用 + 状态轮询），抽离到独立 feature 模块
 *
 * @see src/features/mcp-manager/McpServerList.tsx — MCP 服务器列表组件
 */
export function McpSettingsPane() {
  // MCP 服务器列表、添加/删除、工具调用界面由 McpServerList 统一管理
  return <McpServerList />
}

// ════════════════════════════════════════════════════════════════
// 7. 高级
// ════════════════════════════════════════════════════════════════

/** 实验功能条目 — 用于 AdvancedSettingsPane 中的功能开关 */
interface ExperimentalFeature {
  /** 唯一标识，作为 localStorage 中的 key 后缀 */
  key: string
  /** 显示名称 */
  name: string
  /** 功能描述 */
  desc: string
  /** 默认是否启用 */
  defaultOn: boolean
}

/** 高级设置中的实验功能列表 */
const EXPERIMENTAL_FEATURES: ExperimentalFeature[] = [
  {
    key: 'realtime',
    name: '实时音频输入输出',
    desc: 'thread-scoped 实时语音交互',
    defaultOn: false,
  },
  {
    key: 'remote',
    name: '远端控制',
    desc: '配对设备访问与远程操作',
    defaultOn: false,
  },
  {
    key: 'collab',
    name: '协作模式',
    desc: '多用户共同编辑同一会话',
    defaultOn: false,
  },
  {
    key: 'plan',
    name: 'Plan 流式输出',
    desc: '显示推理计划与步骤',
    defaultOn: true,
  },
  {
    key: 'reasoning',
    name: '推理摘要',
    desc: '显示思考过程摘要',
    defaultOn: true,
  },
  {
    key: 'scanlines',
    name: '扫描线纹理',
    desc: '致敬终端的 CRT 扫描线效果',
    defaultOn: true,
  },
  {
    key: 'sandbox',
    name: 'Windows Sandbox 集成',
    desc: '在隔离沙箱中执行不信任代码',
    defaultOn: false,
  },
]

/**
 * AdvancedSettingsPane 组件 —— 高级设置分区。
 *
 * 渲染逻辑：
 *  - 实验功能区：ToggleRow 列表，逐项开关
 *  - 命令白名单区：列表展示 + Input 输入 + 添加按钮 + 每项删除按钮
 *
 * 状态依赖：
 *  - features（Record<string, boolean>）通过 useLocalState 持久化
 *  - whitelist（string[]）通过 useLocalState 持久化
 *  - whitelistInput 为临时输入，使用 useState
 *
 * 副作用：
 *  - 添加白名单：toast.success 提示
 *
 * 设计决策：
 *  - 实验功能开关用 Record 而非数组，便于 O(1) 查找
 *  - 白名单使用受控 Input + Enter 提交，提升输入效率
 */
export function AdvancedSettingsPane() {
  const [features, setFeatures] = useLocalState<Record<string, boolean>>(
    'codex-experimental',
    Object.fromEntries(EXPERIMENTAL_FEATURES.map(f => [f.key, f.defaultOn]))
  )
  const [whitelist, setWhitelist] = useLocalState<string[]>('codex-whitelist', [
    'cargo nextest run',
    'cargo build',
    'git status',
  ])
  const [whitelistInput, setWhitelistInput] = useState('')

  const handleFeatureToggle = (key: string, value: boolean) => {
    setFeatures({ ...features, [key]: value })
  }

  const handleAddWhitelist = () => {
    const cmd = whitelistInput.trim()
    if (!cmd) return
    setWhitelist([...whitelist, cmd])
    setWhitelistInput('')
    toast.success(`已添加白名单: ${cmd}`)
  }

  const handleRemoveWhitelist = (idx: number) => {
    setWhitelist(whitelist.filter((_, i) => i !== idx))
  }

  return (
    <div className="space-y-2">
      <SectionTitle>实验功能</SectionTitle>
      <p className="mb-3 text-[11px] leading-[1.5] text-[var(--text-faint)]">
        以下功能处于实验阶段，可能不稳定或发生变更。
      </p>
      {EXPERIMENTAL_FEATURES.map(f => (
        <ToggleRow
          key={f.key}
          name={f.name}
          description={f.desc}
          checked={features[f.key] ?? f.defaultOn}
          onChange={toggleWithToast(f.name, v => handleFeatureToggle(f.key, v))}
        />
      ))}

      <SectionTitle>命令白名单</SectionTitle>
      <p className="mb-3 text-[11px] leading-[1.5] text-[var(--text-faint)]">
        以下 Shell 命令无需审批即可执行。
      </p>
      {whitelist.map((cmd, idx) => (
        <div
          key={`${cmd}-${idx}`}
          className="flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-elev-2)] px-2.5 py-2"
        >
          <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-[var(--text)]">
            {cmd}
          </code>
          <button
            type="button"
            onClick={() => handleRemoveWhitelist(idx)}
            className="shrink-0 text-[var(--text-faint)] hover:text-[var(--error)]"
            aria-label="移除"
          >
            <Trash2 width={13} height={13} />
          </button>
        </div>
      ))}
      <div className="flex gap-2">
        <Input
          value={whitelistInput}
          onChange={e => setWhitelistInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault()
              handleAddWhitelist()
            }
          }}
          placeholder="输入命令…"
          className="font-mono text-[12px]"
        />
        <Button variant="default" size="sm" onClick={handleAddWhitelist}>
          添加
        </Button>
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════
// 8. 账户
// ════════════════════════════════════════════════════════════════

/** 速率限制条目 — 描述一个时间窗口内的请求配额 */
interface RateLimit {
  /** 显示名称（如「主请求」「5h 滚动」） */
  label: string
  /** 已使用次数 */
  used: number
  /** 总配额 */
  total: number
}

/** 速率限制 mock 数据 */
const RATE_LIMITS: RateLimit[] = [
  { label: '主请求', used: 420, total: 1000 },
  { label: '5h 滚动', used: 134, total: 200 },
  { label: '每周', used: 900, total: 5000 },
]

/** Token 用量条目 — 用于账户设置中的用量统计 */
interface UsageItem {
  /** 显示名称（输入/输出/缓存/总计） */
  label: string
  /** Token 数量 */
  value: number
  /** 是否为总计行（true 时使用 accent 色高亮） */
  total?: boolean
}

/** Token 用量 mock 数据 */
const USAGE_ITEMS: UsageItem[] = [
  { label: '输入', value: 15420 },
  { label: '输出', value: 8230 },
  { label: '缓存', value: 4100 },
  { label: '总计', value: 23650, total: true },
]

/**
 * AccountSettingsPane 组件 —— 账户设置分区。
 *
 * 渲染逻辑：
 *  - 账户信息卡片：头像（首字母）+ 邮箱 + 订阅等级 + 退出按钮
 *  - 登录方式：SegControl 切换 ChatGPT / API Key 认证
 *  - 速率限制：进度条列表，展示各时间窗口的配额使用情况
 *  - Token 用量：2x2 网格卡片，总计行使用 accent 色高亮
 *
 * 状态依赖：
 *  - authMode 通过 useLocalState 持久化（codex-auth-mode）
 *
 * 副作用：
 *  - 退出登录 / 重置额度：toast.info 提示功能开发中
 *
 * 设计决策：
 *  - 速率限制进度条宽度用 inline style 动态计算（百分比），过渡动画 300ms
 *  - Token 用量网格使用 tabular-nums 等宽数字，便于对齐
 *
 * @todo 接入真实账户 API 替换 mock 数据
 */
export function AccountSettingsPane() {
  const [authMode, setAuthMode] = useLocalState('codex-auth-mode', 'chatgpt')

  return (
    <div className="space-y-2">
      <SectionTitle>账户信息</SectionTitle>
      {/* D-B-017: account-card 圆角改为 8px（rounded-lg） */}
      <div className="flex items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--bg-elev-2)] p-3">
        {/* D-B-008: account-avatar 尺寸 40x40，形状改为圆形（rounded-full） */}
        <div className="flex h-[40px] w-[40px] items-center justify-center rounded-full bg-gradient-to-br from-[#2A3441] to-[#1A2330] font-mono text-[14px] font-semibold text-[var(--accent)] border border-[var(--border-strong)]">
          DS
        </div>
        <div className="min-w-0 flex-1">
          {/* D-B-018: account-name 添加 font-semibold */}
          <div className="text-[13px] font-semibold text-[var(--text)]">dev@codex.dev</div>
          <div className="text-[11px] text-[var(--text-faint)]">
            ChatGPT Plus · Pro · AuthMode: ChatGPT
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => toast.info('退出登录功能开发中')}
          className="text-[var(--error)]"
        >
          退出
        </Button>
      </div>

      <SectionTitle>登录方式</SectionTitle>
      <SettingRow label="认证方式">
        <SegControl
          value={authMode}
          onChange={setAuthMode}
          options={[
            { value: 'chatgpt', label: 'ChatGPT' },
            { value: 'apikey', label: 'API Key' },
          ]}
        />
      </SettingRow>

      <SectionTitle>速率限制</SectionTitle>
      {RATE_LIMITS.map(rl => {
        const pct = Math.min((rl.used / rl.total) * 100, 100)
        return (
          <div
            key={rl.label}
            className="flex items-center gap-2.5 text-[11px]"
          >
            {/* D-B-010: rl-label 宽度改为 60px */}
            <span className="w-[60px] shrink-0 text-[var(--text-dim)]">
              {rl.label}
            </span>
            {/* D-B-016: rl-bar 圆角改为 3px（rounded-[3px]） */}
            <div className="h-[5px] flex-1 overflow-hidden rounded-[3px] bg-[var(--bg-elev-2)]">
              {/* D-B-016: rl-fill 圆角改为 3px（rounded-[3px]） */}
              <div
                className="h-full rounded-[3px] bg-[var(--accent)] transition-[width] duration-300"
                style={{ width: `${pct}%` }}
              />
            </div>
            {/* D-B-010: rl-text 宽度改为 min-width 70px */}
            <span className="min-w-[70px] shrink-0 text-right font-mono tabular-nums text-[var(--text-faint)]">
              {rl.used}/{rl.total}
            </span>
          </div>
        )
      })}

      <SectionTitle>Token 用量</SectionTitle>
      <div className="grid grid-cols-2 gap-2">
        {USAGE_ITEMS.map(item => (
          <div
            key={item.label}
            // D-B-009: usage-item padding 改为 10px（px-2.5 py-2.5）
            className="rounded-md border border-[var(--border)] bg-[var(--bg-elev-2)] px-2.5 py-2.5"
          >
            {/* D-B-018: ui-label 添加 uppercase 与 letter-spacing 0.05em */}
            <div className="text-[10px] uppercase tracking-[0.05em] text-[var(--text-faint)]">
              {item.label}
            </div>
            {/* D-B-009: ui-value 字号改为 16px，添加 font-semibold */}
            <div
              className={`font-mono text-[16px] font-semibold tabular-nums ${
                item.total ? 'text-[var(--accent)]' : 'text-[var(--text)]'
              }`}
            >
              {item.value.toLocaleString()}
            </div>
          </div>
        ))}
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => toast.info('额度重置功能开发中')}
        className="mt-2"
      >
        <RefreshCw width={13} height={13} /> 重置额度
      </Button>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════
// 9. 关于
// ════════════════════════════════════════════════════════════════

/** 关于信息条目 — 版本号、依赖版本等静态信息 */
const ABOUT_INFO = [
  { label: '版本', value: 'v0.1.0-alpha' },
  { label: '协议版本', value: 'app-server v2' },
  { label: 'Tauri', value: 'v2.4.0' },
  { label: 'React', value: 'v19.2.3' },
  { label: 'TypeScript', value: 'v6.0.2' },
]

/**
 * AboutSettingsPane 组件 —— 关于设置分区。
 *
 * 渲染逻辑：
 *  - 版本信息：键值对列表（版本/协议版本/Tauri/React/TypeScript）
 *  - 检查更新：按钮触发 toast.info 提示（当前已是最新版本）
 *  - 开源许可：Apache-2.0 协议说明 + 外链到官方协议页
 *  - 致谢：列出依赖的开源项目
 *
 * 设计决策：
 *  - 静态信息直接硬编码，无需状态管理
 *  - 外链使用 rel="noopener noreferrer" 防止 tabnabbing 攻击
 */
export function AboutSettingsPane() {
  // 检查更新弹窗开关 — 对齐原型 openUpdater
  const setUpdateOpen = useDialogStore((s: DialogState) => s.setUpdateOpen)

  return (
    <div className="space-y-2">
      <SectionTitle>版本信息</SectionTitle>
      <div className="flex flex-col gap-1.5 rounded-[9px] border border-[var(--border)] bg-[var(--bg-elev-2)] p-3">
        {ABOUT_INFO.map(item => (
          <div
            key={item.label}
            className="flex items-center justify-between text-[12px]"
          >
            <span className="text-[var(--text-dim)]">{item.label}</span>
            <span className="font-mono text-[var(--text)]">{item.value}</span>
          </div>
        ))}
      </div>

      <SectionTitle>检查更新</SectionTitle>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setUpdateOpen(true)}
        className="w-full"
      >
        <RefreshCw width={13} height={13} /> 检查更新
      </Button>

      <SectionTitle>开源许可</SectionTitle>
      <div className="rounded-[9px] border border-[var(--border)] bg-[var(--bg-elev-2)] p-3">
        <p className="text-[12px] leading-[1.6] text-[var(--text-dim)]">
          SuperAgent 基于 Apache-2.0 协议开源。
        </p>
        <a
          href="https://www.apache.org/licenses/LICENSE-2.0"
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-flex items-center gap-1 text-[11px] text-[var(--accent)] hover:underline"
        >
          查看完整协议 <ExternalLink width={11} height={11} />
        </a>
      </div>

      <SectionTitle>致谢</SectionTitle>
      <div className="rounded-[9px] border border-[var(--border)] bg-[var(--bg-elev-2)] p-3">
        <p className="text-[11px] leading-[1.6] text-[var(--text-faint)]">
          感谢以下开源项目：React、Tauri、shadcn/ui、Tailwind
          CSS、Zustand、TanStack Query、
          Vite、Vitest、Playwright、ESLint、Prettier。
        </p>
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════
// 10. 权限配置
// 参照 prototype.html data-section="perm"（行 6043-6077）
// ════════════════════════════════════════════════════════════════

/** 权限配置文件选项 */
interface PermProfile {
  id: string
  name: string
  desc: string
}

const PERM_PROFILES: PermProfile[] = [
  { id: 'default', name: 'default', desc: '默认配置，平衡安全与便利' },
  { id: 'workspace', name: 'workspace', desc: '工作区配置，跟随项目设置' },
  { id: 'custom', name: 'custom', desc: '自定义配置，手动指定规则' },
]

/** 权限作用域条目 */
interface PermScope {
  label: string
  level: 'balanced' | 'strict' | 'relaxed'
}

const PERM_SCOPES: PermScope[] = [
  { label: 'Shell 命令', level: 'balanced' },
  { label: '文件写入', level: 'balanced' },
  { label: '网络请求', level: 'strict' },
  { label: 'MCP 工具', level: 'strict' },
]

/** 作用域级别对应的 badge 样式 */
const SCOPE_BADGE_CLASS: Record<PermScope['level'], string> = {
  balanced:
    'bg-[var(--info-blue)] text-[var(--accent)] border-[var(--accent-dim)]',
  strict:
    'bg-[var(--info-amber)] text-[var(--warn)] border-[var(--warn)]',
  relaxed:
    'bg-[rgba(0,217,192,0.12)] text-[var(--success)] border-[var(--success)]',
}

/**
 * PermissionSettingsPane 组件 —— 权限配置设置分区。
 *
 * 渲染逻辑：
 *  - 权限配置文件区：radio 组（default / workspace / custom），自定义按钮样式模拟 radio
 *  - 作用域区：Shell 命令 / 文件写入 / 网络请求 / MCP 工具，每项显示级别 badge
 *  - 命令白名单区：列表展示 + Input 输入 + 添加按钮 + 每项删除按钮
 *
 * 状态依赖：
 *  - profile 通过 useLocalState 持久化（codex-perm-profile）
 *  - whitelist 通过 useLocalState 持久化（codex-perm-whitelist）
 *  - whitelistInput 为临时输入，使用 useState
 *
 * 副作用：
 *  - 添加白名单：toast.success 提示
 *
 * 设计决策：
 *  - radio 组用 button + 自定义圆形指示器实现，便于完全控制样式
 *  - 作用域级别（balanced/strict/relaxed）使用 badge 配色区分，直观
 *  - 白名单与高级设置中的白名单独立存储，避免混淆
 *
 * @see 参照 prototype.html data-section="perm"（行 6043-6077）
 */
export function PermissionSettingsPane() {
  // 当前选中的权限配置文件
  const [profile, setProfile] = useLocalState('codex-perm-profile', 'default')
  // 命令白名单（mock 数据）
  const [whitelist, setWhitelist] = useLocalState<string[]>('codex-perm-whitelist', [
    'cargo nextest run',
    'cargo build',
    'git status',
  ])
  const [whitelistInput, setWhitelistInput] = useState('')

  const handleAddWhitelist = () => {
    const cmd = whitelistInput.trim()
    if (!cmd) return
    setWhitelist([...whitelist, cmd])
    setWhitelistInput('')
    toast.success(`已添加白名单: ${cmd}`)
  }

  const handleRemoveWhitelist = (idx: number) => {
    setWhitelist(whitelist.filter((_, i) => i !== idx))
  }

  return (
    <div className="space-y-2">
      <SectionTitle>权限配置文件</SectionTitle>
      <p className="mb-3 text-[11px] leading-[1.5] text-[var(--text-faint)]">
        管理 codex 在执行命令、文件写入、网络请求等操作时的权限级别。
      </p>
      {/* 权限配置文件选择器 — radio 组 */}
      <div className="flex flex-col gap-1.5">
        {PERM_PROFILES.map(p => {
          const isActive = profile === p.id
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => setProfile(p.id)}
              className={
                'flex items-center gap-2.5 rounded-[9px] border px-3 py-2.5 text-left transition-colors ' +
                (isActive
                  ? 'border-[var(--accent)] bg-[var(--info-blue)]'
                  : 'border-[var(--border)] bg-[var(--bg-elev-2)] hover:bg-[var(--bg-elev)]')
              }
            >
              <span
                className={
                  'flex h-[14px] w-[14px] shrink-0 items-center justify-center rounded-full border ' +
                  (isActive
                    ? 'border-[var(--accent)]'
                    : 'border-[var(--border-strong)]')
                }
              >
                {isActive && (
                  <span className="h-[7px] w-[7px] rounded-full bg-[var(--accent)]" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <div className="font-mono text-[12px] text-[var(--text)]">
                  {p.name}
                </div>
                <div className="text-[11px] text-[var(--text-faint)]">
                  {p.desc}
                </div>
              </div>
            </button>
          )
        })}
      </div>

      <SectionTitle>作用域</SectionTitle>
      {PERM_SCOPES.map(scope => (
        <SettingRow key={scope.label} label={scope.label}>
          <span
            className={
              'rounded border px-2 py-0.5 font-mono text-[10px] font-semibold ' +
              SCOPE_BADGE_CLASS[scope.level]
            }
          >
            {scope.level}
          </span>
        </SettingRow>
      ))}

      <SectionTitle>命令白名单</SectionTitle>
      <p className="mb-3 text-[11px] leading-[1.5] text-[var(--text-faint)]">
        白名单中的命令将自动批准，无需每次审批。可按需添加或移除。
      </p>
      {whitelist.map((cmd, idx) => (
        <div
          key={`${cmd}-${idx}`}
          className="flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-elev-2)] px-2.5 py-2"
        >
          <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-[var(--text)]">
            {cmd}
          </code>
          <button
            type="button"
            onClick={() => handleRemoveWhitelist(idx)}
            className="shrink-0 text-[var(--text-faint)] hover:text-[var(--error)]"
            aria-label="移除"
          >
            <Trash2 width={13} height={13} />
          </button>
        </div>
      ))}
      <div className="flex gap-2">
        <Input
          value={whitelistInput}
          onChange={e => setWhitelistInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault()
              handleAddWhitelist()
            }
          }}
          placeholder="输入命令…"
          className="font-mono text-[12px]"
        />
        <Button variant="default" size="sm" onClick={handleAddWhitelist}>
          添加
        </Button>
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════
// 11. 实验功能
// 参照 prototype.html data-section="exp"（行 6078-6144）
// ════════════════════════════════════════════════════════════════

/** 实验功能条目 */
interface ExpFeature {
  key: string
  name: string
  desc: string
  stable: boolean
  defaultOn: boolean
}

const EXP_FEATURES: ExpFeature[] = [
  { key: 'collab', name: 'collaboration', desc: '协作模式 · 多用户共同编辑', stable: false, defaultOn: false },
  { key: 'interpreter', name: 'code-interpreter', desc: '代码解释器 · 在沙箱中执行代码', stable: false, defaultOn: false },
  { key: 'localtools', name: 'local-tools', desc: '本地工具调用 · 直接调用系统工具', stable: false, defaultOn: false },
  { key: 'expmodel', name: 'experimental-model', desc: '实验模型 · 启用尚未正式发布的模型', stable: false, defaultOn: false },
  { key: 'streamdiff', name: 'streaming-diff', desc: '流式 diff 输出 · 实时显示文件差异', stable: true, defaultOn: true },
  { key: 'websearch', name: 'web-search', desc: 'Web 搜索 · 联网搜索补充上下文', stable: true, defaultOn: false },
  { key: 'snapshot', name: 'file-snapshot', desc: '文件快照 · 编辑前自动保存快照', stable: true, defaultOn: true },
  { key: 'telemetry', name: 'telemetry', desc: '遥测数据上报 · 帮助改进产品', stable: true, defaultOn: false },
  { key: 'realtime', name: 'realtime-audio', desc: '实时音频输入输出（thread-scoped）', stable: false, defaultOn: false },
  { key: 'remote', name: 'remote-control', desc: '远端控制 · 配对设备访问', stable: false, defaultOn: false },
  { key: 'plan', name: 'plan-streaming', desc: 'Plan 流式输出 · 显示推理计划', stable: true, defaultOn: true },
  { key: 'reasoning', name: 'reasoning-summary', desc: '推理摘要 · 显示思考过程', stable: true, defaultOn: true },
  { key: 'scanlines', name: 'scanlines', desc: '扫描线纹理 · 致敬终端', stable: true, defaultOn: true },
  { key: 'sandbox', name: 'windows-sandbox', desc: 'Windows Sandbox 集成', stable: false, defaultOn: false },
]

/**
 * ExperimentalSettingsPane 组件 —— 实验功能设置分区。
 *
 * 渲染逻辑：
 *  - 顶部说明文字：提示用户实验功能可能不稳定
 *  - 实验功能列表：每项显示名称 + stable/unstable 标签 + 描述 + Switch 开关
 *
 * 状态依赖：
 *  - features（Record<string, boolean>）通过 useLocalState 持久化（codex-exp-features）
 *
 * 设计决策：
 *  - 与 AdvancedSettingsPane 中的实验功能列表不同，此处分区更详细：
 *    包含 stable/unstable 标签，且功能数量更多（14 个 vs 7 个）
 *  - stable 标签使用 success 色绿色，unstable 使用 warn 色黄色
 *
 * @see 参照 prototype.html data-section="exp"（行 6078-6144）
 */
export function ExperimentalSettingsPane() {
  // 实验功能开关状态，持久化到 localStorage
  const [features, setFeatures] = useLocalState<Record<string, boolean>>(
    'codex-exp-features',
    Object.fromEntries(EXP_FEATURES.map(f => [f.key, f.defaultOn]))
  )

  const handleToggle = (key: string, value: boolean) => {
    setFeatures({ ...features, [key]: value })
  }

  return (
    <div className="space-y-2">
      <SectionTitle>实验功能开关</SectionTitle>
      <p className="mb-3 text-[11px] leading-[1.5] text-[var(--text-faint)]">
        以下功能处于实验阶段，可能不稳定。启用后请关注可能的性能影响。
      </p>
      {EXP_FEATURES.map(f => (
        <div
          key={f.key}
          className="flex items-center gap-2.5 rounded-[9px] border border-[var(--border)] bg-[var(--bg-elev-2)] px-3 py-2.5"
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[12.5px] text-[var(--text)]">
                {f.name}
              </span>
              {/* stable / unstable 标签 */}
              <span
                className={
                  'rounded px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase ' +
                  (f.stable
                    ? 'bg-[rgba(0,217,192,0.12)] text-[var(--success)]'
                    : 'bg-[var(--info-amber)] text-[var(--warn)]')
                }
              >
                {f.stable ? 'stable' : 'unstable'}
              </span>
            </div>
            <p className="mt-0.5 text-[11px] leading-[1.5] text-[var(--text-faint)]">
              {f.desc}
            </p>
          </div>
          <Switch
            checked={features[f.key] ?? f.defaultOn}
            onCheckedChange={toggleWithToast(f.name, v => handleToggle(f.key, v))}
          />
        </div>
      ))}
    </div>
  )
}

// ════════════════════════════════════════════════════════════════
// 12. 技能
// 参照 prototype.html data-section="skills"（行 6145-6156）
// ════════════════════════════════════════════════════════════════

/** 技能条目 */
interface SkillEntry {
  id: string
  name: string
  path: string
  enabled: boolean
}

const DEFAULT_SKILLS: SkillEntry[] = [
  { id: '1', name: 'commit', path: '~/.codex/skills/commit', enabled: true },
  { id: '2', name: 'review', path: '~/.codex/skills/review', enabled: true },
  { id: '3', name: 'test-gen', path: '~/.codex/skills/test-gen', enabled: false },
]

/**
 * SkillsSettingsPane 组件 —— 技能设置分区。
 *
 * 渲染逻辑：
 *  - 已注册技能列表：每项显示技能名称 + 路径 + Switch 启用开关
 *  - 添加技能区：SettingField + Input 输入路径 + 注册按钮
 *
 * 状态依赖：
 *  - skills 数组通过 useLocalState 持久化（codex-skills）
 *  - newPath 为临时输入，使用 useState
 *
 * 副作用：
 *  - 注册新技能：从路径末段提取名称，toast.success 提示
 *
 * 设计决策：
 *  - 技能名称从路径末段自动提取（如 ~/.codex/skills/my-skill → my-skill）
 *  - 使用 Date.now().toString() 生成唯一 ID，避免引入额外依赖
 *
 * @see 参照 prototype.html data-section="skills"（行 6145-6156）
 */
export function SkillsSettingsPane() {
  const [skills, setSkills] = useLocalState<SkillEntry[]>(
    'codex-skills',
    DEFAULT_SKILLS
  )
  const [newPath, setNewPath] = useState('')

  // 切换技能启用状态
  const handleToggle = (id: string, value: boolean) => {
    setSkills(skills.map(s => (s.id === id ? { ...s, enabled: value } : s)))
  }

  // 注册新技能根目录
  const handleAddSkill = () => {
    const path = newPath.trim()
    if (!path) return
    const name = path.split('/').pop() ?? path
    const newSkill: SkillEntry = {
      id: Date.now().toString(),
      name,
      path,
      enabled: true,
    }
    setSkills([...skills, newSkill])
    setNewPath('')
    toast.success(`已注册技能: ${name}`)
  }

  return (
    <div className="space-y-2">
      <SectionTitle>已注册技能</SectionTitle>
      <p className="mb-3 text-[11px] leading-[1.5] text-[var(--text-faint)]">
        技能是可复用的提示词模板和工作流，注册后可通过斜杠命令快速调用。
      </p>
      {skills.map(skill => (
        <div
          key={skill.id}
          className="flex items-center gap-2.5 rounded-[9px] border border-[var(--border)] bg-[var(--bg-elev-2)] px-3 py-2.5"
        >
          <div className="min-w-0 flex-1">
            <div className="font-mono text-[12.5px] text-[var(--text)]">
              {skill.name}
            </div>
            <div className="truncate font-mono text-[11px] text-[var(--text-faint)]">
              {skill.path}
            </div>
          </div>
          <Switch
            checked={skill.enabled}
            onCheckedChange={toggleWithToast(skill.name, v => handleToggle(skill.id, v))}
          />
        </div>
      ))}

      <SectionTitle>添加技能</SectionTitle>
      <SettingField
        label="注册新的技能根目录"
        description="输入技能目录的绝对或相对路径"
      >
        <div className="flex gap-2">
          <Input
            value={newPath}
            onChange={e => setNewPath(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault()
                handleAddSkill()
              }
            }}
            placeholder="~/.codex/skills/my-skill"
            className="font-mono text-[12px]"
          />
          <Button variant="default" size="sm" onClick={handleAddSkill}>
            <Plus width={13} height={13} /> 注册
          </Button>
        </div>
      </SettingField>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════
// 13. 钩子
// 参照 prototype.html data-section="hooks"（行 6157-6177）
// ════════════════════════════════════════════════════════════════

/** 钩子条目 */
interface HookEntry {
  id: string
  name: string
  event: string
  enabled: boolean
}

const DEFAULT_HOOKS: HookEntry[] = [
  { id: '1', name: 'pre-commit-lint', event: 'PreToolUse', enabled: true },
  { id: '2', name: 'post-edit-format', event: 'PostToolUse', enabled: true },
  { id: '3', name: 'notify-on-error', event: 'onError', enabled: false },
]

/**
 * HooksSettingsPane 组件 —— 钩子设置分区。
 *
 * 渲染逻辑：
 *  - 钩子列表：每项显示钩子名称 + 监听事件 + Switch 启用开关
 *  - 新建钩子区：SettingField + Input 输入名称 + 创建按钮
 *
 * 状态依赖：
 *  - hooks 数组通过 useLocalState 持久化（codex-hooks）
 *  - newName 为临时输入，使用 useState
 *
 * 副作用：
 *  - 创建新钩子：默认监听 PreToolUse 事件，toast.success 提示
 *
 * 设计决策：
 *  - 新建钩子默认事件为 PreToolUse（最常用场景：代码检查、格式化）
 *  - 导航项 badge 显示告警数（如 2 个钩子未启用），吸引用户关注
 *
 * @see 参照 prototype.html data-section="hooks"（行 6157-6177）
 */
export function HooksSettingsPane() {
  const [hooks, setHooks] = useLocalState<HookEntry[]>(
    'codex-hooks',
    DEFAULT_HOOKS
  )
  const [newName, setNewName] = useState('')

  // 切换钩子启用状态
  const handleToggle = (id: string, value: boolean) => {
    setHooks(hooks.map(h => (h.id === id ? { ...h, enabled: value } : h)))
  }

  // 创建新钩子
  const handleAddHook = () => {
    const name = newName.trim()
    if (!name) return
    const newHook: HookEntry = {
      id: Date.now().toString(),
      name,
      event: 'PreToolUse',
      enabled: true,
    }
    setHooks([...hooks, newHook])
    setNewName('')
    toast.success(`已创建钩子: ${name}`)
  }

  return (
    <div className="space-y-2">
      <SectionTitle>钩子列表</SectionTitle>
      <p className="mb-3 text-[11px] leading-[1.5] text-[var(--text-faint)]">
        钩子可在特定事件触发时执行自定义脚本，用于代码检查、格式化等场景。
      </p>
      {hooks.map(hook => (
        <div
          key={hook.id}
          className="flex items-center gap-2.5 rounded-[9px] border border-[var(--border)] bg-[var(--bg-elev-2)] px-3 py-2.5"
        >
          <div className="min-w-0 flex-1">
            <div className="font-mono text-[12.5px] text-[var(--text)]">
              {hook.name}
            </div>
            <div className="font-mono text-[11px] text-[var(--text-faint)]">
              事件: {hook.event}
            </div>
          </div>
          <Switch
            checked={hook.enabled}
            onCheckedChange={v => handleToggle(hook.id, v)}
          />
        </div>
      ))}

      <SectionTitle>新建钩子</SectionTitle>
      <SettingField
        label="创建新的钩子监听事件"
        description="输入钩子名称，默认监听 PreToolUse 事件"
      >
        <div className="flex gap-2">
          <Input
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault()
                handleAddHook()
              }
            }}
            placeholder="my-hook"
            className="font-mono text-[12px]"
          />
          <Button variant="default" size="sm" onClick={handleAddHook}>
            <Plus width={13} height={13} /> 创建
          </Button>
        </div>
      </SettingField>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════
// 14. 环境
// 参照 prototype.html data-section="env"（行 6168-6177）
// ════════════════════════════════════════════════════════════════

/** 环境变量条目 */
interface EnvVarEntry {
  key: string
  value: string
}

const DEFAULT_ENV_VARS: EnvVarEntry[] = [
  { key: 'CODEX_HOME', value: '~/.codex' },
  { key: 'RUST_LOG', value: 'info' },
  { key: 'NODE_ENV', value: 'development' },
]

/** 工具链状态 */
interface ToolchainItem {
  name: string
  version: string
  status: 'ok' | 'missing' | 'warning'
}

const DEFAULT_TOOLCHAIN: ToolchainItem[] = [
  { name: 'Rust', version: '1.82.0', status: 'ok' },
  { name: 'Node.js', version: '20.10.0', status: 'ok' },
  { name: 'Python', version: '3.12.1', status: 'ok' },
  { name: 'Git', version: '2.43.0', status: 'ok' },
  { name: 'Docker', version: '—', status: 'missing' },
]

/** 工具链状态对应的颜色 */
const TOOLCHAIN_STATUS_CLASS: Record<ToolchainItem['status'], string> = {
  ok: 'text-[var(--success)]',
  missing: 'text-[var(--text-faint)]',
  warning: 'text-[var(--warn)]',
}

const TOOLCHAIN_STATUS_LABEL: Record<ToolchainItem['status'], string> = {
  ok: '已安装',
  missing: '未安装',
  warning: '版本过低',
}

/**
 * EnvironmentSettingsPane 组件 —— 环境设置分区。
 *
 * 渲染逻辑：
 *  - 环境变量区：键值对列表，key 使用 accent 色，value 使用 text-dim 色
 *  - 工具链状态区：每项显示工具图标 + 名称 + 版本 + 状态标签（已安装/未安装/版本过低）
 *  - 刷新检测按钮：触发 toast.info 提示
 *
 * 状态依赖：
 *  - envVars 通过 useLocalState 持久化（codex-env-vars）
 *  - toolchain 通过 useLocalState 持久化（codex-toolchain）
 *
 * 设计决策：
 *  - 当前为 mock 数据，仅展示不提供编辑能力
 *  - 工具链状态用三色区分（success/text-faint/warn），直观
 *
 * @see 参照 prototype.html data-section="env"（行 6168-6177）
 * @todo 接入真实环境检测逻辑（如 which / cargo --version 等）
 */
export function EnvironmentSettingsPane() {
  const [envVars] = useLocalState<EnvVarEntry[]>(
    'codex-env-vars',
    DEFAULT_ENV_VARS
  )
  const [toolchain] = useLocalState<ToolchainItem[]>(
    'codex-toolchain',
    DEFAULT_TOOLCHAIN
  )

  const handleRefresh = () => {
    toast.info('正在重新检测本机开发环境…')
  }

  return (
    <div className="space-y-2">
      <SectionTitle>开发环境</SectionTitle>
      <p className="mb-3 text-[11px] leading-[1.5] text-[var(--text-faint)]">
        检测本机开发工具链状态与环境变量配置。
      </p>

      <SectionTitle>环境变量</SectionTitle>
      {envVars.map(env => (
        <div
          key={env.key}
          className="flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-elev-2)] px-2.5 py-2"
        >
          <code className="shrink-0 font-mono text-[12px] font-semibold text-[var(--accent)]">
            {env.key}
          </code>
          <span className="text-[var(--text-faint)]">=</span>
          <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-[var(--text-dim)]">
            {env.value}
          </code>
        </div>
      ))}

      <SectionTitle>工具链状态</SectionTitle>
      {toolchain.map(tool => (
        <div
          key={tool.name}
          className="flex items-center gap-2.5 rounded-[9px] border border-[var(--border)] bg-[var(--bg-elev-2)] px-3 py-2.5"
        >
          <Terminal
            width={14}
            height={14}
            className="shrink-0 text-[var(--text-dim)]"
          />
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] text-[var(--text)]">{tool.name}</div>
            <div className="font-mono text-[11px] text-[var(--text-faint)]">
              {tool.version}
            </div>
          </div>
          <span
            className={
              'shrink-0 font-mono text-[11px] ' +
              TOOLCHAIN_STATUS_CLASS[tool.status]
            }
          >
            {TOOLCHAIN_STATUS_LABEL[tool.status]}
          </span>
        </div>
      ))}

      <Button
        variant="outline"
        size="sm"
        onClick={handleRefresh}
        className="mt-2 w-full"
      >
        <RefreshCw width={13} height={13} /> 刷新检测
      </Button>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════
// 15. 协作模式
// 参照 prototype.html data-section="collab"（行 6178-6209）
// ════════════════════════════════════════════════════════════════

/** 协作参与者 */
interface CollabUser {
  id: string
  name: string
  avatar: string
  status: 'online' | 'idle' | 'offline'
}

const DEFAULT_COLLAB_USERS: CollabUser[] = [
  { id: '1', name: '当前用户', avatar: 'U', status: 'online' },
  { id: '2', name: 'Alice', avatar: 'A', status: 'idle' },
  { id: '3', name: 'Bob', avatar: 'B', status: 'offline' },
]

/** 协作者状态对应的样式 */
const COLLAB_STATUS_CLASS: Record<CollabUser['status'], string> = {
  online: 'text-[var(--success)]',
  idle: 'text-[var(--warn)]',
  offline: 'text-[var(--text-faint)]',
}

const COLLAB_STATUS_LABEL: Record<CollabUser['status'], string> = {
  online: '在线',
  idle: '空闲',
  offline: '离线',
}

/**
 * CollaborationSettingsPane 组件 —— 协作模式设置分区。
 *
 * 渲染逻辑：
 *  - 协作模式开关：ToggleRow 启用/禁用协作
 *  - 协作者状态显示：ToggleRow 控制是否显示其他协作者的实时光标与选区
 *  - 当前会话协作者列表：头像 + 名称 + 在线状态（在线/空闲/离线）
 *  - 邀请协作者：通过链接邀请（复制到剪贴板）+ 通过邮箱邀请（发送邮件）
 *
 * 状态依赖：
 *  - collabEnabled 通过 useLocalState 持久化（codex-collab-enabled）
 *  - showPresence 通过 useLocalState 持久化（codex-collab-presence）
 *  - inviteEmail 为临时输入，使用 useState
 *
 * 副作用：
 *  - 生成邀请链接：toast.success 提示已复制到剪贴板
 *  - 发送邮箱邀请：toast.success 提示已发送
 *
 * 设计决策：
 *  - 协作者状态用三色区分（success/warn/text-faint），对应 online/idle/offline
 *  - 邮箱邀请使用 type="email" Input，利用浏览器原生邮箱校验
 *
 * @see 参照 prototype.html data-section="collab"（行 6178-6209）
 */
export function CollaborationSettingsPane() {
  const [collabEnabled, setCollabEnabled] = useLocalState(
    'codex-collab-enabled',
    true
  )
  const [showPresence, setShowPresence] = useLocalState(
    'codex-collab-presence',
    true
  )
  const [inviteEmail, setInviteEmail] = useState('')

  const handleInviteLink = () => {
    toast.success('邀请链接已复制到剪贴板')
  }

  const handleInviteEmail = () => {
    const email = inviteEmail.trim()
    if (!email) return
    toast.success(`已向 ${email} 发送邀请`)
    setInviteEmail('')
  }

  return (
    <div className="space-y-2">
      <SectionTitle>协作模式</SectionTitle>
      <ToggleRow
        name="启用协作模式"
        description="允许多用户共同编辑同一会话"
        checked={collabEnabled}
        onChange={toggleWithToast('启用协作模式', setCollabEnabled)}
      />
      <ToggleRow
        name="显示协作者状态"
        description="在界面中显示其他协作者的实时光标与选区"
        checked={showPresence}
        onChange={toggleWithToast('显示协作者状态', setShowPresence)}
      />

      <SectionTitle>当前会话协作</SectionTitle>
      {/* D-B-001: collab-users 分组列表容器（参照原型 .collab-users 容器样式） */}
      <div className="mb-3.5 rounded-md border border-[var(--border)] bg-[var(--bg-elev-2)] p-3">
        {DEFAULT_COLLAB_USERS.map(user => (
          <div
            key={user.id}
            // D-B-001: collab-user-item 改为分组列表项样式（移除独立卡片 border/rounded/padding）
            className="flex items-center gap-2.5 border-b border-[var(--border)] px-0 py-2 last:border-b-0"
          >
            {/* 头像首字母 */}
            {/* D-B-002: collab-avatar 尺寸改为 28x28，字号改为 11px */}
            <div className="flex h-[28px] w-[28px] shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#2A3441] to-[#1A2330] font-mono text-[11px] font-semibold text-[var(--accent)] border border-[var(--border-strong)]">
              {user.avatar}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[12.5px] text-[var(--text)]">
                {user.name}
              </div>
              <div
                className={
                  'font-mono text-[11px] ' + COLLAB_STATUS_CLASS[user.status]
                }
              >
                {COLLAB_STATUS_LABEL[user.status]}
              </div>
            </div>
          </div>
        ))}
      </div>

      <SectionTitle>邀请协作者</SectionTitle>
      <SettingRow label="通过链接邀请">
        <Button
          variant="outline"
          size="sm"
          onClick={handleInviteLink}
        >
          生成邀请链接
        </Button>
      </SettingRow>
      <SettingField label="通过邮箱邀请">
        <div className="flex gap-2">
          <Input
            type="email"
            value={inviteEmail}
            onChange={e => setInviteEmail(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault()
                handleInviteEmail()
              }
            }}
            placeholder="colleague@example.com"
            className="font-mono text-[12px]"
          />
          <Button variant="default" size="sm" onClick={handleInviteEmail}>
            发送邀请
          </Button>
        </div>
      </SettingField>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════
// 16. 应用
// 参照 prototype.html data-section="apps"（行 6323-6369）
// ════════════════════════════════════════════════════════════════

/** 已注册应用条目 */
interface AppEntry {
  id: string
  name: string
  clientId: string
  version: string
  status: 'active' | 'idle'
  iconBg: string
  iconColor: string
}

const DEFAULT_APPS: AppEntry[] = [
  {
    id: '1',
    name: 'SuperAgent',
    clientId: 'superagent',
    version: 'v0.1.0',
    status: 'active',
    iconBg: 'var(--info-blue)',
    iconColor: 'var(--accent)',
  },
  {
    id: '2',
    name: 'Codex CLI',
    clientId: 'codex-cli',
    version: 'v0.9.8',
    status: 'idle',
    iconBg: 'var(--info-amber)',
    iconColor: 'var(--warn)',
  },
  {
    id: '3',
    name: 'Codex Web',
    clientId: 'codex-web',
    version: 'v0.2.1',
    status: 'idle',
    iconBg: 'rgba(0,229,199,0.12)',
    iconColor: 'var(--accent-2)',
  },
]

/** 工作区消息条目 */
interface WorkspaceMsg {
  severity: 'warn' | 'info' | 'error'
  text: string
}

const DEFAULT_WORKSPACE_MSGS: WorkspaceMsg[] = [
  { severity: 'warn', text: '检测到 .env 文件未加入 .gitignore' },
  { severity: 'info', text: '项目根目录存在 codex.md 配置文件' },
]

/** 工作区消息严重级别样式 */
const WM_SEVERITY_CLASS: Record<WorkspaceMsg['severity'], string> = {
  warn: 'bg-[var(--info-amber)] text-[var(--warn)]',
  info: 'bg-[var(--info-blue)] text-[var(--accent)]',
  error: 'bg-[rgba(197,48,48,0.15)] text-[var(--error)]',
}

/**
 * AppsSettingsPane 组件 —— 应用设置分区。
 *
 * 渲染逻辑：
 *  - 已注册应用列表：每项显示应用图标 + 名称 + client_id + 版本 + 状态 badge（活跃/空闲）
 *  - 工作区消息列表：每项显示 severity 标签（warn/info/error）+ 消息文本
 *
 * 状态依赖：
 *  - DEFAULT_APPS 和 DEFAULT_WORKSPACE_MSGS 为静态 mock 数据，无状态管理
 *
 * 设计决策：
 *  - 应用图标使用 inline style 动态设置背景色与图标色，支持自定义配色
 *  - 状态 badge 使用 success 色（活跃）或 text-faint 色（空闲）区分
 *  - 工作区消息 severity 用三色 badge 区分，便于快速识别严重程度
 *
 * @see 参照 prototype.html data-section="apps"（行 6323-6369）
 */
export function AppsSettingsPane() {
  return (
    <div className="space-y-2">
      <SectionTitle>已注册应用</SectionTitle>
      <p className="mb-3 text-[11px] leading-[1.5] text-[var(--text-faint)]">
        已接入 codex 后端的应用列表，可通过 client_id 区分不同客户端。
      </p>
      {DEFAULT_APPS.map(app => (
        <div
          key={app.id}
          // D-B-003: app-item 圆角改为 6px（rounded-md），padding 改为 10px（px-2.5 py-2.5）
          className="flex items-center gap-2.5 rounded-md border border-[var(--border)] bg-[var(--bg-elev-2)] px-2.5 py-2.5"
        >
          {/* 应用图标 */}
          {/* D-B-004: app-icon 圆角改为 6px（rounded-md） */}
          <div
            className="flex h-[32px] w-[32px] shrink-0 items-center justify-center rounded-md"
            style={{ background: app.iconBg, color: app.iconColor }}
          >
            <Monitor width={16} height={16} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] text-[var(--text)]">
              {app.name}
            </div>
            <div className="font-mono text-[11px] text-[var(--text-faint)]">
              client_id: {app.clientId} · {app.version}
            </div>
          </div>
          {/* D-B-005: app-status 圆角改为 10px（rounded-[10px]），padding 改为 8px 2px（px-2 py-0.5） */}
          <span
            className={
              'shrink-0 rounded-[10px] px-2 py-0.5 font-mono text-[10px] font-semibold ' +
              (app.status === 'active'
                ? 'bg-[rgba(0,217,192,0.12)] text-[var(--success)]'
                : 'bg-[var(--bg-elev-3)] text-[var(--text-faint)]')
            }
          >
            {app.status === 'active' ? '活跃' : '空闲'}
          </span>
        </div>
      ))}

      <SectionTitle>工作区消息</SectionTitle>
      {DEFAULT_WORKSPACE_MSGS.map((msg, idx) => (
        <div
          key={idx}
          // D-B-006: wm-item 圆角改为 5px，padding 改为 8px 10px，移除 border，items-center 改为 items-start
          className="flex items-start gap-2 rounded-[5px] bg-[var(--bg-elev-2)] px-2.5 py-2"
        >
          {/* D-B-007: wm-severity 圆角改为 8px，字号改为 10px，padding 改为 1px 6px，移除 uppercase */}
          <span
            className={
              'shrink-0 rounded-[8px] px-1.5 py-px font-mono text-[10px] font-semibold ' +
              WM_SEVERITY_CLASS[msg.severity]
            }
          >
            {msg.severity}
          </span>
          <span className="min-w-0 flex-1 text-[12px] text-[var(--text-dim)]">
            {msg.text}
          </span>
        </div>
      ))}
    </div>
  )
}

// ════════════════════════════════════════════════════════════════
// 17. 插件市场
// 参照 prototype.html data-section="marketplace"（行 6370-6388）
// ════════════════════════════════════════════════════════════════

/** 插件条目 */
interface PluginEntry {
  id: string
  name: string
  version: string
  description: string
  enabled: boolean
  installed: boolean
}

const DEFAULT_INSTALLED_PLUGINS: PluginEntry[] = [
  {
    id: '1',
    name: 'codex-git-flow',
    version: '1.2.0',
    description: 'Git Flow 工作流增强',
    enabled: true,
    installed: true,
  },
  {
    id: '2',
    name: 'codex-docker-helper',
    version: '0.4.1',
    description: 'Docker 容器管理辅助',
    enabled: false,
    installed: true,
  },
]

const DEFAULT_AVAILABLE_PLUGINS: PluginEntry[] = [
  {
    id: '3',
    name: 'codex-jira-bridge',
    version: '2.0.0',
    description: 'Jira 任务双向同步',
    enabled: false,
    installed: false,
  },
  {
    id: '4',
    name: 'codex-terraform',
    version: '1.0.0',
    description: 'Terraform 基础设施即代码',
    enabled: false,
    installed: false,
  },
  {
    id: '5',
    name: 'codex-k8s-toolkit',
    version: '0.8.2',
    description: 'Kubernetes 集群管理工具集',
    enabled: false,
    installed: false,
  },
]

/**
 * MarketplaceSettingsPane 组件 —— 插件市场设置分区。
 *
 * 渲染逻辑：
 *  - 已安装插件列表：每项显示名称 + 版本 + 描述 + 启用开关 + 卸载按钮
 *  - 添加插件区：SettingField + Input 输入市场源 URL + 添加/刷新按钮
 *  - 可用插件列表：每项显示名称 + 版本 + 描述 + 安装按钮
 *
 * 状态依赖：
 *  - installed 数组通过 useLocalState 持久化（codex-installed-plugins）
 *  - available 数组使用 useState（无需持久化，每次从源拉取）
 *  - sourceUrl 为临时输入，使用 useState
 *
 * 副作用：
 *  - 卸载插件：从 installed 移除，添加到 available，toast.success 提示
 *  - 安装插件：从 available 移除，添加到 installed，toast.success 提示
 *  - 添加市场源 / 刷新源：toast 提示
 *
 * 设计决策：
 *  - 安装/卸载采用乐观更新策略，直接操作本地状态
 *  - 卸载时保留插件的 enabled=false 状态，避免重新安装后自动启用
 *
 * @see 参照 prototype.html data-section="marketplace"（行 6370-6388）
 */
export function MarketplaceSettingsPane() {
  const [installed, setInstalled] = useLocalState<PluginEntry[]>(
    'codex-installed-plugins',
    DEFAULT_INSTALLED_PLUGINS
  )
  const [available, setAvailable] = useState(DEFAULT_AVAILABLE_PLUGINS)
  const [sourceUrl, setSourceUrl] = useState('')

  // 切换已安装插件启用状态
  const handleTogglePlugin = (id: string, value: boolean) => {
    setInstalled(
      installed.map(p => (p.id === id ? { ...p, enabled: value } : p))
    )
  }

  // 卸载插件
  const handleUninstall = (id: string) => {
    const plugin = installed.find(p => p.id === id)
    setInstalled(installed.filter(p => p.id !== id))
    if (plugin) {
      setAvailable([...available, { ...plugin, installed: false, enabled: false }])
    }
    toast.success('插件已卸载')
  }

  // 安装插件
  const handleInstall = (id: string) => {
    const plugin = available.find(p => p.id === id)
    if (!plugin) return
    setInstalled([
      ...installed,
      { ...plugin, installed: true, enabled: true },
    ])
    setAvailable(available.filter(p => p.id !== id))
    toast.success(`已安装: ${plugin.name}`)
  }

  // 添加市场源
  const handleAddSource = () => {
    const url = sourceUrl.trim()
    if (!url) return
    toast.success(`已添加市场源: ${url}`)
    setSourceUrl('')
  }

  // 刷新源
  const handleRefreshSource = () => {
    toast.info('正在刷新插件市场源…')
  }

  return (
    <div className="space-y-2">
      <SectionTitle>已安装插件</SectionTitle>
      {installed.map(plugin => (
        <div
          key={plugin.id}
          className="flex items-center gap-2.5 rounded-[9px] border border-[var(--border)] bg-[var(--bg-elev-2)] px-3 py-2.5"
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[12.5px] text-[var(--text)]">
                {plugin.name}
              </span>
              <span className="font-mono text-[10px] text-[var(--text-faint)]">
                v{plugin.version}
              </span>
            </div>
            <p className="mt-0.5 text-[11px] text-[var(--text-faint)]">
              {plugin.description}
            </p>
          </div>
          {/* 启用/禁用开关 */}
          <Switch
            checked={plugin.enabled}
            onCheckedChange={v => handleTogglePlugin(plugin.id, v)}
          />
          {/* 卸载按钮 */}
          <button
            type="button"
            onClick={() => handleUninstall(plugin.id)}
            className="shrink-0 text-[var(--text-faint)] hover:text-[var(--error)]"
            aria-label="卸载插件"
            title="卸载"
          >
            <Power width={13} height={13} />
          </button>
        </div>
      ))}

      <SectionTitle>添加插件</SectionTitle>
      <SettingField
        label="插件市场源"
        description="输入插件市场 URL 以添加新的插件源"
      >
        <Input
          value={sourceUrl}
          onChange={e => setSourceUrl(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault()
              handleAddSource()
            }
          }}
          placeholder="https://marketplace.codex.dev/plugins/…"
          className="font-mono text-[12px]"
        />
      </SettingField>
      <div className="flex gap-2">
        <Button variant="default" size="sm" onClick={handleAddSource}>
          <Plus width={13} height={13} /> 添加
        </Button>
        <Button variant="outline" size="sm" onClick={handleRefreshSource}>
          <RefreshCw width={13} height={13} /> 刷新源
        </Button>
      </div>

      <SectionTitle>可用插件</SectionTitle>
      {available.map(plugin => (
        <div
          key={plugin.id}
          className="flex items-center gap-2.5 rounded-[9px] border border-[var(--border)] bg-[var(--bg-elev-2)] px-3 py-2.5"
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[12.5px] text-[var(--text)]">
                {plugin.name}
              </span>
              <span className="font-mono text-[10px] text-[var(--text-faint)]">
                v{plugin.version}
              </span>
            </div>
            <p className="mt-0.5 text-[11px] text-[var(--text-faint)]">
              {plugin.description}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleInstall(plugin.id)}
          >
            <Download width={13} height={13} /> 安装
          </Button>
        </div>
      ))}

      <SectionTitle>插件分享</SectionTitle>
      <div className="flex gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => toast.info('分享列表功能开发中')}
        >
          查看分享列表
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => toast.info('保存分享功能开发中')}
        >
          保存分享
        </Button>
      </div>
    </div>
  )
}
