# 04 · AI 智能体层

> 覆盖：`src/main/infra/ai/` 下的 Agent 编排、Agent-Runtime 回合机器、LLM 客户端、模型/Provider 路由、Prompt、知识（goal/memory/session-title/learn-skill）。

## 1. 架构总览

```
ai/
 ├─ agent/          高层编排：AgentService、Workflow/Task/Team/Branch、Hook 注册表、上下文压缩、子代理、Agent 提问、工具入参修复、停顿看门狗
 ├─ agent-runtime/  回合执行原语：TurnMachine、TurnRunner、create-stream、stream-reader、并发闸、活跃会话、循环检测
 ├─ llm-client/     LlmClient 封装 + ai-provider + retry
 ├─ models/         模型注册表、运行时模型存储、generation-options、token-limits、reasoning-effort
 ├─ providers/      供应商工厂与内置定义（deepseek/openai/anthropic/ollama）
 ├─ prompt/         PromptService + dynamic-context + agents-md + default-prompt
 ├─ skills/         技能注册表（skill-registry，learned + builtin）
 ├─ mcp/            MCP 客户端与服务（见 05）
 ├─ tools/          工具系统（见 05）
 ├─ cron-service    定时任务调度服务（cron_tasks 表 + croner）
 └─ knowledge/      goal-judge/goal-service、session-title、learn-skill-agent（记忆已迁至 memory-hub，见 07）
```

> **历史**：早期版本的纯对话链路（`chat:stream` + 后端 ChatService）已随 AI SDK v7 迁移删除。现在全应用只有 agent 一个对话域：渲染层经 AI SDK `useChat` + `ipc-agent-transport.ts` 直接驱动 `agent:run`，无独立后端聊天服务。

## 2. AgentService（Code Agent 主入口）

文件：`agent/agent-service.ts`

### 2.1 对外方法

- `startAgent({ mode, sessionId, prompt, systemPrompt?, ... })`：主入口。
  - 生成/复用 `sessionId` → 通过共享 `ActiveSessionRegistry` 防重 → 注册活跃 stream → stream 结束后标记 idle。
  - `mode: 'plan' | 'build'`：plan 只读探索，写工具被 ToolExecutor 拒绝返回 `TOOL_PERMISSION_DENIED`。
- `stopAgent(sessionId)`：中止当前回合（配合回合状态机）。
- 内部流程：
  1. 创建 `TurnEventEmitter`、`TurnRunner`、`AgentTurnActor`（回合状态机）。
  2. 订阅审批生命周期（Approval lifecycle → 回合状态 `waitingApproval`）。
  3. 经 `concurrencyGate.ready` 获取并发槽位（多会话公平 FIFO 调度，防 429）。
  4. 解析 system prompt（未传时 `PromptService.resolvePrompt`）。
  5. 构造 `baseCtx`，`ToolRegistry.toAISDKTools(baseCtx, executeHook)` 注入 `executeHook`（= `ToolExecutor.execute`），调 `createStreamWithRetry` 传 `tools` + `stopWhen` + `abortSignal` + 生成选项。
  6. 将 `TURN_START/END/DELTA/TOOL_CALL/RESULT/ERROR` 推送到渲染层。

## 3. Agent-Runtime（回合原语）

目录 `agent-runtime/`：

| 文件 | 职责 |
|---|---|
| `create-stream.ts` | 请求级流创建 + **重试**：创建 `streamText`、拿到 `toUIMessageStream()` reader；只重试"创建 + 首 part"，首 part 成功后不重试（防重复工具副作用） |
| `turn-runner.ts` | 回合执行器：复用上层 reader，循环读取流并翻译为 `TurnEvent`；含 tool-call 循环检测、abort 归类、错误传播、finally 清理 |
| `agent-turn-machine.ts` | 回合状态机（idle / running / waitingApproval / ended 等），驱动审批等待 |
| `turn-translator.ts` | 把 AI SDK 流 part 翻译为内部 `TurnEvent` |
| `turn-emitter.ts` | 回合事件分发 |
| `stream-reader.ts` | 读取/消费 `UIMessageStream` 的封装 |
| `active-session-registry.ts` | 活跃 stream 注册表（共享 CAS 删除，防旧 stream 覆盖新 controller） |
| `concurrency-gate.ts` | 并发公平调度门（默认槽位 `DEFAULT_MAX_CONCURRENT_TURNS`，FIFO，防供应商 429） |
| `loop-detector.ts` | 工具调用循环检测 |
| `abort-utils.ts` | abort 信号工具 |

**重点设计**：`activeSessions.set` 必须先 `has()` 检查再做 CAS 删除（否则"同 chatId 双击"产生孤儿流）；`abort()` 必须从 Map 删除并等待旧流 finally 收尾（避免 stop 后立即发送时旧流删除新 controller）。

## 4. LLM 客户端与 Provider 路由

### 4.1 llm-client（`llm-client/index.ts` / `llm-client.ts`）

- `LlmClient`：统一封装 `model(...)` / `streamText(...)` / 结构化输出等，供 agent 主流程与 side-query（标题、GoalJudge、CommandClassifier）共用。
- `ai-provider.ts`：`llmClient` 单例 + `runtimeModelStore`（运行时自定义模型）+ `resetAIProvider()`。
- `retry.ts`：重试层——定义可重试错误集合、解析 `Retry-After`、指数退避执行器；支持 abort 中断重试链。

