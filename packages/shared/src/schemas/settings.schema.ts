// packages/shared/src/schemas/settings.schema.ts
// ProjectSetting / AppSetting Zod schema
// 字段来源：设计文档 §6.2 Prisma ProjectSetting / AppSetting 模型

import { z } from 'zod';

/** ProjectSetting 实体 schema */
export const ProjectSettingSchema = z.object({
  projectId: z.string().min(1),
  aiModel: z.string().min(1).max(50),
  aiTemperature: z.number().min(0).max(2),
  aiMaxTokens: z.number().int().positive().max(32768),
  ragEnabled: z.boolean(),
  ragTopK: z.number().int().positive().max(50),
  ragThreshold: z.number().min(0).max(1),
  customPrompts: z.record(z.string(), z.unknown()).default({}),
  updatedAt: z.string().min(1),
});
export type ProjectSetting = z.infer<typeof ProjectSettingSchema>;

/** 更新项目设置入参 */
export const ProjectSettingUpdateInputSchema = z.object({
  projectId: z.string().min(1),
  aiModel: z.string().min(1).max(50).optional(),
  aiTemperature: z.number().min(0).max(2).optional(),
  aiMaxTokens: z.number().int().positive().max(32768).optional(),
  ragEnabled: z.boolean().optional(),
  ragTopK: z.number().int().positive().max(50).optional(),
  ragThreshold: z.number().min(0).max(1).optional(),
  customPrompts: z.record(z.string(), z.unknown()).optional(),
});
export type ProjectSettingUpdateInput = z.infer<typeof ProjectSettingUpdateInputSchema>;

/** AppSetting 实体 schema */
export const AppSettingSchema = z.object({
  key: z.string().min(1),
  value: z.string(),
  updatedAt: z.string().min(1),
});
export type AppSetting = z.infer<typeof AppSettingSchema>;

/** 设置 AppSetting 入参 */
export const AppSettingSetInputSchema = z.object({
  key: z.string().min(1),
  value: z.string(),
});
export type AppSettingSetInput = z.infer<typeof AppSettingSetInputSchema>;

/** API Key 测试入参（不携带 key 本身，只测已存 key 是否有效） */
export const TestApiKeyInputSchema = z.object({
  provider: z.enum(['deepseek', 'ollama']),
});
export type TestApiKeyInput = z.infer<typeof TestApiKeyInputSchema>;
