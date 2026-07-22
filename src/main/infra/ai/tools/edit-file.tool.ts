// src/main/infra/ai/tools/edit-file.tool.ts
// edit_file 工具：基于字符串替换的结构化文件编辑
// ──────────────────────────────────────────────────────────────
// 职责：
// - 接收 LLM 生成的 path / oldString / newString / replaceAll 入参
// - 通过 path-guard 把路径解析为 workingDir 内的绝对路径
// - 读取文件 → 校验 oldString 唯一性 → 替换 → 写回
//
// 权限：'ask'（写操作有副作用，需用户审批）
// - 替换可能改变代码语义
// - 误替换可能导致功能损坏
// - 用户需确认后再执行
//
// 设计原则：
// - 字符串替换模式（参考 Claude Code / Aider）：
//   · oldString 必须在文件中存在且唯一（除非 replaceAll=true）
//   · newString 为替换内容（可为空字符串，表示删除）
//   · replaceAll=true 时替换所有匹配项
// - 不使用 diff-match-patch 等外部依赖，保持零依赖
// - 原子性：读取 → 替换 → 写回，中途失败不修改文件
//   （FileService.write 是覆盖写入，要么成功要么失败）
// - 返回 diff 摘要：addedLines / removedLines / bytesWritten
//
// 与 write_file 工具的区别：
// - write_file：整文件覆盖（适合新建或大改）
// - edit_file：精确替换（适合小范围修改，保留未修改部分）
//
// 入参：
// - path：文件路径（相对或绝对）
// - oldString：要查找的字符串（必须非空，且在文件中存在）
// - newString：替换后的字符串（可为空字符串，表示删除）
// - replaceAll：是否替换所有匹配项（默认 false，要求 oldString 唯一）
//
// 输出：
// - bytesWritten：实际写入字节数
// - replacedCount：替换的匹配项数量
// - addedLines：新增行数
// - removedLines：删除行数
// ──────────────────────────────────────────────────────────────

import { promises as fs } from 'node:fs';
import { AppError, ErrorCode } from '@novel-writer/shared';
import { z } from 'zod';
import type { Tool, ToolContext } from '../tool';
import { resolveWithinWorkspace } from './path-guard';

/**
 * edit_file 工具入参 zod schema
 *
 * oldString 必须非空（防止误传空字符串导致无限匹配）。
 * newString 可为空字符串（表示删除 oldString）。
 */
const EditFileInputSchema = z.object({
  path: z.string().min(1).describe('文件路径（相对路径基于工作目录解析）'),
  oldString: z
    .string()
    .min(1)
    .describe('要查找的字符串（必须在文件中存在；除非 replaceAll=true，否则必须唯一）'),
  newString: z.string().describe('替换后的字符串（可为空字符串，表示删除 oldString）'),
  replaceAll: z
    .boolean()
    .default(false)
    .describe('是否替换所有匹配项（默认 false，要求 oldString 在文件中唯一）'),
});

/** edit_file 工具入参类型（从 schema 派生） */
type EditFileInput = z.infer<typeof EditFileInputSchema>;

/** edit_file 工具输出 */
interface EditFileOutput {
  /** 实际写入的字节数 */
  readonly bytesWritten: number;
  /** 替换的匹配项数量 */
  readonly replacedCount: number;
  /** 新增行数（newString 行数 × 替换次数） */
  readonly addedLines: number;
  /** 删除行数（oldString 行数 × 替换次数） */
  readonly removedLines: number;
}

/**
 * 计算字符串行数
 *
 * 空字符串算 0 行；"a\nb" 算 2 行；"a\n" 算 1 行（末尾换行不计行）。
 * 与 split('\n') 行为一致，便于统计 diff。
 */
function countLines(s: string): number {
  if (s.length === 0) return 0;
  return s.split('\n').length;
}

/**
 * 工厂函数：创建 edit_file 工具实例
 *
 * @returns Tool 实例（permission: 'ask'）
 */
export function createEditFileTool(): Tool<EditFileInput, EditFileOutput> {
  return {
    name: 'edit_file',
    description:
      '通过字符串替换精确编辑文件（不重写整个文件）。查找 oldString 并替换为 newString，默认要求 oldString 在文件中唯一（防止误替换）。设置 replaceAll=true 可替换所有匹配项。newString 为空字符串时表示删除 oldString。会修改文件系统，需用户审批后执行。',
    inputSchema: EditFileInputSchema,
    permission: 'ask',
    execute: async (input: EditFileInput, ctx: ToolContext): Promise<EditFileOutput> => {
      // 路径解析与边界检查
      const absPath = resolveWithinWorkspace(input.path, ctx.workingDir);

      // 1. 读取原文件内容
      // 文件不存在时抛 NOT_FOUND（oldString 无法在空文件中找到）
      let original: string;
      try {
        original = await fs.readFile(absPath, 'utf-8');
      } catch (error) {
        const nodeError = error as { code?: string };
        if (nodeError.code === 'ENOENT') {
          throw new AppError(ErrorCode.NOT_FOUND, `文件不存在：${absPath}`, error);
        }
        throw new AppError(ErrorCode.FS_READ_FAILED, '读取文件失败', error);
      }

      // 2. 统计 oldString 出现次数
      // 使用 split 方式统计（避免正则元字符干扰）
      const parts = original.split(input.oldString);
      const matchCount = parts.length - 1;

      if (matchCount === 0) {
        // oldString 未找到：返回明确错误，便于 LLM 修正
        throw new AppError(
          ErrorCode.INVALID_INPUT,
          `oldString 在文件中未找到。请先用 read_file 工具查看文件内容，确认 oldString 与文件实际内容完全一致（包括缩进、换行符）。`,
        );
      }

      if (matchCount > 1 && !input.replaceAll) {
        // 多次匹配但未启用 replaceAll：拒绝执行，避免误替换
        throw new AppError(
          ErrorCode.INVALID_INPUT,
          `oldString 在文件中出现 ${matchCount} 次，但 replaceAll=false。请提供更长、更唯一的 oldString，或设置 replaceAll=true 替换所有匹配项。`,
        );
      }

      // 3. 执行替换
      // replaceAll=true 时全部替换；否则只替换第一处（split + join 等价于 replaceAll）
      // 注意：split + join 会替换所有匹配项，与 replaceAll=true 行为一致
      // 单次替换场景下 matchCount===1，split + join 等价于单次替换
      const updated =
        matchCount === 1
          ? original.replace(input.oldString, input.newString)
          : original.split(input.oldString).join(input.newString);

      // 4. 统计 diff 摘要
      const replacedCount = input.replaceAll ? matchCount : 1;
      const oldLines = countLines(input.oldString);
      const newLines = countLines(input.newString);
      const addedLines = newLines * replacedCount;
      const removedLines = oldLines * replacedCount;

      // 5. 写回文件（覆盖写入）
      // 不自动创建父目录（edit_file 假定文件已存在）
      try {
        const buffer = Buffer.from(updated, 'utf-8');
        await fs.writeFile(absPath, buffer);
        return {
          bytesWritten: buffer.byteLength,
          replacedCount,
          addedLines,
          removedLines,
        };
      } catch (error) {
        throw new AppError(ErrorCode.FS_WRITE_FAILED, '写入文件失败', error);
      }
    },
  };
}
