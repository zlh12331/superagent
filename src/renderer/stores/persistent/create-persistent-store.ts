// src/renderer/stores/persistent/create-persistent-store.ts
// 持久化 Zustand Store 工厂（L2 客户端共享状态层 - persistent 子层）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 统一封装 zustand persist 中间件的配置（storage key 前缀 / 版本迁移 / 错误降级）
// - 持久化策略：跨应用重启保留状态（settings / sessions 等）
// - 与 transient/ 目录的 store 区分：transient 不持久化，重启即失
//
// 设计要点：
// - storage key 统一前缀 `novel-writer:`，避免与其他应用冲突
// - 默认 partialize：仅持久化非函数字段（函数自动被过滤）
// - 版本字段 + migrate 函数支持 schema 演进（如 v1 → v2 字段重命名）
// - localStorage 失败时（隐私模式 / 配额超限）静默降级到内存 store
// - createJSONStorage(() => localStorage) 显式声明存储后端，便于未来切换到 IndexedDB
//
// 与原生 persist() 的差异：
// - 原生 persist 需要每个 store 重复写 name / partialize
// - 本工厂统一默认值，业务 store 只关心 state shape 与 actions
// ──────────────────────────────────────────────────────────────

import { create, type StateCreator, type StoreApi, type UseBoundStore } from 'zustand';
import {
  createJSONStorage,
  type PersistOptions,
  type PersistStorage,
  persist,
} from 'zustand/middleware';

/**
 * storage key 统一前缀
 *
 * 所有持久化 store 共享此前缀，避免与其他 Electron 应用 / localStorage 项冲突。
 */
const STORAGE_KEY_PREFIX = 'novel-writer:';

/**
 * 持久化 store 配置（业务 store 传入的覆盖项）
 *
 * 大部分字段有默认值，业务 store 通常只需提供 name + version + migrate。
 */
export interface PersistentStoreConfig<TState>
  extends Partial<Omit<PersistOptions<TState, Partial<TState>>, 'name'>> {
  /** store 名称（与 STORAGE_KEY_PREFIX 拼接成最终 storage key） */
  name: string;
  /** schema 版本（默认 1，字段结构变更时递增并配套 migrate） */
  version?: number;
}

/**
 * 创建持久化 Zustand Store
 *
 * @param initializer state creator（与 create<T>()(initializer) 一致）
 * @param config 持久化配置（name 必填，version / migrate / partialize 可选）
 * @returns useXxxStore hook（与 zustand create 返回值一致）
 *
 * @example
 * ```ts
 * export const useSettingsStore = createPersistentStore<SettingsState>()(
 *   (set) => ({ theme: 'system', setTheme: (t) => set({ theme: t }) }),
 *   { name: 'settings', version: 1 },
 * );
 * ```
 */
export function createPersistentStore<TState extends object>() {
  return <TSlice extends TState>(
    initializer: StateCreator<TSlice, [], [], TSlice>,
    config: PersistentStoreConfig<TSlice>,
  ): UseBoundStore<StoreApi<TSlice>> => {
    const { name, version = 1, migrate, partialize, ...rest } = config;
    const storageKey = `${STORAGE_KEY_PREFIX}${name}`;

    // 显式声明 PersistStorage 类型，避免 exactOptionalPropertyTypes 下的兼容问题
    // createJSONStorage(() => localStorage) 返回 PersistStorage<unknown>，
    // 通过 cast 与 TSlice 对齐
    const storage: PersistStorage<Partial<TSlice>> | undefined = createJSONStorage(
      () => localStorage,
    ) as PersistStorage<Partial<TSlice>> | undefined;

    return create<TSlice>()(
      persist(initializer, {
        name: storageKey,
        version,
        // createJSONStorage 显式声明存储后端
        // 若 localStorage 不可用（隐私模式 / SSR），zustand 会自动降级为内存存储
        storage,
        // 默认仅持久化非函数字段（自动过滤 actions）
        partialize:
          partialize ??
          ((state) => {
            const data: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(state)) {
              if (typeof value !== 'function') {
                data[key] = value;
              }
            }
            return data as Partial<TSlice>;
          }),
        // migrate 透传（未提供时 zustand 默认直接返回旧 state）
        ...(migrate !== undefined ? { migrate } : {}),
        ...rest,
      }),
    );
  };
}
