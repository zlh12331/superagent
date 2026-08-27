// src/renderer/components/ui/dropdown-menu.tsx
// 下拉菜单组件（shadcn/ui new-york 风格，基于 @radix-ui/react-dropdown-menu）
// 设计文档 §2.3 shadcn/ui 组件库

import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import { CheckIcon, ChevronRightIcon, CircleIcon } from 'lucide-react';
import type * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * 下拉菜单根容器
 *
 * 包装 Radix DropdownMenu Primitive，负责管理开关状态。
 * 通过 open / onOpenChange 受控或 defaultOpen 非受控。
 * ──────────────────────────────
 * 变体：Item 支持 data-[variant=destructive]；Content 可组合子项/分隔/子菜单
 * 状态：受控（open + onOpenChange）| 非受控（defaultOpen）
 * 依赖：@radix-ui/react-dropdown-menu
 * 可访问性：Radix 内置全键盘导航/方向键/ARIA menu 角色；14 个导出覆盖完整菜单形态
 * ──────────────────────────────
 */
export function DropdownMenu(
  props: React.ComponentProps<typeof DropdownMenuPrimitive.Root>,
): React.ReactElement {
  return <DropdownMenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}

/**
 * 下拉菜单触发器
 *
 * 通常包裹一个按钮，点击后展开菜单。
 */
export function DropdownMenuTrigger(
  props: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>,
): React.ReactElement {
  return <DropdownMenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}

/**
 * 下拉菜单传送门
 *
 * 把菜单内容渲染到 body 末尾，避免被父级 overflow / transform 影响。
 */
export function DropdownMenuPortal(
  props: React.ComponentProps<typeof DropdownMenuPrimitive.Portal>,
): React.ReactElement {
  return <DropdownMenuPrimitive.Portal data-slot="dropdown-menu-portal" {...props} />;
}

/**
 * 下拉菜单主体内容
 *
 * 包含所有菜单项的浮动面板。
 * 自带 Esc 关闭、点击外部关闭、焦点陷阱等无障碍行为。
 */
