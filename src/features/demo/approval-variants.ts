/**
 * @file 审批变体元数据 — 7种审批类型的配置中心
 *
 * 对齐原型 APPROVAL_META (prototype.html L11162-11170) 和
 * modal-variant CSS (prototype.html L2455-2470)。
 *
 * 作为审批系统的单一数据源（Single Source of Truth），
 * 被 InlineApprovalCard / ApprovalDialog / DemoPanel 共享，
 * 避免多处硬编码导致的类型不一致问题。
 *
 * 每种 variant 包含：
 * - badge: 徽章文本（大写缩写）
 * - badgeCls: modal-variant CSS 类名（控制配色）
 * - title: 审批卡片标题
 * - description: 审批描述
 * - approveLabel: 批准按钮文本
 * - denyLabel: 拒绝按钮文本
 * - hasWhitelist: 是否显示"加入白名单"按钮
 * - bodyFields: 卡片body区域显示的字段列表
 */

// ===== 类型定义 =====

/** 7种审批变体类型 */
export type ApprovalVariant =
  | 'command' // 命令执行审批
  | 'patch' // 文件变更审批
  | 'tool' // 工具输入请求
  | 'mcp' // MCP Elicitation
  | 'perm' // 权限授予审批
  | 'dyn' // 动态工具调用
  | 'attest' // Attestation 生成

/** 审批变体的元数据结构 */
export interface ApprovalMeta {
  /** 徽章文本（大写缩写，如 CMD / PATCH / TOOL） */
  badge: string
  /** modal-variant CSS 类名（控制 badge 配色） */
  badgeCls: string
  /** 审批卡片标题 */
  title: string
  /** 审批描述文本 */
  description: string
  /** 批准按钮文本 */
  approveLabel: string
  /** 拒绝按钮文本 */
  denyLabel: string
  /** 是否显示"加入白名单"按钮 */
  hasWhitelist: boolean
  /** 卡片 body 区域显示的字段列表（label → value） */
  bodyFields: { label: string; value: string }[]
}

// ===== 元数据查表 =====

/** 7种审批变体的元数据查表 */
export const APPROVAL_META: Record<ApprovalVariant, ApprovalMeta> = {
  command: {
    badge: 'CMD',
    badgeCls: 'modal-variant-command',
    title: '命令执行审批',
    description: 'Codex 请求执行以下命令，请确认是否允许。',
    approveLabel: '允许执行',
    denyLabel: '拒绝',
    hasWhitelist: true,
    bodyFields: [
      { label: '命令', value: 'npm install lodash' },
      { label: '工作目录', value: '/home/user/project' },
      { label: '超时', value: '30s' },
    ],
  },
  patch: {
    badge: 'PATCH',
    badgeCls: 'modal-variant-patch',
    title: '文件变更审批',
    description: 'Codex 请求应用以下文件补丁，请确认。',
    approveLabel: '应用补丁',
    denyLabel: '拒绝',
    hasWhitelist: false,
    bodyFields: [
      { label: '文件', value: 'src/utils.ts' },
      { label: '变更类型', value: 'modify' },
      { label: '行数', value: '+12 -3' },
    ],
  },
  tool: {
    badge: 'TOOL',
    badgeCls: 'modal-variant-tool',
    title: '工具输入请求',
    description: '工具请求用户输入参数。',
    approveLabel: '提交',
    denyLabel: '取消',
    hasWhitelist: false,
    bodyFields: [
      { label: '工具', value: 'search_web' },
      { label: '参数', value: 'query: "tauri v2 docs"' },
    ],
  },
  mcp: {
    badge: 'MCP',
    badgeCls: 'modal-variant-mcp',
    title: 'MCP Elicitation',
    description: 'MCP 服务器请求用户提供信息。',
    approveLabel: '响应',
    denyLabel: '忽略',
    hasWhitelist: false,
    bodyFields: [
      { label: '服务器', value: 'github-mcp' },
      { label: '方法', value: 'elicitation/input' },
    ],
  },
  perm: {
    badge: 'PERM',
    badgeCls: 'modal-variant-perm',
    title: '权限授予审批',
    description: 'Codex 请求授予以下权限。',
    approveLabel: '授权',
    denyLabel: '拒绝',
    hasWhitelist: true,
    bodyFields: [
      { label: '权限', value: 'fs:write' },
      { label: '作用域', value: '/home/user/project/**' },
    ],
  },
  dyn: {
    badge: 'DYN',
    badgeCls: 'modal-variant-dyn',
    title: '动态工具调用',
    description: 'Codex 请求调用动态注册的工具。',
    approveLabel: '允许调用',
    denyLabel: '拒绝',
    hasWhitelist: false,
    bodyFields: [
      { label: '工具名', value: 'custom_analyzer' },
      { label: '来源', value: 'plugin:analyzer' },
    ],
  },
  attest: {
    badge: 'ATTEST',
    badgeCls: 'modal-variant-attest',
    title: 'Attestation 生成',
    description: 'Codex 请求生成 attestation 证明。',
    approveLabel: '生成',
    denyLabel: '拒绝',
    hasWhitelist: false,
    bodyFields: [
      { label: '类型', value: 'build-provenance' },
      { label: '主题', value: 'sha256:abc123...' },
    ],
  },
}

