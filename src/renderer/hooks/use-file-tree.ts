import type { FileEntry } from '@code-agent/shared/renderer';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';

import { useTranslation } from '@/i18n/use-translation';
import { hasIpcBridge, unwrap } from '@/lib/ipc';
import { useSettingsStore } from '@/stores/persistent/settings-store';
import { useFileTreeStore } from '@/stores/transient/file-tree-store';
import { useLatestRef } from './use-latest-ref';

/**
 * i18n 文案函数类型
 *
 * 由 useTranslation 推导：本项目所用 react-i18next 版本未导出 TFunction 类型，
 * 且推导能自动跟随 hook 的命名空间推导，比手写泛型更不易漂移。
 */
type TranslateFn = ReturnType<typeof useTranslation>['t'];

/**
 * useFileTree：文件树数据生命周期管理 hook
 *
 * 必须传入 workingDir。workingDir 为 null 时（无激活会话）不加载任何数据。
 *
 * @param workingDir 当前激活会话的工作目录绝对路径
 * @returns 控制面（当前仅 refresh：手动重拉根目录 + 所有已展开目录）
 *
 * @example
 * ```tsx
 * function FileTreePanel({ workingDir }: { workingDir: string | null }) {
 *   const { refresh } = useFileTree(workingDir);
 *   const rootPath = useFileTreeStore((s) => s.rootPath);
 *   if (rootPath === null) return <EmptyHint />;
 *   return <button onClick={refresh}>刷新</button>;
 * }
 * ```
 */
