// src/renderer/components/settings/settings-controls.tsx
// 设置分区通用控件集（对齐参考项目 superagent SettingsControls + 原型 .setting-row）
// ──────────────────────────────────────────────────────────────
// 提供 5 个布局控件：
// - SectionTitle  — 分区小标题（uppercase + letter-spacing）
// - SettingRow    — 水平设置行（label 在左，控件在右，卡片底）
// - ToggleRow     — 开关行（右侧 Switch）
// - SegControl    — 分段控件（互斥选项切换，原型 .seg-control）
// - SettingField  — 垂直堆叠设置字段（label 在上，控件在下）
// ──────────────────────────────────────────────────────────────

import type { ReactElement, ReactNode } from 'react';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';

/** 分区小标题 props */
export interface SectionTitleProps {
  readonly children: ReactNode;
  readonly className?: string;
}

/**
 * 分区小标题
 *
 * uppercase + tracking 拉开与正文的层级；首项 mt-0 避免顶部多余间距。
 */
export function SectionTitle({ children, className }: SectionTitleProps): ReactElement {
  return (
    <h4
      className={cn(
        'text-muted-foreground mt-[18px] mb-2.5 text-xs font-semibold tracking-[0.12em] uppercase first:mt-0',
        className,
      )}
    >
      {children}
    </h4>
  );
}

/** 水平设置行 props */
export interface SettingRowProps {
  /** 行标签（左侧主文字） */
  readonly label: string;
  /** 可选描述（label 下方，次级色） */
  readonly description?: string;
  /** 右侧控件 */
  readonly children: ReactNode;
  readonly className?: string;
}

/**
 * 水平设置行
 *
 * 左 label + 可选 description（flex-1），右控件（shrink-0）。
 * 卡片视觉：圆角 + 边框 + 浅底色（对齐原型 .setting-row）。
 */
export function SettingRow({
  label,
  description,
  children,
  className,
}: SettingRowProps): ReactElement {
  return (
    <div
      className={cn('bg-card flex items-center gap-2.5 rounded-lg border px-3 py-2.5', className)}
    >
      <div className="min-w-0 flex-1">
        <div className="text-foreground text-sm">{label}</div>
        {description !== undefined && (
          <p className="text-muted-foreground mt-0.5 text-xs leading-[1.5]">{description}</p>
        )}
      </div>
      {/* shrink：允许控件区随容器收缩（SegControl 等可折行控件需要宽度约束） */}
      <div className="min-w-0 shrink">{children}</div>
    </div>
  );
}

/** 开关行 props */
export interface ToggleRowProps {
  /** 开关名称（行 label） */
  readonly name: string;
  /** 可选描述 */
  readonly description?: string;
  /** 开关状态 */
  readonly checked: boolean;
  /** 切换回调 */
  readonly onChange: (checked: boolean) => void;
  readonly className?: string;
}

/**
 * 开关行（右侧 Switch，对齐原型 .toggle-row）
 */
export function ToggleRow({
  name,
  description,
  checked,
  onChange,
  className,
}: ToggleRowProps): ReactElement {
  return (
    <SettingRow
      label={name}
      {...(description !== undefined ? { description } : {})}
      className={cn('py-[11px]', className)}
    >
      <Switch checked={checked} onCheckedChange={onChange} aria-label={name} />
    </SettingRow>
  );
}

/** 分段选项 */
export interface SegOption {
  /** 选项值（存储用） */
  readonly value: string;
  /** 选项显示文本 */
  readonly label: string;
}

/** 分段控件 props */
export interface SegControlProps {
  /** 当前选中值 */
  readonly value: string;
  /** 可选选项 */
  readonly options: readonly SegOption[];
  /** 变更回调 */
  readonly onChange: (value: string) => void;
  readonly className?: string;
}

/**
 * 分段控件（互斥选项，对齐原型 .seg-control）
 *
 * 选中项 accent 底 + 深色文字，未选中浅底 + 次级文字。
 * 2026-09 迁移到 Radix ToggleGroup：获得方向键切换/roving tabindex/
 * ARIA toggle 语义（此前手写 aria-pressed 无 roving 导航）。
 */
export function SegControl({ value, options, onChange, className }: SegControlProps): ReactElement {
  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={onChange}
      className={cn(
        'flex min-w-0 flex-wrap gap-0 overflow-hidden rounded-md border border-border',
        className,
      )}
    >
      {options.map((opt) => (
        <ToggleGroupItem key={opt.value} value={opt.value} className="shrink px-[11px] py-1">
          {opt.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
