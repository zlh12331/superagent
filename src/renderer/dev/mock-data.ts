// src/renderer/dev/mock-data.ts
// dev mock 响应样板数据（自 mock-api.ts 拆分）
// ──────────────────────────────────────────────────────────────
// 背景：mock-api.ts 契约对齐后行数膨胀（新增字段/类型化），超文件棘轮基线。
// 遂将纯响应样板数据（usage/system/models/git）拆到此模块，mock-api 仅引用。
// 数据形状与 shared 契约一致（satisfies IpcApi 仍负责最终校验）。
// ──────────────────────────────────────────────────────────────

import type { GitFileStatus, ModelsListRes, UsageSummaryRes } from '@code-agent/shared/renderer';

/** session:getUsageSummary 样板（近 90 天假数据） */
export function mockUsageSummary(): UsageSummaryRes {
  return {
    total: { calls: 12, inputTokens: 12_000, outputTokens: 28_000, totalTokens: 40_000 },
    byModel: [
      {
        modelId: 'deepseek-v4-flash',
        calls: 8,
        inputTokens: 8_000,
        outputTokens: 20_000,
        totalTokens: 28_000,
        cacheReadTokens: 0,
        reasoningTokens: 3_000,
      },
      {
        modelId: 'gpt-5-codex',
        calls: 4,
        inputTokens: 4_000,
        outputTokens: 8_000,
        totalTokens: 12_000,
        cacheReadTokens: 0,
        reasoningTokens: 1_000,
      },
    ],
    byDay: Array.from({ length: 90 }, (_, i) => ({
      date: new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10),
      calls: i % 3 === 0 ? 1 : 0,
      totalTokens: i % 3 === 0 ? 400 + i * 13 : 0,
    })),
  };
}

/** system:getStatus 样板（浏览器模式无真实进程度量，给固定演示值） */
export function mockSystemStatus() {
  return {
    appVersion: '0.1.0-mock',
    electronVersion: 'mock',
    nodeVersion: 'mock',
    platform: 'web',
    arch: 'x64',
    isPackaged: false,
    uptimeSeconds: 3_600,
    pid: 0,
    memory: {
      rss: 320_000_000,
      heapTotal: 180_000_000,
      heapUsed: 120_000_000,
      external: 40_000_000,
      arrayBuffers: 0,
    },
    cpu: { user: 1_200, system: 300 },
    timestamp: new Date().toISOString(),
  };
}

/** models:list 样板（内置模型 2 条） */
export function mockModels(): ModelsListRes {
  return {
    models: [
      {
        id: 'deepseek-v4-flash',
        label: 'DeepSeek V4 Flash',
        providerKind: 'deepseek',
        isRuntime: false,
        capabilities: {},
      },
      {
        id: 'gpt-5-codex',
        label: 'GPT-5 Codex',
        providerKind: 'openai',
        isRuntime: false,
        capabilities: {},
      },
    ],
  };
}

/** git:status 样板（2 个未暂存变更文件） */
export function mockGitStatus() {
  return {
    branch: 'main',
    ahead: 2,
    behind: 0,
    clean: false,
    files: [
      {
        path: 'src/renderer/dev/mock-api.ts',
        status: 'untracked',
        staged: false,
        oldPath: undefined,
      },
      {
        path: 'docs/design/09-ux-interaction-spec.md',
        status: 'modified',
        staged: false,
        oldPath: undefined,
      },
    ] satisfies readonly GitFileStatus[],
  };
}
