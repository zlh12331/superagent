/**
 * @file 原生右键上下文菜单工具。
 *
 * 使用 Tauri 内置的 Menu API（无需插件）封装三种常用菜单：
 *  - 自定义菜单项；
 *  - 标准编辑菜单（剪切/复制/粘贴/全选）；
 *  - 文本输入菜单（额外含撤销/重做）。
 *
 * 调用方式：在 React 组件的 onContextMenu 事件中调用对应 show* 函数即可。
 */

import { Menu, MenuItem, PredefinedMenuItem } from '@tauri-apps/api/menu'

/**
 * 自定义菜单项描述。
 *
 * 字段说明：
 *  - id           菜单项唯一标识，便于日志与测试定位
 *  - label        显示文本
 *  - accelerator  快捷键，遵循 Tauri 加速键语法（如 'CmdOrCtrl+C'）
 *  - disabled     是否禁用，禁用时灰显但不隐藏
 *  - action       点击回调，省略则该项不可点击
 */
export interface ContextMenuItem {
  id: string
  label: string
  accelerator?: string
  disabled?: boolean
  action?: () => void
}

/**
 * 分隔符条目。仅占位用于视觉分隔，不携带交互。
 */
export interface ContextMenuSeparator {
  type: 'separator'
}

/** 菜单项联合类型，用于 showContextMenu 入参。 */
export type ContextMenuEntry = ContextMenuItem | ContextMenuSeparator

/**
 * 类型守卫：判断条目是否为分隔符。
 *
 * 通过 'type' 字段区分，因为分隔符没有 id/label 等字段。
 */
function isSeparator(item: ContextMenuEntry): item is ContextMenuSeparator {
  return 'type' in item && item.type === 'separator'
}

/**
 * 在当前光标位置弹出自定义右键菜单。
 *
 * 步骤：
 *  1. 通过 Promise.all 并行构造菜单项（Tauri API 返回 Promise）；
 *  2. 分隔符使用 PredefinedMenuItem.new 简化构造；
 *  3. 用 Menu.new 装配后调用 popup() 在光标处显示。
 *
 * @example
 * ```typescript
 * await showContextMenu([
 *   { id: 'copy', label: 'Copy', accelerator: 'CmdOrCtrl+C', action: handleCopy },
 *   { type: 'separator' },
 *   { id: 'delete', label: 'Delete', action: handleDelete },
 * ]);
 * ```
 *
 * @param items 菜单条目数组（按顺序显示）
 */
export async function showContextMenu(
  items: ContextMenuEntry[]
): Promise<void> {
  const menuItems = await Promise.all(
    items.map(async item => {
      if (isSeparator(item)) {
        return PredefinedMenuItem.new({ item: 'Separator' })
      }
      // 条件展开避免 undefined 字段被传入 Tauri（exactOptionalPropertyTypes）
      return MenuItem.new({
        id: item.id,
        text: item.label,
        ...(item.accelerator !== undefined
          ? { accelerator: item.accelerator }
          : {}),
        enabled: !item.disabled,
        ...(item.action !== undefined ? { action: item.action } : {}),
      })
    })
  )

  const menu = await Menu.new({ items: menuItems })
  await menu.popup()
}

/**
 * 构造标准编辑菜单项（剪切/复制/粘贴/分隔符/全选）。
 *
 * 共享给 `showEditContextMenu` 与 `showTextInputContextMenu`，
 * 避免重复构造 PredefinedMenuItem 的样板代码。
 */
async function createEditMenuItems() {
  return [
    await PredefinedMenuItem.new({ item: 'Cut' }),
    await PredefinedMenuItem.new({ item: 'Copy' }),
    await PredefinedMenuItem.new({ item: 'Paste' }),
    await PredefinedMenuItem.new({ item: 'Separator' }),
    await PredefinedMenuItem.new({ item: 'SelectAll' }),
  ]
}

/**
 * 弹出标准编辑菜单（剪切/复制/粘贴/全选）。
 *
 * 使用原生 PredefinedMenuItem，自动与系统剪贴板交互，
 * 无需在前端实现剪贴板逻辑。
 */
export async function showEditContextMenu(): Promise<void> {
  const menu = await Menu.new({
    items: await createEditMenuItems(),
  })
  await menu.popup()
}

/**
 * 显示用于文本输入框的上下文菜单。
 * 在标准编辑操作之外还包含撤销/重做。
 */
export async function showTextInputContextMenu(): Promise<void> {
  const menu = await Menu.new({
    items: [
      await PredefinedMenuItem.new({ item: 'Undo' }),
      await PredefinedMenuItem.new({ item: 'Redo' }),
      await PredefinedMenuItem.new({ item: 'Separator' }),
      ...(await createEditMenuItems()),
    ],
  })
  await menu.popup()
}
