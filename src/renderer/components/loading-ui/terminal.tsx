// src/renderer/components/loading-ui/terminal.tsx
// Terminal 加载动画（copy-paste 自 @loading-ui/terminal，shadcn registry 组件）
// ──────────────────────────────────────────────────────────────
// 纯展示组件：终端提示符 + 闪烁光标（token 化：bg-current / var(--duration)）
// 无依赖、无 runtime 绑定，可直接嵌入任意 loading 状态。
// ──────────────────────────────────────────────────────────────

import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

type TerminalProps = ComponentProps<'span'> & {
  /** 提示符字符（默认 '>'） */
  prompt?: string;
};

/**
 * 终端风格加载指示器（光标闪烁动画）
 */
function Terminal({ className, prompt = '>', style, ...props }: TerminalProps) {
  return (
    <>
      <style>{`
        @keyframes loading-ui-terminal-blink {
          0%,
          100% {
            opacity: 1;
          }

          50% {
            opacity: 0;
          }
        }
      `}</style>
      <span
        role="status"
        className={cn('inline-flex items-center gap-[0.25em] font-mono', className)}
        style={style}
        {...props}
      >
        <span aria-hidden="true">{prompt}</span>
        <span
          aria-hidden="true"
          className="inline-block w-[0.5em] bg-current"
          style={{
            height: '1em',
            animation: 'loading-ui-terminal-blink var(--duration, 1s) step-end infinite',
          }}
        />
        <span className="sr-only">Loading</span>
      </span>
    </>
  );
}

export { Terminal };
