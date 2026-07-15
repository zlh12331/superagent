/**
 * InfoPane — 会话详情面板（info tab）
 *
 * 对应 prototype.html `#crpPaneInfo`。
 * 包含三个区块：会话目标（可选）、计划待办、引用文件。
 * 注意：原型无"会话信息"区块（线程ID/创建时间等），前端已删除以对齐原型。
 *
 * 参考样式: prototype.html `.crp-section`, `.crp-goal`, `.crp-plan-list`,
 *           `.crp-plan-progress`, `.crp-plan-item`, `.crp-plan-toggle`,
 *           `.crp-plan-level`, `.crp-plan-idx`, `.crp-plan-spinner`
 *
 * 计划待办区块对齐原型 L9070-9132 的 `renderPlanList` / `renderPlanNodes`：
 *   - 顶部进度条：doneCount/total + 百分比 + 填充条
 *   - 递归层级树：支持任意深度嵌套（PlanItem.children）
 *   - 折叠/展开：父节点点击切换 _collapsed，本地状态管理
 *   - 点击切换完成：叶子节点点击切换 done 状态，本地状态覆盖
 *   - 层级标签 L{depth+1} + 序号 idx + 折叠图标 ▶/▼ + active spinner
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  FileCode,
  Info,
  Loader2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { useThreads } from '@/queries/threads'
import { useMessages } from '@/queries/messages'
import { useConversationStore } from '@/features/conversation/conversation-store'
import { getThreadGoal, clearThreadGoal } from '@/lib/codex/thread'
import type { ThreadGoalGetResponse } from '@/lib/codex/thread'
import { confirm } from '@/features/dialog'
import type { ThreadId, PlanItem } from '@/lib/codex/types'
import { cn } from '@/lib/utils'

/**
 * 会话目标状态的中文映射（对齐原型 L8628 展示 `状态: {status}`）。
 * 原型直接显示英文值，这里映射为中文保持 UI 一致性。
 */
const GOAL_STATUS_LABEL: Record<string, string> = {
  active: '进行中',
  paused: '已暂停',
  blocked: '已阻塞',
  usageLimited: '用量受限',
  budgetLimited: '预算受限',
  complete: '已完成',
}

/** 引用文件项 */
export interface ReferencedFile {
  id: string
  path: string
}

/** InfoPane 组件 props */
export interface InfoPaneProps {
  /** 当前活跃线程 ID；null 表示无活跃线程（显示空状态） */
  activeThreadId: ThreadId | null
}

// 模块级常量：避免在 Zustand selector 中每次返回新的 [] 引用，导致无限重渲染。
// 模式与 ConversationArea.tsx 中的 EMPTY_TURNS 一致。
const EMPTY_PLAN_ITEMS: PlanItem[] = []
// conversation-store 中 referencedFilesByThread 的值类型为 string[]（文件路径列表）
const EMPTY_REFERENCED_PATHS: string[] = []

// ─── 计划待办工具函数（对齐原型 L9048-9067 isPlanDone / countAllPlans）──────

/**
 * 判断单个 plan 节点是否"已完成"。
 * - 父节点（有 children）：所有子节点 done 才算 done
 * - 叶子节点：status === 'done'
 *
 * 注意：done 覆盖状态优先于 status 字段（本地点击切换后的临时状态）。
 *
 * @param item - 计划节点
 * @param doneOverrides - 本地完成状态覆盖表（key 为节点路径字符串）
 * @param path - 当前节点的路径标识（如 "0-1-2"）
 */
function isPlanDone(
  item: PlanItem,
  doneOverrides: Map<string, boolean>,
  path: string
): boolean {
  // 优先使用本地覆盖状态（点击切换后的临时状态）
  if (doneOverrides.has(path)) {
    return doneOverrides.get(path) === true
  }
  // 父节点：递归检查所有子节点
  if (item.children && item.children.length > 0) {
    return item.children.every((child, idx) =>
      isPlanDone(child, doneOverrides, `${path}-${idx}`)
    )
  }
  // 叶子节点：看 status
  return item.status === 'done'
}

/**
 * 统计 plan 树的完成情况（对齐原型 countAllPlans）。
 * 仅统计叶子节点，父节点不计入总数。
 *
 * @param items - 计划节点列表
 * @param doneOverrides - 本地完成状态覆盖表
 * @param basePath - 基础路径（递归用）
 * @returns { total: 叶子节点总数, done: 已完成的叶子节点数 }
 */
