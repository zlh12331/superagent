// src/renderer/hooks/use-file-tree.ts
// 文件树数据获取 hook（L3 服务端请求状态层）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 监听 rootPath 变化 → 同步到 store + 启动 file:watch
// - 监听 expandedPaths 变化 → 对新增展开的目录触发 file:list
// - 订阅 file:watch:event → 增量更新 store（create/delete/rename）
// - 暴露 refresh()：手动重拉根目录 + 所有已展开目录（工具栏刷新）
//
// 设计依据（项目规范）：
// - "IPC `on` push events must be managed with Zustand stores instead of TanStack Query"
//   file:watch:event 是流式事件，由本 hook 订阅后写入 Zustand store
// - file:list 是请求-响应，但因结果需要进入 Zustand store（与 watch 事件合并），
//   不适合用 TanStack Query 缓存（会导致双份一致性问题），故直接调用 IPC
//
// 调用关系：
// - 调用方：FileTreePanel 组件，传入 workingDir
// - 被调方：file-tree-store（状态写入）、preload file API（IPC 调用）
// ──────────────────────────────────────────────────────────────

import type { FileEntry } from '@code-agent/shared/renderer';
import { useCallback, useEffect, useRef } from 'react';
import { toast } from 'sonner';

import { useTranslation } from '@/i18n/use-translation';
import { unwrap } from '@/lib/ipc';
import { useSettingsStore } from '@/stores/persistent/settings-store';
import { useFileTreeStore } from '@/stores/transient/file-tree-store';

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
  // 本地化文案
  const { t } = useTranslation();
  // store actions（订阅 action 引用稳定，不触发额外渲染）
  const setRootPath = useFileTreeStore((s) => s.setRootPath);
  const expandedPaths = useFileTreeStore((s) => s.expandedPaths);
  const setEntries = useFileTreeStore((s) => s.setEntries);
  const setLoading = useFileTreeStore((s) => s.setLoading);
  const removeEntry = useFileTreeStore((s) => s.removeEntry);
  const expandPaths = useFileTreeStore((s) => s.expandPaths);
  const reset = useFileTreeStore((s) => s.reset);

  // 跟踪已加载的目录，避免展开/折叠切换时重复请求
  // 注意：不放入 store，避免 setEntries 后触发已加载标记重置
  const loadedDirsRef = useRef<Set<string>>(new Set());
  // 默认展开剩余深度：每完成一波加载递减，归零后停止自动注入子目录
  const autoExpandLeftRef = useRef(0);

  /**
   * 加载指定目录的条目列表
   *
   * 调用 file:list IPC，结果写入 store（自动排序）。
   * 错误处理：失败时移除 loadedDirs 标记，允许下次重试；静默不提示（后台加载）。
   *
   * 用 useCallback 包装以稳定引用，避免 useEffect 频繁触发。
   *
   * @returns 成功时返回条目列表（默认展开链读取子目录用）；失败返回 null
   */
  const loadDir = useCallback(
    async (path: string): Promise<readonly FileEntry[] | null> => {
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
        // 加载失败/异常：移除标记，允许下次展开时重试
        loadedDirsRef.current.delete(path);
      }
      // finally 语义（React Compiler 不优化 try/finally）：try 内不 rethrow，
      // 统一在这里复位加载态后再返回结果
      setLoading(path, false);
      return entries;
    },
    [setEntries, setLoading],
  );

  // 1. 同步 workingDir 到 store（切换会话时重置状态，默认展开根目录）
  //    同时重置自动展开剩余深度（getState 现读：层级设置在挂载/切换项目时生效）
  useEffect(() => {
    setRootPath(workingDir);
    // 重置已加载标记，让新根目录下的目录都能重新加载
    loadedDirsRef.current = new Set();
    autoExpandLeftRef.current = Math.max(
      0,
      useSettingsStore.getState().workspace.defaultExpandDepth - 1,
    );
  }, [workingDir, setRootPath]);

  // 2. 对已展开但未加载的目录触发 file:list；完成后按剩余深度自动注入下一层子目录
  useEffect(() => {
    if (workingDir === null) return;

    // 收集本次需要加载的目录（已展开但未加载）
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
      if (cancelled) return;
      // 默认展开层级链：把本波新加载目录中的子目录注入展开集，
      // 触发本 effect 下一轮加载，直到剩余深度归零
      if (autoExpandLeftRef.current > 0) {
        autoExpandLeftRef.current -= 1;
        const childDirs: string[] = [];
        for (const dir of toLoad) {
          const entries = useFileTreeStore.getState().entries.get(dir) ?? [];
          for (const entry of entries) {
            if (entry.type === 'directory') {
              childDirs.push(entry.path);
            }
          }
        }
        if (childDirs.length > 0) {
          expandPaths(childDirs);
        }
      }
    });
    return () => {
      cancelled = true;
    };
  }, [workingDir, expandedPaths, loadDir, expandPaths]);

  // 3. 启动 file:watch + 订阅 file:watch:event
  useEffect(() => {
    if (workingDir === null) return undefined;

    let watcherId: string | null = null;
    let cancelled = false;

    // 启动 watcher
    void (async () => {
      try {
        const response = await window.api.file.watchStart({ path: workingDir });
        if (cancelled) {
          // 已取消（workingDir 变化），立即停止 watcher 避免泄漏。
          // 此处 catch 是**有意忽略**：watchStart 返回 error 响应时无 watcherId，
          // unwrap 抛错即"本就无可停"，属预期分支而非故障（无需上报）。
          try {
            await window.api.file.watchStop({ watcherId: unwrap(response).watcherId });
          } catch {
            // 预期分支：无 watcherId 可停（见上方说明）
          }
          return;
        }
        // 成功取 watcherId；error 响应（IPC）或异常统一走 catch 提示
        watcherId = unwrap(response).watcherId;
      } catch (err) {
        // 区分 IPC 错误响应（watchFailed，提示可刷新目录重试）与异常（watchAbnormal）
        if (err instanceof Error && /^\[[A-Z_]+\]/.test(err.message)) {
          toast.warning(t('common.watchFailed'), {
            description: t('common.watchFailedDesc'),
            duration: 4000,
          });
        } else {
          toast.warning(t('common.watchAbnormal'), {
            description: t('common.watchAbnormalDesc'),
            duration: 4000,
          });
        }
      }
    })();

    // 订阅文件变更事件
    const unsubscribe = window.api.file.subscribeWatchEvent((event) => {
      // 过滤非当前 watcher 的事件（多窗口或旧 watcher 残留）
      if (watcherId !== null && event.watcherId !== watcherId) return;

      const parentDir = dirname(event.path);

      switch (event.type) {
        case 'create': {
          // 新建文件/目录：重新加载父目录条目（最简单可靠，避免漏掉 stat 信息）
          loadedDirsRef.current.delete(parentDir);
          void loadDir(parentDir);
          break;
        }
        case 'modify': {
          // 文件内容变更：不影响文件树结构（size/modifiedAt 仅展示用），忽略
          break;
        }
        case 'delete': {
          // 删除文件/目录：从父目录条目中移除
          removeEntry(parentDir, event.path);
          // 若删除的是目录，清理其子条目缓存（避免再次展开时显示陈旧数据）
          loadedDirsRef.current.delete(event.path);
          break;
        }
        case 'rename': {
          // 重命名：旧路径从父目录移除，新路径触发父目录重载
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
      // 停止 watcher（异步，不阻塞卸载）
      if (watcherId !== null) {
        void window.api.file.watchStop({ watcherId });
        watcherId = null;
      }
    };
    // 仅依赖 workingDir 和稳定的 store actions：watcher 生命周期与根目录绑定
  }, [workingDir, removeEntry, loadDir, t]);

  // 组件卸载时重置 store（避免切换到无文件树页面时残留状态）
  useEffect(() => {
    return () => {
      reset();
    };
  }, [reset]);

  // 手动刷新：重拉根目录 + 所有已展开目录（工具栏「刷新」菜单项）
  // 数据面留在 hook 内（与 watch 生命周期同层），组件只触发；失败集中提示一次。
  // 不手写 useCallback：返回值是每次渲染新建的 { refresh } 对象，记忆化本函数
  // 改变不了调用方拿到的引用（且本函数不进任何依赖数组），记忆化交给 React Compiler。
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
 * 重拉根目录 + 所有已展开目录的条目
 *
 * 单目录失败不中断其余目录（allSettled 语义），最后统一提示一次。
 * 浏览器模式（无 window.api）视为全部成功——不误报失败。
 *
 * @param rootPath 根目录绝对路径
 * @returns 失败目录数（0 表示全部成功）——调用方据此决定是否提示
 */
async function refreshExpandedDirs(rootPath: string): Promise<number> {
  if (typeof window === 'undefined' || window.api === undefined) {
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
  // 无分隔符（如 'C:'）：原样返回
  if (idx < 0) return path;
  const parent = path.slice(0, idx);
  // 分隔符在位置 0（根级文件）或 parent 仅剩盘符（Windows 盘根）：
  // 父目录就是「分隔符前的部分 + 该分隔符」，保留根形态
  if (parent === '' || /^[A-Za-z]:$/.test(parent)) return path.slice(0, idx + 1);
  return parent;
}
