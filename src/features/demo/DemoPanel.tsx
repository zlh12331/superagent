/**
 * @file 演示面板组件
 *
 * 对齐 HTML 原型的 Demo 下拉菜单功能（prototype.html #demoDropdown，L5707-5819）。
 * 提供一个烧瓶图标按钮，点击展开下拉菜单，包含 **6 个分组**（与原型完全对齐）：
 *   1. 审批类型演示（7 种内联卡片，灰底灰字 badge）
 *   2. 消息流演示（reasoning/plan/rate — accent绿 / warn黄 badge）
 *   3. 用户消息类型（user-code/user-attach/user-long/user-error — accent-2蓝 / error红 badge）
 *   4. 工具卡状态（tool-running/tool-error/cmd-success/cmd-error/multi-tool — 多色 badge）
 *   5. 系统状态（3 种 Toast + interrupted + whitelist — 多色 badge）
 *   6. 综合演示（ALL — 渐变 badge）
 *
 * 每个分组使用独立的彩色 badge 配色（对齐原型内联 style），
 * 不再使用统一灰底 BADGE_CLASS 常量。
 *
 * 仅在开发模式（import.meta.env.DEV）下显示。
 * 生产构建中 Vite 会静态替换 DEV 为 false，组件直接返回 null。
 *
 * 触发按钮样式与 TitleBar 其他按钮一致（h-7 w-7 rounded-md + hover 高亮）。
 */

import { FlaskConical } from 'lucide-react'
import { toast } from 'sonner'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  handleDemoCard,
  handleDemoComprehensive,
  handleDemoMsg,
  handleDemoSystemStatus,
  handleDemoToast,
  triggerInlineApproval,
  type ApprovalVariant,
  type DemoCardType,
  type DemoMessageType,
  type DemoToastType,
  type SystemStatusType,
} from './demo-injector'

// ===== Badge 配色常量 =====

/**
 * Badge 基础样式 — 所有分组共享的尺寸 / 字体 / 圆角 / 间距
 *
 * 原型 .di-badge 基础样式：
 *   flex-shrink-0 rounded-[4px] px-[7px] py-[2px]
 *   font-mono text-[9.5px] uppercase tracking-[0.1em] font-bold
 *
 * 配色（bg + color）由各分组的 *_BADGE_CLASS 常量单独指定，
 * 对齐原型每个 badge 的内联 style。
 */
const BADGE_BASE =
  'flex-shrink-0 rounded-[4px] px-[7px] py-[2px] font-mono text-[9.5px] uppercase tracking-[0.1em] font-bold' as const

/**
 * 审批分组 badge 配色 — 灰底灰字带边框
 *
 * 对齐原型：7 种审批 badge（CMD/PATCH/TOOL/MCP/PERM/DYN/ATST）无内联 style，
 * 使用 .di-badge 默认样式（灰底灰字）。
 */
const APPROVAL_BADGE_CLASS =
  'border border-[var(--border)] bg-[var(--bg-elev-2)] text-[var(--text-faint)]' as const

/**
 * accent 绿底 badge — 用于消息流（REA/PLAN）、工具卡成功（RUN/OK）、
 * Toast 成功（OK）、whitelist（WL）
 *
 * 对齐原型：background:rgba(0,229,199,0.15); color:var(--accent)
 */
const ACCENT_BADGE_CLASS = 'bg-[rgba(0,229,199,0.15)] text-[var(--accent)]' as const

/**
 * warn 黄底 badge — 用于速率限制（RATE）、Toast 警告（WARN）、
 * 中断（STOP）
 *
 * 对齐原型：background:rgba(255,180,84,0.15); color:var(--warn)
 */
const WARN_BADGE_CLASS = 'bg-[rgba(255,180,84,0.15)] text-[var(--warn)]' as const

/**
 * accent-2 蓝底 badge — 用于用户消息类型（CODE/FILE/LONG）
 *
 * 对齐原型：background:rgba(120,160,255,0.15); color:var(--accent-2)
 */
