// src/main/infra/rag/pdf-parser.ts
// PDF 文本抽取基础设施
// 设计文档 §4.2 rag.service / §6 RAG 检索增强 / §7.4 错误处理流程
//
// 职责：
// - 封装 pdf-parse 库（PDFParse 类），把 PDF 二进制解析为纯文本
// - 暴露 parsePdfToText(data: Uint8Array) 单一函数给 rag.service 调用
// - 失败时抛 AppError(RAG_DOCUMENT_PARSE_FAILED)（聚合底层异常，避免污染上层）
//
// 设计要点：
// 1. pdf-parse 依赖 @napi-rs/canvas（Node 原生模块），只能在主进程使用，渲染层不可用
// 2. PDFParse 实例非线程安全，每次解析新建实例并 destroy 释放 worker 资源
// 3. 用 try/finally 保证 destroy 一定被调用（避免 worker 泄漏导致内存增长）
// 4. 解析得到的 text 是按页拼接的全文档字符串（pdf-parse 已处理页间分隔）
//
// 注意：
// - 调用方需保证传入的 Uint8Array 是完整有效的 PDF 二进制（前 4 字节应为 %PDF）
// - 解析过程可能因为加密 PDF / 损坏 PDF / 图片型 PDF 而返回空字符串或抛错
//   - 空字符串：上层 rag.service 会因切片无有效内容返回 chunksCount=0
//   - 抛错：本模块统一包装为 AppError(RAG_DOCUMENT_PARSE_FAILED)

import { AppError, ErrorCode } from '@novel-writer/shared';
import { PDFParse } from 'pdf-parse';

import { logger } from '../../utils/logger';

/**
 * 把 PDF 二进制解析为纯文本
 *
 * @param data - PDF 文件的二进制内容（Uint8Array / Buffer 均可，PDFParse 内部会归一化）
 * @returns 解析得到的全文文本（按页拼接，可能为空字符串）
 *
 * @throws AppError(RAG_DOCUMENT_PARSE_FAILED) PDF 解析失败（文件损坏 / 加密 / 不支持）
 *
 * @example
 * ```ts
 * const buffer = await fs.readFile('设定集.pdf');
 * const text = await parsePdfToText(new Uint8Array(buffer));
 * console.log(text); // 解析得到的全文
 * ```
 */
export async function parsePdfToText(data: Uint8Array): Promise<string> {
  logger.info({ size: data.byteLength }, '开始解析 PDF');

  // 用 try/finally 确保 destroy 一定被调用（释放 pdfjs 内部 worker）
  // 注意：PDFParse 构造时不会真正读取数据，只有 getText 才会触发解析
  const parser = new PDFParse({ data });
  try {
    const result = await parser.getText();
    logger.info({ size: data.byteLength, textLength: result.text.length }, 'PDF 解析完成');
    return result.text;
  } catch (error) {
    // 聚合底层 pdfjs 异常，统一抛 AppError 给上层处理
    // 保留 cause 便于排查（AppError.toIpcError 不会序列化 cause，只在日志中可见）
    throw new AppError(
      ErrorCode.RAG_DOCUMENT_PARSE_FAILED,
      `PDF 解析失败：${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  } finally {
    // 无论成功失败都释放 worker 资源（避免内存泄漏）
    try {
      await parser.destroy();
    } catch (destroyError) {
      // destroy 失败不影响主流程，仅记录日志
      logger.warn(
        { error: destroyError instanceof Error ? destroyError.message : String(destroyError) },
        'PDF 解析器 destroy 失败（已忽略）',
      );
    }
  }
}
