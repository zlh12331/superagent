// src/renderer/components/dev/RenderProfiler.tsx
// React Profiler API 埋点组件（方案 F）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 用 React.Profiler API 包裹根组件，自动收集每次 commit 的性能数据
// - dev 环境：通过 console.info 输出慢渲染（>16ms 掉帧 / >100ms 卡顿）
// - 通过 window.__RENDER_PROFILER__ 暴露历史记录，便于 CDP / DevTools console 查询
// - 生产环境：组件透传 children，Profiler 回调为 noop，零运行时开销
//
// 使用：
// - 在 main.tsx 中 <RenderProfiler><App /></RenderProfiler>
// - DevTools console 中查询：window.__RENDER_PROFILER__.snapshot()
// - 查询慢渲染：window.__RENDER_PROFILER__.slowRenders(16)
//
// 参考：
// - https://react.dev/reference/react/Profiler
// - https://react.dev/blog/2024-routing-and-rendering-profiling
// ──────────────────────────────────────────────────────────────

import { Profiler, type ReactElement, type ReactNode } from 'react';

// 一次 commit 的性能记录
interface ProfilerRecord {
  /** commit 阶段（'mount' | 'update' | 'nested-update'） */
  phase: 'mount' | 'update' | 'nested-update';
  /** 实际渲染耗时（毫秒） */
  actualDuration: number;
  /** base 渲染耗时（无 memo 优化时的耗时） */
  baseDuration: number;
  /** 提交时间戳（performance.now()） */
  timestamp: number;
  /** 组件 id */
  id: string;
}

// 慢渲染阈值（毫秒）—— 按 RAIL 模型分阶段
//
// mount 阶段：一次性初始化（ESM 解析 + Provider 链路 + hooks 注册 + 首屏渲染）
//   - 慢渲染 500ms（RAIL Load 阈值 1000ms 的 50%，留出模块加载 + useEffect 余量）
//   - 严重卡顿 2000ms（用户明显感知"卡"）
//   - dev 环境含 StrictMode 双重渲染 + React DevTools 注入，actualDuration 翻倍
//   - 16ms 阈值仅适用于每帧交互（update），mount 不可能 <16ms
//
// update / nested-update 阶段：每次交互触发，需 <16ms 才不掉帧
//   - 慢渲染 16ms（60fps 每帧预算）
//   - 严重卡顿 100ms（用户感知卡顿）
//
// 参考：
// - https://web.dev/articles/rail#response
// - https://react.dev/reference/react/Profiler
const MOUNT_SLOW_THRESHOLD_MS = 500;
const MOUNT_CRITICAL_THRESHOLD_MS = 2000;
const UPDATE_SLOW_THRESHOLD_MS = 16;
const UPDATE_CRITICAL_THRESHOLD_MS = 100;

// 保留最近 N 条记录，避免内存无限增长
const MAX_RECORDS = 500;

// 历史记录环形缓冲区
const records: ProfilerRecord[] = [];

/**
 * Profiler onRender 回调
 *
 * 仅在 dev 环境执行实际逻辑，生产环境由 Profiler 的 disabled prop 关闭
 */
function onRender(
  id: string,
  phase: 'mount' | 'update' | 'nested-update',
  actualDuration: number,
  baseDuration: number,
): void {
  const record: ProfilerRecord = {
    phase,
    actualDuration,
    baseDuration,
    timestamp: performance.now(),
    id,
  };

  // 入环形缓冲区
  records.push(record);
  if (records.length > MAX_RECORDS) {
    records.shift();
  }

  // 慢渲染告警 —— 按 phase 选择阈值（RAIL 模型）
  // mount 是一次性初始化，按 RAIL Load 阈值判定；
  // update/nested-update 是每帧交互，按 60fps 预算判定
  const slowThreshold = phase === 'mount' ? MOUNT_SLOW_THRESHOLD_MS : UPDATE_SLOW_THRESHOLD_MS;
  const criticalThreshold =
    phase === 'mount' ? MOUNT_CRITICAL_THRESHOLD_MS : UPDATE_CRITICAL_THRESHOLD_MS;

  if (actualDuration >= criticalThreshold) {
    // biome-ignore lint/suspicious/noConsole: dev 环境性能埋点需要 console
    console.warn(
      `[Profiler] 严重卡顿: ${id} ${phase} ${actualDuration.toFixed(2)}ms (base: ${baseDuration.toFixed(2)}ms)`,
    );
  } else if (actualDuration >= slowThreshold) {
    // biome-ignore lint/suspicious/noConsole: dev 环境性能埋点需要 console
    console.info(`[Profiler] 慢渲染: ${id} ${phase} ${actualDuration.toFixed(2)}ms`);
  }
}

// 暴露查询 API 到 window，供 DevTools console / CDP 调用
declare global {
  interface Window {
    // biome-ignore lint/style/useNamingConvention: dev 全局变量约定（双下划线）
    __RENDER_PROFILER__?: {
      /** 获取所有记录（最新在前） */
      records(): readonly ProfilerRecord[];
      /** 获取慢渲染记录（默认阈值 16ms） */
      slowRenders(thresholdMs?: number): ProfilerRecord[];
      /** 统计摘要 */
      stats(): {
        total: number;
        mounts: number;
        updates: number;
        avgDuration: number;
        maxDuration: number;
        p95Duration: number;
      };
      /** 清空记录 */
      clear(): void;
    };
  }
}

if (import.meta.env.DEV) {
  window.__RENDER_PROFILER__ = {
    records: () => [...records].reverse(),
    slowRenders: (thresholdMs = UPDATE_SLOW_THRESHOLD_MS) =>
      records.filter((r) => r.actualDuration >= thresholdMs).reverse(),
    stats: () => {
      const sorted = [...records].sort((a, b) => a.actualDuration - b.actualDuration);
      const total = records.length;
      const mounts = records.filter((r) => r.phase === 'mount').length;
      const updates = records.filter((r) => r.phase === 'update').length;
      const avg = total > 0 ? records.reduce((s, r) => s + r.actualDuration, 0) / total : 0;
      const max = total > 0 ? (sorted[sorted.length - 1]?.actualDuration ?? 0) : 0;
      const p95Index = Math.floor(sorted.length * 0.95);
      const p95 = sorted[p95Index]?.actualDuration ?? 0;
      return {
        total,
        mounts,
        updates,
        avgDuration: Number(avg.toFixed(2)),
        maxDuration: Number(max.toFixed(2)),
        p95Duration: Number(p95.toFixed(2)),
      };
    },
    clear: () => {
      records.length = 0;
    },
  };
}

interface RenderProfilerProps {
  children: ReactNode;
}

/**
 * React Profiler 包裹组件
 *
 * dev 环境：启用 Profiler 收集性能数据
 * 生产环境：直接返回 children，Profiler 回调为 noop（React 内部会跳过）
 */
export function RenderProfiler({ children }: RenderProfilerProps): ReactElement {
  // 生产环境直接透传，不包裹 Profiler
  // React Profiler 在生产构建中即使存在也会有微小开销，所以直接跳过
  if (!import.meta.env.DEV) {
    return <>{children}</>;
  }

  return (
    <Profiler id="App" onRender={onRender}>
      {children}
    </Profiler>
  );
}