const ACCENT2_BADGE_CLASS = 'bg-[rgba(120,160,255,0.15)] text-[var(--accent-2)]' as const

/**
 * error 红底 badge — 用于用户错误（ERR）、工具错误（ERR/FAIL）、
 * Toast 错误（ERR）
 *
 * 对齐原型：background:rgba(255,107,107,0.15); color:var(--error)
 */
const ERROR_BADGE_CLASS = 'bg-[rgba(255,107,107,0.15)] text-[var(--error)]' as const

/**
 * 紫色 badge — 用于并行工具调用（MUL）
 *
 * 对齐原型：background:rgba(180,140,255,0.15); color:#b48cff
 */
const PURPLE_BADGE_CLASS = 'bg-[rgba(180,140,255,0.15)] text-[#b48cff]' as const

/**
 * 渐变 badge — 用于综合演示（ALL）
 *
 * 对齐原型：background:linear-gradient(135deg,rgba(0,229,199,0.2),rgba(180,140,255,0.2));
 *          color:var(--accent)
 */
const GRADIENT_BADGE_CLASS =
  'bg-[linear-gradient(135deg,rgba(0,229,199,0.2),rgba(180,140,255,0.2))] text-[var(--accent)]' as const

// ===== 菜单项配置 =====

/**
 * 带徽章的菜单项通用结构
 *
 * 每项包含：badge 文本、badge 配色类、标题、副标题
 */
interface BadgedMenuItem {
  /** 徽章文本（对齐原型 .di-badge 内文本） */
  badge: string
  /** 徽章配色类（追加到 BADGE_BASE 之后） */
  badgeClass: string
  /** 菜单项标题 */
  label: string
  /** 菜单项副标题（事件类名或描述） */
  subtitle: string
}

// ----- 分组 1：审批类型演示 -----

/**
 * 审批变体菜单项 — 在 BadgedMenuItem 基础上额外携带 variant 字段
 */
interface ApprovalMenuItem extends BadgedMenuItem {
  /** 审批变体标识 */
  variant: ApprovalVariant
}

/**
 * 审批类型演示分组 — 对齐原型 7 种 data-variant 项
 *
 * 顺序：command / patch / tool / mcp / perm / dyn / attest
 *
 * 注意：attest 的 badge 文本对齐原型为 "ATST"（原型 L5734），
 * 非 "ATTEST"。此为原型原始设计，保持一致。
 */
const APPROVAL_ITEMS: readonly ApprovalMenuItem[] = [
  { variant: 'command', badge: 'CMD', badgeClass: APPROVAL_BADGE_CLASS, label: '命令执行审批', subtitle: 'CommandExecutionRequestApproval' },
  { variant: 'patch', badge: 'PATCH', badgeClass: APPROVAL_BADGE_CLASS, label: '文件变更审批', subtitle: 'FileChangeRequestApproval' },
  { variant: 'tool', badge: 'TOOL', badgeClass: APPROVAL_BADGE_CLASS, label: '工具输入请求', subtitle: 'ToolRequestUserInput' },
  { variant: 'mcp', badge: 'MCP', badgeClass: APPROVAL_BADGE_CLASS, label: 'MCP Elicitation', subtitle: 'McpServerElicitationRequest' },
  { variant: 'perm', badge: 'PERM', badgeClass: APPROVAL_BADGE_CLASS, label: '权限授予审批', subtitle: 'PermissionsRequestApproval' },
  { variant: 'dyn', badge: 'DYN', badgeClass: APPROVAL_BADGE_CLASS, label: '动态工具调用', subtitle: 'DynamicToolCall' },
  { variant: 'attest', badge: 'ATST', badgeClass: APPROVAL_BADGE_CLASS, label: 'Attestation 生成', subtitle: 'AttestationGenerate' },
]

// ----- 分组 2：消息流演示 -----

/**
 * 消息流菜单项 — 在 BadgedMenuItem 基础上额外携带 type 字段
 */
interface MessageMenuItem extends BadgedMenuItem {
  /** 消息类型标识 */
  type: DemoMessageType
}

