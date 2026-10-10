import { z } from 'zod';

/** 思考强度档位（用户可选值，对齐原型 thinking seg-control） */
export const ThinkingLevelSchema = z.enum(['off', 'low', 'medium', 'high']);

/** 思考强度 TypeScript 类型 */
export type ThinkingLevel = z.infer<typeof ThinkingLevelSchema>;

/** 思考强度默认档位（渲染层 settings-store 与后端默认值共用） */
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = 'high';
