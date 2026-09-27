# 31 · 失效自动化规格（写路径声明式失效域）

- **状态**：用户拍板立项（2026-09-28），方案方向已对齐；实施随同分支 `feat(invalidation)` 提交落地，
  验证结果见 §6.4。
- **范围**：`packages/shared/src/ipc/`（定义表三步走）、`packages/shared/src/schemas/invalidation.ts`（新）、
  `src/main/infra/invalidation/`（新）、`src/main/infra/storage/session-service.ts`、
  `src/main/infra/ai/agent/agent-service.ts`、`src/main/infra/memory-hub/memory-hub-service.ts`、
  `src/main/infra/im/im-service.ts`、`src/main/ipc/memory.handler.ts`、
  `src/renderer/lib/invalidation/`（新）、`src/renderer/hooks/use-invalidation-bridge.ts`（新）、
  `src/renderer/hooks/use-agent-bridge.ts`、`src/renderer/dev/mock-api.ts`
- **上游**：[30-residency-fix-spec.md](./30-residency-fix-spec.md) §4.7（主进程主动广播形态的先例）、
  `docs/design/data-ownership.md`（数据归属）、`src/renderer/lib/query/keys.ts` 头注释（失效前提）
- **不含**：taskService / goalService / cron 任务的写路径声明（§7「明确不做」）；MCP / skill / whitelist
  等设置域（已有 mutation 自失效，前提见 `keys.ts:18-24`）

## 0. 结论摘要

数据一致性自动化的同根问题：**失效的「知识」长在了消费端（渲染层），而不是写入端（主进程）**。
主进程每条写路径最清楚"我改了什么"，但它没有渠道告诉渲染层；渲染层只能靠人工排查逐域补失效——
历史缺陷全是这么补出来的：

| 域 | 遗漏史 | 现状 |
|---|---|---|
| task | P3 修复（回合结束任务不收敛） | `use-agent-bridge.ts:83` 硬编码补上 |
| usage | P2 修复（设置页用量过期） | `use-agent-bridge.ts:87` 硬编码补上 |
| git / file / turns | 2026-09-08 修复（GitPanel/文件面板/回合记录永 stale） | `use-agent-bridge.ts:93-95` 硬编码补上 |
| memory | **至今无任何失效点**（台账审计缺口） | 引擎懒启动/退出后 `memory:status` 面板永久 stale |
| im | **至今无任何失效点**（台账审计缺口） | 主进程侧渠道状态变化后渠道列表 stale |
| 无头回合 | **至今渲染层零感知**（本文新识别，§1.2 缺口 D） | IM/远程/定时触发的回合结束后侧栏/详情不刷新 |

本方案：主进程新增失效广播基础设施 + 各写路径**声明式**携带受影响域（元素形如 `'sessions'` 或
`'session:<id>'`），经新 IPC 事件 `invalidation:event:domains` 推送；渲染层新增事件桥做前缀失效。
agent 回合结束的硬编码清单迁为主进程声明（含无头回合——缺口 D 一并关闭）；渲染层旧清单保留作回落，
待事件全覆盖后删（渐进兼容，不破坏现有失效行为）。

## 1. 现状与缺陷链

### 1.1 现状代码地图（file:line 均为 2026-09-28 基线核实值）

