// src/main/infra/storage/ai-pref.ts
// AI 设置读取（app_settings 表，主进程直读 SQLite）
// ──────────────────────────────────────────────────────────────
// 背景：`ai.defaultModel` 由渲染层设置页/模型选择器写穿透落库（settings:set），
// 主进程消费方有三处，语义必须一致：
// - agent 回合：agent:run 契约携带 modelId（请求时快照，UI 路径精确值）；
//   headless 入口（IM / cron / 远程 / 子代理）不带该字段，回落读本设置
// - /compact 上下文压缩：无契约字段可用，读本设置确定窗口预算基准
// - 记忆蒸馏 LLM：读本设置（llm-config.ts 消费）
//
// 与 remote-pref.ts 同模式：主进程直接读 SQLite，不经渲染层 settings 域
// 白名单（SETTING_KEYS 不动——该键的写入方仍是渲染层 settings-store）。
// 读取失败（库未初始化 / 值损坏 / 非字符串）一律回落 undefined，由调用方
// 走各自默认——本模块不抛错，避免设置读取拖垮对话主链路。
// ──────────────────────────────────────────────────────────────

import { readSetting } from './settings-pref';

/** app_settings 中的 AI 设置键（渲染层 settings-store 的结构契约） */
const AI_SETTINGS_KEY = 'ai';

/**
 * 读取用户选定的默认模型 id
 *
 * @returns 模型 id；未设置 / 非法值 / 读取失败均返回 undefined（调用方回落默认模型）
 */
export function readSelectedModelId(): string | undefined {
  try {
    const raw = readSetting(AI_SETTINGS_KEY) as { defaultModel?: unknown } | undefined;
    const modelId = raw?.defaultModel;
    return typeof modelId === 'string' && modelId.length > 0 ? modelId : undefined;
  } catch {
    // 库未初始化（启动早期）等场景：回落默认模型，不阻断调用方
    return undefined;
  }
}
