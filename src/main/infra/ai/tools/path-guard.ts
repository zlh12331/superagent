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
  // 上限防深路径死循环（正常路径解析次数远小于此）
  for (let i = 0; i < 64; i += 1) {
    try {
      // 2026-09-08 修复：此前用 resolve(realpathSync(current), ...tail)——当
      // realpathSync 返回绝对路径且 tail 非空时，resolve 会把 tail 当作新的
      // 绝对路径段重新解析，产出畸形路径（实测 Windows：
      // `<tmp>\src\C:\Users\...\alias\main.ts`）。改用 join 做纯字符串拼接。
      return join(realpathSync(current), ...tail);
    } catch {
      const parent = dirname(current);
      // 2026-09-08：到根仍失败 → 返回 null（此前回退原路径，使边界检查退化）
      if (parent === current) return null;
      tail.unshift(basename(current));
      current = parent;
    }
  }
  return null;
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
  //
  // 2026-09-08 修复（fail closed）：resolveRealTarget 解析失败时此前回退原路径，
  // 使边界检查退化为纯字符串比较（symlink 可绕过）。现在解析失败直接拒绝——
  // 拿不到真实落点就无法证明路径在边界内，按拒绝处理。
  const realTarget = resolveRealTarget(resolved);
  if (realTarget === null) {
    throw new AppError(
      ErrorCode.UNAUTHORIZED,
      `无法解析路径的真实落点（可能含损坏/循环符号链接）：${resolved}`,
    );
  }
  // 2026-09-09 修复：工作目录同样做 realpath 规范化后与 realTarget 对称比较。
  // 此前用 workingDir 原始字符串比较——macOS/Linux 的临时目录常是符号链接
  // （macOS /tmp → /private/tmp、/var → /private/var），realTarget 已是真实路径，
  // 两者前缀不一致导致 relative() 误判越界，整批解析型用例在 CI 失败。
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

  // 说明（2026-09-08 评估后保留现状）：返回 resolved 而非 realTarget。
  // 返回 realTarget 能彻底消除「校验与 IO 之间换链」的 TOCTOU 窗口，
  // 但会改变所有工具返回给模型/UI 的路径形态（symlink 路径被解析成真实路径），
  // 影响面覆盖 read/write/edit/grep/glob/terminal 等全部文件工具，
  // 且与本条债的收益不成比例。此处保留返回 resolved，
  // TOCTOU 残余风险记录在技术债清单（需要时按"返回 realTarget + 全量回归"专项处理）。
  return resolved;
}
