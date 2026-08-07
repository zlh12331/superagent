// packages/shared/src/schemas/thinking.ts
// 思考强度档位（agent:run / chat:send 共用）
// ──────────────────────────────────────────────────────────────
// 对齐原型 seg-control 的 thinking 四档（off/low/medium/high）：
// - off：不注入思考强度（模型默认档位）
// - low / medium / high：映射到后端 reasoningEffort 阶梯
//   （主进程按模型能力钳制，见 reasoning-effort.ts）
// ──────────────────────────────────────────────────────────────

import { z } from 'zod';

/** 思考强度档位（用户可选值，对齐原型 thinking seg-control） */
export const ThinkingLevelSchema = z.enum(['off', 'low', 'medium', 'high']);

/** 思考强度 TypeScript 类型 */
export type ThinkingLevel = z.infer<typeof ThinkingLevelSchema>;

/** 思考强度默认档位（渲染层 settings-store 与后端默认值共用） */
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = 'high';
