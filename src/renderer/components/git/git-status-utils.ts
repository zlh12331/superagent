// git-status-utils.ts（自 GitPanel 拆分）
// Git 文件状态 → 图标/颜色 元数据表（单一真源）
// ──────────────────────────────
// 拆分背景：GitPanel 486 行，纯函数与组件混合，按职责提取
// 表驱动重构（2026-09-15）：原 getIconForFileStatus / getColorForFileStatus /
// getLabelKeyForFileStatus 三个平行 switch 合并为 GIT_STATUS_META 单表——新增状态
// 从改 3 处降为 1 行；原 switch 无 default 本具编译期穷尽性，satisfies Record
// 无损继承。文案键对齐协议值（git.<status>）删除 labelKey 映射，消费
// t(`git.${status}`) 零映射。协议值本身是 camelCase，与 biome 对象键规范相容，
// 无需 approval 域的计算键方案
// ──────────────────────────────

import type { GitFileStatus } from '@code-agent/shared/main';
import type { LucideIcon } from 'lucide-react';
import { AlertCircle, FileEdit, FilePlus, FileQuestion, FileX } from 'lucide-react';

/** 单个 Git 文件状态的全量 UI 元数据 */
interface GitStatusMeta {
  /** 状态图标 */
  readonly icon: LucideIcon;
  /** 状态颜色语义类 */
  readonly className: string;
}

/**
 * Git 文件状态元数据表（单一真源）
 *
 * satisfies Record<GitFileStatus['status'], GitStatusMeta>：新增协议状态而未登记
 * 元数据时编译失败——穷尽性由类型系统保证。
 * 文案：i18n 键与协议值一致（git.modified / git.added …），消费 t(`git.${status}`)
 */
const GIT_STATUS_META = {
  modified: { icon: FileEdit, className: 'text-warn' },
  added: { icon: FilePlus, className: 'text-success' },
  deleted: { icon: FileX, className: 'text-error' },
  renamed: { icon: FileEdit, className: 'text-accent-2' },
  untracked: { icon: FileQuestion, className: 'text-muted-foreground' },
  conflicted: { icon: AlertCircle, className: 'text-error font-semibold' },
} as const satisfies Record<GitFileStatus['status'], GitStatusMeta>;

/** 读取 Git 文件状态全量 UI 元数据（唯一查询入口，替代原 3 个平行查询函数） */
export function getGitStatusMeta(status: GitFileStatus['status']): GitStatusMeta {
  return GIT_STATUS_META[status];
}