| 关注点 | 位置 | 现状 |
|---|---|---|
| 回合结束失效（唯一收敛点） | `use-agent-bridge.ts:69-96` | `handleSessionEnd` 硬编码 8 域：sessions / session:<id> / goal / task / usage / git / file / turns |
| 同上，注释证据 | `use-agent-bridge.ts:80-92` | 「P3 修复：task 列表此前遗漏」「P2 修复：用量汇总此前无人失效」「2026-09-08 修复：git/file/turns 此前无人失效」——五域全是事后逐个补 |
| 回合结束推送（仅窗口回合） | `agent-service.ts:1027-1038` | `completeTurn` 只在 `webContents !== undefined && !isDestroyed() && reason !== 'error'` 时推 `agent:stream:end` |
| 无头回合出口 | `agent-service.ts:1000-1065` | `completeTurn` 是 completed/aborted/error 三出口收敛点，但**不区分有头/无头**——失效没有独立于 `webContents` 的通道 |
| 主进程主动广播形态（先例） | `deep-link.ts:66-74` / `main-events.ts:26-47` | 遍历 `BrowserWindow.getAllWindows()` + `isDestroyed()` 守卫 + `webContents.send` |
| 发送侧 dev 契约校验 | `emit-event.ts:78-110` | 按 definitions 的 `payloadSchema` 校验（dev only），prod 零开销 |
| queryKey 根注册表 | `lib/query/keys.ts:28-38` | `QUERY_KEY_ROOTS`：sessions / session / goal / task / usage / git / file / turns / memory |
| IM 渠道列表消费 | `im-channels-section.tsx:40` | `useQuery(IM_CHANNELS_QUERY_KEY)`；mutation onSuccess 自失效（`:54,:66`） |
| 记忆面板消费 | `memory-panel.tsx:240,257` | `MEMORY_LIST_QUERY_KEY` / `MEMORY_STATUS_QUERY_KEY`；**全仓无失效点** |
| memory 状态源 | `memory-hub-service.ts:231-247,330-336,249-271` | sidecar 懒启动（`ensureStarted`）/ 异常退出（`child.onExit`）/ 停止（`stop`），状态变化只落内存字段 |
| IM 状态源 | `im-service.ts:49-62,67-72,151-154` | `start` / `stop` / `stopAll` 改 `started` 集合，无任何渲染层通知 |
| 会话写路径 | `session-service.ts:187,200,222,242,306,372` | delete / rename / pin / create / appendMessage / replaceMessages，写库后无失效通知 |

### 1.2 缺陷链（同根：知识错位）

```
主进程写路径（知道改了什么） ──✗ 无通道──▶ 渲染层缓存（TanStack Query）
       ▲                                        ▲
       │ 唯一例外：agent:stream:end（仅窗口回合） │ 消费端硬编码清单兜底
       └── use-agent-bridge 逐域人工补（五连遗漏的由来）
```

- **缺口 A（结构性）**：渲染层清单是「消费端对主进程写入的猜测」。主进程新增写路径（或新域接入）
  时没有任何机制提醒渲染层——只能等用户报障或台账审计，再人工补一行
  `invalidateQueries`。补一行就是一次"缺陷-修复"循环。
- **缺口 B（memory 运行态）**：引擎 sidecar 懒启动——设置页记忆面板打开时引擎未启动
  （`running:false`），随后回合触发懒启动，面板不刷新永远显示"未运行"；引擎崩溃退出同理反向。
- **缺口 C（im 渠道态）**：渲染层发起的 start/stop 有 mutation 自失效；但主进程侧的状态变化
  （启动恢复 `restore()`、退出 `stopAll()`、以及未来任何自动重连/异常下线）没有通知路径。
- **缺口 D（无头回合，本文新识别）**：IM / 远程控制 / 定时任务触发的回合走无头路径
  （`options.webContents === undefined`），`agent:stream:end` 不推送 ⇒ 渲染层侧栏的
  会话列表、详情、usage、turns 全部 stale。当前唯一的"自愈"是用户手动刷新或下个回合结束。
  渲染层旧清单挂在 stream:end 事件上，结构性无法覆盖无头回合——失效必须改由主进程声明。

## 2. 契约设计

### 2.1 IPC 事件（定义表三步走）

| 步骤 | 内容 |
|---|---|
| `meta.ts` | `invalidation: { subscribeDomains: event('invalidation:event:domains') }`（一行） |
| `definitions.ts` | `subscribeDomains: withPayload(IPC_META.invalidation.subscribeDomains, {} as InvalidationPayload, InvalidationPayloadSchema)`（一行） |
| handler | 无（事件方法不经 `registerIpcHandlers`，主进程经广播模块推送） |

