import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import type { ReactElement } from 'react';

/**
 * dev 专属 Query Devtools 面板
 *
 * initialIsOpen=false：默认收起，仅显示浮动开关按钮，不遮挡业务界面。
 * 可视化 query 缓存与失效链路（use-agent-bridge 事件中枢触发的
 * invalidate 在这里一眼可见），弥补五处历史失效遗漏靠读代码发现的问题。
 */
export function QueryDevtools(): ReactElement {
  return <ReactQueryDevtools initialIsOpen={false} />;
}
