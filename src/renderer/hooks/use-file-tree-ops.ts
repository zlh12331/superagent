// src/renderer/hooks/use-file-tree-ops.ts
// 文件树编辑操作 hook（L3 服务端请求状态层）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 封装 file:create / file:createDir / file:delete / file:rename IPC 调用
// - 自动管理 pendingOps 状态（IPC 前后置位/清除，防止重复操作）
// - 成功后取消内联编辑状态（cancelCreate / cancelRename）
// - 依赖 file:watch 事件自动同步文件树状态（useFileTree 已订阅）
// - 错误时 toast 提示
//
// 设计依据（项目规范）：
// - "Server state from IPC invoke (request-response) must use TanStack Query"
//   文件树编辑操作是 mutation 类型，但结果由 watch 事件自动同步到 store，
//   无需缓存，直接调用 IPC 即可（与 use-file-tree.ts 的 loadDir 设计一致）
// - 不重复 watch 文件树（useFileTree 已订阅），仅触发变更
//
// 调用关系：
// - 调用方：FileTreeNode 组件（菜单项点击、内联输入框确认）
// - 被调方：preload file API（IPC 调用）、file-tree-store（pendingOps + 内联状态）
// ──────────────────────────────────────────────────────────────

import { toast } from 'sonner';

import { useFileTreeStore } from '@/stores/transient/file-tree-store';

/**
 * useFileTreeOps：文件树编辑操作 hook
 *
 * 提供 createFile / createDir / deleteEntry / renameEntry 四个方法，
 * 自动管理 pendingOps 状态和内联编辑状态。
 *
 * @example
 * ```tsx
 * const ops = useFileTreeOps();
 * await ops.createFile('/path/to/parent', 'newfile.ts');
 * await ops.deleteEntry('/path/to/file');
 * ```
 */
export function useFileTreeOps() {
  const setPendingOp = useFileTreeStore((s) => s.setPendingOp);
  const cancelCreate = useFileTreeStore((s) => s.cancelCreate);
  const cancelRename = useFileTreeStore((s) => s.cancelRename);

  /**
   * 创建新文件
   *
   * 成功后取消内联编辑状态，依赖 file:watch 的 create 事件自动刷新父目录。
   *
   * @param parentDir 父目录绝对路径
   * @param name 新文件名（不含路径分隔符）
   * @returns 是否成功（失败时已 toast 提示，调用方无需额外处理）
   */
  async function createFile(parentDir: string, name: string): Promise<boolean> {
    const fullPath = joinPath(parentDir, name);
    setPendingOp(fullPath, true);
    try {
      const res = await window.api.file.create({ path: fullPath, createDirs: false });
      if ('error' in res) {
        toast.error('创建文件失败', { description: res.error.message });
        return false;
      }
      cancelCreate();
      return true;
    } catch (err) {
      toast.error('创建文件异常', { description: String(err) });
      return false;
    } finally {
      setPendingOp(fullPath, false);
    }
  }

  /**
   * 创建新目录
   *
   * @param parentDir 父目录绝对路径
   * @param name 新目录名
   */
  async function createDir(parentDir: string, name: string): Promise<boolean> {
    const fullPath = joinPath(parentDir, name);
    setPendingOp(fullPath, true);
    try {
      const res = await window.api.file.createDir({ path: fullPath });
      if ('error' in res) {
        toast.error('创建目录失败', { description: res.error.message });
        return false;
      }
      cancelCreate();
      return true;
    } catch (err) {
      toast.error('创建目录异常', { description: String(err) });
      return false;
    } finally {
      setPendingOp(fullPath, false);
    }
  }

  /**
   * 删除文件或目录
   *
   * @param path 目标绝对路径
   */
  async function deleteEntry(path: string): Promise<boolean> {
    setPendingOp(path, true);
    try {
      const res = await window.api.file.delete({ path, recursive: true });
      if ('error' in res) {
        toast.error('删除失败', { description: res.error.message });
        return false;
      }
      return true;
    } catch (err) {
      toast.error('删除异常', { description: String(err) });
      return false;
    } finally {
      setPendingOp(path, false);
    }
  }

  /**
   * 重命名/移动文件或目录
   *
   * @param oldPath 原路径
   * @param newName 新名称（不含路径分隔符，新路径自动通过 dirname 拼接）
   */
  async function renameEntry(oldPath: string, newName: string): Promise<boolean> {
    const newPath = joinPath(dirname(oldPath), newName);
    setPendingOp(oldPath, true);
    try {
      const res = await window.api.file.rename({
        oldPath,
        newPath,
        overwrite: false,
      });
      if ('error' in res) {
        toast.error('重命名失败', { description: res.error.message });
        return false;
      }
      cancelRename();
      return true;
    } catch (err) {
      toast.error('重命名异常', { description: String(err) });
      return false;
    } finally {
      setPendingOp(oldPath, false);
    }
  }

  return { createFile, createDir, deleteEntry, renameEntry };
}

/**
 * 路径拼接（兼容 Windows 反斜杠与 POSIX 正斜杠）
 *
 * 自动处理分隔符：若 parentDir 以分隔符结尾或 name 以分隔符开头，
 * 避免重复分隔符。空 parentDir 时直接返回 name。
 */
function joinPath(parentDir: string, name: string): string {
  if (parentDir === '') return name;
  // 同时支持 \ 和 / 分隔符，取最后出现的作为当前分隔符
  const lastSlash = parentDir.lastIndexOf('/');
  const lastBackslash = parentDir.lastIndexOf('\\');
  const sep = lastBackslash > lastSlash ? '\\' : '/';
  const trimmedParent = parentDir.replace(/[\\/]+$/, '');
  const trimmedName = name.replace(/^[\\/]+/, '');
  return `${trimmedParent}${sep}${trimmedName}`;
}

/**
 * 计算父目录路径（与 use-file-tree.ts 中的 dirname 行为一致）
 */
function dirname(path: string): string {
  const lastSlash = path.lastIndexOf('/');
  const lastBackslash = path.lastIndexOf('\\');
  const idx = Math.max(lastSlash, lastBackslash);
  if (idx <= 0) return path;
  return path.slice(0, idx);
}
