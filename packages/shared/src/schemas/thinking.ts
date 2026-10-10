// thinking.ts：思考强度档位（off/low/medium/high）的值域与默认档位——agent:run 入参校验与渲染层设置共用
// 边界：档位到供应商 reasoningEffort 的映射（含 DeepSeek 官方逐档表）在主进程
// （src/main/infra/ai/models/generation-options.ts、reasoning-effort.ts），本文件只定义值域

import { z } from 'zod';

/**
 * 思考强度档位（用户可选值）
 *
 * - `off`：不注入思考强度，走模型自身默认行为
 * - `low` / `medium` / `high`：由主进程映射为供应商 reasoningEffort；
 *   DeepSeek 模型按官方逐档映射表换算（src/main/infra/ai/models/reasoning-effort.ts）
 */
export const ThinkingLevelSchema = z.enum(['off', 'low', 'medium', 'high']);

/** 思考强度档位类型（ThinkingLevelSchema 的推导类型，供 agent:run 入参与渲染层设置标注） */
export type ThinkingLevel = z.infer<typeof ThinkingLevelSchema>;

/**
 * 思考强度默认档位（'high'）
 *
 * 渲染层设置的默认值另写在 src/renderer/stores/persistent/settings-store.ts 的
 * DEFAULT_SETTINGS（同为 'high'）；两侧是独立字面量，调默认档位需同步改动。
 */
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = 'high';
