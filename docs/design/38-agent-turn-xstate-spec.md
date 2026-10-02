# 38 · Agent 回合执行流 XState 编排化重构（阶段 1：机器升级为编排者）

> 状态：实施中（2026-10-02 立项）｜前置：agent-turn-machine.ts 护栏模式（2026-08 引入）
> 关联：30-residency（进程韧性）、agent-service.ts 文件头「与 agent-runtime 的分工」、
> 本目录文件头「事件驱动重构 = 暂停/恢复阶段的工作」（本 spec 即该工作的阶段 1）

## 0 背景与判级

- 现状：`streamToWebContents`（agent-service.ts，约 450 行）是 await 驱动的过程式代码；
  XState 机器只做旁观记账（护栏模式）。生命周期记账依赖 finally 清单（8 项）；
  状态权威二元（真值在过程变量，机器是影子）；异常路径顺序靠人工记忆
  （超时归因先于终态、空回复防护先于终态——2026-09-28 两处深读修复即此类坑）。
- 判级：现有功能内部重构（无新用户交互）→ 轻量路径；因触及核心链路，本 spec 记录
  完整设计与语义搬运清单。
- 阶段划分：
  - **阶段 1（本 spec）**：机器从护栏升级为编排者——装配/运行/收尾进入 invoked
    services，guard 接管人工顺序，exit action 接管清理。对外契约不变。
  - **阶段 2（另行立项）**：暂停/恢复（审批超时 after 转换、事件驱动执行流）+
    并行子任务（并行状态 + final 态 onDone 组合）。

## 1 需求

### 1.1 语义边界（对外契约一字不变）

- `startAgent(options)` 返回 sessionId 的时机与语义不变（立即返回，不 await 回合）；
- `agent:stream:part` / `agent:stream:end` / `agent:stream:error` /
  `turn:*` 事件的推送序列与载荷不变（含 P2-31 合帧保序：END/ERROR 前 flush）；
- 中断（abort 单个/全部）、超时归因（reason='timeout' vs 'aborted'）、空回复防护
  （AI_EMPTY_RESPONSE）、装配失败容忍（缺席推送 ERROR，渲染层不得永久 loading）
  行为逐项保持；
- dispose / preempt / registry CAS / TOCTOU（startingSessions）语义保持。

### 1.2 不做清单（阶段 1 边界）

- 不改 ToolExecutor 内审批暂停机制（AI SDK v7 约束：工具暂停靠 SDK 内部 await，
  外部无法任意接管；`waitingApproval` 在本阶段是真实状态跟踪与决策依据，
  不是暂停控制机制）；
- 不动 agent-runtime 纯件内部：turn-runner / stream-reader / concurrency-gate /
  create-stream / loop-detector / turn-transcript 零改动；
- 不动 context-compression / token-overhead / repair-tool-call（被调用的纯函数）；
- 不做暂停恢复、并行子任务（阶段 2）；不把 IM 桥 / ask-service 塞进机器
  （跨回合职责）。

### 1.3 验收

- `agent-service.test.ts`（1731 行，含生命周期/中断/dispose/压缩/usage/超时批次）
  全绿；`agent-turn-machine.test.ts` 全表转换断言按新拓扑更新后全绿；
- `pnpm test:main` 全量绿；typecheck / lint / check:static 绿；
- file-size 棘轮：agent-service.ts 净行下降（预期显著），新文件不超限。

## 2 设计

### 2.1 目标状态拓扑

```text
assembling ──(assembly.done)──▶ queued ──(gate.acquired)──▶ running
     │                            │                           │
     │ stream.aborted             │ stream.aborted            ├─ streaming ⇄ waitingApproval
     ▼                            ▼                           │  (approval.requested/responded)
   aborted ◀──────────────────────┘                           ├─ stream.finished ─▶ completed✓
   error ◀─(assembly.error / stream.error / turn.runError)────┘
   running 的 runDone 决策链（guard 顺序即原人工顺序）：
     isTimeout ▶ error ；isEmptyResponse ▶ error ；否则 ▶ completed
```

- `streaming/waitingApproval` 为 running 的**层级子状态**（审批只可能发生在
  running 中；`stream.aborted`/`stream.error` 提升到 running 层统一处理）；
