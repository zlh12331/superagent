// src/renderer/components/chat/streaming-cursor.tsx
// 流式输出闪烁光标（照搬自参考项目 F:\TraeProjects\Agent2\1\src\features\conversation\messages\StreamingCursor.tsx）
// ──────────────────────────────────────────────────────────────
// 渲染在流式 assistant 文本末尾：accent 色短竖条 + 发光 + 1s 闪烁动画（blink 关键帧）。
// 纯 CSS 动画，无交互。
// ──────────────────────────────────────────────────────────────

import type { ReactElement } from 'react';

/**
 * 流式输出光标
 *
 * @example
 * {isStreaming && <StreamingCursor />}
 */
export function StreamingCursor(): ReactElement {
  return (
    <span
      aria-hidden="true"
      className="bg-[var(--accent)] ml-0.5 inline-block h-3.5 w-2 animate-[blink_1s_infinite] align-text-bottom shadow-[0_0_8px_var(--accent-glow)]"
    />
  );
}