// ===== modal-variant 配色样式 =====

/**
 * modal-variant badge 配色类名 → CSS（注入到组件样式中）。
 *
 * 对齐原型 prototype.html L2455-2470 的 6 色 badge，
 * 新增 command 灰色变体（原型中 command 复用 perm 配色，
 * 此处独立为灰色以区分命令执行与权限审批）。
 *
 * 使用方式：在组件中通过 <style> 标签注入此 CSS 字符串，
 * 然后在 badge 元素上添加对应的 modal-variant-* 类名。
 */
export const MODAL_VARIANT_STYLES = `
.modal-variant-command { color: var(--text-faint); background: var(--bg-elev-2); border: 1px solid var(--border); }
.modal-variant-patch { color: var(--accent); background: rgba(0,229,199,0.1); border: 1px solid rgba(0,229,199,0.25); }
.modal-variant-tool { color: #B084FF; background: rgba(176,132,255,0.1); border: 1px solid rgba(176,132,255,0.25); }
.modal-variant-mcp { color: #6BCBFF; background: rgba(107,203,255,0.1); border: 1px solid rgba(107,203,255,0.25); }
.modal-variant-perm { color: var(--warn); background: rgba(255,180,84,0.1); border: 1px solid rgba(255,180,84,0.25); }
.modal-variant-dyn { color: #FFB454; background: rgba(255,180,84,0.1); border: 1px solid rgba(255,180,84,0.25); }
.modal-variant-attest { color: #FF9F6B; background: rgba(255,159,107,0.1); border: 1px solid rgba(255,159,107,0.25); }
`

// ===== 工具函数 =====

/**
 * 将 ApprovalVariant 映射为 ApprovalType（兼容旧 store）。
 *
 * 统一后 ApprovalType 已扩展为 7 种，与 ApprovalVariant 完全对齐，
 * 因此直接返回原值。保留此函数是为了向后兼容已有调用点。
 *
 * @param variant - 审批变体
 * @returns 与 ApprovalType 对齐的字符串
 */
export function variantToApprovalType(variant: ApprovalVariant): string {
  return variant
}

/**
 * 获取演示用的审批 payload JSON。
 *
 * 将 variant 及其 bodyFields 序列化为 JSON 字符串，
 * 供 ApprovalDialog / InlineApprovalCard 展示。
 *
 * @param variant - 审批变体
 * @returns JSON 格式的 payload 字符串
 */
export function getDemoApprovalPayload(variant: ApprovalVariant): string {
  const meta = APPROVAL_META[variant]
  return JSON.stringify(
    meta.bodyFields.reduce(
      (acc, f) => ({ ...acc, [f.label]: f.value }),
      { variant }
    )
  )
}
