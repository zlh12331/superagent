'use client'

import * as React from 'react'
import { GripVerticalIcon } from 'lucide-react'
import * as ResizablePrimitive from 'react-resizable-panels'

import { cn } from '@/lib/utils'

function ResizablePanelGroup({
  className,
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.PanelGroup>) {
  return (
    <ResizablePrimitive.PanelGroup
      data-slot="resizable-panel-group"
      className={cn(
        'flex h-full w-full data-[panel-group-direction=vertical]:flex-col',
        className
      )}
      {...props}
    />
  )
}

function ResizablePanel({
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.Panel>) {
  return <ResizablePrimitive.Panel data-slot="resizable-panel" {...props} />
}

function ResizableHandle({
  withHandle,
  className,
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.PanelResizeHandle> & {
  withHandle?: boolean
}) {
  return (
    <ResizablePrimitive.PanelResizeHandle
      data-slot="resizable-handle"
      className={cn(
        // 基础样式：1px 可见竖线（元素本体）+ 居中 4px 不可见 hit area（::after 拓宽抓取范围）
        'bg-border focus-visible:ring-ring relative flex w-px items-center justify-center',
        // ::after 伪元素需 content-[''] 才能渲染（Tailwind 不会自动添加 content，缺则 hit area 失效）
        "after:content-[''] after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2",
        // hover 发光效果（对齐 prototype.html 行 3720-3740 resizer hover 高亮）：
        //   容器背景 8% accent 光晕（原型 .resizer:hover { background: rgba(0,229,199,0.08) }）
        'transition-colors hover:bg-[var(--accent)]/10',
        // 拖拽中状态（对齐原型 .resizer.dragging { background: rgba(0, 229, 199, 0.15) }）：
        //   react-resizable-panels 通过 data-resize-handle-active 属性标识拖拽进行中，
        //   容器背景 15% accent 光晕（比 hover 的 10% 更强，反馈当前正在拖拽）
        'data-[resize-handle-active]:bg-[var(--accent)]/15',
        // 竖线（::after）hover：accent 100% + 宽度 1px→2px + 发光阴影
        //   对齐原型 .resizer:hover::after { background: var(--accent); width: 2px; box-shadow: 0 0 8px rgba(0,229,199,0.5) }
        "after:bg-transparent after:transition-[background-color,width,box-shadow] hover:after:bg-[var(--accent)] hover:after:w-0.5 hover:after:shadow-[0_0_8px_rgba(0,229,199,0.5)]",
        // 竖线（::after）拖拽中：与 hover 相同的 accent 高亮 + 2px 宽度 + 发光阴影
        //   对齐原型 .resizer.dragging::after { background: var(--accent); width: 2px; box-shadow: 0 0 8px rgba(0,229,199,0.5) }
        "data-[resize-handle-active]:after:bg-[var(--accent)] data-[resize-handle-active]:after:w-0.5 data-[resize-handle-active]:after:shadow-[0_0_8px_rgba(0,229,199,0.5)]",
        // focus 可见性
        'focus-visible:ring-1 focus-visible:ring-offset-1 focus-visible:outline-hidden',
        // 垂直方向适配：宽高互换
        'data-[panel-group-direction=vertical]:h-px data-[panel-group-direction=vertical]:w-full',
        'data-[panel-group-direction=vertical]:after:left-0',
        'data-[panel-group-direction=vertical]:after:h-1',
        'data-[panel-group-direction=vertical]:after:w-full',
        'data-[panel-group-direction=vertical]:after:translate-x-0',
        'data-[panel-group-direction=vertical]:after:-translate-y-1/2',
        '[&[data-panel-group-direction=vertical]>div]:rotate-90',
        className
      )}
      {...props}
    >
      {withHandle && (
        <div className="bg-border z-10 flex h-4 w-3 items-center justify-center rounded-xs border">
          <GripVerticalIcon className="size-2.5" />
        </div>
      )}
    </ResizablePrimitive.PanelResizeHandle>
  )
}

export { ResizablePanelGroup, ResizablePanel, ResizableHandle }
