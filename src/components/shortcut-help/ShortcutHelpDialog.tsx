import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'

/* ============================================================
 * 快捷键数据结构定义
 * 对齐 prototype.html 中的快捷键帮助面板内容（行 5865-5879）
 * ============================================================ */

/** 单条快捷键项 — 描述 + 按键文本 */
interface ShortcutItem {
  /** 描述文案的 i18n key */
  descriptionKey: string
  /** 按键显示文本，如 "⌘/Ctrl + P" */
  keys: string
  /** 是否为实验性快捷键（尚未完整实现或仅注册为命令未绑定按键） */
  experimental?: boolean
  /**
   * 直接显示的描述文案（可选）。
   * 当提供此字段时，优先使用它而非 i18n 翻译（t(descriptionKey)）。
   * 用于尚未在 locale 文件中注册翻译键的新增快捷键项，
   * 后续在 locales/en.json 和 locales/zh.json 补充对应 key 后可移除此字段。
   */
  label?: string
}

/**
 * 快捷键列表 — 对齐原型 #shortcutHelp 的双列网格（行 5870-5876）。
 *
 * 原型布局：`display:grid; grid-template-columns:1fr 1fr; gap:4px 24px`
 * 不分组，所有快捷键在同一个网格中按行排列。
 *
 * 这里复用既有的 i18n key，将原分组的 4 组快捷键合并为单列表，
 * 由组件渲染为双列网格。
 */
const SHORTCUTS: ShortcutItem[] = [
  // ── 原全局组 ──
  { descriptionKey: 'shortcutHelp.item.openCommandPalette', keys: '⌘/Ctrl + P' },
  { descriptionKey: 'shortcutHelp.item.openSettings', keys: '⌘/Ctrl + ,' },
  { descriptionKey: 'shortcutHelp.item.quickAction', keys: '⌘/Ctrl + K' },
  // demoMode (Ctrl+Shift+D)：尚未实现，标注为实验
  { descriptionKey: 'shortcutHelp.item.demoMode', keys: 'Ctrl + Shift + D', experimental: true },
  // ── 原会话组 ──
  { descriptionKey: 'shortcutHelp.item.newConversation', keys: '⌘/Ctrl + N' },
  // C1 修复：⌘F 实际触发文件模糊搜索（FuzzySearchDialog），非"对话内搜索"。
  // label 字段提供直接文案，后续可在 locale 文件注册 shortcutHelp.item.fuzzySearchFiles 后移除。
  { descriptionKey: 'shortcutHelp.item.fuzzySearchFiles', keys: 'Ctrl + F', label: '文件模糊搜索' },
  { descriptionKey: 'shortcutHelp.item.closeSearchOrDialog', keys: 'Esc' },
  // ── 原输入组 ──
  { descriptionKey: 'shortcutHelp.item.sendMessage', keys: 'Enter' },
  { descriptionKey: 'shortcutHelp.item.newline', keys: 'Shift + Enter' },
  { descriptionKey: 'shortcutHelp.item.slashCommand', keys: '/' },
  { descriptionKey: 'shortcutHelp.item.attachFile', keys: '@' },
  // ── 原视图组 ──
  { descriptionKey: 'shortcutHelp.item.toggleSidebar', keys: '⌘/Ctrl + B' },
  { descriptionKey: 'shortcutHelp.item.toggleRightPanel', keys: '⌘/Ctrl + J' },
  // toggleTerminal (Ctrl+`)：已注册为 codex.openTerminal 命令但未绑定全局按键，标注为实验
  { descriptionKey: 'shortcutHelp.item.toggleTerminal', keys: 'Ctrl + `', experimental: true },
  // ── C2 新增：视图切换快捷键（label 提供直接文案，后续可迁移至 locale） ──
  // Alt+1/2/3 在 use-keyboard-shortcuts.ts 中注册，切换 chat/remote/config 视图
  { descriptionKey: 'shortcutHelp.item.switchToChatView', keys: 'Alt + 1', label: '切换到聊天视图' },
  { descriptionKey: 'shortcutHelp.item.switchToRemoteView', keys: 'Alt + 2', label: '切换到远程视图' },
  { descriptionKey: 'shortcutHelp.item.switchToSettingsView', keys: 'Alt + 3', label: '切换到设置视图' },
  // Alt+← 触发 view-store.goBack()，后退到上一个视图
  { descriptionKey: 'shortcutHelp.item.goBack', keys: 'Alt + ←', label: '后退' },
  // ? 打开当前快捷键帮助弹窗（自引用）
  { descriptionKey: 'shortcutHelp.item.openShortcutHelp', keys: '?', label: '打开快捷键帮助' },
]