function countAllPlans(
  items: PlanItem[],
  doneOverrides: Map<string, boolean>,
  basePath = ''
): { total: number; done: number } {
  let total = 0
  let done = 0
  items.forEach((item, idx) => {
    const path = basePath === '' ? `${idx}` : `${basePath}-${idx}`
    if (item.children && item.children.length > 0) {
      // 父节点：递归统计子节点
      const childCount = countAllPlans(item.children, doneOverrides, path)
      total += childCount.total
      done += childCount.done
    } else {
      // 叶子节点
      total++
      if (isPlanDone(item, doneOverrides, path)) done++
    }
  })
  return { total, done }
}

// ─── 计划节点组件（递归渲染，对齐原型 renderPlanNodes）─────────────────────

interface PlanNodeProps {
  /** 当前节点 */
  item: PlanItem
  /** 节点路径标识（用于 doneOverrides / collapsedSet 的 key） */
  path: string
  /** 是否顶层节点（控制序号显示） */
  isTopLevel: boolean
  /** 节点在同级中的序号（从 1 开始，用于顶层显示） */
  index: number
  /** 递归深度（0 = 顶层，用于 L{depth+1} 标签） */
  depth: number
  /** 本地完成状态覆盖表 */
  doneOverrides: Map<string, boolean>
  /** 折叠节点路径集合 */
  collapsedSet: Set<string>
  /** 切换折叠状态回调 */
  onToggleCollapse: (path: string) => void
  /** 切换叶子节点完成状态回调 */
  onToggleDone: (path: string, currentDone: boolean) => void
}

/**
 * 单个计划节点渲染（递归）。
 *
 * 布局（对齐原型 L9107-9113）：
 *   [L{depth+1}] [spinner?] [▶/▼?] [idx?] [text]
 *
 * 样式规则（对齐 prototype.html L3951-4134）：
 *   - parent: font-weight 600 + margin-top 4px + idx 边框 accent
 *   - child: font-weight 400 + color text-dim + ::before 圆点
 *   - done: idx 背景 accent + text 删除线
 *   - active: idx 透明 + spinner 旋转 + text accent
 */
function PlanNode({
  item,
  path,
  isTopLevel,
  index,
  depth,
  doneOverrides,
  collapsedSet,
  onToggleCollapse,
  onToggleDone,
}: PlanNodeProps) {
  const hasChildren = !!(item.children && item.children.length > 0)
  const isDone = isPlanDone(item, doneOverrides, path)
  // active 状态：status === 'active' 且未完成（对齐原型 !!plan.active && !isDone）
  const isActive = item.status === 'active' && !isDone
  const collapsed = hasChildren ? collapsedSet.has(path) : false

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        onClick={e => {
          e.stopPropagation()
          if (hasChildren) {
            onToggleCollapse(path)
          } else {
            onToggleDone(path, isDone)
          }
        }}
        onKeyDown={e => {
          // Enter / Space 触发点击（无障碍）
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            e.stopPropagation()
            if (hasChildren) {
              onToggleCollapse(path)
            } else {
              onToggleDone(path, isDone)
            }
          }
        }}
        className={cn(
          // 基础样式（对齐 .crp-plan-item L3951-3963）
          'flex items-start gap-1.5 rounded-[5px] px-2 py-[5px]',
          'text-xs leading-[1.5] cursor-pointer transition-[background] duration-100',
          'min-w-0 text-[var(--text)]',
          'hover:bg-[var(--bg-elev-2)]',
          // 父节点样式（对齐 .crp-plan-item.parent L3967-3970）
          hasChildren && 'font-semibold mt-1',
          // 子节点样式（对齐 .crp-plan-item.child L3974-3977）
          !isTopLevel && 'font-normal text-[var(--text-dim)]',
          // 完成状态（对齐 .crp-plan-item.done）
          isDone && 'text-[var(--text-faint)]'
        )}
      >
        {/* 层级标签 L{depth+1}（对齐 .crp-plan-level L4023-4031） */}
        <span className="flex-shrink-0 font-mono text-[10px] font-bold tracking-wider text-[var(--accent)] min-w-[22px]">
          L{depth + 1}
        </span>

        {/* active 状态的旋转 spinner（对齐 .crp-plan-spinner L4098-4106，仅非顶层 active 显示） */}
        {isActive && !isTopLevel && (
          <Loader2
            size={12}
            className="flex-shrink-0 mt-px animate-spin text-[var(--accent)]"
          />
        )}

        {/* 折叠/展开图标（对齐 .crp-plan-toggle L3992-4002，仅有子节点时显示） */}
        {hasChildren && (
          <span className="flex-shrink-0 w-[14px] flex items-center justify-center mt-[3px] text-[9px] text-[var(--text-faint)] transition-colors">
            {collapsed ? '▶' : '▼'}
          </span>
        )}

        {/* 序号圆圈（对齐 .crp-plan-idx L4006-4022，仅顶层显示） */}
        {isTopLevel && (
          <span
            className={cn(
              'flex-shrink-0 relative w-[22px] h-[22px] rounded-full border flex items-center justify-center',
              'font-mono text-[10px] font-semibold transition-[background-color,color] duration-150',
              'whitespace-nowrap overflow-hidden',
              // 默认样式
              !isDone && !isActive && 'border-[var(--border-strong)] text-[var(--text-faint)]',
              // 父节点：边框 accent（对齐 .crp-plan-item.parent .crp-plan-idx L4037-4040）
              hasChildren && !isDone && 'border-[var(--accent)] text-[var(--accent)]',
              // 完成状态：背景 accent（对齐 .crp-plan-item.done .crp-plan-idx L4032-4036）
              isDone && 'bg-[var(--accent)] border-[var(--accent)] text-white',
              // active 状态：透明背景 + 旋转边框（对齐 .crp-plan-item.active .crp-plan-idx L4079-4094）
              isActive && 'bg-transparent border-transparent text-transparent'
            )}
          >
            {index}
            {/* active 状态的旋转边框（伪元素，对齐 L4084-4094） */}
            {isActive && (
              <span
                className="absolute inset-0 rounded-full border-[1.5px] border-transparent border-t-[var(--accent)] border-r-[var(--accent)] animate-spin"
                style={{ boxSizing: 'border-box' }}
                aria-hidden
              />
            )}
          </span>
        )}

        {/* 文本内容（对齐 .crp-plan-text L4068-4074） */}
        <span
          className={cn(
            'flex-1 min-w-0 break-words transition-[color,text-decoration] duration-150',
            isDone && 'text-[var(--text-faint)] line-through',
            isActive && 'text-[var(--accent)]'
          )}
        >
          {item.text}
        </span>
      </div>

      {/* 递归渲染子节点（对齐 L9128-9130） */}
      {/* hasChildren 已保证 item.children 非空，这里用安全访问避免 non-null assertion */}
      {hasChildren && !collapsed && item.children?.map((child, idx) => (
        <PlanNode
          key={`${path}-${idx}`}
          item={child}
          path={`${path}-${idx}`}
          isTopLevel={false}
          index={idx + 1}
          depth={depth + 1}
          doneOverrides={doneOverrides}
          collapsedSet={collapsedSet}
          onToggleCollapse={onToggleCollapse}
          onToggleDone={onToggleDone}
        />
      ))}
    </>
  )
}

