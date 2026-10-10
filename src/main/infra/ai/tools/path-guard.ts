import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
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
 * @returns 最终落点绝对路径；到根仍无法解析时返回 null（调用方 fail closed）
 */
export function resolveRealTarget(p: string): string | null {
  const tail: string[] = [];
  let current = p;
  for (let i = 0; i < 64; i += 1) {
    try {
      return join(realpathSync(current), ...tail);
    } catch {
      const parent = dirname(current);
      if (parent === current) return null;
      tail.unshift(basename(current));
      current = parent;
    }
  }
  return null;
}

/** resolveWithinWorkspace 的双形态结果 */
export interface ResolvedWorkspacePath {
  /** 输入形态解析出的绝对路径（对外展示/回传给模型；symlink 不解析，形态稳定） */
  readonly resolved: string;
  /** 真实落点（realpath 已验证在工作区内；**文件 IO 必须用它**，见头注释 TOCTOU 段） */
  readonly realTarget: string;
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
 * @returns 双形态：resolved（展示用）+ realTarget（IO 用，见头注释 TOCTOU 段）
 *
 * @throws AppError(INVALID_INPUT) 路径为空
 * @throws AppError(UNAUTHORIZED) 路径越权访问
 */
export function resolveWithinWorkspace(
  inputPath: string,
  workingDir: string,
): ResolvedWorkspacePath {
  if (!inputPath || inputPath.trim().length === 0) {
    throw new AppError(ErrorCode.INVALID_INPUT, '路径不能为空');
  }

  const resolved = resolve(workingDir, inputPath);

  const rel = relative(workingDir, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new AppError(
      ErrorCode.UNAUTHORIZED,
      `路径越权访问：${inputPath} 解析为 ${resolved}，超出工作目录 ${workingDir}`,
    );
  }

  const realTarget = resolveRealTarget(resolved);
  if (realTarget === null) {
    throw new AppError(
      ErrorCode.UNAUTHORIZED,
      `无法解析路径的真实落点（可能含损坏/循环符号链接）：${resolved}`,
    );
  }
  const realWorkingDir = resolveRealTarget(workingDir);
  if (realWorkingDir === null) {
    throw new AppError(ErrorCode.UNAUTHORIZED, `无法解析工作目录的真实落点：${workingDir}`);
  }
  const relReal = relative(realWorkingDir, realTarget);
  if (relReal.startsWith('..') || isAbsolute(relReal)) {
    throw new AppError(
      ErrorCode.UNAUTHORIZED,
      `路径符号链接指向工作目录之外：${resolved} -> ${realTarget}`,
    );
  }

  return { resolved, realTarget };
}
