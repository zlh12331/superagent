// src/main/ipc/handlers/project.handler.ts
// 项目域 IPC handler（薄层）
// 设计文档 §4.1 分层架构：handler 只做参数校验 + 调 service
//
// 职责：
// 1. 注册 project 域 6 个 channel（create/list/get/update/delete/archive）
// 2. 通过 wrap() 统一包装：sender 校验 + traceId + zod 校验 + 错误处理
// 3. 回调函数为箭头函数，透传 input 或提取 id 后调用对应 service
//
// 注意：
// - handler 不持有状态，不直接访问 Prisma
// - 简单入参（{ id }）使用内联 z.object schema
// - 复杂入参使用 shared 包导出的 Zod schema

import {
  IPC_CHANNELS,
  ProjectCreateInputSchema,
  ProjectUpdateInputSchema,
} from '@novel-writer/shared';
import { z } from 'zod';
import {
  archiveProject,
  createProject,
  deleteProject,
  getProject,
  listProjects,
  updateProject,
} from '../../services/project.service';
import { wrap } from '../../utils/wrap';

/**
 * 注册 project 域 IPC handler
 *
 * 注册 6 个 channel：
 * - project:create  → createProject
 * - project:list    → listProjects
 * - project:get     → getProject
 * - project:update  → updateProject
 * - project:delete  → deleteProject
 * - project:archive → archiveProject
 */
export function registerProjectHandlers(): void {
  // 创建项目：透传 input（ProjectCreateInputSchema 已校验）
  wrap(IPC_CHANNELS.PROJECT_CREATE, ProjectCreateInputSchema, (input) => createProject(input));

  // 列出项目：无入参
  wrap(IPC_CHANNELS.PROJECT_LIST, null, () => listProjects());

  // 获取单个项目：从 input 提取 id
  wrap(IPC_CHANNELS.PROJECT_GET, z.object({ id: z.string().min(1) }), (input) =>
    getProject(input.id),
  );

  // 更新项目：透传 input（ProjectUpdateInputSchema 已校验）
  wrap(IPC_CHANNELS.PROJECT_UPDATE, ProjectUpdateInputSchema, (input) => updateProject(input));

  // 删除项目：从 input 提取 id
  wrap(IPC_CHANNELS.PROJECT_DELETE, z.object({ id: z.string().min(1) }), (input) =>
    deleteProject(input.id),
  );

  // 归档项目：从 input 提取 id
  wrap(IPC_CHANNELS.PROJECT_ARCHIVE, z.object({ id: z.string().min(1) }), (input) =>
    archiveProject(input.id),
  );
}
