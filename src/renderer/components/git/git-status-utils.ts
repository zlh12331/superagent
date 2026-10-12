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
