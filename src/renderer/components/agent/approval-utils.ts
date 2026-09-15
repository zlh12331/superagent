// approval-utils.ts（自原 ApprovalDialog 拆分，弹窗已删除）
// 审批载荷解析（纯函数守卫）+ 类型元数据表（单一真源）
// ──────────────────────────────
// 拆分背景：原 ApprovalDialog 539 行，纯函数与组件混合，按职责提取
// 表驱动重构（2026-09-15）：原 getIconForType / getVariantForType / isDangerousType /
// canRememberDecision 四个平行函数合并为 APPROVAL_META 单表——新增类型从改 4 处
// 降为 1 行，satisfies Record 提供编译期穷尽性（漏登记即编译失败，无需 default 兜底）；
// getLabelKeyForType 随 i18n 键对齐协议值（approval.<type>）删除，文案消费
// t(`approval.${type}`) 零映射层
// ──────────────────────────────

import type { LucideIcon } from 'lucide-react';
import {
  CloudUpload,
  FileDiff,
  FileEdit,
  FilePlus,
  FileX,
  GitBranch,
  GitCommitHorizontal,
  Globe,
  Package,
  Terminal,
} from 'lucide-react';
import type { ApprovalType } from '@/stores/transient/approvals-store';

export function getField(obj: unknown, key: string): string | undefined {
  if (typeof obj !== 'object' || obj === null) return undefined;
  const value = (obj as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * 安全读取对象布尔字段（类型守卫）
 *
 * 与 getField 类似，但缩窄为 boolean | undefined。
 * 用于读取工具入参中的布尔选项（如 amend / force / setUpstream）。
 */
export function getBooleanField(obj: unknown, key: string): boolean | undefined {
  if (typeof obj !== 'object' || obj === null) return undefined;
  const value = (obj as Record<string, unknown>)[key];
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * 安全读取对象字符串数组字段（类型守卫）
 *
 * 用于读取工具入参中的路径列表（如 git_add 的 paths）。
 * 非数组或元素非字符串时返回 undefined。
 */
export function getStringArrayField(obj: unknown, key: string): string[] | undefined {
  if (typeof obj !== 'object' || obj === null) return undefined;
  const value = (obj as Record<string, unknown>)[key];
  if (!Array.isArray(value)) return undefined;
  return value.every((v) => typeof v === 'string') ? (value as string[]) : undefined;
}

/** 单个审批类型的全量 UI 元数据 */
interface ApprovalMeta {
  /** 类型图标 */
  readonly icon: LucideIcon;
  /** 类型徽章语义类（颜色全走一等公民语义令牌） */
  readonly className: string;
  /** 危险类型：拒绝操作以红色强调不可逆风险 */
  readonly dangerous: boolean;
  /** 是否提供白名单（记住决策）：仅副作用可重复的类型 */
  readonly canRemember: boolean;
}

/**
 * 审批类型元数据表（单一真源）
 *
 * - 计算键（['run_command']）：键是协议值（zod schema 字面量）而非命名，必须逐字符
 *   一致；计算键形式绕开 useNamingConvention 的对象键 camelCase 强制（实测引号键
 *   同样被拒，仅计算键与 Map 可行，前者保留 satisfies 编译期穷尽性故胜出）
 * - satisfies Record<ApprovalType, ApprovalMeta>：ApprovalType 新增成员而未登记
 *   元数据时编译直接失败——穷尽性由类型系统保证而非运行时 default 兜底
 */
const APPROVAL_META = {
  ['run_command']: {
    icon: Terminal,
    className: 'bg-amber/15 text-warn',
    dangerous: true,
    canRemember: true,
  },
  ['write_file']: {
    icon: FilePlus,
    className: 'bg-info-blue text-accent-2',
    dangerous: false,
    canRemember: true,
  },
  ['edit_file']: {
    icon: FileEdit,
    className: 'bg-info-blue text-accent-2',
    dangerous: false,
    canRemember: true,
  },
  ['delete_file']: {
    icon: FileX,
    className: 'bg-error-bg text-error',
    dangerous: true,
    canRemember: false,
  },
  ['apply_patch']: {
    icon: FileDiff,
    className: 'bg-info-blue text-accent-2',
    dangerous: false,
    canRemember: false,
  },
  ['install_package']: {
    icon: Package,
    className: 'bg-magenta/15 text-magenta',
    dangerous: true,
    canRemember: false,
  },
  ['external_call']: {
    icon: Globe,
    className: 'bg-accent-2-soft text-accent-2',
    dangerous: false,
    canRemember: false,
  },
  ['git_add']: {
    icon: GitBranch,
    className: 'bg-magenta/15 text-magenta',
    dangerous: false,
    canRemember: false,
  },
  ['git_commit']: {
    icon: GitCommitHorizontal,
    className: 'bg-magenta/15 text-magenta',
    dangerous: false,
    canRemember: false,
  },
  ['git_push']: {
    icon: CloudUpload,
    className: 'bg-magenta/15 text-magenta',
    dangerous: true,
    canRemember: false,
  },
} as const satisfies Record<ApprovalType, ApprovalMeta>;

/** 读取审批类型全量 UI 元数据（唯一查询入口，替代原 4 个平行查询函数） */
export function getApprovalMeta(type: ApprovalType): ApprovalMeta {
  return APPROVAL_META[type];
}
