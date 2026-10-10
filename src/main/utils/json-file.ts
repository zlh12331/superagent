// json-file.ts：JSON 导入文件读取（会话导入等场景）——大小护栏 + AppError 归一
import { readFile, stat } from 'node:fs/promises';
import { AppError, ErrorCode } from '@code-agent/shared/main';

// 256MB 上限：JSON.parse 无流式能力，全量进内存，护栏防一个超大文件把主进程打爆
const MAX_IMPORT_FILE_BYTES = 256 * 1024 * 1024;

/** 读取导入用 JSON 文件；超大或非法 JSON 抛 AppError(INVALID_INPUT)（IPC 层可直接透传给渲染层） */
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