- 三个终态为 `type: 'final'`，收尾动作放终态 entry（谁到达谁收尾，无共享 finally）。

### 2.2 机器与依赖边界（保持 agent-runtime 纯净）

- 机器留在 `agent-runtime/agent-turn-machine.ts`（纯层）：拓扑、guard、context
  assign 全部在此；**不 import electron/db/infra**——dep 序列化违反 depcruise；
- 宿主效果经 `TurnDeps` 接口注入（input → context.deps）：acquireGate /
  resolveAssembly / runTurn / finalizeAborted / finalizeCompleted / finalizeError /
  flushForwarder / clearModelTimeout / releaseGate / unsubscribe——签名全是纯函数
  形态，实现由 agent-service 提供（AutostartDeps 同款注入模式）；
- invoked services 在机器内是薄分发（`fromPromise(async ({ context }) =>
  context.deps.xxx(...))`），真实行为留在宿主——机器 = 控制流权威，宿主 = 效果
  提供者。测试用 `.provide()` 换 fixture deps，不 mock 模块。

### 2.3 语义搬运清单（逐条对应，缺一即回归）

| # | 原位置 | 去处 |
|---|---|---|
| 1 | 超时归因先于终态 send（2026-09-28 顺序坑） | running.on turn.runDone 首位 guard `isTimeout` |
| 2 | 空回复防护先于终态（同批修复） | 次位 guard `isEmptyResponse`（rawPartCount 在 context） |
| 3 | 并发门 acquire（排队期 abort 走 AbortError 分类） | `queued` 状态 + acquireGate service |
| 4 | gate.ready 发送时机 | running entry action（机器内部自洽，不再手工 send） |
| 5 | finally：releaseGate / modelTimeout.clear | running.exit（顺序保留：先释放槽位再清定时器） |
| 6 | finally：三个退订（累积器/类级转发/审批生命周期） | 终态公共 exit action `unsubscribeAll` |
| 7 | flush 保序（END/ERROR 前落地合帧缓冲） | 各 finalize 前置 action `flushForwarder`（幂等） |
| 8 | 装配失败容忍（缺席推送 ERROR） | assembling.on stream.aborted + assembly.error 事件；catch 兜底保留 |
| 9 | CAS 删 controller / markIdle 仅 current / TOCTOU | **留宿主**（跨回合职责），机器不管注册表 |
| 10 | 用户消息落库 fire-and-forget 失败静默 | assembling service 内联（行为不变） |
| 11 | usage await 失败静默（`.catch(() => null)`） | finalizeCompleted service 内联 |

### 2.4 宿主瘦身后的形态

```ts
async startAgent(options): Promise<string> {
  // TOCTOU + preempt + registry 记账（跨回合，保留现状）
  const actor = createAgentTurnActor({ sessionId, turnId, deps, webContents });
  // part 推送订阅 actor 广播（合帧器由 deps 提供，flush 时机由机器保证）
  actor.start();
  return sessionId;
}
```

agent-service.ts 预期净行从 683 降至约 450（file-size 棘轮只紧不松，自然受益）。

### 2.5 测试策略

- `agent-turn-machine.test.ts`：全表转换断言按新拓扑重写（含非法转换忽略断言：
  waitingApproval 下重复 approval.requested 被忽略、final 后事件无效）；
- service 层用 `.provide({ actors: {...fixture} })` 覆盖 runTurn/resolveAssembly，
  断言 guard 顺序（timeout/empty 优先级）与 exit 清理调用；
- 宿主测试（1731 行）作为行为黄金基线**不迁移断言**，仅适配注入点。

## 3 提交链与状态

| 提交 | 内容 | 状态 |
|---|---|---|
| 1 | 本 spec | ✅ |
| 2 | 机器重写（setup/层级/invoked/guards）+ 全表断言迁移 | ✅（含 v5 实测三坑记录：invoke.input 显式传 / onError 事件 type 实值含 actor id / actor 调度跨宏任务） |
| 3 | 宿主切换（runTurnStream = 效果提供者）+ 装配段提取 turn-assembly.ts（agent-service 净行 705→657，complexity 基线条目删除） | ✅ |
| 4（后续） | 阶段 2：暂停/恢复 + 并行子任务 | 未立项 |
