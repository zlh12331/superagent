// src/main/ipc/handlers/worldview.handler.ts
// 世界观域 IPC handler（薄层）
// 设计文档 §4.1 分层架构：handler 只做参数校验 + 调 service
// §6.2 Worldview 模型：自关联树形，service 返回扁平数组，渲染层组装树
//
// 职责：
// 1. 注册 worldview 域 4 个 channel（create/tree/update/delete）
// 2. 通过 wrap() 统一包装：sender 校验 + traceId + zod 校验 + 错误处理
// 3. tree 从 input 提取 projectId，返回扁平世界观条目数组
//
// 注意：
// - handler 不持有状态，不直接访问 Prisma
// - create/update 透传 input（schema 已校验）
// - tree/delete 使用内联 z.object schema

import {
  IPC_CHANNELS,
  WorldviewCreateInputSchema,
  WorldviewUpdateInputSchema,
} from '@novel-writer/shared';
import { z } from 'zod';
import {
  createWorldview,
  deleteWorldview,
  getWorldviewTree,
  updateWorldview,
} from '../../services/worldview.service';
import { wrap } from '../../utils/wrap';

/**
 * 注册 worldview 域 IPC handler
 *
 * 注册 4 个 channel：
 * - worldview:create → createWorldview
 * - worldview:tree   → getWorldviewTree
 * - worldview:update → updateWorldview
 * - worldview:delete → deleteWorldview
 */
export function registerWorldviewHandlers(): void {
  // 创建世界观条目：透传 input（WorldviewCreateInputSchema 已校验）
  wrap(IPC_CHANNELS.WORLDVIEW_CREATE, WorldviewCreateInputSchema, (input) =>
    createWorldview(input),
  );

  // 获取世界观树（扁平数组）：从 input 提取 projectId
  wrap(IPC_CHANNELS.WORLDVIEW_TREE, z.object({ projectId: z.string().min(1) }), (input) =>
    getWorldviewTree(input.projectId),
  );

  // 更新世界观条目：透传 input（WorldviewUpdateInputSchema 已校验）
  wrap(IPC_CHANNELS.WORLDVIEW_UPDATE, WorldviewUpdateInputSchema, (input) =>
    updateWorldview(input),
  );

  // 删除世界观条目（DB 层级联删除子节点）：从 input 提取 id
  wrap(IPC_CHANNELS.WORLDVIEW_DELETE, z.object({ id: z.string().min(1) }), (input) =>
    deleteWorldview(input.id),
  );
}
