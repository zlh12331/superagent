// src/renderer/components/git/git-status-utils.ts
// Git 文件状态 → 图标/配色/文案 元数据表（单一真源）
// ──────────────────────────────
// 拆分背景：GitPanel 486 行，纯函数与组件混合，按职责提取
//
// 表驱动重构（2026-09-15）：原 getIconForFileStatus / getColorForFileStatus /
// getLabelKeyForFileStatus 三个平行 switch 合并为单表——新增状态从改 3 处降为 1 行；
// satisfies Record 保留编译期穷尽性。文案键对齐协议值（t(`git.${status}`)）零映射。
//
// 图标色与文本色分离（2026-09 file-tree 审计同批）：原单字段 className 同时喂给
// 12px 图标和 9px 状态标签，且 conflicted 里混着 font-semibold（对 SVG 无意义）
// ——一个字段承担两种消费场景，必然在某一侧取错令牌。拆为 iconClassName /
// labelClassName 后：
// - 图标用语义基色（accent-2/success/warn/error），表达"这是什么状态"
// - 标签用 -text 变体（亮色下加深保 4.5:1，见 tokens.css 注释），9px 小字才够清晰
// 同域的 git-panel-parts.tsx 一直用的是 -text 变体，此前两处各写一套。
// ──────────────────────────────

import type { GitFileStatus } from '@code-agent/shared/main';
import type { LucideIcon } from 'lucide-react';
import { AlertCircle, FileEdit, FilePlus, FileQuestion, FileX } from 'lucide-react';

/** 单个 Git 文件状态的全量 UI 元数据 */
interface GitStatusMeta {
  /** 状态图标 */
  readonly icon: LucideIcon;
  /** 图标配色（语义基色） */
  readonly iconClassName: string;
  /** 状态标签配色（-text 对比度变体）与字重 */
  readonly labelClassName: string;
}

/**
 * Git 文件状态元数据表（单一真源）
 *
 * satisfies Record<GitFileStatus['status'], GitStatusMeta>：新增协议状态而未登记
 * 元数据时编译失败——穷尽性由类型系统保证。
 * 文案：i18n 键与协议值一致（git.modified / git.added …），消费 t(`git.${status}`)
 */
const GIT_STATUS_META = {
  modified: {
    icon: FileEdit,
    iconClassName: 'text-warn',
    labelClassName: 'text-warn-text',
  },
  added: {
    icon: FilePlus,
    iconClassName: 'text-success',
    labelClassName: 'text-success-text',
  },
  deleted: {
    icon: FileX,
    iconClassName: 'text-error',
    labelClassName: 'text-error-text',
  },
  renamed: {
    icon: FileEdit,
    iconClassName: 'text-accent-2',
    // accent-2 无 -text 变体；全仓既有用法即以它作文本色（approval-preview 等）
    labelClassName: 'text-accent-2',
  },
  untracked: {
    icon: FileQuestion,
    iconClassName: 'text-muted-foreground',
    labelClassName: 'text-muted-foreground',
  },
  conflicted: {
    icon: AlertCircle,
    iconClassName: 'text-error',
    labelClassName: 'text-error-text font-semibold',
  },
} as const satisfies Record<GitFileStatus['status'], GitStatusMeta>;

/** 读取 Git 文件状态全量 UI 元数据（唯一查询入口，替代原 3 个平行查询函数） */
export function getGitStatusMeta(status: GitFileStatus['status']): GitStatusMeta {
  return GIT_STATUS_META[status];
}
