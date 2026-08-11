// src/renderer/components/file-tree/file-icon.tsx
// 文件图标（照搬参考项目 FileIcon：按扩展名匹配图标与颜色）
// ──────────────────────────────────────────────────────────────
// 规则：
// - 文件夹：Folder / FolderOpen（根据 expanded 切换），颜色 --text-faint
// - 文件：按扩展名匹配：
//   .rs → FileCode 橙色
//   .ts/.tsx/.js/.jsx → FileCode 蓝色
//   .json → FileJson 黄色
//   .md → FileText 灰色
//   .toml → FileCog 红色
//   图片类 → Image 绿色
//   默认 → File 灰色
// ──────────────────────────────────────────────────────────────

import type { LucideIcon } from 'lucide-react';
import {
  File,
  FileCode,
  FileCog,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  Image as ImageIcon,
} from 'lucide-react';
import type { ReactElement } from 'react';

interface FileIconProps {
  /** 文件/文件夹名称（含扩展名） */
  readonly name: string;
  /** 是否为文件夹 */
  readonly isFolder: boolean;
  /** 文件夹是否展开（仅 isFolder=true 时有意义） */
  readonly expanded?: boolean;
  /** 图标尺寸（像素），默认 13 */
  readonly size?: number;
}

/** 图标 + 颜色 配对结果 */
interface IconConfig {
  readonly icon: LucideIcon;
  readonly color: string;
}

/** 文件夹图标统一颜色 */
const FOLDER_COLOR = 'var(--text-faint)';

/**
 * 根据扩展名解析文件图标配置。
 *
 * 通过 lastIndexOf('.') 取最后一个 `.` 后的部分作为扩展名，
 * 大小写不敏感（先转小写再匹配）。无扩展名时使用默认图标。
 */
function resolveFileIcon(name: string): IconConfig {
  const lower = name.toLowerCase();
  // 取最后一个 `.` 后的部分作为扩展名
  const dotIndex = lower.lastIndexOf('.');
  const ext = dotIndex >= 0 ? lower.slice(dotIndex + 1) : '';

  switch (ext) {
    case 'rs':
      // 图标语义色 → 现有令牌（双主题自适应）：橙=warn / 蓝=accent-2 / 黄=amber / 灰=muted / 红=error / 绿=success
      return { icon: FileCode, color: 'var(--warn)' };
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
      return { icon: FileCode, color: 'var(--accent-2)' };
    case 'json':
      return { icon: FileJson, color: 'var(--amber)' };
    case 'md':
      return { icon: FileText, color: 'var(--muted-foreground)' };
    case 'toml':
      return { icon: FileCog, color: 'var(--error)' };
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'svg':
      return { icon: ImageIcon, color: 'var(--success)' };
    default:
      return { icon: File, color: 'var(--text-faint)' };
  }
}

/**
 * FileIcon 组件 —— 根据文件名/类型返回对应图标。
 *
 * 图标为纯装饰性（aria-hidden），由父组件提供可访问性标签。
 */
export function FileIcon({
  name,
  isFolder,
  expanded = false,
  size = 13,
}: FileIconProps): ReactElement {
  if (isFolder) {
    const Icon = expanded ? FolderOpen : Folder;
    return (
      <Icon
        width={size}
        height={size}
        strokeWidth={2}
        className="shrink-0"
        style={{ color: FOLDER_COLOR }}
        aria-hidden
      />
    );
  }

  const { icon: Icon, color } = resolveFileIcon(name);
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
