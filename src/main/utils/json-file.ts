// src/main/utils/json-file.ts
// 导入通道的 JSON 文件读取（大小上限 + 解析，session:import / settings:import 共用）
// ──────────────────────────────────────────────────────────────

import { readFile, stat } from 'node:fs/promises';
import { AppError, ErrorCode } from '@code-agent/shared/main';

/** 导入文件大小上限（256 MB）：防超界文件把主进程内存拖垮（读入为 UTF-8 串再解析） */
const MAX_IMPORT_FILE_BYTES = 256 * 1024 * 1024;

/**
 * 读取导入 JSON 文件并解析为 unknown
 *
 * 格式级校验（版本 / 字段）由各域的 zod schema 负责，此处只兜底
 * 「文件级异常」：超限与非法 JSON——两者都按 INVALID_INPUT 上报渲染层。
 *
 * @throws AppError(INVALID_INPUT) 文件超限或不是合法 JSON
 */
export async function readJsonImportFile(filePath: string): Promise<unknown> {
  const info = await stat(filePath);
  if (info.size > MAX_IMPORT_FILE_BYTES) {
    throw new AppError(
      ErrorCode.INVALID_INPUT,
      `导入文件过大（${info.size} > ${MAX_IMPORT_FILE_BYTES} 字节）`,
    );
  }
  const raw = await readFile(filePath, 'utf8');
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new AppError(ErrorCode.INVALID_INPUT, '导入文件不是合法 JSON', error);
  }
}