export function useFileTree(workingDir: string | null): { refresh: () => void } {
  const { t } = useTranslation();
  const setRootPath = useFileTreeStore((s) => s.setRootPath);
  const expandedPaths = useFileTreeStore((s) => s.expandedPaths);
  const setEntries = useFileTreeStore((s) => s.setEntries);
  const setLoading = useFileTreeStore((s) => s.setLoading);
  const removeEntry = useFileTreeStore((s) => s.removeEntry);
  const expandPaths = useFileTreeStore((s) => s.expandPaths);
  const reset = useFileTreeStore((s) => s.reset);

  const loadedDirsRef = useRef<Set<string>>(new Set());
  const autoExpandLeftRef = useRef(0);

  /**
   * 加载指定目录的条目列表
   *
   * 调用 file:list IPC，结果写入 store（自动排序）。
   * 错误处理：失败时移除 loadedDirs 标记，允许下次重试；静默不提示（后台加载）。
   *
   * 经 loadDirRef 调用：不进 effect 依赖数组（vitest 无 React Compiler，
   * 每渲染新函数会让 watch 生命周期 effect 反复重订阅）。
   *
   * @returns 成功时返回条目列表（默认展开链读取子目录用）；失败返回 null
   */
  const loadDirImpl = async (path: string): Promise<readonly FileEntry[] | null> => {
    setLoading(path, true);
    let entries: readonly FileEntry[] | null = null;
    try {
      const response = await window.api.file.list({
        path,
        depth: 1,
        includeHidden: false,
      });
      const data = unwrap(response);
      setEntries(path, data.entries);
      entries = data.entries;
    } catch {
      loadedDirsRef.current.delete(path);
    }
    setLoading(path, false);
    return entries;
  };
  const loadDirRef = useLatestRef(loadDirImpl);
  const loadDir = useRef(
    (path: string): Promise<readonly FileEntry[] | null> => loadDirRef.current(path),
  ).current;

  useEffect(() => {
    setRootPath(workingDir);
    loadedDirsRef.current = new Set();
    autoExpandLeftRef.current = Math.max(
      0,
      useSettingsStore.getState().workspace.defaultExpandDepth - 1,
    );
  }, [workingDir, setRootPath]);

  useEffect(() => {
    if (workingDir === null) return;

    const toLoad: string[] = [];
    for (const path of expandedPaths) {
      if (!loadedDirsRef.current.has(path)) {
        loadedDirsRef.current.add(path);
        toLoad.push(path);
      }
    }

    if (toLoad.length === 0) return;

    let cancelled = false;
    void Promise.all(toLoad.map((path) => loadDir(path))).then(() => {
      if (cancelled || autoExpandLeftRef.current <= 0) return;
      autoExpandLeftRef.current -= 1;
      expandPaths(collectChildDirs(toLoad));
    });
    return () => {
      cancelled = true;
    };
  }, [workingDir, expandedPaths, expandPaths, loadDir]);

  useEffect(() => {
    if (workingDir === null) return undefined;

    let watcherId: string | null = null;
    let cancelled = false;

    void (async () => {
      try {
        const response = await window.api.file.watchStart({ path: workingDir });
        if (cancelled) {
          await stopWatcherBestEffort(response);
          return;
        }
        watcherId = unwrap(response).watcherId;
      } catch (err) {
        notifyWatchStartFailure(err, t);
      }
    })();

    const unsubscribe = window.api.file.subscribeWatchEvent((event) => {
      if (watcherId !== null && event.watcherId !== watcherId) return;

      const parentDir = dirname(event.path);

      switch (event.type) {
        case 'create': {
          loadedDirsRef.current.delete(parentDir);
          void loadDir(parentDir);
          break;
        }
        case 'modify': {
          break;
        }
        case 'delete': {
          removeEntry(parentDir, event.path);
          loadedDirsRef.current.delete(event.path);
          break;
        }
        case 'rename': {
          if (event.oldPath !== undefined) {
            removeEntry(dirname(event.oldPath), event.oldPath);
            loadedDirsRef.current.delete(event.oldPath);
          }
          loadedDirsRef.current.delete(parentDir);
          void loadDir(parentDir);
          break;
        }
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
      if (watcherId !== null) {
        void window.api.file.watchStop({ watcherId });
        watcherId = null;
      }
    };
  }, [workingDir, removeEntry, t, loadDir]);

  useEffect(() => {
    return () => {
      reset();
    };
  }, [reset]);

  const refresh = (): void => {
    if (workingDir === null) return;
    void refreshExpandedDirs(workingDir).then((failed) => {
      if (failed > 0) {
        toast.warning(t('fileTree.refreshFailed'));
      }
    });
  };

  return { refresh };
}

/**
 * 收集给定目录下「已加载子条目中的目录」路径
 *
 * 抽离动机（2026-09 file-tree 审计）：原为 effect 回调内的双重嵌套循环
 * （遍历待加载目录 × 遍历其条目），使该回调认知复杂度达 26（阈值 15）。
 * 移出后回调只表达「加载完成后按剩余深度注入下一层」这一件事。
 *
 * 读的是 store 当前值（而非入参快照）：本函数在 await 之后调用，
 * 条目由 loadDir 经 setEntries 异步写入，故必须现读。
 *
 * @param dirs 待检查的目录路径（本波刚加载完成的目录）
 * @returns 展开集中应新增的子目录路径（可能为空）
 */
function collectChildDirs(dirs: readonly string[]): string[] {
  const entriesByDir = useFileTreeStore.getState().entries;
  const childDirs: string[] = [];
  for (const dir of dirs) {
    for (const entry of entriesByDir.get(dir) ?? []) {
      if (entry.type === 'directory') childDirs.push(entry.path);
    }
  }
  return childDirs;
}

/**
 * 启动在途期间被取消：尽力回收已创建的 watcher
 *
 * 抽离动机（同上）：原为 effect 内联的嵌套 try/catch。此处 catch 是**有意忽略**——
 * watchStart 返回错误信封时无 watcherId，unwrap 抛错即"本就无可停"，
 * 属预期分支而非故障（无需上报）。
 *
 * @param response watchStart 的原始响应信封
 */
async function stopWatcherBestEffort(
  response: Awaited<ReturnType<typeof window.api.file.watchStart>>,
): Promise<void> {
  try {
    await window.api.file.watchStop({ watcherId: unwrap(response).watcherId });
  } catch {}
}

/**
 * watch 启动失败提示
 *
 * 区分两类：IPC 错误响应（形如 `[CODE] message`，可刷新目录重试）与
 * 其它异常（监听能力异常）。抽离后启动分支只剩正常路径。
 *
 * @param err 启动失败原因（错误信封抛出的 Error，或任意异常）
 * @param t i18n 文案函数
 */
function notifyWatchStartFailure(err: unknown, t: TranslateFn): void {
  const isIpcError = err instanceof Error && /^\[[A-Z_]+\]/.test(err.message);
  if (isIpcError) {
    toast.warning(t('common.watchFailed'), {
      description: t('common.watchFailedDesc'),
      duration: 4000,
    });
    return;
  }
  toast.warning(t('common.watchAbnormal'), {
    description: t('common.watchAbnormalDesc'),
    duration: 4000,
  });
}

/**
 * 重拉根目录 + 所有已展开目录的条目
 *
 * 单目录失败不中断其余目录（allSettled 语义），最后统一提示一次。
 * 浏览器模式（无 window.api）视为全部成功——不误报失败。
 *
 * @param rootPath 根目录绝对路径
 * @returns 失败目录数（0 表示全部成功）——调用方据此决定是否提示
 */
async function refreshExpandedDirs(rootPath: string): Promise<number> {
  if (!hasIpcBridge()) {
    return 0;
  }
  const paths = [...new Set([rootPath, ...useFileTreeStore.getState().expandedPaths])];
  let failed = 0;
  await Promise.allSettled(
    paths.map(async (path) => {
      try {
        const res = await window.api.file.list({ path, depth: 1, includeHidden: false });
        useFileTreeStore.getState().setEntries(path, unwrap(res).entries);
      } catch {
        failed += 1;
      }
    }),
  );
  return failed;
}

/**
 * 计算父目录路径（兼容 Windows 反斜杠与 POSIX 正斜杠）
 *
 * 不依赖 node:path（渲染层无 Node API），手写实现。
 * 用于从 file:watch:event 的 path 字段反推父目录（作为 store 的 entries 键）。
 *
 * 与 lib/file-search.extractDir 的区别（勿合并）：
 * - extractDir 面向**展示**（副标题），会把反斜杠统一成正斜杠、根级返回空串；
 * - 本函数面向**store 键匹配**，必须保留原分隔符与根形态，否则与 file:list
 *   用 workingDir 建立的键不一致，增量更新会静默落空。
 *
 * 边界（均为 store 键匹配正确性所需）：
 * - `/a.ts` → `/`：根级文件的父目录是根分隔符本身
 * - `C:\a.ts` → `C:\`：盘符根保留尾分隔符（返回 `C:` 会与 workingDir 键 `C:\` 失配）
 * - `C:` → `C:`、`a.ts` → `a.ts`：无分隔符时原样返回（调用方保证传入绝对路径）
 * - 尾部分隔符未做去重归一（watcher 事件路径不带尾分隔符），不属本函数职责
 */
function dirname(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (idx < 0) return path;
  const parent = path.slice(0, idx);
  if (parent === '' || /^[A-Za-z]:$/.test(parent)) return path.slice(0, idx + 1);
  return parent;
}
