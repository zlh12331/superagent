import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock Tauri 菜单 API
const mockPopup = vi.fn().mockResolvedValue(undefined)
const mockMenuNew = vi.fn().mockResolvedValue({ popup: mockPopup })
const mockMenuItemNew = vi.fn().mockResolvedValue({})
const mockPredefinedMenuItemNew = vi.fn().mockResolvedValue({})

vi.mock('@tauri-apps/api/menu', () => ({
  Menu: {
    new: mockMenuNew,
  },
  MenuItem: {
    new: mockMenuItemNew,
  },
  PredefinedMenuItem: {
    new: mockPredefinedMenuItemNew,
  },
}))

describe('context-menu utilities', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should export all utility functions', async () => {
    const module = await import('./context-menu')
    expect(module.showContextMenu).toBeDefined()
    expect(module.showEditContextMenu).toBeDefined()
    expect(module.showTextInputContextMenu).toBeDefined()
  })

  it('showContextMenu should create menu items and show popup', async () => {
    const { showContextMenu } = await import('./context-menu')

    const action = vi.fn()
    await showContextMenu([
      { id: 'test', label: 'Test Item', action },
      { type: 'separator' },
      { id: 'disabled', label: 'Disabled', disabled: true },
      { id: 'shortcut', label: 'With Shortcut', accelerator: 'CmdOrCtrl+K' },
    ])

    // 应为常规项创建 MenuItem
    expect(mockMenuItemNew).toHaveBeenCalledWith({
      id: 'test',
      text: 'Test Item',
      accelerator: undefined,
      enabled: true,
      action,
    })

    // 应为分隔符创建 PredefinedMenuItem
    expect(mockPredefinedMenuItemNew).toHaveBeenCalledWith({
      item: 'Separator',
    })

    // 应创建禁用的 MenuItem
    expect(mockMenuItemNew).toHaveBeenCalledWith({
      id: 'disabled',
      text: 'Disabled',
      accelerator: undefined,
      enabled: false,
      action: undefined,
    })

    // 应透传 accelerator（快捷键）
    expect(mockMenuItemNew).toHaveBeenCalledWith({
      id: 'shortcut',
      text: 'With Shortcut',
      accelerator: 'CmdOrCtrl+K',
      enabled: true,
      action: undefined,
    })

    // 应创建菜单并显示弹出
    expect(mockMenuNew).toHaveBeenCalled()
    expect(mockPopup).toHaveBeenCalled()
  })

  it('showEditContextMenu should create standard edit menu', async () => {
    const { showEditContextMenu } = await import('./context-menu')

    await showEditContextMenu()

    // 应创建 Cut、Copy、Paste、Separator、SelectAll
    expect(mockPredefinedMenuItemNew).toHaveBeenCalledWith({ item: 'Cut' })
    expect(mockPredefinedMenuItemNew).toHaveBeenCalledWith({ item: 'Copy' })
    expect(mockPredefinedMenuItemNew).toHaveBeenCalledWith({ item: 'Paste' })
    expect(mockPredefinedMenuItemNew).toHaveBeenCalledWith({
      item: 'Separator',
    })
    expect(mockPredefinedMenuItemNew).toHaveBeenCalledWith({
      item: 'SelectAll',
    })
    expect(mockPopup).toHaveBeenCalled()
  })

  it('showTextInputContextMenu should include Undo/Redo', async () => {
    const { showTextInputContextMenu } = await import('./context-menu')

    await showTextInputContextMenu()

    // 应包含 Undo 和 Redo
    expect(mockPredefinedMenuItemNew).toHaveBeenCalledWith({ item: 'Undo' })
    expect(mockPredefinedMenuItemNew).toHaveBeenCalledWith({ item: 'Redo' })
    expect(mockPopup).toHaveBeenCalled()
  })
})