payload（`packages/shared/src/schemas/invalidation.ts`，新文件）：

```ts
export const InvalidationPayloadSchema = z.object({
  domains: z.array(z.string().min(1)).min(1),
  sessionId: z.string().min(1).optional(),
});
export interface InvalidationPayload {
  readonly domains: readonly string[];
  readonly sessionId?: string;
}
```

- `sessionId` 是可选上下文（哪个会话引发的失效），**失效指令以 `domains` 为准**——
  会话自身的域已内含 `session:<id>` 元素，`sessionId` 供日志排障与未来按会话过滤使用。
- preload / channels / IpcApi 类型由定义表自动派生（`create-api.ts` 遍历 meta，零改动）。
- `mock-api.ts` 补 `invalidation.subscribeDomains` no-op（浏览器模式无主进程推送）——
  `IpcApi` 形状变化的强制同步点（30 号 spec §4.7b 同款）。

### 2.2 域词表与映射规则（单一真源在 shared）

域元素形如 `'sessions'` 或 `'session:<id>'`，渲染层 `split(':')` 得 queryKey 前缀：
`'sessions' → ['sessions']`、`'session:abc' → ['session', 'abc']`。
前半段与 `QUERY_KEY_ROOTS` 键一一对应（sessions/session/goal/task/usage/git/file/turns/memory/im）。

```ts
/** 主进程声明点统一取词；渲染层按 ':' 拆成 queryKey 前缀 */
export const INVALIDATION_DOMAINS = {
  sessions: 'sessions',
  session: (sessionId: string): string => `session:${sessionId}`,
  goal: 'goal', task: 'task', usage: 'usage',
  git: 'git', file: 'file', turns: 'turns', memory: 'memory', im: 'im',
} as const;

/** 回合结束聚合声明的全局域（迁移自 use-agent-bridge 硬编码清单） */
export const TURN_END_GLOBAL_DOMAINS =
  ['sessions', 'goal', 'task', 'usage', 'git', 'file', 'turns'] as const;

/** 回合结束聚合声明域（agent-service.completeTurn 唯一调用点） */
export function turnEndInvalidationDomains(sessionId: string): readonly string[];
```

`TURN_END_GLOBAL_DOMAINS` 同时被渲染层回落判定（§2.5）引用——**声明侧与消费侧共用同一常量**，
清单漂移在编译期暴露，而不是等 stale 复现。

### 2.3 主进程广播模块（`src/main/infra/invalidation/invalidation.ts`，新）

```ts
export function broadcastInvalidation(
  domains: readonly string[],
  sessionId?: string,
): void;
```

- **广播形态照抄先例**（`deep-link.ts:66-74` / `main-events.ts`）：遍历
  `BrowserWindow.getAllWindows()`，逐窗 `isDestroyed()` 守卫后发送；channel 取
  `IPC_CHANNELS['INVALIDATION_EVENT_DOMAINS']`。
- **复用 `emitEvent`**（`emit-event.ts`）做逐窗发送：免费获得 dev 侧 payload 契约校验 +
  webContents 销毁守卫（P2-38 / R2 既有能力，不另造第二套发送路径）。
- **electron 引用用命名空间惰性访问 + 空窗降级**（本设计对先例的一处细化）：`import * as electron
  from 'electron'` 后在函数体内取 `electron.BrowserWindow`，不可用或返回空即 no-op。理由：
  ① 广播在"无窗口"下本来就该是 no-op（`deep-link.ts:64` 同语义）；② session-service /
  agent-service / memory-hub / im-service 四条链的单测与集成测试都会传递性 import 本模块，
  惰性访问让测试环境（electron 命名空间为部分形状）零 mock 透传，不为广播改十余个测试文件的
  mock 形状——广播行为本身由本模块专属单测（vi.mock electron 捕获 send）严格覆盖。

### 2.4 主进程声明点（写路径 → 域）

