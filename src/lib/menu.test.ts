import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock @tauri-apps/api/menu —— Tauri 菜单 API
// ---------------------------------------------------------------------------
const mockSetAsAppMenu = vi.fn().mockResolvedValue(undefined)
const mockMenu = { setAsAppMenu: mockSetAsAppMenu }
const mockMenuNew = vi.fn().mockResolvedValue(mockMenu)
const mockMenuItemNew = vi.fn().mockResolvedValue({})
const mockSubmenuNew = vi.fn().mockResolvedValue({})
const mockPredefinedMenuItemNew = vi.fn().mockResolvedValue({})

vi.mock('@tauri-apps/api/menu', () => ({
  Menu: { new: mockMenuNew },
  MenuItem: { new: mockMenuItemNew },
  Submenu: { new: mockSubmenuNew },
  PredefinedMenuItem: { new: mockPredefinedMenuItemNew },
}))

// ---------------------------------------------------------------------------
// Mock @/store/dialog-store —— 对话框开关 store
// ---------------------------------------------------------------------------
// handleCheckForUpdates 现在通过 setUpdateOpen(true) 打开 UpdateDialog，
// 不再直接调用 @tauri-apps/plugin-updater 的 check()。
const mockSetUpdateOpen = vi.fn()
vi.mock('@/store/dialog-store', () => ({
  useDialogStore: {
    getState: () => ({
      setUpdateOpen: mockSetUpdateOpen,
    }),
  },
}))

// ---------------------------------------------------------------------------
// Mock @/i18n/config —— 包含 t、on、off 的 i18n 实例
// ---------------------------------------------------------------------------
let languageChangedHandler: (...args: unknown[]) => void = () => undefined
const mockI18n = {
  t: vi.fn((key: string) => key),
  on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    if (event === 'languageChanged') {
      languageChangedHandler = handler
    }
  }),
  off: vi.fn(),
}
vi.mock('@/i18n/config', () => ({
  default: mockI18n,
}))

// ---------------------------------------------------------------------------
// Mock @/store/ui-store —— UI 状态 store
// ---------------------------------------------------------------------------
const mockSetPreferencesOpen = vi.fn()
const mockToggleLeftSidebar = vi.fn()
const mockToggleRightSidebar = vi.fn()

vi.mock('@/store/ui-store', () => ({
  useUIStore: {
    getState: () => ({
      setPreferencesOpen: mockSetPreferencesOpen,
      toggleLeftSidebar: mockToggleLeftSidebar,
      toggleRightSidebar: mockToggleRightSidebar,
    }),
  },
}))

// ---------------------------------------------------------------------------
// Mock @/lib/logger —— 日志工具
// ---------------------------------------------------------------------------
vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