/**
 * 会话详情面板组件
 *
 * 从 activeThreadId 派生所有展示数据：
 *  - 会话目标通过 getThreadGoal API 获取（对齐原型 thread/goal/get）
 *  - 计划待办来自 useMessages 查询中最新一条含 planItems 的消息
 *  - 引用文件来自 conversation-store（patch 审批追踪）
 *
 * 如果无活跃线程，显示空状态提示。
 */
export function InfoPane({ activeThreadId }: InfoPaneProps) {
  // 从 TanStack Query 获取线程列表，查找活跃线程
  const { data: threads = [] } = useThreads()
  const activeThread = activeThreadId
    ? threads.find(t => t.id === activeThreadId)
    : undefined

  // 从 conversation-store 获取引用文件路径列表（patch 审批追踪）
  const referencedFileStrings = useConversationStore(s =>
    activeThreadId
      ? (s.referencedFilesByThread[activeThreadId] ?? EMPTY_REFERENCED_PATHS)
      : EMPTY_REFERENCED_PATHS
  )

  // 从消息查询获取计划项 —— 找到最后一条含 planItems 的消息
  // React Compiler 自动 memoize，无需手动 useMemo
  const { data: messages = [] } = useMessages(activeThreadId)
  const planItems = (() => {
    // 从后往前找最后一条含 planItems 的消息
    for (let i = messages.length - 1; i >= 0; i--) {
      // noUncheckedIndexedAccess: messages[i] 类型为 Message | undefined，需检查
      const msg = messages[i]
      if (msg && msg.planItems && msg.planItems.length > 0) {
        return msg.planItems
      }
    }
    return EMPTY_PLAN_ITEMS
  })()

  // ─── 计划待办本地状态（对齐原型 _collapsed + plan.done 切换）──────────────
  // 折叠状态：Set<string> 存储被折叠的父节点路径（如 "0"、"0-1"）
  // 对齐原型 L9096: `if (hasChildren && plan._collapsed === undefined) plan._collapsed = true;`
  // 即父节点默认折叠。
  const [collapsedSet, setCollapsedSet] = useState<Set<string>>(() => new Set())
  // 完成状态覆盖表：Map<path, boolean>，用于本地切换叶子节点 done 状态
  // 后端暂无 updatePlanItem API，本地覆盖保证 UI 即时反馈；刷新后状态丢失（符合现状）
  const [doneOverrides, setDoneOverrides] = useState<Map<string, boolean>>(
    () => new Map()
  )

  // 收集所有父节点路径（用于初始化默认折叠）—— 仅在 planItems 变化时重算
  const parentPaths = useMemo(() => {
    const paths: string[] = []
    const collect = (items: PlanItem[], basePath: string) => {
      items.forEach((item, idx) => {
        const path = basePath === '' ? `${idx}` : `${basePath}-${idx}`
        if (item.children && item.children.length > 0) {
          paths.push(path)
          collect(item.children, path)
        }
      })
    }
    collect(planItems, '')
    return paths
  }, [planItems])

  // planItems 变化时重置折叠状态 + 清空 doneOverrides
  // 采用 React 推荐的"渲染期间调整 state"模式（避免 effect 级联渲染）
  // @see https://react.dev/reference/react/useState#storing-information-from-previous-renders
  // 注意：parentPaths 是 useMemo 派生，引用仅在 planItems 变化时改变，因此比较引用即可
  const [prevParentPaths, setPrevParentPaths] = useState(parentPaths)
  if (parentPaths !== prevParentPaths) {
    setPrevParentPaths(parentPaths)
    setCollapsedSet(new Set(parentPaths))
    setDoneOverrides(new Map())
  }

  // 进度统计（对齐原型 L9079-9080 countAllPlans + pct 计算）
  const { total, done: doneCount } = useMemo(
    () => countAllPlans(planItems, doneOverrides),
    [planItems, doneOverrides]
  )
  const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0

  // 切换折叠状态回调（对齐原型 L9115-9119: plan._collapsed = !plan._collapsed）
  const handleToggleCollapse = useCallback((path: string) => {
    setCollapsedSet(prev => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
  }, [])

  // 切换叶子节点完成状态回调（对齐原型 L9121-9125: plan.done = !plan.done）
  const handleToggleDone = useCallback(
    (path: string, currentDone: boolean) => {
      setDoneOverrides(prev => {
        const next = new Map(prev)
        next.set(path, !currentDone)
        return next
      })
    },
    []
  )

  // P2-1: 会话目标从 thread/goal/get API 获取（对齐原型 L8618-8620）
  // 不再使用线程标题作为 goal 文本——线程标题和会话目标是两个独立概念。
  // 原型 #crpGoalSection 默认 display:none，仅当 API 返回非空 objective 时才显示。
  // 存储完整 goal 对象（含 status 字段），对齐原型 L8624-8631 渲染 objective + status 标签。
  const [goal, setGoal] = useState<ThreadGoalGetResponse | null>(null)

  useEffect(() => {
    let cancelled = false
    // activeThreadId 为空时异步清空（避免 effect 体内同步 setState）
    if (!activeThreadId) {
      Promise.resolve().then(() => {
        if (!cancelled) setGoal(null)
      })
      return
    }
    getThreadGoal(activeThreadId)
      .then(g => {
        if (cancelled) return
        setGoal(g)
      })
      .catch(err => {
        if (cancelled) return
        // 保留 console.error 用于开发调试，同时用 toast 给用户即时反馈
        console.error('Failed to load thread goal:', err)
        toast.error('加载会话目标失败')
        setGoal(null)
      })
    return () => {
      cancelled = true
    }
  }, [activeThreadId])

  /**
   * 清除会话目标 —— 对齐原型 L11829-11832
   *   1. 弹出二次确认对话框（不可撤销操作）
   *   2. 确认后调用 clearThreadGoal API
   *   3. 成功后清空本地 goal + toast 提示
   */
  const handleClearGoal = useCallback(async () => {
    if (!activeThreadId) return
    const confirmed = await confirm({
      title: '清除会话目标',
      message: '确定要清除当前会话的目标吗？此操作不可撤销。',
      confirmText: '确认清除',
      danger: true,
    })
    if (!confirmed) return
    try {
      await clearThreadGoal(activeThreadId)
      setGoal(null)
      toast.success('会话目标已清除')
    } catch (err) {
      toast.error('清除会话目标失败')
      console.error('Failed to clear thread goal:', err)
    }
  }, [activeThreadId])

  // 空状态：无活跃线程
  if (!activeThreadId || !activeThread) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2">
        <Info size={32} className="text-[var(--text-faint)] opacity-50" />
        <div className="font-mono text-xs text-[var(--text-faint)]">
          未选中会话
        </div>
        <div className="text-[11px] text-[var(--text-faint)]">
          从左侧选择一个会话以查看详情
        </div>
      </div>
    )
  }

  // 将引用文件路径列表转换为 ReferencedFile 格式
  const referencedFiles: ReferencedFile[] = referencedFileStrings.map(
    (path, idx) => ({ id: `ref-${idx}`, path })
  )

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {/* === 会话目标区块 === */}
      {/* 对齐原型 #crpGoalSection 默认 display:none —— 仅当 goal.objective 非空时渲染 */}
      {goal?.objective && (
        <section className="border-b border-[var(--border)] px-4 py-3.5">
          <h3 className="mb-2.5 flex items-center font-mono text-[11px] font-semibold uppercase tracking-wider text-[var(--text-faint)]">
            <span>会话目标</span>
            <button
              type="button"
              title="清除目标"
              onClick={handleClearGoal}
              className="ml-auto rounded px-1 leading-none text-[var(--text-faint)] transition-colors hover:text-[var(--text)]"
            >
              <X size={14} />
            </button>
          </h3>
          {/* 对齐原型 L8626-8631：objective 文本 + status 标签 */}
          <div className="rounded-md border border-[var(--border)] bg-[var(--bg-elev-2)] px-3 py-2.5">
            {/* objective 文本（对齐原型 font-size:12px; margin-bottom:6px） */}
            <p className="mb-1.5 text-[12.5px] leading-[1.5] text-[var(--text)]">
              {goal.objective}
            </p>
            {/* status 标签（对齐原型 font-size:10px; color:var(--text-faint)） */}
            {goal.status && (
              <div className="flex gap-2 text-[10px] text-[var(--text-faint)]">
                <span>状态: {GOAL_STATUS_LABEL[goal.status] ?? goal.status}</span>
              </div>
            )}
          </div>
        </section>
      )}

      {/* === 计划待办区块 === */}
      {/* 对齐原型 L9070-9132 renderPlanList + renderPlanNodes */}
      <section className="border-b border-[var(--border)] px-4 py-3.5">
        <h3 className="mb-2.5 flex items-center font-mono text-[11px] font-semibold uppercase tracking-wider text-[var(--text-faint)]">
          计划待办
        </h3>
        {planItems.length === 0 ? (
          <div className="px-2 py-3 text-center font-mono text-xs text-[var(--text-faint)]">
            暂无计划待办
          </div>
        ) : (
          <div className="flex max-h-[33vh] flex-col gap-0.5 overflow-y-auto overflow-x-hidden pr-0.5">
            {/* 进度条（对齐 .crp-plan-progress L4110-4134） */}
            <div className="flex items-center gap-1.5 px-2 pb-0.5 pt-1.5 font-mono text-[10px] uppercase tracking-[0.05em] text-[var(--text-faint)]">
              <span>{doneCount}/{total}</span>
              <div className="h-[3px] min-w-[40px] flex-1 overflow-hidden rounded-[2px] bg-[var(--border)]">
                <div
                  className="h-full rounded-[2px] bg-[var(--accent)] transition-[width] duration-200 ease-out"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span>{pct}%</span>
            </div>
            {/* 递归渲染计划节点 */}
            {planItems.map((item, idx) => (
              <PlanNode
                key={`${idx}`}
                item={item}
                path={`${idx}`}
                isTopLevel={true}
                index={idx + 1}
                depth={0}
                doneOverrides={doneOverrides}
                collapsedSet={collapsedSet}
                onToggleCollapse={handleToggleCollapse}
                onToggleDone={handleToggleDone}
              />
            ))}
          </div>
        )}
      </section>

      {/* === 引用文件区块 === */}
      <section className="px-4 py-3.5">
        <h3 className="mb-2.5 flex items-center font-mono text-[11px] font-semibold uppercase tracking-wider text-[var(--text-faint)]">
          引用文件
        </h3>
        {referencedFiles.length === 0 ? (
          <div className="px-2 py-3 text-center text-[11px] text-[var(--text-faint)]">
            暂无引用文件
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {referencedFiles.map(file => (
              <div
                key={file.id}
                className="flex items-center gap-2 rounded px-2 py-1.5 font-mono text-xs text-[var(--text-dim)] transition-colors hover:bg-[var(--bg-elev-2)]"
              >
                <FileCode size={12} className="flex-shrink-0 text-[var(--text-faint)]" />
                <span className="truncate">{file.path}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
