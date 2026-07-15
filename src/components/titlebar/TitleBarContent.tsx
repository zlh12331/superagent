import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { useSidebarStore, type SidebarState } from '@/store/sidebar-store'
import { executeCommand } from '@/lib/commands'
import { useCommandContext } from '@/hooks/use-command-context'
import {
  PanelLeft,
  PanelLeftClose,
  PanelRight,
  PanelRightClose,
  Settings,
} from 'lucide-react'

/**
 * 左侧工具栏操作（侧栏开关）。
 * macOS 上放在窗口控制按钮之后，Windows/Linux 上放在最前。
 */
export function TitleBarLeftActions() {
  const { t } = useTranslation()
  const leftSidebarVisible = useSidebarStore(
    (state: SidebarState) => state.leftSidebarVisible
  )
  const toggleLeftSidebar = useSidebarStore(
    (state: SidebarState) => state.toggleLeftSidebar
  )

  return (
    <div className="flex items-center gap-1">
      <Button
        onClick={toggleLeftSidebar}
        variant="ghost"
        size="icon"
        className="h-6 w-6 text-foreground/70 hover:text-foreground"
        title={t(
          leftSidebarVisible
            ? 'titlebar.hideLeftSidebar'
            : 'titlebar.showLeftSidebar'
        )}
      >
        {leftSidebarVisible ? (
          <PanelLeftClose className="h-3 w-3" />
        ) : (
          <PanelLeft className="h-3 w-3" />
        )}
      </Button>
    </div>
  )
}

/**
 * 右侧工具栏操作（设置、侧栏开关）。
 * Windows 上放在窗口控制按钮之前，macOS/Linux 上放在末尾。
 */
export function TitleBarRightActions() {
  const { t } = useTranslation()
  const rightSidebarVisible = useSidebarStore(
    (state: SidebarState) => state.rightSidebarVisible
  )
  const toggleRightSidebar = useSidebarStore(
    (state: SidebarState) => state.toggleRightSidebar
  )
  const commandContext = useCommandContext()

  const handleOpenPreferences = async () => {
    const result = await executeCommand('open-preferences', commandContext)
    if (!result.success && result.error) {
      commandContext.showToast(result.error, 'error')
    }
  }

  return (
    <div className="flex items-center gap-1">
      <Button
        onClick={handleOpenPreferences}
        variant="ghost"
        size="icon"
        className="h-6 w-6 text-foreground/70 hover:text-foreground"
        title={t('titlebar.settings')}
      >
        <Settings className="h-3 w-3" />
      </Button>

      <Button
        onClick={toggleRightSidebar}
        variant="ghost"
        size="icon"
        className="h-6 w-6 text-foreground/70 hover:text-foreground"
        title={t(
          rightSidebarVisible
            ? 'titlebar.hideRightSidebar'
            : 'titlebar.showRightSidebar'
        )}
      >
        {rightSidebarVisible ? (
          <PanelRightClose className="h-3 w-3" />
        ) : (
          <PanelRight className="h-3 w-3" />
        )}
      </Button>
    </div>
  )
}

interface TitleBarTitleProps {
  title?: string | undefined
}

/**
 * 标题栏居中标题。
 * 使用绝对定位，无论其他内容如何变化都保持居中。
 */
export function TitleBarTitle({ title = 'Tauri App' }: TitleBarTitleProps) {
  return (
    <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
      <span className="text-sm font-medium text-foreground/80">{title}</span>
    </div>
  )
}

/**
 * 用于简单布局的合并工具栏内容。
 * Linux 场景或需要将所有工具栏项放在同一 fragment 中时使用。
 *
 * 如需更细粒度的控制，可分别使用 TitleBarLeftActions、TitleBarRightActions 和 TitleBarTitle。
 */
export function TitleBarContent({ title = 'Tauri App' }: TitleBarTitleProps) {
  return (
    <>
      <TitleBarLeftActions />
      <TitleBarTitle title={title} />
      <TitleBarRightActions />
    </>
  )
}