### 4.2 models（`models/`）

- `registry.ts` / `types.ts`：`ModelRegistry`（`resolve(kind)` 返回模型能力/上下文窗口等）。
- `generation-options.ts`：统一构造生成参数——按能力、思考强度（reasoning）、温度、上下文 token 预算计算 `samplingOptions` / `providerOptions` / `maxOutputTokens`，agent 主流程共用。
- `reasoning-effort.ts`：思考强度映射。
- `token-limits.ts`：各模型 token 上限。
- `runtime-model-store.ts`：自定义模型增删改查（落 `runtime_models` 表）。
- `builtin-models.ts`：内置模型定义。

### 4.3 providers（`providers/`）

- `types.ts`：`PROVIDER_KINDS`（deepseek / openai / anthropic / ollama）。
- `registry.ts`：`BUILTIN_DEFINITIONS` + `BUILTIN_FACTORIES`（新增供应商 = 注册一条定义 + 一个工厂）；`registry-factory.ts` 工厂装配。
- 路由：`getModel(kind, modelId)` → ProviderRegistry；deepseek/ollama 走 `@ai-sdk/openai-compatible`，openai 走 `@ai-sdk/openai`，anthropic 走 `@ai-sdk/anthropic`。
- API Key 按供应商存 keychain（safeStorage）；baseURL 可 `.env` 覆盖（`*_API_BASE`）。
- **默认供应商/模型单一真源**：`packages/shared/src/constants/defaults.ts` 定义 `DEFAULT_PROVIDER`（deepseek）与 `DEFAULT_MODEL`（deepseek-v4-flash），渲染层对话区模型选择器与主进程 `ModelRegistry.resolve(undefined)` 共用，保证"默认模型"三端一致。

## 5. Prompt 层（`prompt/`）

| 文件 | 职责 |
|---|---|
| `prompt-service.ts` | 从 `prompts` 表读取模板（用户可编辑），失败回退硬编码默认；`initialize()` 幂等插入默认 Code Agent prompt |
| `dynamic-context.ts` | `injectDynamicContext()`：收集 OS/shell/工作目录/git 状态/AGENTS.md，替换 `{{workingDir}}`/`{{gitBranch}}`/`{{agentsMd}}` 占位符 |
| `agents-md.ts` | 向上查找 `AGENTS.md`，按优先级拼接并限制字节预算，`resolveAgentsMd` 返回注入块 |
| `default-prompt.ts` | 默认 Code Agent system prompt |

`agent/context-compression.ts`：`compressByTokenBudget` / `getCompactionBudget` —— /compact 命令的默认模型窗口感知预算裁剪（纯函数，agent 主流程与 session/compact 复用同一逻辑）。

## 6. 知识 / 记忆 / 目标

`knowledge/`：
- `goal-service.ts` + `goal-judge.ts`：会话目标（Goals）——挂载回合监听，用 LLM 判断目标是否达成（GoalJudge），迭代执行。
- `session-title.ts`：会话标题生成（llmClient side query）。
- `learn-skill-agent.ts`：技能学习（把用户场景沉淀为可复用技能，写 `skills` 表，`skill-registry` 加载）。
- **记忆已迁出本目录**：`save-memory.tool` / `recall-memory.tool` 经 `MemoryPort` 读写 **memory-hub sidecar**（TencentDB-Agent-Memory 引擎，见 07 记忆章节）；`agent.handler` 注入 `createMemoryCaptureWire`（`memory-hub/capture-wire.ts`）在回合结束后自动提取用户意图做记忆捕获（落 L0 JSONL + 引擎侧写入）。不再有自研 `memories` 表。

## 7. Hook 与工作流

- `hook-registry.ts`：Hook 生命周期注册表。
- `workflow-service.ts`：多步工作流编排。
- `task-service.ts` + `branch-service.ts`：任务（tasks 表）+ 分支（git 分支管理，`git-branch` 工具）。
- `team-service.ts`：团队协作（多 Agent）。
- `stall-watchdog.ts`：LLM 长时间不响应（TCP 未断但无数据）的看门狗——per-part 60s 超时，推送 `AI_TIMEOUT` 错误，避免前端无限等待。
- `repair-tool-call.ts`：工具调用入参自动修复引擎——以 llmClient 为依赖，接 AI SDK `streamText` 的 `repairToolCall` 钩子，工具入参解析失败时用 LLM 重试修复入参，并覆写 OTel 模型级 span。

## 8. 关键辅助

- `agent-ask-service.ts`：Agent 向用户提问（`ask-user-question` 工具），`agent:ask` 事件 → 渲染层提问框 → `agent:respondAsk`。
- `subagent-manager.ts`：子代理管理器（`run_subagent` / `run-team` 工具依赖），由 `serviceContainer.initSubagents()` 初始化。

## 9. 关键文件参考

- 各子目录 `index.ts` 是聚合出口。
- 单元测试与实现同目录或就近（`*.test.ts`），是理解行为的最佳示例，如 `ai/agent-service.test.ts`、`ai/llm-client/llm-client.test.ts`、`ai/agent/context-compression.test.ts`。
