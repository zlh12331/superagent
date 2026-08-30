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

import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { AppError, ErrorCode } from '@code-agent/shared/main';

/**
 * 解析路径的最终落点（含符号链接）
 *
 * 字符串级路径检查不解析 symlink——workingDir 内 `link -> /etc` 时读写实际
 * 发生在外部。本函数用 realpathSync 解析真实落点：
 * - 路径存在：直接 realpath（文件/目录本身）
 * - 路径不存在（新建文件等）：对最近已存在的祖先目录 realpath，再拼回剩余
 *   basename 段（新建文件的落点 = 父目录真实位置 + 文件名；父目录链中若含
 *   symlink 同样被解析）
 *
 * @returns 最终落点绝对路径（解析失败等极端情况回退原路径，由上层 IO 报错兜底）
 */
export function resolveRealTarget(p: string): string {
  const tail: string[] = [];
  let current = p;
  // 上限防深路径死循环（正常路径解析次数远小于此）
  for (let i = 0; i < 64; i += 1) {
    try {
      return resolve(realpathSync(current), ...tail);
    } catch {
      const parent = dirname(current);
      if (parent === current) return p; // 到根仍失败，回退原路径
      tail.unshift(basename(current));
      current = parent;
    }
  }
  return p;
}

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
  // 空路径校验（含纯空白路径：LLM 可能输出无意义空白）
  if (!inputPath || inputPath.trim().length === 0) {
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

  // P1 安全修复（2026-08 安全审计）：字符串级检查不解析符号链接——
  // workingDir 内 symlink 指向外部时，实际 IO 发生在外部。
  // 解析最终落点（realpath）后重新校验边界；仅校验落点，
  // 不拒绝工作目录内的合法 symlink（如 pnpm node_modules 结构）。
  const realTarget = resolveRealTarget(resolved);
  const relReal = relative(workingDir, realTarget);
  if (relReal.startsWith('..') || isAbsolute(relReal)) {
    throw new AppError(
      ErrorCode.UNAUTHORIZED,
      `路径符号链接指向工作目录之外：${resolved} -> ${realTarget}`,
    );
  }

  return resolved;
}