// ---------------------------------------------------------------------------
// Mock @/lib/notifications —— 通知工具
// ---------------------------------------------------------------------------
// createMenuCommandContext.showToast 仍会调用 notifications.*，
// 但 handleCheckForUpdates 已不再走此路径，故无需单独断言。
vi.mock('@/lib/notifications', () => ({
  notifications: {
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}))

// ---------------------------------------------------------------------------
// Mock @/lib/commands/registry —— 菜单动作通过 executeCommand 路由
// ---------------------------------------------------------------------------
const mockExecuteCommand = vi.fn().mockResolvedValue({ success: true })
vi.mock('@/lib/commands/registry', () => ({
  executeCommand: mockExecuteCommand,
}))

// ---------------------------------------------------------------------------
// Stub __APP_VERSION__（通常由 Vite define 提供）
// ---------------------------------------------------------------------------
vi.stubGlobal('__APP_VERSION__', '0.1.0')

// Mock alert —— 全局 alert 函数
const mockAlert = vi.fn()
vi.stubGlobal('alert', mockAlert)

const { logger } = await import('@/lib/logger')
const { buildAppMenu, setupMenuLanguageListener } = await import('./menu')

// ---------------------------------------------------------------------------
// 辅助函数：从 MenuItem.new 调用中提取 action 处理器
// ---------------------------------------------------------------------------
function getAction(id: string): (() => void | Promise<void>) | undefined {
  const call = mockMenuItemNew.mock.calls.find(c => {
    const opts = c[0] as { id?: string } | undefined
    return opts?.id === id
  })
  const opts = call?.[0] as { action?: () => void | Promise<void> } | undefined
  return opts?.action
}

describe('buildAppMenu — 菜单构建', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    mockSetAsAppMenu.mockResolvedValue(undefined)
  })

  describe('正向用例 — 菜单结构', () => {
    it('创建两个子菜单 (app submenu 和 view submenu)', async () => {
      await buildAppMenu()
      expect(mockSubmenuNew).toHaveBeenCalledTimes(2)
    })

    it('创建顶层 Menu 并包含两个子菜单', async () => {
      await buildAppMenu()
      expect(mockMenuNew).toHaveBeenCalledWith({
        items: expect.arrayContaining([expect.any(Object), expect.any(Object)]),
      })
    })

    it('调用 setAsAppMenu 设置应用菜单', async () => {
      await buildAppMenu()
      expect(mockSetAsAppMenu).toHaveBeenCalledTimes(1)
    })

    it('返回创建的 Menu 对象', async () => {
      const result = await buildAppMenu()
      expect(result).toBe(mockMenu)
    })
  })

  describe('正向用例 — 菜单项', () => {
    it('创建 about 菜单项', async () => {
      await buildAppMenu()
      expect(mockMenuItemNew).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'about',
          text: 'menu.about',
        })
      )
    })

    it('创建 check-updates 菜单项', async () => {
      await buildAppMenu()
      expect(mockMenuItemNew).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'check-updates',
          text: 'menu.checkForUpdates',
        })
      )
    })

    it('创建 preferences 菜单项并包含快捷键', async () => {
      await buildAppMenu()
      expect(mockMenuItemNew).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'preferences',
          text: 'menu.preferences',
          accelerator: 'CmdOrCtrl+,',
        })
      )
    })

    it('创建 toggle-left-sidebar 菜单项并包含快捷键', async () => {
      await buildAppMenu()
      expect(mockMenuItemNew).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'toggle-left-sidebar',
          accelerator: 'CmdOrCtrl+1',
        })
      )
    })

    it('创建 toggle-right-sidebar 菜单项并包含快捷键', async () => {
      await buildAppMenu()
      expect(mockMenuItemNew).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'toggle-right-sidebar',
          accelerator: 'CmdOrCtrl+2',
        })
      )
    })
  })

  describe('正向用例 — 预定义菜单项', () => {
    it('创建 Separator 分隔符', async () => {
      await buildAppMenu()
      expect(mockPredefinedMenuItemNew).toHaveBeenCalledWith({
        item: 'Separator',
      })
    })

    it('创建 Hide 菜单项', async () => {
      await buildAppMenu()
      expect(mockPredefinedMenuItemNew).toHaveBeenCalledWith(
        expect.objectContaining({ item: 'Hide' })
      )
    })

    it('创建 HideOthers 菜单项', async () => {
      await buildAppMenu()
      expect(mockPredefinedMenuItemNew).toHaveBeenCalledWith(
        expect.objectContaining({ item: 'HideOthers' })
      )
    })

    it('创建 ShowAll 菜单项', async () => {
      await buildAppMenu()
      expect(mockPredefinedMenuItemNew).toHaveBeenCalledWith(
        expect.objectContaining({ item: 'ShowAll' })
      )
    })

    it('创建 Quit 菜单项', async () => {
      await buildAppMenu()
      expect(mockPredefinedMenuItemNew).toHaveBeenCalledWith(
        expect.objectContaining({ item: 'Quit' })
      )
    })
  })

  describe('正向用例 — i18n 翻译调用', () => {
    it('t 函数被调用时传入 menu.about 键', async () => {
      await buildAppMenu()
      expect(mockI18n.t).toHaveBeenCalledWith('menu.about', {
        appName: 'SuperAgent',
      })
    })

    it('t 函数被调用时传入 menu.view 键', async () => {
      await buildAppMenu()
      expect(mockI18n.t).toHaveBeenCalledWith('menu.view')
    })

    it('t 函数被调用时传入 menu.quit 键', async () => {
      await buildAppMenu()
      expect(mockI18n.t).toHaveBeenCalledWith('menu.quit', {
        appName: 'SuperAgent',
      })
    })
  })

  describe('正向用例 — 日志记录', () => {
    it('成功构建后记录 info 日志', async () => {
      await buildAppMenu()
      expect(logger.info).toHaveBeenCalledWith(
        'Application menu built successfully'
      )
    })
  })

  describe('异常用例 — 构建失败', () => {
    it('Submenu.new 抛出错误时记录 error 日志并重新抛出', async () => {
      const error = new Error('Menu creation failed')
      mockSubmenuNew.mockRejectedValueOnce(error)

      await expect(buildAppMenu()).rejects.toThrow('Menu creation failed')
      expect(logger.error).toHaveBeenCalledWith(
        'Failed to build application menu',
        { error }
      )
    })

    it('setAsAppMenu 失败时抛出错误', async () => {
      mockSetAsAppMenu.mockRejectedValueOnce(new Error('Set menu failed'))
      await expect(buildAppMenu()).rejects.toThrow('Set menu failed')
    })
  })
})

