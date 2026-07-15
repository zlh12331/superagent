/**
 * CommandPalette — 命令面板（多模态搜索）
 *
 * 对齐 prototype.html 的 .palette 设计，支持三种搜索模式：
 * - 命令模式（默认 / 输入以 / 开头）：搜索已注册的命令列表
 * - 会话模式（输入以 # 开头）：搜索 thread-store 中的会话列表
 * - 文件模式（输入其他任意文本）：模糊搜索文件列表（MockData 提供）
 *
 * 底部 palette-foot 展示当前搜索模式标识 + 快捷键提示。
 * 搜索结果按类型分组显示（文件 N / 命令 N / 会话 N）。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { motion } from 'motion/react'
import { File, Hash } from 'lucide-react'
import { useDialogStore, type DialogState } from '@/store/dialog-store'
import { useThreadStore } from '@/store/thread-store'
import { useThreads } from '@/queries/threads'
import { useCommandContext } from '@/hooks/use-command-context'
import { getAllCommands, executeCommand } from '@/lib/commands'
import { fadeVariants, springTransition } from '@/lib/animations'
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandGroup,
  CommandItem,
  CommandShortcut,
} from '@/components/ui/command'
// 集中式 mock 数据 — 文件搜索列表从 MockData 统一获取
import { getMockData } from '@/lib/codex/mock'
import { isTauri } from '@/lib/env'
import { logger } from '@/lib/logger'

// ─── 类型定义 ──────────────────────────────────────────────────

/**
 * 搜索模式：command=命令、file=文件、session=会话。
 *
 * 由 detectSearchMode 根据输入前缀判定：
 *  - `#xxx` → session
 *  - `/xxx` 或空输入 → command
 *  - 其他非空文本 → file
 */
type SearchMode = 'command' | 'file' | 'session'

// ─── 常量 ──────────────────────────────────────────────────────

/**
 * 文件搜索数据源 — 从 MockData 获取（支持场景切换）。
 * 浏览器开发模式使用 MockData；Tauri 生产模式返回空数组占位，
 * 真实数据由 fuzzyFileSearch API 提供，避免 mock 数据泄漏到生产环境。
 */
const paletteFiles = isTauri() ? [] : getMockData().allFiles

// ─── 纯函数：搜索模式检测与查询解析 ────────────────────────────

/**
 * 根据用户输入检测当前搜索模式。
 * - 以 # 开头 → 会话搜索
 * - 以 / 开头 → 命令搜索（/cmd 语法）
 * - 空白输入 → 命令模式（默认，展示全部命令）
 * - 其他非空文本 → 文件模糊搜索
 */
function detectSearchMode(input: string): SearchMode {
  if (input.startsWith('#')) return 'session'
  if (input.startsWith('/')) return 'command'
  if (input.trim() === '') return 'command'
  return 'file'
}

/**
 * 根据搜索模式提取有效查询词（去掉模式前缀）。
 * 例如：输入 "#会话" → 模式 session → 有效查询 "会话"
 *       输入 "/cmd" → 模式 command → 有效查询 "cmd"
 *       输入 "main" → 模式 file → 有效查询 "main"
 */
function getEffectiveQuery(input: string, mode: SearchMode): string {
  if (mode === 'command' && input.startsWith('/')) return input.slice(1)
  if (mode === 'session' && input.startsWith('#')) return input.slice(1)
  return input
}

// ─── 主组件 ────────────────────────────────────────────────────

