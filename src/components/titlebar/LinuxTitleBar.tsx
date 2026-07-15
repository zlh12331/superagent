import { cn } from '@/lib/utils'
import {
  TitleBarLeftActions,
  TitleBarRightActions,
  TitleBarTitle,
} from './TitleBarContent'

interface LinuxTitleBarProps {
  className?: string | undefined
  title?: string
}

/**
 * Linux 标题栏 / 工具栏。
 *
 * Linux 上使用原生窗口装饰（配置中 decorations: true）。
 * 此组件仅渲染工具栏内容，不包含任何窗口控制按钮。
 * 关闭 / 最小化 / 最大化按钮由原生装饰提供。
 *
 * 工具栏位于原生标题栏下方，包含应用专属的工具栏按钮和标题。
 */
export function LinuxTitleBar({ className, title }: LinuxTitleBarProps) {
  return (
    <div
      className={cn(
        'relative flex h-8 w-full shrink-0 items-center justify-between border-b bg-background',
        className
      )}
    >
      {/* 左侧 - 操作按钮 */}
      <div className="flex items-center pl-2">
        <TitleBarLeftActions />
      </div>

      {/* 居中 - 标题 */}
      <TitleBarTitle title={title} />

      {/* 右侧 - 操作按钮 */}
      <div className="flex items-center pr-2">
        <TitleBarRightActions />
      </div>
    </div>
  )
}
