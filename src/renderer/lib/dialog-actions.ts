import type { DialogPickDirectoryRes, DialogPickFilesRes } from '@code-agent/shared/renderer';

import { hasIpcBridge, unwrap } from '@/lib/ipc';

/**
 * 打开多选文件对话框
 *
 * @returns 无桥时视为用户取消（canceled: true），保证调用方可统一按取消分支处理
 */
export async function pickFiles(
  options: { readonly multiple?: boolean } = {},
): Promise<DialogPickFilesRes> {
  if (!hasIpcBridge()) {
    return { canceled: true };
  }
  return unwrap(
    await window.api.dialog.pickFiles({
      ...(options.multiple !== undefined ? { multiple: options.multiple } : {}),
    }),
  );
}

/**
 * 打开目录选择对话框
 *
 * @returns 无桥时视为用户取消（canceled: true）
 */
export async function pickDirectory(): Promise<DialogPickDirectoryRes> {
  if (!hasIpcBridge()) {
    return { canceled: true };
  }
  return unwrap(await window.api.dialog.pickDirectory({}));
}