/**
 * CommandPalette 组件 —— 多模态命令面板。
 *
 * 渲染逻辑：
 *  - 由 CommandDialog（shadcn/ui）承载，受控于 dialog-store 中的 commandPaletteOpen
 *  - 顶部 CommandInput 接收用户输入
 *  - 中部 CommandList 按搜索模式分组展示结果：
 *    - command 模式：按命令 group 字段细分多组
 *    - file 模式：扁平展示匹配文件
 *    - session 模式：扁平展示匹配会话
 *  - 底部 palette-foot 展示快捷键提示 + 当前搜索模式标识
 *  - 空结果时显示「无匹配结果」提示
 *
 * 状态依赖：
 *  - 通过 useDialogStore 读写 commandPaletteOpen
 *  - 通过 useCommandContext 获取命令执行上下文（showToast / navigate 等）
 *  - 通过 useThreads（TanStack Query）获取会话列表
 *  - 通过 useThreadStore 获取 setActiveThread
 *  - 本地 useState 管理 search 输入
 *
 * 副作用：
 *  - 选择命令：关闭面板 + 调用 executeCommand + 失败时 toast 错误
 *  - 选择文件：关闭面板 + toast 提示（mock 行为，后续接入文件打开逻辑）
 *  - 选择会话：关闭面板 + setActiveThread 切换会话
 *  - 关闭对话框时清空 search
 *
 * 设计决策：
 *  - shouldFilter=false：禁用 cmdk 内置过滤，由本组件按模式自定义过滤逻辑
 *  - 命令分组按 group 字段聚合，便于按「文件 / 编辑 / 视图 / ...」分类展示
 *  - 模式检测使用前缀字符（# / /），与 VS Code 命令面板行为对齐
 */
