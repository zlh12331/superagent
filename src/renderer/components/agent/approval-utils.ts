// approval-utils.ts（自 ApprovalDialog 拆分）
// 审批载荷解析与类型元数据（纯函数）
// ──────────────────────────────
// 拆分背景：ApprovalDialog 539 行，纯函数与组件混合，按职责提取
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

/**
 * 按 ApprovalType 获取对应图标
 *
 * 不同审批类型使用不同图标增强视觉辨识：
 * - run_command: Terminal（终端）
 * - write_file: FilePlus（新建文件）
 * - edit_file: FileEdit（编辑文件）
 * - delete_file: FileX（删除文件）
 * - apply_patch: FileDiff（差异补丁）
 * - install_package: Package（安装包）
 * - external_call: Globe（外部调用）
 * - git_add: GitBranch（暂存改动）
 * - git_commit: GitCommitHorizontal（提交）
 * - git_push: CloudUpload（推送到远程）
 *
 * 使用 switch-case 而非对象字面量，避免 snake_case key 触发 useNamingConvention。
 */
export function getIconForType(type: ApprovalType): LucideIcon {
  switch (type) {
    case 'run_command':
      return Terminal;
    case 'write_file':
      return FilePlus;
    case 'edit_file':
      return FileEdit;
    case 'delete_file':
      return FileX;
    case 'apply_patch':
      return FileDiff;
    case 'install_package':
      return Package;
    case 'external_call':
      return Globe;
    case 'git_add':
      return GitBranch;
    case 'git_commit':
      return GitCommitHorizontal;
    case 'git_push':
      return CloudUpload;
  }
}

/**
 * 从 ApprovalType 获取本地化 key（组件内 t(`approval.${key}`) 渲染）
 *
 * 用于 Dialog 标题前缀，让用户一眼看出审批类型。
 * 使用 switch-case 避免对象字面量的 snake_case key 命名冲突。
 */
export function getLabelKeyForType(type: ApprovalType): string {
  switch (type) {
    case 'run_command':
      return 'runCommand';
    case 'write_file':
      return 'writeFile';
    case 'edit_file':
      return 'editFile';
    case 'delete_file':
      return 'deleteFile';
    case 'apply_patch':
      return 'applyPatch';
    case 'install_package':
      return 'installDependency';
    case 'external_call':
      return 'externalCall';
    case 'git_add':
      return 'gitStage';
    case 'git_commit':
      return 'gitCommit';
    case 'git_push':
      return 'gitPush';
  }
}

/**
 * 判断是否为危险审批类型
 *
 * 涉及不可逆操作或影响他人的工具返回 true：
 * - delete_file：删除文件不可逆
 * - run_command：执行命令可能有副作用
 * - install_package：安装依赖影响整个项目
 * - git_push：推送影响远程仓库与他人协作
 *
 * 拒绝按钮使用 destructive variant 以提示风险。
 */
export function isDangerousType(type: ApprovalType): boolean {
  return (
    type === 'delete_file' ||
    type === 'run_command' ||
    type === 'install_package' ||
    type === 'git_push'
  );
}

/**
 * 判断是否支持"记住决策"
 *
 * 仅对有副作用但可重复的工具类型支持记住决策（run_command / write_file / edit_file）。
 * 危险操作（delete_file / install_package / git_push）不提供记住决策，强制每次询问。
 * apply_patch / external_call / git_add / git_commit 因入参差异大或影响仓库状态，也不提供记住决策。
 */
export function canRememberDecision(type: ApprovalType): boolean {
  return type === 'run_command' || type === 'write_file' || type === 'edit_file';
}

/**
 * 渲染结构化工具入参预览
 *
 * 按 ApprovalType 渲染不同的预览卡片：
 * - run_command: 命令文本 + 工作目录 + 超时
 * - write_file: 文件路径 + 写入内容预览（前 500 字符）
 * - edit_file: 文件路径 + oldString / newString diff 预览
 * - git_add / git_commit / git_push: 委托 renderGitPreview
 * - 其他类型: 仅显示 description（已在 DialogDescription 渲染）
 */
