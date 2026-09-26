# 技术债清单（DEBT REGISTER）

> 单一真源：所有已知但**尚未修复**的技术债在此登记。代码注释提及「技术债清单」时，
> 必须指向本文件的条目 ID（如 `debt.md#d1`），不允许指向「一份不存在的文档」。
>
> 生命周期：发现 → 登记（ID + 证据位置）→ 处置（修复/接受/降级）。
> 修复后**不要删行**——把「状态」改为 resolved 并附提交号，保留历史可追溯。
>
> 最后盘点：2026-09-24（来源：外部 agent 六轮审计 + 本地实测复核，数字以实测为准）。

## 索引

| ID | 严重度 | 主题 | 状态 |
|---|---|---|---|
| D1 | P2 | path-guard TOCTOU 残余风险 | resolved（双形态返回 realTarget，13 工具点适配） |
| D2 | P1 | 会话数据全量传输（无分页/增量） | resolved（2e20ed6，回合分页落地） |
| D3 | P2 | TSDoc 规则 18.1 无自动门禁 | resolved（check:tsdoc 门禁落地 + 存量清零） |
| D4 | P2 | `session:getTurnMessages` IPC 闲置未接线 | resolved（2e20ed6，渲染层已消费） |
| D5 | P2 | Query 预取/loader 空白（路由串行等待） | resolved（647896e，chat 路由 loader 预取） |
| D6 | P1 | 数据层写路径未收敛 + 事务边界未成文 | resolved（683b1f3，拍板成文 + 事务盘点） |
| D7 | P3 | css rgba alpha 效果色未收口令牌 | resolved（D7 专项，color-mix 收口 + rgba 门禁） |
| D8 | P3 | React Compiler 单组件 bail-out 无度量 | open（接受，源码层有 try-finally 规则兜底） |
| D9 | P3 | 云端 CI electron postinstall 解压竞态 | open（用户指示暂不管云端 CI） |

## 条目

### D1 · path-guard TOCTOU 残余风险