| # | 声明点 | 域 | 动作时机 |
|---|---|---|---|
| S1 | `session-service.delete(id)` | `['sessions']` | 删除落库后（不含 `session:<id>`：详情缓存指向已删除会话，重拉只会 SESSION_NOT_FOUND） |
| S2 | `session-service.rename / pin` | `['sessions', 'session:<id>']` | 写库成功后 |
| S3 | `session-service.create` | `['sessions', 'session:<id>']` | 事务提交后（IM/远程桥创建会话由此到达渲染层——缺口 D 的一部分） |
| S4 | `session-service.appendMessage` | `['sessions', 'session:<id>']` | 事务提交后（回合开始的用户消息 / 回合结束的助手消息落库） |
| S5 | `session-service.replaceMessages` | `['sessions', 'session:<id>']` | /compact 压缩落库后 |
| S6 | `session-service.importAll` | `['sessions']` | 导入完成后 |
| S7 | `agent-service.completeTurn` | `turnEndInvalidationDomains(sessionId)`（8 域聚合） | **先于** `agent:stream:end` 推送；三出口（completed/aborted/error）全走；**不判 webContents**（无头回合也广播——缺口 D 的主修复） |
| S8 | `memory-hub-service`（sidecar 就绪 / 进程退出 / stop 收尾） | `['memory']` | 运行态真实迁移时（未配置降级路径不声明——状态没变） |
| S9 | `memory.handler.clear / clearAll`（有实际删除时） | `['memory']` | 清除落盘后（列表 + 状态面板的 recordCount 都变） |
| S10 | `im-service.start（新连接）/ stop（真停止）/ stopAll（有渠道在跑）` | `['im']` | `started` 集合真实变化时（幂等重复调用不声明） |

**刻意不声明的点位**（防止回归与噪音，实施时在代码处注释）：

| 点位 | 不声明理由 |
|---|---|
| `session-service.markRunning / markIdle` | D4A 乐观徽标依赖 setQueryData 恰因 invalidate 有**读不到 running 的时序竞态**（徽标闪失，`use-agent-bridge.ts:43-47` 的既证结论）；回合状态由 S7 聚合声明在回合结束统一收敛为真值 |
| `session-service.markAllInterrupted` | 启动期执行，渲染层尚未挂载；启动后的首次拉取天然是新数据 |
| `session-service.recordUsage / recordTurn` | 每回合一次、只在回合粒度有消费方（usage 汇总 / turns 列表），S7 聚合声明覆盖，逐写广播是纯噪音 |
| 渲染层发起的 IPC 写（delete/rename/pin/create/import/compact/im:start/im:stop/memory:clear） | mutation onSuccess 已自失效；广播与之重复但无害——失效事件**不携带数据**，不存在 30 号 spec 担心的「回声写回」问题，仅为多一次幂等重拉。收益是契约统一：任何来源的写（含未来的新调用方）都自动通知 |

### 2.5 渲染层

**a) 纯函数层 `src/renderer/lib/invalidation/invalidation.ts`（新）**

```ts
/** 失效域 → queryKey 前缀；空段 / 空域返回 null（跳过，前向兼容旧渲染层收到新域） */
export function domainToQueryKey(domain: string): readonly string[] | null;
/** 逐域前缀失效（queryClient.invalidateQueries） */
export function applyDomainInvalidation(domains: readonly string[]): void;
/** 记录失效事件（回合结束全域声明命中时登记该会话已覆盖，供 use-agent-bridge 回落判定） */
export function noteInvalidationEvent(domains: readonly string[], sessionId?: string): void;
/** 该会话的回合结束域是否已由事件覆盖（30s TTL + 128 容量上界，防泄漏防陈旧） */
export function isTurnEndCovered(sessionId: string): boolean;
```

