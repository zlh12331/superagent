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
const STORAGE_KEY_PREFIX = 'code-agent:';

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

    const storage: PersistStorage<Partial<TSlice>> | undefined = createJSONStorage(
      () => localStorage,
    ) as PersistStorage<Partial<TSlice>> | undefined;

    return create<TSlice>()(
      persist(initializer, {
        name: storageKey,
        version,
        storage,
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
        migrate: migrate ?? ((persisted) => persisted as never),
        ...rest,
      }),
    );
  };
}
