/**
 * AboutDialog — 关于弹窗（独立弹窗）
 *
 * 参照 prototype.html `#aboutModal`（行 6488-6527）实现：
 * - 独立弹窗，与设置抽屉中的 AboutSettingsPane 并存（后者保留更详细信息）
 * - logo 区：44×44 图标 + "SuperAgent" 名称 + "v0.1.0" 版本
 * - meta 区：发布日期 / 构建 / 运行时
 * - footer：版权元信息 + 关闭按钮
 *
 * 触发入口：侧边栏下拉菜单的"关于"按钮（sdAboutBtn）。
 * 状态管理：useDialogStore.aboutOpen 控制开关。
 *
 * @see src/store/dialog-store.ts — aboutOpen / setAboutOpen
 * @see src/components/preferences/panes/SettingsPanes.tsx — AboutSettingsPane（详细版本，保留）
 */

import { useCallback } from 'react'
import { Info } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useDialogStore, type DialogState } from '@/store/dialog-store'

/**
 * 关于弹窗 meta 信息项
 *
 * 对齐原型 .about-meta-row（行 6506-6519）：
 * - 发布日期 / 构建 / 运行时
 */
interface AboutMetaItem {
  /** 标签（左侧 faint 文本） */
  label: string
  /** 值（右侧 mono 文本） */
  value: string
}

/** 静态 meta 数据 — 与原型保持一致 */
const ABOUT_META: AboutMetaItem[] = [
  { label: '发布日期', value: '2026-07-01' },
  { label: '构建', value: 'codex-rs · stable' },
  { label: '运行时', value: 'Tauri 2.0 · Rust 1.82' },
]

export function AboutDialog() {
  // 弹窗开关状态
  const aboutOpen = useDialogStore((s: DialogState) => s.aboutOpen)
  const setAboutOpen = useDialogStore((s: DialogState) => s.setAboutOpen)

  // 关闭弹窗
  const handleOpenChange = useCallback(
    (open: boolean) => {
      setAboutOpen(open)
    },
    [setAboutOpen]
  )

  return (
    <Dialog open={aboutOpen} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="w-[420px] max-w-[calc(100%-2rem)] gap-0 overflow-hidden p-0"
      >
        {/* Header — accent 图标 + 标题 + 副标题 */}
        <DialogHeader className="flex flex-row items-center gap-2.5 border-b border-[var(--border)] px-4 py-3.5">
          {/* warn-icon 圆角 6px — 对齐原型 border-radius:6px（D-A-008 修复） */}
          <div className="flex h-[22px] w-[22px] items-center justify-center rounded-md bg-[rgba(0,229,199,0.15)] text-[var(--accent)]">
            <Info width={13} height={13} />
          </div>
          <DialogTitle className="text-[14px] font-semibold text-[var(--text)]">
            关于 SuperAgent
          </DialogTitle>
          {/* ml-auto 使副标题右对齐 — 对齐原型 .modal-sub { margin-left: auto } */}
          <span className="ml-auto font-mono text-[11.5px] text-[var(--text-faint)]">
            About
          </span>
        </DialogHeader>

        {/* 无障碍描述 */}
        <DialogDescription className="sr-only">
          查看应用程序版本与构建信息
        </DialogDescription>

        {/* Body — logo 区 + meta 区 */}
        {/* modal-body padding 14px 16px — 对齐原型（D-A-007 修复） */}
        <div className="px-4 py-[14px]">
          {/*
            logo 区 — 对齐原型 .about-logo（行 2952-2961）：
            - 44×44 图标（accent→#00A896 渐变）
            - 应用名称 + 版本号
          */}
          <div className="mb-3 flex items-center gap-3 rounded-[9px] border border-[var(--border)] bg-[var(--bg-elev-2)] p-3">
            <div className="flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-[10px] bg-gradient-to-br from-[var(--accent)] to-[#00A896] font-sans text-[22px] font-bold text-[#001814]">
              C
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[15px] font-semibold text-[var(--text)]">
                SuperAgent
              </div>
              <div className="mt-0.5 font-mono text-[12px] text-[var(--accent)]">
                v0.1.0
              </div>
            </div>
          </div>

          {/*
            meta 区 — 对齐原型 .about-meta（行 2976-2985）：
            - 3 行键值对，每行 label（faint）+ value（mono）
            - 行间 6px 间距
          */}
          <div className="flex flex-col gap-1.5">
            {ABOUT_META.map(item => (
              <div
                key={item.label}
                className="flex items-center justify-between py-1.5 text-[12px]"
              >
                <span className="text-[var(--text-faint)]">{item.label}</span>
                <span className="font-mono text-[11.5px] text-[var(--text)]">
                  {item.value}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Footer — 版权元信息 + 关闭按钮 */}
        <DialogFooter className="flex-row justify-end gap-2 border-t border-[var(--border)] bg-[var(--bg-elev-2)] px-4 py-3">
          {/*
            foot-meta — 对齐原型 .modal-foot .foot-meta（行 6523）：
            展示版权与协议信息，左对齐占满剩余空间。
          */}
          {/* foot-meta — font-size:10.5px 对齐原型（D-A-020 修复） */}
          <span className="mr-auto self-center font-mono text-[10.5px] text-[var(--text-faint)]">
            © 2026 Codex · Apache-2.0
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleOpenChange(false)}
          >
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
