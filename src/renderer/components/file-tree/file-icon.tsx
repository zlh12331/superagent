// src/renderer/components/file-tree/file-icon.tsx
// 文件图标（按扩展名匹配图标与颜色）
// ──────────────────────────────────────────────────────────────
// 用途：搜索结果行（fuzzy-search-dialog）的文件图标——按扩展名给**语义配色**。
//
// 与文件树节点的分工（勿合并）：树节点行用统一的单色 lucide 图标
// （FileTreeNode 直接渲染 `<File>`），强调「层级/结构」而非文件类型；
// 本组件用彩色图标，服务于「在一堆搜索结果里一眼区分文件类型」。两者视觉
// 意图不同，故各自实现是正确的，不是重复。
//
// 规则（扩展名一律经 lib/utils.fileExtension 归一化，口径与语言检测同源）：
//   .rs → FileCode 橙     .ts/.tsx/.js/.jsx → FileCode 蓝
//   .json → FileJson 黄    .md → FileText 灰
//   .toml → FileCog 红     图片类 → Image 绿
//   默认 → File 灰
//
// 已移除（2026-09 file-tree 审计）：isFolder / expanded 两个 prop 及其文件夹
// 分支——生产代码零使用（唯一调用点固定传 isFolder={false}），且该分支重复了
// 文件树既有的 Folder/FolderOpen 渲染。属未被消费的预留能力，按「不留死代码」
// 移除；将来若需要带配色的文件夹图标再按需加回。
// ──────────────────────────────────────────────────────────────

import type { LucideIcon } from 'lucide-react';
import { File, FileCode, FileCog, FileJson, FileText, Image as ImageIcon } from 'lucide-react';
import type { ReactElement } from 'react';
import { fileExtension } from '@/lib/utils';

interface FileIconProps {
  /** 文件名称（含扩展名） */
  readonly name: string;
  /** 图标尺寸（像素），默认 13 */
  readonly size?: number;
}

/** 图标 + 颜色 配对结果 */
interface IconConfig {
  readonly icon: LucideIcon;
  readonly color: string;
}

/** 图标语义色 → 现有令牌（双主题自适应）：橙=warn / 蓝=accent-2 / 黄=amber / 灰=muted / 红=error / 绿=success */
const EXT_ICONS: Readonly<Record<string, IconConfig>> = {
  rs: { icon: FileCode, color: 'var(--warn)' },
  ts: { icon: FileCode, color: 'var(--accent-2)' },
  tsx: { icon: FileCode, color: 'var(--accent-2)' },
  js: { icon: FileCode, color: 'var(--accent-2)' },
  jsx: { icon: FileCode, color: 'var(--accent-2)' },
  json: { icon: FileJson, color: 'var(--amber)' },
  md: { icon: FileText, color: 'var(--muted-foreground)' },
  toml: { icon: FileCog, color: 'var(--error)' },
  png: { icon: ImageIcon, color: 'var(--success)' },
  jpg: { icon: ImageIcon, color: 'var(--success)' },
  jpeg: { icon: ImageIcon, color: 'var(--success)' },
  gif: { icon: ImageIcon, color: 'var(--success)' },
  svg: { icon: ImageIcon, color: 'var(--success)' },
};

/** 未命中扩展名时的默认图标（灰） */
const DEFAULT_ICON: IconConfig = { icon: File, color: 'var(--text-faint)' };

/**
 * FileIcon 组件 —— 根据文件名扩展名返回对应图标与配色。
 *
 * 图标为纯装饰性（aria-hidden），由父组件提供可访问性标签。
 *
 * @param name - 文件名称（含扩展名，大小写不敏感）
 * @param size - 图标尺寸（像素），默认 13
 */
export function FileIcon({ name, size = 13 }: FileIconProps): ReactElement {
  const { icon: Icon, color } = EXT_ICONS[fileExtension(name)] ?? DEFAULT_ICON;
  return (
    <Icon
      width={size}
      height={size}
      strokeWidth={2}
      className="shrink-0"
      style={{ color }}
      aria-hidden
    />
  );
}
