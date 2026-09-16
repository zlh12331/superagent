// src/renderer/components/loading-ui/terminal.tsx
// Terminal 加载动画（copy-paste 自 @loading-ui/terminal，shadcn registry 组件）
// ──────────────────────────────────────────────────────────────
// 纯展示组件：终端提示符 + 闪烁块光标。无依赖、无 runtime 绑定，可直接嵌入
// 任意 loading 状态（当前唯一调用点：TerminalPanel 创建会话时的加载态）。
//
// 与 ui/spinner 的分工（勿合并）：Spinner 是环形转圈，服务于通用加载；
// 本组件是终端提示符样式，服务于「终端正在启动」这一具体语境。
//
// 动画与可访问性：
// - 光标闪烁复用 globals.css 的 blink 关键帧（见 .loading-ui-terminal-cursor），
//   不再内联 <style>——该 keyframe 此前在组件内私有复制了一份等价实现，
//   且是渲染层唯一的内联 <style>；globals.css 现有 15 个 @keyframes 统一在此维护
// - role="status" + sr-only 本地化文案播报加载语义；提示符与光标对读屏器隐藏
//   （与 ui/spinner 的可访问性模式一致）
// ──────────────────────────────────────────────────────────────

import type { ComponentProps } from 'react';
import { useTranslation } from '@/i18n/use-translation';
import { cn } from '@/lib/utils';

type TerminalProps = ComponentProps<'span'> & {
  /** 提示符字符（默认 '>'） */
  prompt?: string;
};

/**
 * 终端风格加载指示器（光标闪烁动画）
 *
 * @param className 附加类名（颜色经 currentColor 继承，如 text-muted-foreground）
 * @param prompt 提示符字符，默认 '>'
 */
function Terminal({ className, prompt = '>', ...props }: TerminalProps): React.ReactElement {
  const { t } = useTranslation();
  return (
    <span
      role="status"
      className={cn('inline-flex items-center gap-[0.25em] font-mono', className)}
      {...props}
    >
      <span aria-hidden="true">{prompt}</span>
      <span aria-hidden="true" className="loading-ui-terminal-cursor" />
      <span className="sr-only">{t('common.loading')}</span>
    </span>
  );
}

export { Terminal };
