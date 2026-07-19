// src/renderer/stores/app-status.store.ts
// 应用级状态订阅（PG/Ollama 健康状态）
// 设计文档 §7.8 PG 子进程健康监控 / §7.9 Ollama 嵌入服务健康监控
//
// 职责：
// - 缓存最新 PG/Ollama 状态与 DB 连接状态
// - 提供 init() 启动订阅 + 返回 cleanup 函数
// - 提供 refresh() 主动拉取一次最新状态
//
// 注意：不直接在模块加载时订阅，由 AppShell 在 useEffect 中调用 init()

import type { AppStatus } from '@novel-writer/shared';
import { create } from 'zustand';

/**
 * 应用级状态接口
 *
 * 缓存 PG/Ollama 子进程的健康状态及 DB 连接状态。
 * init() 启动 IPC 订阅并立即拉取一次最新状态，返回 cleanup 函数用于卸载订阅。
 */
export interface AppStatusState {
  /** PostgreSQL 子进程状态 */
  pgStatus: AppStatus['pgStatus'];
  /** Ollama 服务状态 */
  ollamaStatus: AppStatus['ollamaStatus'];
  /** Ollama 嵌入模型是否就绪 */
  ollamaModelReady: boolean;
  /** DB 连接是否就绪 */
  dbConnected: boolean;
  /** Ollama 模型拉取进度（无拉取任务时为 null） */
  pullProgress: { model: string; percent: number } | null;
  /** 主动拉取一次最新状态（调用 window.api.app.getStatus） */
  refresh: () => Promise<void>;
  /** 启动 IPC 订阅，返回 cleanup 函数（由组件在 useEffect 中调用） */
  init: () => () => void;
}

/**
 * 应用级状态 store
 *
 * 由 AppShell 在 useEffect 中调用 init() 启动订阅，
 * 在组件卸载时调用返回的 cleanup 函数清理订阅。
 *
 * 注意：refresh 内部使用 get() 访问当前 state，因此 create 必须传入 get 参数。
 *
 * @example
 * useEffect(() => {
 *   const cleanup = useAppStatusStore.getState().init();
 *   return cleanup;
 * }, []);
 */
export const useAppStatusStore = create<AppStatusState>()((set, get) => ({
  pgStatus: 'stopped',
  ollamaStatus: 'stopped',
  ollamaModelReady: false,
  dbConnected: false,
  pullProgress: null,
  refresh: async () => {
    const res = await window.api.app.getStatus();
    // IpcResponse 是 discriminated union：用 'data' in res 类型收窄
    if ('data' in res) {
      const s = res.data;
      set({
        pgStatus: s.pgStatus,
        ollamaStatus: s.ollamaStatus,
        ollamaModelReady: s.ollamaModelReady,
        dbConnected: s.dbConnected,
      });
    }
  },
  init: () => {
    const unsubPg = window.api.app.onPgStatusChange((status) => {
      set({ pgStatus: status });
    });
    const unsubOllama = window.api.app.onOllamaStatusChange((status) => {
      set({ ollamaStatus: status });
    });
    const unsubPull = window.api.app.onOllamaPullProgress((p) => {
      set({ pullProgress: { model: p.model, percent: p.percent } });
    });
    // 启动时立即拉取一次最新状态，避免初始状态过期
    void get().refresh();
    return () => {
      unsubPg();
      unsubOllama();
      unsubPull();
    };
  },
}));
