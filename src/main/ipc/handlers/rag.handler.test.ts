// src/main/ipc/handlers/rag.handler.test.ts
// rag.handler 单元测试
// 设计文档 §4.1 分层架构：handler 是薄层，只验证调用关系（参数传递 + 返回值）
// §6.4 HNSW 索引 / §6.2 RagDocument 模型
//
// 测试策略：
// 1. mock wrap()，捕获所有注册的 channel + schema + handler
// 2. mock rag.service 所有函数
// 3. 验证 register 函数注册了 4 个 channel
// 4. 验证每个 handler 回调正确调用对应 service 函数

import { IPC_CHANNELS } from '@novel-writer/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMockCtx,
  findRegistration,
  type WrapRegistration,
} from '../../__tests__/helpers/mock-wrap';

// vi.hoisted 模式：避免 vi.mock factory TDZ（参考 wrap.test.ts）
const { registrations } = vi.hoisted(() => ({
  registrations: [] as WrapRegistration[],
}));

// mock wrap：捕获注册记录，不调用真实 ipcMain.handle
vi.mock('../../utils/wrap', () => ({
  wrap: (
    channel: string,
    schema: unknown,
    handler: (input: unknown, ctx: unknown) => Promise<unknown>,
  ) => {
    registrations.push({ channel, schema, handler });
  },
}));

// mock rag.service：所有函数返回可识别的固定值
vi.mock('../../services/rag.service', () => ({
  ingestDocument: vi.fn().mockResolvedValue({ documentId: 'd1', chunksCount: 3 }),
  searchSimilarChunks: vi
    .fn()
    .mockResolvedValue([{ chunkId: 'ck1', documentId: 'd1', content: '片段 1', score: 0.92 }]),
  listRagDocuments: vi.fn().mockResolvedValue([{ id: 'd1', title: '设定集', chunksCount: 3 }]),
  deleteRagDocument: vi.fn().mockResolvedValue({ id: 'd1' }),
}));

import {
  deleteRagDocument,
  ingestDocument,
  listRagDocuments,
  searchSimilarChunks,
} from '../../services/rag.service';
import { registerRagHandlers } from './rag.handler';

describe('rag.handler', () => {
  beforeEach(() => {
    registrations.length = 0;
    registerRagHandlers();
  });

  it('注册 4 个 channel', () => {
    expect(registrations).toHaveLength(4);
    expect(registrations.map((r) => r.channel)).toEqual(
      expect.arrayContaining([
        IPC_CHANNELS.RAG_INGEST_DOCUMENT,
        IPC_CHANNELS.RAG_SEARCH,
        IPC_CHANNELS.RAG_LIST_DOCUMENTS,
        IPC_CHANNELS.RAG_DELETE_DOCUMENT,
      ]),
    );
  });

  it('ingestDocument 透传 input 调用 ingestDocument', async () => {
    const handler = findRegistration(registrations, IPC_CHANNELS.RAG_INGEST_DOCUMENT).handler;
    const input = {
      projectId: 'p1',
      title: '设定集',
      fileContent: '一段设定内容',
    };
    const result = await handler(input, createMockCtx());
    expect(ingestDocument).toHaveBeenCalledWith(input);
    expect(result).toEqual({ documentId: 'd1', chunksCount: 3 });
  });

  it('search 透传 input 调用 searchSimilarChunks', async () => {
    const handler = findRegistration(registrations, IPC_CHANNELS.RAG_SEARCH).handler;
    const input = {
      projectId: 'p1',
      query: '搜索词',
      topK: 5,
      threshold: 0.7,
    };
    const result = await handler(input, createMockCtx());
    expect(searchSimilarChunks).toHaveBeenCalledWith(input);
    expect(result).toEqual([{ chunkId: 'ck1', documentId: 'd1', content: '片段 1', score: 0.92 }]);
  });

  it('listDocuments 从 input 提取 projectId 调用 listRagDocuments', async () => {
    const handler = findRegistration(registrations, IPC_CHANNELS.RAG_LIST_DOCUMENTS).handler;
    const result = await handler({ projectId: 'p1' }, createMockCtx());
    expect(listRagDocuments).toHaveBeenCalledWith('p1');
    expect(result).toEqual([{ id: 'd1', title: '设定集', chunksCount: 3 }]);
  });

  it('deleteDocument 从 input 提取 id 调用 deleteRagDocument', async () => {
    const handler = findRegistration(registrations, IPC_CHANNELS.RAG_DELETE_DOCUMENT).handler;
    const result = await handler({ id: 'd1' }, createMockCtx());
    expect(deleteRagDocument).toHaveBeenCalledWith('d1');
    expect(result).toEqual({ id: 'd1' });
  });
});
