/**
 * FileIcon — 根据文件名/类型返回对应图标的展示组件
 *
 * 规则：
 * - 文件夹：Folder / FolderOpen（根据 expanded 切换），颜色 --text-faint
 * - 文件：按扩展名匹配：
 *   .rs → FileCode 橙色
 *   .ts/.tsx/.js/.jsx → FileCode 蓝色
 *   .json → FileJson 黄色
 *   .md → FileText 灰色
 *   .toml → FileCog 红色
 *   图片类 → Image 绿色
 *   默认 → File 灰色
 */

import {
  File,
  FileCode,
  FileCog,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  Image as ImageIcon,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

interface FileIconProps {
  /** 文件/文件夹名称（含扩展名） */
  name: string
  /** 是否为文件夹 */
  isFolder: boolean
  /** 文件夹是否展开（仅 isFolder=true 时有意义） */
  expanded?: boolean
  /** 图标尺寸（像素），默认 13 */
  size?: number
}

/** 图标 + 颜色 配对结果 */
interface IconConfig {
  Icon: LucideIcon
  color: string
}

/** 文件夹图标统一颜色 */
const FOLDER_COLOR = 'var(--text-faint)'

/**
 * 根据扩展名解析文件图标配置。
 *
 * 通过 lastIndexOf('.') 取最后一个 `.` 后的部分作为扩展名，
 * 大小写不敏感（先转小写再匹配）。无扩展名时使用默认图标。
 *
 * @param name — 文件名（含扩展名）
 * @returns 包含图标组件与颜色的 IconConfig
 *
 * @example
 * resolveFileIcon('main.rs')        // → { Icon: FileCode, color: '#f97316' }
 * resolveFileIcon('README.md')     // → { Icon: FileText,  color: '#94a3b8' }
 * resolveFileIcon('unknown.xyz')   // → { Icon: File,      color: 'var(--text-faint)' }
 */
function resolveFileIcon(name: string): IconConfig {
  const lower = name.toLowerCase()
  // 取最后一个 `.` 后的部分作为扩展名
  const dotIndex = lower.lastIndexOf('.')
  const ext = dotIndex >= 0 ? lower.slice(dotIndex + 1) : ''

  switch (ext) {
    case 'rs':
      return { Icon: FileCode, color: '#f97316' }
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
      return { Icon: FileCode, color: '#3b82f6' }
    case 'json':
      return { Icon: FileJson, color: '#eab308' }
    case 'md':
      return { Icon: FileText, color: '#94a3b8' }
    case 'toml':
      return { Icon: FileCog, color: '#ef4444' }
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'svg':
      return { Icon: ImageIcon, color: '#22c55e' }
    default:
      return { Icon: File, color: 'var(--text-faint)' }
  }
}

/**
 * FileIcon 组件 —— 根据文件名/类型返回对应图标。
 *
 * 渲染逻辑：
 *  - 文件夹：根据 expanded 切换 Folder / FolderOpen 图标，统一使用 --text-faint 色
 *  - 文件：调用 resolveFileIcon 按扩展名匹配图标与颜色
 *
 * 图标为纯装饰性（`aria-hidden`），由父组件提供可访问性标签。
 *
 * @param props —— 见 FileIconProps 接口
 */
export function FileIcon({
  name,
  isFolder,
  expanded = false,
  size = 13,
}: FileIconProps) {
  if (isFolder) {
    const Icon = expanded ? FolderOpen : Folder
    return (
      <Icon
        width={size}
        height={size}
        strokeWidth={2}
        className="shrink-0"
        style={{ color: FOLDER_COLOR }}
        aria-hidden
      />
    )
  }

  const { Icon, color } = resolveFileIcon(name)
  return (
    <Icon
      width={size}
      height={size}
      strokeWidth={2}
      className="shrink-0"
      style={{ color }}
      aria-hidden
    />
  )
}