覆盖判定 = 事件 domains ⊇（`TURN_END_GLOBAL_DOMAINS` 全体 ∪ `session:<sessionId>`）。
**必须全域命中才登记**：单会话写路径的 `['sessions','session:<id>']`（S1–S6）不得冒充回合结束
聚合声明，否则 stream:end 跳过旧清单会丢 goal/task/usage/git/file/turns 的失效——恰是本任务要修的五连。

**b) 事件桥 `src/renderer/hooks/use-invalidation-bridge.ts`（新）**

AppShell 挂载（与 `useAgentBridge` 同列），订阅 `invalidation:event:domains` →
`noteInvalidationEvent` + `applyDomainInvalidation`。无窗口 API（浏览器模式）跳过，
与 `use-agent-bridge` 的 `hasIpcBridge` 守卫同模式。

**c) `use-agent-bridge` 渐进回落**

`handleSessionEnd` 的失效块改为：**事件已覆盖（`isTurnEndCovered`）→ 跳过；缺失 → 回落旧清单**。
- 旧清单（§1.1 的 8 域 invalidate）**原样保留**并加注释：待主进程声明全覆盖后与
  `lib/invalidation` 的覆盖判定一并删除。
- **L2 清理（approvals / agent-ask clearBySession）不属于缓存失效域，事件不覆盖，保持无条件执行**。
- 时序依据：S7 的广播先于 `agent:stream:end` 推送（同一 webContents 队列保序），正常路径渲染层
  先收到失效事件（登记覆盖 + 失效）再进 `stream:end`（跳过旧清单）。
- error 出口的已知折衷：`agent:stream:error` 先于 `completeTurn` 推送（`agent-service.ts:945,956`），
  该路径回落先跑一次、事件随后再失效一次——失效幂等，仅多一次重拉；回落删除后自然归一。

### 2.6 消费矩阵（域 → 渲染层既有 key）

| 域 | 覆盖的 queryKey（前缀匹配） | 消费方 |
|---|---|---|
| `sessions` | `['sessions']` | 侧栏列表（分页 InfiniteData） |
| `session:<id>` | `['session', id]`（详情 + 回合历史子 key） | ChatPage 元数据 / 回合记录 |
| `goal` / `task` / `usage` / `git` / `file` / `turns` | `QUERY_KEY_ROOTS` 对应根 | 目标栏 / InfoPane / 设置页用量 / GitPanel / 文件面板 / 回合记录 |
| `memory` | `['memory', ...]`（list + status） | 记忆面板（`memory-panel.tsx:240,257`） |
| `im` | `['im', ...]` | IM 渠道设置节（`im-channels-section.tsx:40`） |

## 3. 实施分步

1. **shared**：`schemas/invalidation.ts`（payload schema/类型 + 词表 + 聚合清单构造）；
   `meta.ts` / `definitions.ts` 各一行；`main.ts` / `renderer.ts` / `index.ts` 出口登记
   （renderer 出口按值导出词表常量，对齐 `SETTING_KEYS` 先例）。
2. **main 基础设施**：`src/main/infra/invalidation/invalidation.ts`（§2.3）。
3. **main 声明点**：§2.4 的 S1–S10 逐点接入（service 层直调 `broadcastInvalidation`，均为
   infra 叶子依赖，无环；失败路径不声明——只有真实写/状态迁移才通知）。
4. **renderer**：`lib/invalidation/` + `use-invalidation-bridge` + AppShell 挂载 +
   `use-agent-bridge` 回落改造（§2.5）+ `mock-api.ts` 补域。
5. **测试**：§6.1。

## 4. 风险与对策