/**
 * 消息流演示分组 — 对齐原型 data-msg 中的 reasoning / plan / rate 三项
 *
 * 配色：REA/PLAN 用 accent 绿底，RATE 用 warn 黄底
 */
const MSG_FLOW_ITEMS: readonly MessageMenuItem[] = [
  { type: 'reasoning', badge: 'REA', badgeClass: ACCENT_BADGE_CLASS, label: '推理摘要块', subtitle: 'ReasoningSummaryTextDelta' },
  { type: 'plan', badge: 'PLAN', badgeClass: ACCENT_BADGE_CLASS, label: '执行计划块', subtitle: 'TurnPlanUpdated' },
  { type: 'rate', badge: 'RATE', badgeClass: WARN_BADGE_CLASS, label: '速率限制横幅', subtitle: 'AccountRateLimitsUpdated' },
]

// ----- 分组 3：用户消息类型 -----

/**
 * 用户消息类型分组 — 对齐原型 data-msg 中的 user-* 四项
 *
 * 配色：CODE/FILE/LONG 用 accent-2 蓝底，ERR 用 error 红底
 */
const USER_MSG_ITEMS: readonly MessageMenuItem[] = [
  { type: 'user-code', badge: 'CODE', badgeClass: ACCENT2_BADGE_CLASS, label: '含代码块消息', subtitle: '多行代码 + 问题描述' },
  { type: 'user-attach', badge: 'FILE', badgeClass: ACCENT2_BADGE_CLASS, label: '带附件消息', subtitle: '多文件引用 + 图片附件' },
  { type: 'user-long', badge: 'LONG', badgeClass: ACCENT2_BADGE_CLASS, label: '长文本消息', subtitle: '多段 Markdown 内容' },
  { type: 'user-error', badge: 'ERR', badgeClass: ERROR_BADGE_CLASS, label: '错误报告消息', subtitle: '粘贴错误堆栈追踪' },
]

// ----- 分组 4：工具卡状态 -----

/**
 * 工具卡菜单项 — 在 BadgedMenuItem 基础上额外携带 type 字段
 */
interface CardMenuItem extends BadgedMenuItem {
  /** 卡片类型标识 */
  type: DemoCardType
}

/**
 * 工具卡状态分组 — 对齐原型 data-card 五项
 *
 * 配色：RUN/OK 用 accent 绿底，ERR/FAIL 用 error 红底，MUL 用紫色
 * 顺序对齐原型：tool-running / tool-error / cmd-success / cmd-error / multi-tool
 */
const CARD_ITEMS: readonly CardMenuItem[] = [
  { type: 'tool-running', badge: 'RUN', badgeClass: ACCENT_BADGE_CLASS, label: '工具执行中', subtitle: 'running 状态 + 实时输出' },
  { type: 'tool-error', badge: 'ERR', badgeClass: ERROR_BADGE_CLASS, label: '工具执行失败', subtitle: 'error 状态 + 错误详情' },
  { type: 'cmd-success', badge: 'OK', badgeClass: ACCENT_BADGE_CLASS, label: '命令执行成功', subtitle: 'success + 终端输出' },
  { type: 'cmd-error', badge: 'FAIL', badgeClass: ERROR_BADGE_CLASS, label: '命令执行失败', subtitle: '非零退出码 + stderr' },
  { type: 'multi-tool', badge: 'MUL', badgeClass: PURPLE_BADGE_CLASS, label: '并行工具调用', subtitle: '3 个工具并发执行' },
]

// ----- 分组 5：系统状态（Toast + interrupted + whitelist） -----

/**
 * 系统状态菜单项 — 联合类型，支持 Toast / 消息 / 系统状态三种触发方式
 *
 * 原型"系统状态"分组混合了 data-toast / data-msg / data-status 三种触发：
 * - success / error / warn → data-toast（直接 toast）
 * - interrupted / whitelist → data-msg（注入消息）
 * - net 系列 / rate 系列 / backend 系列 → data-status（系统状态事件）
 *
 * 为保持类型安全，使用 kind 字段区分三种触发方式。
 */
