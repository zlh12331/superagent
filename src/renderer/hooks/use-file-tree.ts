// src/renderer/hooks/use-file-tree.ts
// 文件树数据获取 hook（L3 服务端请求状态层）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 监听 rootPath 变化 → 同步到 store + 启动 file:watch
// - 监听 expandedPaths 变化 → 对新增展开的目录触发 file:list
// - 订阅 file:watch:event → 增量更新 store（create/delete/rename）
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
 *
 * @example
 * ```tsx
 * function FileTreePanel({ workingDir }: { workingDir: string | null }) {
 *   useFileTree(workingDir);
 *   const rootPath = useFileTreeStore((s) => s.rootPath);
 *   if (rootPath === null) return <EmptyHint />;
 *   return <FileTreeNode path={rootPath} depth={0} />;
 * }
 * ```
 */
export function useFileTree(workingDir: string | null): void {
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
          // 已取消（workingDir 变化），立即停止 watcher 避免泄漏；
          // error 响应无 watcherId 可停，unwrap 抛错由 catch 吞掉（与旧行为等价）
          try {
            await window.api.file.watchStop({ watcherId: unwrap(response).watcherId });
          } catch {
            // 无 watcherId 可停
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
}

/**
 * 计算父目录路径（兼容 Windows 反斜杠与 POSIX 正斜杠）
 *
 * 不依赖 node:path（渲染层无 Node API），手写实现。
 * 用于从 file:watch:event 的 path 字段反推父目录。
 */
function dirname(path: string): string {
  // 同时查找最后出现的 \ 和 /，取较大者作为分隔符位置
  const lastSlash = path.lastIndexOf('/');
  const lastBackslash = path.lastIndexOf('\\');
  const idx = Math.max(lastSlash, lastBackslash);
  if (idx <= 0) return path; // 无分隔符或根路径（如 'C:'）
  return path.slice(0, idx);
}