/* ============================================================
 * 组件 Props 定义
 * ============================================================ */

interface ShortcutHelpDialogProps {
  /** 是否显示弹窗 */
  open: boolean
  /** 关闭弹窗的回调 */
  onClose: () => void
}

/* ============================================================
 * 快捷键帮助弹窗组件
 * ============================================================ */

/**
 * 快捷键帮助弹窗 — 对齐 prototype.html 中的 #shortcutHelp modal
 *
 * 布局（对齐原型行 5870）：
 *   - 双列网格 `grid grid-cols-2 gap-x-6 gap-y-1`
 *   - 无分组标题，所有快捷键在同一个网格中
 *   - 每项格式：`<kbd class="text-[var(--accent)]">按键</kbd> <span>描述</span>`
 *   - kbd 颜色 accent（#23 P2 修复）
 *
 * 使用方式：
 *   <ShortcutHelpDialog open={open} onClose={() => setOpen(false)} />
 */
export function ShortcutHelpDialog({ open, onClose }: ShortcutHelpDialogProps) {
  const { t } = useTranslation()

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent
        className="w-[480px] sm:max-w-[520px] gap-0 p-0"
        showCloseButton
      >
        {/* 弹窗标题区 — padding 14px 16px 对齐原型 .modal-head（D-A-003 修复） */}
        <DialogHeader className="border-b border-[var(--border)] px-4 py-3.5">
          <DialogTitle className="text-[15px] font-semibold">
            {t('shortcutHelp.title')}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t('shortcutHelp.title')}
          </DialogDescription>
        </DialogHeader>

        {/*
          快捷键双列网格 — 对齐原型行 5870：
          `display:grid; grid-template-columns:1fr 1fr; gap:4px 24px`
          - grid-cols-2：双列
          - gap-x-6：列间距 24px
          - gap-y-1：行间距 4px
          - 无分组标题，所有项在同一个网格中
        */}
        <div
          className="grid grid-cols-2 gap-x-6 gap-y-1 px-5 py-4 text-[12.5px] leading-[1.9]"
        >
          {SHORTCUTS.map(item => (
            <div
              key={item.descriptionKey}
              className="flex items-center gap-1"
            >
              {/*
                kbd — 对齐原型 .sk 样式（行 1618-1622）：
                - 文字颜色 accent（#23 P2 修复，原为 text-dim）
                - mono 字体 + 小圆角边框
                - padding:1px 6px（px-1.5 py-px）— #P3 修复，原为 py-0.5=2px
                - border-radius:3px（rounded-[3px]，与原型一致）
                父容器 gap-1（4px）对齐原型 margin-right:4px — #P3 修复，原为 gap-1.5=6px
              */}
              <kbd className="inline-flex items-center rounded-[3px] border border-[var(--border-strong)] bg-[var(--bg)] px-1.5 py-px font-mono text-[10px] text-[var(--accent)]">
                {item.keys}
              </kbd>
              {/* 描述文字 + 实验性标注 */}
              {/* label 优先：尚未注册 locale 翻译的项使用 label 直接显示，否则走 i18n */}
              <span className="text-[var(--text-dim)]">
                {item.label ?? t(item.descriptionKey)}
                {item.experimental && (
                  <span className="ml-1 text-[var(--text-faint)]">(实验)</span>
                )}
              </span>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
