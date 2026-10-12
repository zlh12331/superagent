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
      className="bg-accent ml-0.5 inline-block h-3.5 w-2 animate-[blink_1s_infinite] align-text-bottom"
    />
  );
}
