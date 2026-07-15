/**
 * SettingsControls — 共用设置控件
 *
 * 参照 prototype.html 的控件样式：
 * - SegControl  ← .seg-control / .seg-btn (行 3063-3083)
 * - ToggleRow   ← .toggle-row / .toggle-switch (行 2917-2949)
 * - SettingRow  ← .setting-row (行 3051-3061)
 * - SectionTitle ← .settings-section-title (行 2751-2760)
 */

import type { ReactNode } from 'react'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'

// ─── SectionTitle ───────────────────────────────────────────────

interface SectionTitleProps {
  children: ReactNode
  className?: string
}

/** 分区小标题 — uppercase + letter-spacing */
export function SectionTitle({ children, className }: SectionTitleProps) {
  return (
    <h4
      className={cn(
        'mt-[18px] mb-2.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--text-faint)] first:mt-0',
        className
      )}
    >
      {children}
    </h4>
  )
}

// ─── SettingRow ─────────────────────────────────────────────────

interface SettingRowProps {
  label: string
  description?: string
  children: ReactNode
  className?: string
}

/** 水平设置行 — label 在左，控件在右 */
export function SettingRow({
  label,
  description,
  children,
  className,
}: SettingRowProps) {
  return (
    <div
      className={cn(
        'flex items-center gap-2.5 rounded-[9px] border border-[var(--border)] bg-[var(--bg-elev-2)] px-3 py-2.5',
        className
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] text-[var(--text)]">{label}</div>
        {description && (
          <p className="mt-0.5 text-[11px] leading-[1.5] text-[var(--text-faint)]">
            {description}
          </p>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

// ─── ToggleRow ──────────────────────────────────────────────────

interface ToggleRowProps {
  name: string
  description?: string
  checked: boolean
  onChange: (checked: boolean) => void
  className?: string
}

/** 开关行 — name + desc 在左，Switch 在右 */
export function ToggleRow({
  name,
  description,
  checked,
  onChange,
  className,
}: ToggleRowProps) {
  // D-B-011: ToggleRow 垂直 padding 为 11px（对齐原型 .toggle-row { padding: 11px 12px }）
  // 通过 cn 合并：内部默认 py-[11px] 覆盖 SettingRow 的 py-2.5，外部 className 可进一步覆盖
  const rowProps: SettingRowProps = {
    label: name,
    children: <Switch checked={checked} onCheckedChange={onChange} />,
    className: cn('py-[11px]', className),
  }
  if (description !== undefined) rowProps.description = description
  return <SettingRow {...rowProps} />
}

// ─── SegControl ─────────────────────────────────────────────────

interface SegOption {
  value: string
  label: string
}

interface SegControlProps {
  value: string
  options: SegOption[]
  onChange: (value: string) => void
  className?: string
}

/** 分段控件 — .seg-control / .seg-btn */
export function SegControl({
  value,
  options,
  onChange,
  className,
}: SegControlProps) {
  return (
    <div
      className={cn(
        'flex overflow-hidden rounded-md border border-[var(--border-strong)]',
        className
      )}
    >
      {options.map(opt => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={cn(
            'cursor-pointer border-none px-[11px] py-1 font-mono text-[11px] transition-colors',
            value === opt.value
              ? 'bg-[var(--accent)] font-semibold text-[#001814]'
              : 'bg-[var(--bg-elev)] text-[var(--text-dim)] hover:text-[var(--text)]'
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

// ─── SettingField (stack variant) ───────────────────────────────

interface SettingFieldProps {
  label: string
  description?: string
  children: ReactNode
  className?: string
}

/** 垂直堆叠的设置字段 — label 在上，控件在下 */
export function SettingField({
  label,
  description,
  children,
  className,
}: SettingFieldProps) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label className="text-[12.5px] font-medium text-[var(--text)]">
        {label}
      </label>
      {children}
      {description && (
        <p className="text-[11px] leading-[1.5] text-[var(--text-faint)]">
          {description}
        </p>
      )}
    </div>
  )
}
