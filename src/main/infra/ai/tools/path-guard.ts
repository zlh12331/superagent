// src/main/infra/ai/tools/path-guard.ts
// 路径安全守卫：统一处理 LLM 输入路径到绝对路径的解析与边界检查
// ──────────────────────────────────────────────────────────────
// 职责：
// - resolveWithinWorkspace：把 LLM 提供的路径（相对或绝对）解析为绝对路径
// - 确保解析后的路径在 workingDir 内，防止路径遍历攻击（如 ../etc/passwd）
//
// 设计原则：
// - 所有文件/搜索工具共享此守卫，避免每个工具重复实现边界检查
// - 使用 path.relative 判断是否越界，比 startsWith 更健壮
//   （处理 Windows 盘符大小写、尾部分隔符差异）
// - 越界抛出 AppError(UNAUTHORIZED)，由 ToolExecutor 捕获转为 ToolResult.error
//
// 使用示例：
// ```ts
// const absPath = resolveWithinWorkspace(input.path, ctx.workingDir);
// await fileService.read({ path: absPath, ... });
// ```
// ──────────────────────────────────────────────────────────────

import { isAbsolute, relative, resolve } from 'node:path';
import { AppError, ErrorCode } from '@novel-writer/shared';

/**
 * 解析路径并确保在 workingDir 内
 *
 * 行为：
 * - 空路径抛 INVALID_INPUT
 * - 相对路径基于 workingDir 解析为绝对路径
 * - 绝对路径直接使用（但仍需通过边界检查）
 * - 解析后的路径若在 workingDir 之外，抛 UNAUTHORIZED
 *
 * @param inputPath LLM 提供的路径（可能是相对或绝对）
 * @param workingDir 工作目录约束（绝对路径）
 * @returns 解析后的绝对路径（已通过边界检查）
 *
 * @throws AppError(INVALID_INPUT) 路径为空
 * @throws AppError(UNAUTHORIZED) 路径越权访问
 */
export function resolveWithinWorkspace(inputPath: string, workingDir: string): string {
  // 空路径校验
  if (!inputPath || inputPath.length === 0) {
    throw new AppError(ErrorCode.INVALID_INPUT, '路径不能为空');
  }

  // 相对路径基于 workingDir 解析；绝对路径 resolve 会保持原样（仅标准化）
  const resolved = resolve(workingDir, inputPath);

  // 路径遍历保护：计算 resolved 相对 workingDir 的相对路径
  // - 若结果以 '..' 开头，表示 resolved 在 workingDir 之外
  // - 若结果是绝对路径（Windows 跨盘符场景），也表示越界
  const rel = relative(workingDir, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new AppError(
      ErrorCode.UNAUTHORIZED,
      `路径越权访问：${inputPath} 解析为 ${resolved}，超出工作目录 ${workingDir}`,
    );
  }

  return resolved;
}