export function CommandPalette() {
  const { t } = useTranslation()
  const commandPaletteOpen = useDialogStore(
    (state: DialogState) => state.commandPaletteOpen
  )
  const setCommandPaletteOpen = useDialogStore(
    (state: DialogState) => state.setCommandPaletteOpen
  )
  const commandContext = useCommandContext()

  // 会话列表来自 TanStack Query（服务端持久化数据），
  // setActiveThread 仍保留在 Zustand（纯 UI 状态）
  const { data: threads = [] } = useThreads()
  const setActiveThread = useThreadStore(state => state.setActiveThread)

  const [search, setSearch] = useState('')

  // P1-8: 命令面板列表 ref —— 用于在 capture 阶段拦截 ArrowUp/ArrowDown，
  // 禁用 cmdk 默认的 wrap around 行为（对齐原型 L12302-12313）
  const listRef = useRef<HTMLDivElement>(null)

  // 检测搜索模式 + 提取有效查询词
  const searchMode = detectSearchMode(search)
  const effectiveQuery = getEffectiveQuery(search, searchMode)

  // ── 文件搜索结果（仅 file 模式计算） ──
  const fileResults = useMemo(() => {
    if (searchMode !== 'file') return []
    const q = effectiveQuery.toLowerCase()
    return paletteFiles.filter(
      f =>
        f.title.toLowerCase().includes(q) ||
        f.path.toLowerCase().includes(q)
    )
  }, [searchMode, effectiveQuery])

  // ── 命令搜索结果（仅 command 模式计算） ──
  // 按命令的 group 字段分组，用于分组展示
  const commandGroups = useMemo(() => {
    if (searchMode !== 'command') return {}
    const commands = getAllCommands(commandContext, effectiveQuery, t)
    return commands.reduce(
      (groups, command) => {
        const group = command.group || 'other'
        if (!groups[group]) {
          groups[group] = []
        }
        groups[group].push(command)
        return groups
      },
      {} as Record<string, typeof commands>
    )
  }, [searchMode, effectiveQuery, commandContext, t])

  // ── 会话搜索结果（仅 session 模式计算） ──
  const sessionResults = useMemo(() => {
    if (searchMode !== 'session') return []
    const q = effectiveQuery.toLowerCase()
    return threads.filter(
      th =>
        th.title.toLowerCase().includes(q) ||
        (th.cwd !== null && th.cwd.toLowerCase().includes(q))
    )
  }, [searchMode, effectiveQuery, threads])

  // 判断是否有任何搜索结果（用于控制空状态显示）
  const hasResults =
    fileResults.length > 0 ||
    Object.values(commandGroups).some(g => g.length > 0) ||
    sessionResults.length > 0

  // P1-8: 对齐原型 prototype.html L12302-12313
  //   原型行为：ArrowDown 到达最后一项时不 wrap 回首项；ArrowUp 到达第一项时不 wrap 回末项。
  //   cmdk 默认 wrap around，需在 capture 阶段拦截 keydown（先于 cmdk 的 bubble 处理），
  //   当当前选中项已是首/末项时 preventDefault + stopPropagation 阻止 cmdk 默认导航。
  //   依赖 commandPaletteOpen：面板打开时挂载监听，关闭时卸载。
  useEffect(() => {
    const list = listRef.current
    if (!list) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
      // 查询当前可见且可用的 cmdk item（排除 disabled）
      const items = list.querySelectorAll<HTMLElement>(
        '[cmdk-item]:not([data-disabled])'
      )
      if (items.length === 0) return
      // cmdk 用 data-selected="true" 标记当前激活项
      const activeIdx = Array.from(items).findIndex(
        it => it.getAttribute('data-selected') === 'true'
      )
      if (e.key === 'ArrowDown' && activeIdx === items.length - 1) {
        // 已到末项：阻止 cmdk wrap 回首项
        e.preventDefault()
        e.stopPropagation()
      } else if (e.key === 'ArrowUp' && activeIdx === 0) {
        // 已到首项：阻止 cmdk wrap 回末项
        e.preventDefault()
        e.stopPropagation()
      }
    }

    // capture 阶段：在 cmdk 的 bubble onKeyDown 之前拦截
    list.addEventListener('keydown', handleKeyDown, true)
    return () => list.removeEventListener('keydown', handleKeyDown, true)
  }, [commandPaletteOpen])

  // ── 选择回调 ──

  /** 执行命令：关闭面板并调用命令执行器 */
  const handleCommandSelect = async (commandId: string) => {
    setCommandPaletteOpen(false)
    setSearch('')

    try {
      const result = await executeCommand(commandId, commandContext)

      if (!result.success && result.error) {
        commandContext.showToast(result.error, 'error')
      }
    } catch (err) {
      // 命令执行抛出异常时，提示用户并记录日志，避免未捕获的 Promise 拒绝
      commandContext.showToast('命令执行失败', 'error')
      logger.error('Command execution failed', { commandId, error: err })
    }
  }

  /** 选择文件：关闭面板并提示（mock 行为，后续可接入文件打开逻辑） */
  const handleFileSelect = (filePath: string) => {
    setCommandPaletteOpen(false)
    setSearch('')
    commandContext.showToast(`打开文件: ${filePath}`, 'info')
  }

  /** 选择会话：关闭面板并切换到对应会话 */
  const handleSessionSelect = (threadId: string) => {
    setCommandPaletteOpen(false)
    setSearch('')
    setActiveThread(threadId)
  }

  /** 对话框开关回调，关闭时清空搜索 */
  const handleOpenChange = (open: boolean) => {
    setCommandPaletteOpen(open)
    if (!open) {
      setSearch('')
    }
  }

  // ── 辅助函数 ──

  /** 获取命令分组的可读标签（带 i18n 翻译回退） */
  const getGroupLabel = (groupName: string): string => {
    const key = `commands.group.${groupName}`
    const translated = t(key)
    return translated !== key
      ? translated
      : groupName.charAt(0).toUpperCase() + groupName.slice(1)
  }

  /** 获取当前搜索模式的标识文本（用于 palette-foot 右侧显示） */
  const getModeLabel = (): string => {
    switch (searchMode) {
      case 'command':
        return t('commandPalette.mode.command')
      case 'file':
        return t('commandPalette.mode.file')
      case 'session':
        return t('commandPalette.mode.session')
    }
  }

  return (
    <CommandDialog
      open={commandPaletteOpen}
      onOpenChange={handleOpenChange}
      title={t('commandPalette.title')}
      description={t('commandPalette.placeholder')}
      shouldFilter={false}
    >
      {/* 搜索输入框 */}
      <CommandInput
        placeholder={t('commandPalette.placeholder')}
        value={search}
        onValueChange={setSearch}
      />

      {/* 搜索结果列表（shouldFilter=false 下手动控制空状态） */}
      {/* P1-8: listRef 用于 capture 阶段拦截 ArrowUp/ArrowDown，禁用 cmdk wrap around */}
      <CommandList ref={listRef}>
        {hasResults ? (
          <motion.div
            variants={fadeVariants}
            initial="initial"
            animate="animate"
            transition={springTransition}
          >
            {/* ── 文件搜索结果组 ── */}
            {fileResults.length > 0 && (
              <CommandGroup
                heading={`${t('commandPalette.group.files')} · ${fileResults.length}`}
              >
                {fileResults.map(file => (
                  <CommandItem
                    key={file.path}
                    value={file.path}
                    onSelect={() => handleFileSelect(file.path)}
                  >
                    <File className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm">{file.title}</span>
                      <span className="truncate font-mono text-[10.5px] text-muted-foreground">
                        {file.path}
                      </span>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {/* ── 命令搜索结果组（按 group 字段细分） ── */}
            {Object.entries(commandGroups).map(
              ([groupName, groupCommands]) => (
                <CommandGroup
                  key={groupName}
                  heading={`${getGroupLabel(groupName)} · ${groupCommands.length}`}
                >
                  {groupCommands.map(command => (
                    <CommandItem
                      key={command.id}
                      value={command.id}
                      onSelect={() => handleCommandSelect(command.id)}
                    >
                      {command.icon && (
                        <command.icon className="mr-2 h-4 w-4 shrink-0" />
                      )}
                      <span>{t(command.labelKey)}</span>
                      {command.descriptionKey && (
                        <span className="ml-auto text-xs text-muted-foreground">
                          {t(command.descriptionKey)}
                        </span>
                      )}
                      {command.shortcut && (
                        <CommandShortcut>{command.shortcut}</CommandShortcut>
                      )}
                    </CommandItem>
                  ))}
                </CommandGroup>
              )
            )}

            {/* ── 会话搜索结果组 ── */}
            {sessionResults.length > 0 && (
              <CommandGroup
                heading={`${t('commandPalette.group.sessions')} · ${sessionResults.length}`}
              >
                {sessionResults.map(thread => (
                  <CommandItem
                    key={thread.id}
                    value={thread.id}
                    onSelect={() => handleSessionSelect(thread.id)}
                  >
                    <Hash className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm">{thread.title}</span>
                      {thread.cwd && (
                        <span className="truncate font-mono text-[10.5px] text-muted-foreground">
                          {thread.cwd}
                        </span>
                      )}
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </motion.div>
        ) : (
          /* 空状态：无匹配结果时显示提示文本 */
          <div className="py-6 text-center text-sm text-muted-foreground">
            {t('commandPalette.noResults')}
          </div>
        )}
      </CommandList>

      {/* ── palette-foot：底部状态栏（快捷键提示 + 搜索模式标识） ── */}
      <div className="flex shrink-0 items-center gap-3.5 border-t border-[var(--border)] bg-[var(--bg-elev-2)] px-4 py-2 font-mono text-[10px] text-[var(--text-faint)]">
        {/* 快捷键提示组 */}
        <span className="flex items-center gap-1">
          <kbd className="rounded-[3px] border border-[var(--border-strong)] bg-[var(--bg)] px-[5px] py-px font-mono text-[10px] text-[var(--text-dim)]">
            ↑↓
          </kbd>
          <span>{t('commandPalette.foot.navigate')}</span>
        </span>
        <span className="flex items-center gap-1">
          <kbd className="rounded-[3px] border border-[var(--border-strong)] bg-[var(--bg)] px-[5px] py-px font-mono text-[10px] text-[var(--text-dim)]">
            ⏎
          </kbd>
          <span>{t('commandPalette.foot.select')}</span>
        </span>
        <span className="flex items-center gap-1">
          <kbd className="rounded-[3px] border border-[var(--border-strong)] bg-[var(--bg)] px-[5px] py-px font-mono text-[10px] text-[var(--text-dim)]">
            esc
          </kbd>
          <span>{t('commandPalette.foot.close')}</span>
        </span>
        {/* 搜索模式标识（右对齐） */}
        <span className="ml-auto">
          {getModeLabel()} · {t('commandPalette.scope.global')}
        </span>
      </div>
    </CommandDialog>
  )
}