export function DropdownMenuContent({
  className,
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>): React.ReactElement {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        data-slot="dropdown-menu-content"
        sideOffset={sideOffset}
        className={cn(
          'bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-popover max-h-(--radix-dropdown-menu-content-available-height) min-w-[8rem] origin-(--radix-dropdown-menu-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-md border p-1 shadow-md',
          className,
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

/**
 * 下拉菜单分组
 *
 * 把若干菜单项归为一组，便于配合 DropdownMenuLabel 使用。
 */
export function DropdownMenuGroup(
  props: React.ComponentProps<typeof DropdownMenuPrimitive.Group>,
): React.ReactElement {
  return <DropdownMenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />;
}

/**
 * 子菜单
 *
 * 嵌套的下拉菜单。其内部需要配 SubTrigger 与 SubContent。
 */
export function DropdownMenuSub(
  props: React.ComponentProps<typeof DropdownMenuPrimitive.Sub>,
): React.ReactElement {
  return <DropdownMenuPrimitive.Sub data-slot="dropdown-menu-sub" {...props} />;
}

/**
 * 子菜单触发器
 *
 * 鼠标 hover 或聚焦时展开对应的 SubContent。
 * 右侧带 ChevronRightIcon 指示。
 */
export function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubTrigger> & {
  inset?: boolean;
}): React.ReactElement {
  return (
    <DropdownMenuPrimitive.SubTrigger
      data-slot="dropdown-menu-sub-trigger"
      data-inset={inset}
      className={cn(
        'focus:bg-accent focus:text-accent-foreground data-[state=open]:bg-accent data-[state=open]:text-accent-foreground flex cursor-default items-center rounded-sm px-2 py-1.5 text-sm outline-none select-none data-[inset]:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*="size-"])]:size-4',
        className,
      )}
      {...props}
    >
      {children}
      <ChevronRightIcon className="ml-auto" />
    </DropdownMenuPrimitive.SubTrigger>
  );
}

/**
 * 子菜单内容
 *
 * 二级菜单的浮动面板，样式与一级 Content 一致。
 */
export function DropdownMenuSubContent({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubContent>): React.ReactElement {
  return (
    <DropdownMenuPrimitive.SubContent
      data-slot="dropdown-menu-sub-content"
      className={cn(
        'bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-popover min-w-[8rem] origin-(--radix-dropdown-menu-content-transform-origin) overflow-hidden rounded-md border p-1 shadow-lg',
        className,
      )}
      {...props}
    />
  );
}

/**
 * 单选项分组
 *
 * 内部所有 DropdownMenuRadioItem 共享一个 value。
 */
export function DropdownMenuRadioGroup(
  props: React.ComponentProps<typeof DropdownMenuPrimitive.RadioGroup>,
): React.ReactElement {
  return <DropdownMenuPrimitive.RadioGroup data-slot="dropdown-menu-radio-group" {...props} />;
}

/**
 * 普通菜单项
 *
 * 可点击执行一个动作。
 * 通过 inset 属性可缩进以对齐带图标的菜单项；
 * 通过 variant="destructive" 可展示为危险操作（红色）。
 *
 * @example
 * <DropdownMenuItem onClick={handleSave}>保存</DropdownMenuItem>
 * <DropdownMenuItem variant="destructive">删除</DropdownMenuItem>
 */
export function DropdownMenuItem({
  className,
  inset,
  variant = 'default',
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & {
  inset?: boolean;
  variant?: 'default' | 'destructive';
}): React.ReactElement {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        // 纯语义令牌（对齐 shadcn 铁律：无手动 dark: 覆盖）——destructive 焦点态统一 /10 令牌
        "focus:bg-accent focus:text-accent-foreground data-[variant=destructive]:text-error-text data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-error-text [&_svg:not([class*='text-'])]:text-muted-foreground relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[inset]:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  );
}

/**
 * 复选菜单项
 *
 * 在左侧显示勾选状态，点击切换 checked。
 * 通过 checked / onCheckedChange 受控。
 *
 * 注意：不显式解构 checked，避免 exactOptionalPropertyTypes 下
 * `checked: CheckedState | undefined` 不能赋给必填 `checked: CheckedState`。
 * checked 由 props 透传给底层 Radix 组件。
 */
export function DropdownMenuCheckboxItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>): React.ReactElement {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      className={cn(
        'focus:bg-accent focus:text-accent-foreground relative flex cursor-default items-center gap-2 rounded-sm py-1.5 pr-2 pl-8 text-sm outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*="size-"])]:size-4',
        className,
      )}
      {...props}
    >
      <span className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <CheckIcon />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  );
}

/**
 * 单选菜单项
 *
 * 配合 DropdownMenuRadioGroup 使用，同组内仅一项被选中。
 * 通过圆点指示器表示当前选中项。
 */
export function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem>): React.ReactElement {
  return (
    <DropdownMenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      className={cn(
        'focus:bg-accent focus:text-accent-foreground relative flex cursor-default items-center gap-2 rounded-sm py-1.5 pr-2 pl-8 text-sm outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*="size-"])]:size-4',
        className,
      )}
      {...props}
    >
      <span className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <CircleIcon className="size-2 fill-current" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  );
}

/**
 * 菜单标签
 *
 * 给一组菜单项加一个不可点击的标题（如「账户」「设置」）。
 */
export function DropdownMenuLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Label> & {
  inset?: boolean;
}): React.ReactElement {
  return (
    <DropdownMenuPrimitive.Label
      data-slot="dropdown-menu-label"
      data-inset={inset}
      className={cn('px-2 py-1.5 text-sm font-medium data-[inset]:pl-8', className)}
      {...props}
    />
  );
}

/**
 * 菜单分隔线
 *
 * 在视觉上把不同分组的菜单项分隔开。
 */
export function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>): React.ReactElement {
  return (
    <DropdownMenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn('bg-border -mx-1 my-1 h-px', className)}
      {...props}
    />
  );
}

/**
 * 菜单快捷键
 *
 * 在菜单项右侧显示快捷键文本（如 ⌘S），仅作展示用。
 */
export function DropdownMenuShortcut({
  className,
  ...props
}: React.ComponentProps<'span'>): React.ReactElement {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cn('text-muted-foreground ml-auto text-xs tracking-widest', className)}
      {...props}
    />
  );
}