describe('setupMenuLanguageListener — 语言变更监听', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSetAsAppMenu.mockResolvedValue(undefined)
  })

  describe('正向用例 — 注册与注销', () => {
    it('通过 i18n.on 注册 languageChanged 事件处理器', () => {
      setupMenuLanguageListener()
      expect(mockI18n.on).toHaveBeenCalledWith(
        'languageChanged',
        expect.any(Function)
      )
    })

    it('返回一个函数 (unsubscribe)', () => {
      const unsubscribe = setupMenuLanguageListener()
      expect(typeof unsubscribe).toBe('function')
    })

    it('调用返回的函数时通过 i18n.off 注销处理器', () => {
      const unsubscribe = setupMenuLanguageListener()
      unsubscribe()
      expect(mockI18n.off).toHaveBeenCalledWith(
        'languageChanged',
        expect.any(Function)
      )
    })
  })

  describe('正向用例 — 语言变更触发重建', () => {
    it('语言变更时重新构建菜单', async () => {
      setupMenuLanguageListener()
      await languageChangedHandler()
      // buildAppMenu 内部会调用 Menu.new
      expect(mockMenuNew).toHaveBeenCalled()
      expect(logger.info).toHaveBeenCalledWith(
        'Language changed, rebuilding menu'
      )
    })
  })

  describe('异常用例 — 重建失败', () => {
    it('重建菜单失败时记录 error 日志但不抛出', async () => {
      mockSubmenuNew.mockRejectedValueOnce(new Error('Rebuild failed'))
      setupMenuLanguageListener()
      // 不应抛出
      await expect(languageChangedHandler()).resolves.toBeUndefined()
      expect(logger.error).toHaveBeenCalledWith(
        'Failed to rebuild menu on language change',
        { error: expect.any(Error) }
      )
    })
  })
})

describe('菜单 action 处理器', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    mockSetAsAppMenu.mockResolvedValue(undefined)
    // 构建菜单以填充 action 处理器
    await buildAppMenu()
  })

  describe('正向用例 — handleAbout', () => {
    it('点击 About 时调用 alert 显示应用信息', () => {
      const aboutAction = getAction('about')
      expect(aboutAction).toBeDefined()
      aboutAction?.()

      expect(mockAlert).toHaveBeenCalledTimes(1)
      const alertText = mockAlert.mock.calls[0]?.[0] as string
      expect(alertText).toContain('SuperAgent')
      expect(alertText).toContain('0.1.0')
      expect(alertText).toContain('Tauri v2 + React + TypeScript')
    })

    it('点击 About 时记录 info 日志', () => {
      const aboutAction = getAction('about')
      aboutAction?.()

      expect(logger.info).toHaveBeenCalledWith('About menu item clicked')
    })
  })

  describe('正向用例 — handleCheckForUpdates', () => {
    it('点击检查更新时打开 UpdateDialog 弹窗', () => {
      const action = getAction('check-updates')
      expect(action).toBeDefined()
      action?.()

      // 验证通过 dialog-store 触发弹窗打开
      expect(mockSetUpdateOpen).toHaveBeenCalledWith(true)
    })

    it('记录 info 日志', () => {
      const action = getAction('check-updates')
      action?.()

      expect(logger.info).toHaveBeenCalledWith(
        'Check for Updates menu item clicked'
      )
    })
  })

  describe('正向用例 — handleOpenPreferences', () => {
    it('点击 Preferences 时通过命令系统打开偏好设置', () => {
      const action = getAction('preferences')
      expect(action).toBeDefined()
      action?.()

      expect(mockExecuteCommand).toHaveBeenCalledWith(
        'open-preferences',
        expect.anything()
      )
      expect(logger.info).toHaveBeenCalledWith('Preferences menu item clicked')
    })
  })

  describe('正向用例 — handleToggleLeftSidebar', () => {
    it('点击 Toggle Left Sidebar 时通过命令系统切换左侧栏', () => {
      const action = getAction('toggle-left-sidebar')
      expect(action).toBeDefined()
      action?.()

      expect(mockExecuteCommand).toHaveBeenCalledWith(
        'toggle-left-sidebar',
        expect.anything()
      )
      expect(logger.info).toHaveBeenCalledWith(
        'Toggle Left Sidebar menu item clicked'
      )
    })
  })

  describe('正向用例 — handleToggleRightSidebar', () => {
    it('点击 Toggle Right Sidebar 时通过命令系统切换右侧栏', () => {
      const action = getAction('toggle-right-sidebar')
      expect(action).toBeDefined()
      action?.()

      expect(mockExecuteCommand).toHaveBeenCalledWith(
        'toggle-right-sidebar',
        expect.anything()
      )
      expect(logger.info).toHaveBeenCalledWith(
        'Toggle Right Sidebar menu item clicked'
      )
    })
  })
})