- 位置：[path-guard.ts:131](file:///src/main/infra/ai/tools/path-guard.ts)
- 描述（改造前）：字符串级边界检查后经 realpath 重校验已修大部分 TOCTOU，但「resolveRealTarget 返回后、
  实际 IO 前」的窗口仍存在，且各工具拿到的是 realpath 后的字符串，与输入形态脱节。残余风险低（需要本地并发攻击者）。
- 来源：安全审计（2026-09）。
- 处置：**resolved（2026-09-25）**。`resolveWithinWorkspace` 改返回双形态
  `{ resolved, realTarget }`——resolved 为输入形态（LLM/UI 展示零漂移），realTarget 为真实落点
  （文件 IO 必用）；13 个工具消费点统一适配（read/write/edit/list/glob/grep/code-review/
  code-symbols/codebase/lsp×3/run-command/terminal：IO 行用 realTarget，metadata/title 用 resolved；
  readTracker 三处键统一 realTarget）。path-guard 测试新增 TOCTOU 回归用例
  （symlink 场景 realTarget 为真实落点、resolved 保持输入形态；realpath 基准对比，兼容 macOS tmpdir 链接）。
  **如实登记的取舍**：① 渲染层用户手势路径（`confineToWorkspace`，用户在对话框选中的文件）保持
  resolved 形态——非 LLM 生成、无 symlink 换链威胁面；② 「resolveRealTarget 返回后、实际 IO 前」的
  检查-使用窗口在单线程工具执行流内已收窄到最小（校验结果直接作为 IO 入参，不再二次解析），
  理论上的跨进程竞态（外部进程在窗口内换链）由 OS 层兜底，用户态无解，与审计结论一致不再扩项。

### D2 · 会话数据全量传输

- 位置：[use-session-turns.ts](file:///src/renderer/hooks/use-session-turns.ts)、
  [chat.tsx](file:///src/renderer/routes/chat.tsx)、契约 `SessionGetReqSchema.includeMessages`。
- 描述（改造前）：会话消息历史全量拉取 + 渲染层 `message-window` 本地 DOM 裁剪（PAGE_SIZE 200），
  IPC 负载与内存随消息数线性增长。
- 处置：**resolved（2e20ed6，2026-09-24）**。渲染层改走 `getTurns`（回合元数据一次全量）+
  `getTurnMessages` 按回合分页（useInfiniteQuery，每页 10 回合）；`session:get` 增
  `includeMessages=false` 元数据模式；路由 loader 预取链与 lazy 并行；message-window DOM
  窗口移除（内存中 messages = 已加载页并集，天然有界）。
  数据不变量：所有持久化消息带 turnId（cron 预落库重复行已随 2e20ed6 移除）。
  **如实登记的取舍**：① /compact 后的压缩上下文消息无 turnId（「旧上下文不可回放」既有语义），
  按回合重建不含它们；② 会话内搜索/导航轨覆盖面 = 已加载页（更早回合未加载前不可达）。
- 来源：use-agent-bridge 注释自记 + 外部审计确认。

### D3 · TSDoc 规则 18.1 无自动门禁

- 位置：[check-tsdoc.ts](file:///scripts/check-tsdoc.ts)、
  [tsdoc-rules.ts](file:///scripts/lib/tsdoc-rules.ts)（判据核 + 反例测试）、
  [typescript-dev-standards-ai.md 规则 18.1](file:///docs/design/typescript-dev-standards-ai.md)。
- 描述：规则 18.1（export 的函数/类/接口/类型必须有 TSDoc）此前无自动门禁，
  check:comments 规则 A 只拦「过期 @param」不拦「缺失」。
- 处置：**resolved（2026-09-25）**。① 门禁落地：`pnpm check:tsdoc` 挂 check:static 链，
  @babel/parser AST 判据（重载/重导出/enum 语义、biome-ignore 邻近豁免），per-file 棘轮基线；
  ② 存量清零：实测 75 处（量化首跑 1126 为脚本误判，修正判据后 75 为真值——含 26 处
  「JSDoc 被 biome-ignore 隔开」的既有文档形态），全部基于真实行为补写；③ 分工成文：
  本门禁拦「缺失」，check:comments 规则 A 拦「漂移」。export const 未强制（规范 18.1 未列，
  16 处无注释仅统计）。

### D4 · `session:getTurnMessages` 闲置

- 位置：[use-session-turns.ts](file:///src/renderer/hooks/use-session-turns.ts)（useTurnMessagesInfinite）。
- 描述：与 D2 同根——分页能力在 IPC 侧已就绪，渲染层未消费。
- 处置：**resolved（2e20ed6）**，渲染层已按回合分页消费（连同 session:getTurns）。

### D5 · Query 预取 / loader 空白

- 位置：[router.tsx](file:///src/renderer/router.tsx)（chat 路由 loader）。
- 描述：进入 `/chat/:id` 的时序为 lazy 组件 → 挂载 → 才发 `useSessionDetail`，「等组件」与
  「等数据」串行。`prefetchQuery`/`ensureQueryData` 全仓 0 使用。
- 处置：**resolved（647896e，2026-09-24）**。chat 路由 loader 在 match 时 fire-and-forget
  预取（元数据 → 回合列表 → 首页消息链式 `ensureQueryData`，与 route.lazy 并行）；
  失败不阻断导航（错误仍由 ChatPage 守卫优雅处理）。home 路由无需预取——会话列表由
  Sidebar（非 lazy 的 AppShell）在启动时拉取。

### D6 · 数据层写路径与事务边界

- 位置：[18-data-layer-spec.md §三/§四](file:///docs/design/18-data-layer-spec.md)、
  [data-ownership.md](file:///docs/design/data-ownership.md)。
- 描述：规范既说「Service → Repository」又说「收敛在 storage/」，实现选了前者但规范未更新；
  多语句写路径无成文的事务边界依据。
- 处置：**resolved（683b1f3，2026-09-24）**。spec 修订为「Service 直访 getDb 合法」（旧
  Repository 规矩废止），事务边界清单全量盘点成文：真正的多语句写仅 4 处（session 3 + goal 1）
  且均已有事务；审计所称「约 13 处多语句写」实为 13 处 getDb 调用现场、逐一核查均为单语句
  DML——**无需补事务**；runtime-model-store 跨存储组合（DB+keychain+registry）按
  「DB 真源 + 可重建投影」成文。数据所有权/缓存失效全景另立 data-ownership.md。

### D7 · css rgba alpha 效果色未收口

- 位置：[styles/*](file:///src/renderer/styles)（效果层，原 globals.css 已按域拆分）、
  [token-rules.ts](file:///scripts/lib/token-rules.ts)（scanCss 门禁）。
- 描述（改造前）：globals.css 内 16 处 `rgba(…)` 带 alpha 效果色，且**基色与令牌漂移**
  （diff 绿 #22c55e ≠ --success、红 #ef4444 ≠ --error、琥珀 #ffb84d ≠ --amber——暗主题不联动）。
- 处置：**resolved（D7 专项，2026-09-25）**。16 处全部改写 `color-mix(in srgb, …)` 形态：
  文学棕 3 处入新令牌 `--ink-brown`（亮 #8B4513 / 暗 #D4A574，恰为现状双主题值）；
  diff/琥珀/stop 红 7 处对齐既有语义令牌（--success/--error/--amber，顺带修复暗主题联动）；
  白高光 5 处 + 阴影黑 1 处用 white/black 关键字（双主题语义一致，无需令牌）。
  门禁升级：scanCss 增补 `rgba?(` 检测（error 级，存量 0；color-mix 形态不误报；
  tokens.css 生成物豁免不变）。视觉变化如实登记：diff 绿/红与琥珀边框色值向令牌收敛
  （同色系内微差），暗主题下这些效果色首次跟随主题。

### D8 · React Compiler 单组件 bail-out 无度量

- 位置：check:compiler 为产物级调用点门禁（chunk 粒度），单个组件 bail-out 不可见。
- 描述：渲染层禁 try/finally 规则（check-ui-consistency `try-finally`）已在源码层拦主要
  bail-out 源头；产物级「每组件是否被编译」无度量。
- 处置：接受现状（源码规则兜底 + 产物调用点下限防整体失效）。

### D9 · 云端 CI electron postinstall 解压竞态

- 位置：.github/workflows/ci.yml「Ensure Electron binary (repair install race)」步骤。
- 描述：多平台 unit job 偶发失败于 electron 二进制解压竞态，现有「重装兜底」未消除竞态。
- 处置：2026-09-24 用户指示暂不管云端 CI；登记备查，恢复云端治理时优先处理
  （方向：消除 postinstall 并发解压，而非加强重装兜底）。

## 已解决（保留历史）

| ID | 主题 | 解决提交 |
|---|---|---|
| — | styles 双门禁逃逸（css 纳入 tokens/file-size 棘轮 + ink 令牌） | ffb319d |
| — | check:compiler 字符串判据假阳性（调用点 + 下限） | 2adc74a |
| — | 组件直连 IPC 无门禁（direct-ipc 规则 + 棘轮） | 05e6cec |
| — | settings 覆盖率洼地不可见（renderer-settings 层；实测推翻旧「21%」口径） | c3d7f4f |
| — | 标准设施采用率无正向推力（adoption 棘轮） | 777fadd |
| — | pnpm 命令引用漂移无门禁（check-comments 规则 D） | 761efd1 |
| — | 文档/配置漂移 11 项 + Sentry 残留 + provenance 失效 | 01f3502 / d3dee09 |
| — | 审计白名单过时（audit 真 0 命中）+ vendored 锁文件依赖告警源 | fe7ba0e |
