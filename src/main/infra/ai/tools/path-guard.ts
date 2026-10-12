// path-guard.ts：路径越权守卫——解析后必须在 workingDir 内 + realpath 追踪符号链接真身
// （防 `link → /etc` 逃逸）；所有文件工具与 file 域 IPC 共用此守卫
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { AppError, ErrorCode } from '@code-agent/shared/main';

// realpath 解析：目标不存在时逐级回退到存在的最近祖先再拼回尾巴（新建文件场景）；
// 64 层上限防符号链接循环
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

/** 解析结果：词法落点（resolved）+ 真实落点（realTarget，穿透符号链接后） */
export interface ResolvedWorkspacePath {
  readonly resolved: string;
  readonly realTarget: string;
}

/**
 * 工作区路径守卫：空路径拒 / 解析出界拒 / 真实落点出界拒——三关全过才放行
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