type SysStatusItem =
  | (BadgedMenuItem & { kind: 'toast'; toastType: DemoToastType })
  | (BadgedMenuItem & { kind: 'msg'; msgType: DemoMessageType })
  | (BadgedMenuItem & { kind: 'status'; statusType: SystemStatusType })

/**
 * 系统状态分组 — 对齐原型 L5792-5812
 *
 * 顺序：Toast成功 / Toast错误 / Toast警告 / interrupted / whitelist
 * 注意：原型此分组不包含 net 系列 / rate 系列 / backend 系列系统状态（那些是 React 额外扩展，
 * 此处保留以兼容已有功能，放在 whitelist 之后）。
 *
 * 配色：
 * - Toast 成功（OK）→ accent 绿底
 * - Toast 错误（ERR）→ error 红底
 * - Toast 警告（WARN）→ warn 黄底
 * - 中断（STOP）→ warn 黄底
 * - 白名单（WL）→ accent 绿底
 */
const SYS_STATUS_ITEMS: readonly SysStatusItem[] = [
  { kind: 'toast', toastType: 'success', badge: 'OK', badgeClass: ACCENT_BADGE_CLASS, label: '成功 Toast', subtitle: '操作成功反馈' },
  { kind: 'toast', toastType: 'error', badge: 'ERR', badgeClass: ERROR_BADGE_CLASS, label: '错误 Toast', subtitle: '网络/操作失败' },
  { kind: 'toast', toastType: 'warn', badge: 'WARN', badgeClass: WARN_BADGE_CLASS, label: '警告 Toast', subtitle: '需要注意的提示' },
  { kind: 'msg', msgType: 'interrupted', badge: 'STOP', badgeClass: WARN_BADGE_CLASS, label: 'Turn 中断', subtitle: '用户中断当前生成' },
  { kind: 'msg', msgType: 'whitelist', badge: 'WL', badgeClass: ACCENT_BADGE_CLASS, label: '白名单自动执行', subtitle: '已授权命令自动通过' },
  // 以下为 React 扩展项（原型"系统状态"分组无，但 DemoPanel 早期已实现，保留以不丢失功能）
  { kind: 'status', statusType: 'net-online', badge: 'NET', badgeClass: ACCENT_BADGE_CLASS, label: '网络状态：在线', subtitle: 'NetworkStatus: online' },
  { kind: 'status', statusType: 'net-offline', badge: 'NET', badgeClass: ERROR_BADGE_CLASS, label: '网络状态：离线', subtitle: 'NetworkStatus: offline' },
  { kind: 'status', statusType: 'net-reconnecting', badge: 'NET', badgeClass: WARN_BADGE_CLASS, label: '网络状态：重连中', subtitle: 'NetworkStatus: reconnecting' },
  { kind: 'status', statusType: 'rate-normal', badge: 'RATE', badgeClass: ACCENT_BADGE_CLASS, label: '速率限制：正常', subtitle: 'RateLimit: normal' },
  { kind: 'status', statusType: 'rate-limited', badge: 'RATE', badgeClass: WARN_BADGE_CLASS, label: '速率限制：受限', subtitle: 'RateLimit: limited' },
  { kind: 'status', statusType: 'backend-connected', badge: 'BE', badgeClass: ACCENT_BADGE_CLASS, label: '后端连接：已连接', subtitle: 'BackendConnection: connected' },
  { kind: 'status', statusType: 'backend-disconnected', badge: 'BE', badgeClass: ERROR_BADGE_CLASS, label: '后端连接：断开', subtitle: 'BackendConnection: disconnected' },
]

// ===== 其他样式常量 =====

/**
 * 分组标签样式 — 对齐原型 .demo-dropdown-head 的视觉风格
 * mono 字体、小号大写、间距加宽、低饱和文字色
 */
const GROUP_LABEL_CLASS =
  'font-mono text-[10px] uppercase tracking-wider text-[var(--text-faint)]' as const

/**
 * 菜单项内容区样式 — 标题 + 副标题两行布局
 */
const ITEM_CONTENT_CLASS = 'flex flex-col' as const

