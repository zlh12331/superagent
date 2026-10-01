# 数据所有权与缓存失效规范（Data Ownership & Invalidation）

> 回答一个问题：**每类数据的真源在哪、谁写、渲染层谁缓存、谁负责失效。**
> 失效中枢是 `use-agent-bridge`（AppShell 挂载，回合结束统一处理）——本文件是其注释的
> 全景视图；两者不一致时以代码为准并回改本文。
>
> 最后同步：2026-09-24（debt.md#d6 批次成文）

---

## 一、判据（四层状态架构）

| 层 | 用途 | 落点 |
|---|---|---|
| L1 useState | 组件内瞬态（输入框/折叠/编辑态） | 组件 |
| L2 Zustand | 客户端共享：persistent/（跨重启）/ transient/（会话内流式） | `stores/` |
| L3 TanStack Query | IPC invoke（请求-响应）：缓存/竞态/重试 | `hooks/` 域文件 + `lib/query/keys.ts` |
| L4 IPC 事件流 | 主进程持续推送 → subscribe 直接写 transient store | `use-*-bridge` |

判定：IPC invoke → L3；IPC on（持续推送）→ L2 transient；UI 交互态 → L2 transient；组件独享 → L1。

## 二、SQLite 持久数据（真源 = 主进程库表）

| 数据 | 真源 | 写入方（主进程） | 渲染层消费 | 渲染层缓存 | 失效点 |
|---|---|---|---|---|---|
| 会话列表 | `sessions` 表 | SessionService | Sidebar / CommandPalette / fuzzy-search | L3 `['sessions']`（InfiniteData） | use-agent-bridge；session 增删改 mutation `onSettled` |
| 会话详情+消息 | `sessions` + `messages` | SessionService（append/replace） | ChatPage → ChatPanel initialMessages | L3 `['session', id]` | use-agent-bridge；删除会话 `removeQueries`（debt#d2 关联缺口已修）；/compact invalidate |
| 回合记录 | `turns` 表 | usage-turn-store `recordTurn` | 设置页回合记录 | L3 `['turns']` | use-agent-bridge |
| Token 用量 | `token_usage` | usage-turn-store `recordUsage` | 设置页 usage-section | L3 `['usage']` | use-agent-bridge |
| 会话目标 | `goals` | GoalService（回合判定） | GoalBar | L3 `['goal', 'list', sessionId]` | use-agent-bridge；goal mutation |
| 委派任务 | `tasks` | TaskService（SubagentManager） | InfoPane | L3 `['task']` | use-agent-bridge |
| 定时任务 | `cron_tasks` | CronService | cron 工具 / 管理面板 | L3（就近 key） | mutation 后 invalidate |
| 已学技能 | `skills` | LearnSkillAgent | skill 面板 / load_skill | L3（就近 key） | mutation 后 invalidate |
| Prompt 模板 | `prompts` | PromptService | （预留设置界面） | — | — |
| 运行时模型 | `runtime_models` | RuntimeModelStore | 设置页模型列表 | L3（就近 key） | mutation 后 invalidate |
| API Key | keychain.dat（safeStorage 加密） | api-key service（main） | 设置页（掩码回显） | 不缓存（按需查询） | — |
| 应用设置 | `app_settings` 表 | settings:set 写穿透 | settings-store 内存镜像 | L2（内存态，非持久插件） | 启动快照 `settings:getAll` 拉取；legacy localStorage 首启迁移 |
| 会话记忆 | `userData/memory-hub` | memory-engine（utilityProcess） | memory 面板 | L3 `['memory']` | mutation 后 invalidate |

**事务边界**：主进程多语句写的判据与全量盘点见 [18-data-layer-spec.md §四](18-data-layer-spec.md)。

## 三、工作区数据（真源 = 文件系统 / .git，非本应用持有）

| 数据 | 真源 | 谁改 | 渲染层缓存 | 失效点 |
|---|---|---|---|---|
| Git 状态 / diff / log | 工作目录 `.git` | 用户终端 / Agent git 工具 | L3 `['git']`（staleTime 10s） | use-agent-bridge（回合内 git_* 写入后回合结束刷新） |
| 文件树 / 文件内容 / diff 视图 | 工作目录文件 | Agent write_file/edit_file / 用户 | L3 `['file']`（staleTime 30s） | use-agent-bridge（落盘后回合结束刷新） |

渲染层对这两类数据**只有缓存，没有所有权**——永远以 IPC 重查为准，不做本地合并。

## 四、L4 推送 → L2 transient store（流式数据）

| Store | 数据来源（推送） | 生命周期 |
|---|---|---|
| tool-store | `tool:call` 流（工具调用快照） | **回合结束不清空**（例外，见下）；环形淘汰 MAX_CALLS_PER_SESSION + 会话切换按 sessionId 过滤 |
| approvals-store | 审批请求事件 | 回合结束 `clearBySession` |
| agent-ask-store | ask_user_question 请求 | 回合结束 `clearAsk`（含 60s 超时兜底） |
| agent-run-store / pending-message-store | agent 回合状态流 | 回合结束由 ChatPanel/bridge 状态机收敛 |
| terminal-store | `terminal:output` | 会话切换清空 |
| rate-limit-store | stream error（AI_RATE_LIMITED） | 横幅确认后复位 |
| update-store | `update:status` | 应用生命周期 |
| reasoning-collapse-store / file-viewer-store / file-tree-store / ui-store / confirm-dialog-store / welcome-store | 纯 UI 交互态 | 组件卸载 / 用户操作 |

**例外登记（tool-store）**：回合结束不清空——右面板 DiffPane/InfoPane 的「本轮文件变更/
引用文件」数据源正是 callsBySession，回合结束瞬间清空会让用户恰在回合后想回看变更时无数据。
内存上界由环形淘汰保证（这是 use-agent-bridge 注释中 P3 决策的规范级登记）。

## 五、纯 UI 态（localStorage，非数据真源）

| Store | 内容 | 说明 |
|---|---|---|
| draft-store | 输入框草稿 | 可丢 |
| sessions-store | activeSession 激活会话指针 | 可丢（详情从 L3 重查） |
| sidebar-pref-store | 侧栏折叠/宽度偏好 | 可丢 |

设置类（theme/ai/editor/shortcuts/experimental）**不在** localStorage：真源 = `app_settings`
表（用户决策 2026-09），localStorage 仅存 legacy 迁移前的历史数据。

## 六、失效中枢（use-agent-bridge）职责清单

回合结束（stream:end / stream:error）统一执行：

1. **L3 失效 8 域**：`['sessions']`（恒发）+ sessionId 非空时：session 详情 / goal / task /
   usage / git / file / turns（前缀匹配，key 根见 `lib/query/keys.ts` QUERY_KEY_ROOTS）
2. **L2 清理**：approvals-store.clearBySession + agent-ask-store.clearAsk
3. **错误域联动**：429 → rate-limit-store.trigger

新增「回合内被 Agent 改写、回合外展示」的数据域时：key 进 QUERY_KEY_ROOTS + 本文件第二节
登记 + use-agent-bridge 加一行失效——三处缺一即出现「回合后看到旧数据」的静默失效缺口
（task/usage/git/file/turns 五域的历史教训均为漏配此链）。
