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
  rs: { icon: FileCode, color: 'var(--amber)' },
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
