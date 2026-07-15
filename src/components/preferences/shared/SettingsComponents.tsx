/**
 * SettingsComponents — 设置分区共用布局组件。
 *
 * 提供两个基础布局组件，被生产版本的 Pane 组件（GeneralPane / AppearancePane /
 * AdvancedPane / ApiConfigForm）使用：
 *  - SettingsField：垂直堆叠的字段（label 在上，控件在下，可选描述）
 *  - SettingsSection：带标题与分隔线的分区容器
 *
 * 注意：此文件与 SettingsControls.tsx 不同。SettingsControls 提供更细粒度的
 * 控件（SectionTitle / SettingRow / ToggleRow / SegControl / SettingField），
 * 主要被 mock 版本的 SettingsPanes.tsx 使用。本文件中的组件使用 shadcn/ui
 * 的 Label 和 Separator，样式更接近生产版本的设计规范。
 *
 * @see src/components/preferences/shared/SettingsControls.tsx — mock 版本控件
 */

import type { ReactNode } from 'react'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'

/** SettingsField 组件的 props */
interface SettingsFieldProps {
  /** 字段标签文本 */
  label: string
  /** 字段控件（Input / Select / Switch 等） */
  children: ReactNode
  /** 可选的字段描述文字（显示在控件下方，使用 muted-foreground 色） */
  description?: string
}

/** SettingsSection 组件的 props */
interface SettingsSectionProps {
  /** 分区标题 */
  title: string
  /** 分区内容 */
  children: ReactNode
}

/**
 * SettingsField 组件 —— 垂直堆叠的设置字段。
 *
 * 布局结构：
 *  - 顶部 Label（text-sm font-medium）
 *  - 中间 children（控件）
 *  - 底部可选 description（text-sm text-muted-foreground）
 *
 * 使用场景：生产版本的 Pane 组件中，作为单个设置项的容器。
 *
 * @example
 * <SettingsField label="API Key" description="用于认证的密钥">
 *   <Input type="password" />
 * </SettingsField>
 */
export function SettingsField({
  label,
  children,
  description,
}: SettingsFieldProps) {
  return (
    <div className="space-y-2">
      <Label className="text-sm font-medium text-foreground">{label}</Label>
      {children}
      {description && (
        <p className="text-sm text-muted-foreground">{description}</p>
      )}
    </div>
  )
}

/**
 * SettingsSection 组件 —— 带标题与分隔线的分区容器。
 *
 * 布局结构：
 *  - 顶部标题（text-lg font-medium）+ Separator 分隔线
 *  - 下方 children 内容区（space-y-4 垂直间距）
 *
 * 使用场景：生产版本的 Pane 组件中，用于将相关设置项分组。
 *
 * @example
 * <SettingsSection title="键盘快捷键">
 *   <SettingsField label="快速面板">
 *     <ShortcutPicker />
 *   </SettingsField>
 * </SettingsSection>
 */
export function SettingsSection({ title, children }: SettingsSectionProps) {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-medium text-foreground">{title}</h3>
        <Separator className="mt-2" />
      </div>
      <div className="space-y-4">{children}</div>
    </div>
  )
}
