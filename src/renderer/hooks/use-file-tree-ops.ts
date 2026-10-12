import { toast } from 'sonner';

import { useTranslation } from '@/i18n/use-translation';
import { unwrap } from '@/lib/ipc';
import { useFileTreeStore } from '@/stores/transient/file-tree-store';

/**
 * useFileTreeOps：文件树编辑操作 hook
 *
 * 提供 createFile / createDir 两个方法，
 * 自动管理父目录的 pendingDirs 状态和内联编辑状态。
 *
 * @example
 * ```tsx
 * const ops = useFileTreeOps();
 * await ops.createFile('/path/to/parent', 'newfile.ts');
 * await ops.deleteEntry('/path/to/file');
 * ```
 */
export function useFileTreeOps() {
  const { t } = useTranslation();
  const setPendingDir = useFileTreeStore((s) => s.setPendingDir);
  const cancelCreate = useFileTreeStore((s) => s.cancelCreate);

  /**
   * 创建新文件
   *
   * 成功后取消内联编辑状态，依赖 file:watch 的 create 事件自动刷新父目录。
   *
   * pending 标记挂在**父目录**路径上：新建条目此刻尚不存在于 entries，
   * 若按 fullPath 标记，`.ft-row.pending` 永远命中不到任何已渲染行（状态
   * 无法抵达 UI）。挂父目录才能在 IPC 在途期间给出真实的「进行中」反馈。
   *
   * @param parentDir 父目录绝对路径
   * @param name 新文件名（不含路径分隔符）
   * @returns 是否成功（失败时已 toast 提示，调用方无需额外处理）
   */
  async function createFile(parentDir: string, name: string): Promise<boolean> {
    setPendingDir(parentDir, true);
    let ok = false;
    try {
      unwrap(await window.api.file.create({ path: joinPath(parentDir, name), createDirs: false }));
      cancelCreate();
      ok = true;
    } catch (err) {
      toast.error(t('common.createFileFailed'), {
        description: err instanceof Error ? err.message : String(err),
      });
    }
    setPendingDir(parentDir, false);
    return ok;
  }

  /**
   * 创建新目录
   *
   * @param parentDir 父目录绝对路径
   * @param name 新目录名
   * @returns 是否成功（失败时已 toast 提示，调用方无需额外处理）
   */
  async function createDir(parentDir: string, name: string): Promise<boolean> {
    setPendingDir(parentDir, true);
    let ok = false;
    try {
      unwrap(await window.api.file.createDir({ path: joinPath(parentDir, name) }));
      cancelCreate();
      ok = true;
    } catch (err) {
      toast.error(t('common.createDirFailed'), {
        description: err instanceof Error ? err.message : String(err),
      });
    }
    setPendingDir(parentDir, false);
    return ok;
  }

  return { createFile, createDir };
}

/**
 * 路径拼接（兼容 Windows 反斜杠与 POSIX 正斜杠）
 *
 * 自动处理分隔符：若 parentDir 以分隔符结尾或 name 以分隔符开头，
 * 避免重复分隔符。空 parentDir 时直接返回 name。
 */
export function joinPath(parentDir: string, name: string): string {
  if (parentDir === '') return name;
  const lastSlash = parentDir.lastIndexOf('/');
  const lastBackslash = parentDir.lastIndexOf('\\');
  const sep = lastBackslash > lastSlash ? '\\' : '/';
  const trimmedParent = parentDir.replace(/[\\/]+$/, '');
  const trimmedName = name.replace(/^[\\/]+/, '');
  return `${trimmedParent}${sep}${trimmedName}`;
}
