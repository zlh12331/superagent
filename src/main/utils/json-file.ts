import { readFile, stat } from 'node:fs/promises';
import { AppError, ErrorCode } from '@code-agent/shared/main';

const MAX_IMPORT_FILE_BYTES = 256 * 1024 * 1024;

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