/**
 * 菜单项标题样式
 */
const ITEM_TITLE_CLASS = 'text-[12px] text-[var(--text)]' as const

/**
 * 菜单项副标题样式 — mono 字体、低饱和色
 */
const ITEM_SUBTITLE_CLASS =
  'font-mono text-[10px] text-[var(--text-faint)]' as const

// ===== 组件 =====

/**
 * 演示面板 — 开发模式下的演示入口
 *
 * 触发按钮使用烧瓶图标（FlaskConical），与 TitleBar 其他按钮样式一致。
 * 点击后展开下拉菜单，提供 6 个分组的演示入口（对齐原型）。
 * 每个菜单项点击后调用对应的注入函数并 toast 提示。
 *
 * 按钮仅在开发模式（import.meta.env.DEV）下渲染，
 * 生产构建中 Vite 静态替换 DEV 为 false，组件返回 null。
 */
export function DemoPanel() {
  // 仅在开发模式下渲染；生产构建中此分支为 true，组件返回 null
  if (!import.meta.env.DEV) return null

  return (
    <DropdownMenu>
      {/* 触发按钮 — h-7 w-7 rounded-md，样式对齐 TitleBar 其他按钮 */}
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-[var(--text-faint)] transition-colors hover:bg-[var(--bg-elev-2)] hover:text-[var(--text)]"
          title="开发演示 (Shift+Ctrl+D)"
          aria-label="开发演示"
        >
          <FlaskConical className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>

      {/* 下拉菜单内容 — 右对齐，固定宽度 280px */}
      <DropdownMenuContent align="end" className="w-[280px]">
        {/* ===== 分组 1：审批类型演示 ===== */}
        <DropdownMenuLabel className={GROUP_LABEL_CLASS}>
          审批类型演示 · 7 种内联卡片
        </DropdownMenuLabel>
        {APPROVAL_ITEMS.map(item => (
          <DropdownMenuItem
            key={item.variant}
            onSelect={() => {
              triggerInlineApproval(item.variant)
              toast.info(`已触发审批: ${item.label}`)
            }}
          >
            {/* 徽章 — 灰底灰字，对齐原型 .di-badge 默认样式 */}
            <span className={`${BADGE_BASE} ${item.badgeClass}`}>
              {item.badge}
            </span>
            <div className={ITEM_CONTENT_CLASS}>
              <span className={ITEM_TITLE_CLASS}>{item.label}</span>
              <span className={ITEM_SUBTITLE_CLASS}>{item.subtitle}</span>
            </div>
          </DropdownMenuItem>
        ))}

        <DropdownMenuSeparator />

        {/* ===== 分组 2：消息流演示 ===== */}
        <DropdownMenuLabel className={GROUP_LABEL_CLASS}>
          消息流演示
        </DropdownMenuLabel>
        {MSG_FLOW_ITEMS.map(item => (
          <DropdownMenuItem
            key={item.type}
            onSelect={() => {
              handleDemoMsg(item.type)
              toast.info(`已注入演示消息: ${item.label}`)
            }}
          >
            {/* 徽章 — accent 绿 / warn 黄 */}
            <span className={`${BADGE_BASE} ${item.badgeClass}`}>
              {item.badge}
            </span>
            <div className={ITEM_CONTENT_CLASS}>
              <span className={ITEM_TITLE_CLASS}>{item.label}</span>
              <span className={ITEM_SUBTITLE_CLASS}>{item.subtitle}</span>
            </div>
          </DropdownMenuItem>
        ))}

        <DropdownMenuSeparator />

        {/* ===== 分组 3：用户消息类型 ===== */}
        <DropdownMenuLabel className={GROUP_LABEL_CLASS}>
          用户消息类型
        </DropdownMenuLabel>
        {USER_MSG_ITEMS.map(item => (
          <DropdownMenuItem
            key={item.type}
            onSelect={() => {
              handleDemoMsg(item.type)
              toast.info(`已注入演示消息: ${item.label}`)
            }}
          >
            {/* 徽章 — accent-2 蓝 / error 红 */}
            <span className={`${BADGE_BASE} ${item.badgeClass}`}>
              {item.badge}
            </span>
            <div className={ITEM_CONTENT_CLASS}>
              <span className={ITEM_TITLE_CLASS}>{item.label}</span>
              <span className={ITEM_SUBTITLE_CLASS}>{item.subtitle}</span>
            </div>
          </DropdownMenuItem>
        ))}

        <DropdownMenuSeparator />

        {/* ===== 分组 4：工具卡状态 ===== */}
        <DropdownMenuLabel className={GROUP_LABEL_CLASS}>
          工具卡状态
        </DropdownMenuLabel>
        {CARD_ITEMS.map(item => (
          <DropdownMenuItem
            key={item.type}
            onSelect={() => {
              // handleDemoCard 返回 Promise（800ms 后 resolve），
              // 此处不需要 await，用 void 显式丢弃 Promise 避免浮动 Promise 警告
              void handleDemoCard(item.type)
              toast.info(`已注入演示卡片: ${item.label}`)
            }}
          >
            {/* 徽章 — accent 绿 / error 红 / 紫色 */}
            <span className={`${BADGE_BASE} ${item.badgeClass}`}>
              {item.badge}
            </span>
            <div className={ITEM_CONTENT_CLASS}>
              <span className={ITEM_TITLE_CLASS}>{item.label}</span>
              <span className={ITEM_SUBTITLE_CLASS}>{item.subtitle}</span>
            </div>
          </DropdownMenuItem>
        ))}

        <DropdownMenuSeparator />

        {/* ===== 分组 5：系统状态（Toast + interrupted + whitelist + 扩展状态） ===== */}
        <DropdownMenuLabel className={GROUP_LABEL_CLASS}>
          系统状态
        </DropdownMenuLabel>
        {SYS_STATUS_ITEMS.map((item, idx) => (
          <DropdownMenuItem
            // sys-status 项可能重复 badge 文本，使用 idx 保证 key 唯一
            key={`${item.kind}-${item.badge}-${idx}`}
            onSelect={() => {
              switch (item.kind) {
                case 'toast':
                  // Toast 演示：直接调用 sonner toast，不进入对话流
                  handleDemoToast(item.toastType, toast)
                  break
                case 'msg':
                  // 消息演示：注入消息到对话流
                  handleDemoMsg(item.msgType)
                  toast.info(`已注入: ${item.label}`)
                  break
                case 'status':
                  // 系统状态演示：派发 system-status 事件
                  handleDemoSystemStatus(item.statusType)
                  toast.info(`已切换: ${item.label}`)
                  break
              }
            }}
          >
            {/* 徽章 — 多色配色 */}
            <span className={`${BADGE_BASE} ${item.badgeClass}`}>
              {item.badge}
            </span>
            <div className={ITEM_CONTENT_CLASS}>
              <span className={ITEM_TITLE_CLASS}>{item.label}</span>
              <span className={ITEM_SUBTITLE_CLASS}>{item.subtitle}</span>
            </div>
          </DropdownMenuItem>
        ))}

        <DropdownMenuSeparator />

        {/* ===== 分组 6：综合演示 ===== */}
        <DropdownMenuLabel className={GROUP_LABEL_CLASS}>
          综合演示
        </DropdownMenuLabel>
        <DropdownMenuItem
          onSelect={() => {
            // handleDemoComprehensive 是 async 函数，
            // 此处不需要 await，用 void 显式丢弃 Promise
            void handleDemoComprehensive()
            toast.info('综合演示已启动')
          }}
        >
          {/* 徽章 — 渐变背景，对齐原型 ALL badge */}
          <span className={`${BADGE_BASE} ${GRADIENT_BADGE_CLASS}`}>
            ALL
          </span>
          <div className={ITEM_CONTENT_CLASS}>
            <span className={ITEM_TITLE_CLASS}>综合性消息流演示</span>
            <span className={ITEM_SUBTITLE_CLASS}>
              覆盖全部消息类型与工具卡状态
            </span>
          </div>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