| 风险 | 对策 |
|---|---|
| 广播风暴（S3/S4 每回合各一次 + S7 聚合） | 声明点只落在事务提交后的回合边界（appendMessage 每回合 2 次），无流中推送；TanStack 同 key 并发重拉自动去重 |
| D4A 徽标竞态回归 | markRunning/markIdle 刻意不声明（§2.4）；S4 在 markRunning 落库之后执行，重拉读到的是 running 真值，与 setQueryData 一致 |
| 事件与 stream:end 乱序导致漏失效 | S7 先广播后推 END（同通道队列保序）+ 覆盖判定全域命中才生效 + 旧清单兜底——三重防御 |
| 覆盖登记内存泄漏 | TTL 30s + 容量 128（超限逐出最旧），单测覆盖 |
| 新增声明点被遗忘（缺口 A 复发） | 声明调用与写库同文件同函数（贴近写路径）；spec §2.4 表作为台账，后续 PR 审阅对照 |

## 5. 验证方案

### 5.1 单元测试

| 文件 | 断言要点 |
|---|---|
| `src/main/infra/invalidation/invalidation.test.ts`（新） | 逐窗 send（channel + payload 形状）；isDestroyed 窗口跳过；无窗口 no-op；sessionId 条件展开（缺省不出现 undefined 键）；domains 空数组不发送 |
| `session-service.test.ts`（增强） | S1–S6 各写操作广播的域清单逐字断言；markRunning/markIdle **不**广播（防回归锚） |
| `agent-service.test.ts`（增强） | 回合完成 → 广播事件含 8 域聚合且**先于** `agent:stream:end`；无 webContents 的回合同样广播（缺口 D 锚） |
| `memory-hub-service.test.ts`（增强） | fake launcher + stub fetch 走通启动 → 广播 memory；进程退出回调 → 广播；未配置降级**不**广播 |
| `im-service.test.ts`（增强） | start 成功 / stop 真停止 / stopAll 广播 im；幂等重复调用不广播 |
| `memory.handler.test.ts`（增强） | clear/clearAll 有删除时广播 memory |
| `src/renderer/lib/invalidation/invalidation.test.ts`（新） | 域映射：`'sessions'`/`'session:<id>'`/各全局域 → 与 `QUERY_KEY_ROOTS` 对齐；非法域（空串/空段）→ null；覆盖判定：全域命中登记、部分命中不登记、TTL 过期失效 |
| `use-invalidation-bridge.test.tsx`（新） | 订阅/退订；事件 → 按映射逐域 invalidateQueries；无 window.api 跳过 |
| `use-agent-bridge.test.tsx`（增强） | 未覆盖 → 旧清单生效（既有断言保持绿）；已覆盖（noteInvalidationEvent 预置）→ 旧清单跳过但 L2 清理仍执行 |

### 5.2 门禁

`pnpm typecheck` → `pnpm lint` → `pnpm check:static` → `pnpm test:main` / `test:renderer` /
`test`（shared 层）→ `pnpm knip`（复核新增导出无死代码）→ `pnpm depcruise`（复核新模块无环）。
E2E 不在本任务范围（失效链路已由单测在通道级锚定；双桥并存行为回归由 use-agent-bridge 增强用例覆盖）。

## 6. 明确不做 / 后续演进

| 项 | 理由 |
|---|---|
| taskService / goalService / cron 写路径逐写声明 | task/goal 的消费方都在回合粒度刷新（S7 已覆盖）；逐写声明收益低、事件量增。待真实需求出现再按本 spec 契约接入 |
| 回合结束声明 `memory` | capture 异步落引擎（HTTP），回合结束时刻不保证已落盘，声明会给出"假新鲜"；记忆面板自有交互刷新路径 |
| IM adapter 级断线事件（7 渠道自动重连） | ImService 尚不观测 adapter isConnected 变化，接线属渠道层改造；S10 已把契约立好，届时只需在状态迁移处调 broadcastInvalidation |
| 渲染层旧清单立即删除 | 渐进兼容承诺：待 S7 在全路径（含 error 出口）稳定运行一个版本后，连覆盖判定一并删（代码内注释已锚定） |

## 7. 交付拆分

1. `docs(design): 31 号失效自动化设计文档` —— 本文档。
2. `feat(invalidation): 写路径声明式失效域与渲染层事件桥` —— §3 全部 + §5.1 测试 + 文档实施记录回填。
