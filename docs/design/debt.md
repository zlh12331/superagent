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
| D1 | P2 | path-guard TOCTOU 残余风险 | open（接受，专项时处理） |
| D2 | P1 | 会话数据全量传输（无分页/增量） | open（批 6 改造中） |
| D3 | P2 | TSDoc 规则 18.1 无自动门禁 | open（维持标注，不强制） |
| D4 | P2 | `session:getTurnMessages` IPC 闲置未接线 | open（并入 D2 批次） |
| D5 | P2 | Query 预取/loader 空白（路由串行等待） | open（批 4 改造中） |
| D6 | P1 | 数据层写路径未收敛 + 事务边界未成文 | open（批 5 拍板后收敛） |
| D7 | P3 | css rgba alpha 效果色未收口令牌 | open（color-mix 专项） |
| D8 | P3 | React Compiler 单组件 bail-out 无度量 | open（接受，源码层有 try-finally 规则兜底） |
| D9 | P3 | 云端 CI electron postinstall 解压竞态 | open（用户指示暂不管云端 CI） |

## 条目

### D1 · path-guard TOCTOU 残余风险

- 位置：[path-guard.ts:131](file:///src/main/infra/ai/tools/path-guard.ts)
- 描述：字符串级边界检查后经 realpath 重校验已修大部分 TOCTOU，但「resolveRealTarget 返回后、
  实际 IO 前」的窗口仍存在。残余风险低（需要本地并发攻击者），专项处理方案：
  「返回 realTarget + 全量回归」。
- 来源：安全审计（2026-09）。

### D2 · 会话数据全量传输

- 位置：[use-agent-bridge.ts](file:///src/renderer/hooks/use-agent-bridge.ts)（失效点注释）、
  契约 `SessionGetReqSchema = { id }`（无分页参数，`messages` 全量返回）。
- 描述：会话消息历史全量拉取 + 渲染层 `message-window` 本地 DOM 裁剪（PAGE_SIZE 200）。
  长会话下 IPC 负载与内存随消息数线性增长。
- 处置：`session:getTurnMessages`（按回合分页）已在 IPC 契约中但渲染层未接线；
  改造方案 = 渲染层换 `useInfiniteQuery` 按回合增量拉取，message-window 退化为滚动锚定。
- 来源：use-agent-bridge 注释自记 + 外部审计确认。

### D3 · TSDoc 规则 18.1 无自动门禁

- 位置：[check-comments.ts](file:///scripts/check-comments.ts) 头注释「已知盲区」段、
  [typescript-dev-standards-ai.md](file:///docs/design/typescript-dev-standards-ai.md) 规则 18.1。
- 描述：check:comments 规则 A 只拦「过期 @param」，不拦「缺失注释」；全量强制需 AST 扫描 +
  棘轮基线（存量无 TSDoc 的 export 数量多）。
- 处置：2026-09-24 已双端如实标注；评估结论为「收益 < 噪音，暂不实施」。

### D4 · `session:getTurnMessages` 闲置

- 位置：`packages/shared` 契约已定义；渲染层仅 [mock-api.ts](file:///src/renderer/dev/mock-api.ts) 占位。
- 描述：与 D2 同根——分页能力在 IPC 侧已就绪，渲染层未消费。并入 D2 批次一并处置。

### D5 · Query 预取 / loader 空白

- 位置：[router.tsx](file:///src/renderer/router.tsx)（`route.lazy` 但无 loader）。
- 描述：进入 `/chat/:id` 的时序为 lazy 组件 → 挂载 → 才发 `useSessionDetail`，「等组件」与
  「等数据」串行。`prefetchQuery`/`ensureQueryData` 全仓 0 使用。
- 处置：路由 loader + `ensureQueryData`（2026-09-24 批次实施中）。

### D6 · 数据层写路径与事务边界

- 位置：[18-data-layer-spec.md](file:///docs/design/18-data-layer-spec.md)（规范自相矛盾）、
  7 个服务约 20+ 处 `getDb()` DML（cron 6 / goal 4 / prompt 4 / runtime-model-store 5 /
  learn-skill-agent 3 / task 3）、事务全主进程仅 5 处（session 4 + goal 1）。
- 描述：规范既说「Service → Repository」又说「收敛在 storage/」，实现选了前者但规范未更新；
  多语句写路径无成文的事务边界依据。
- 处置：2026-09-24 拍板「Service 直访合法化」（session-service 模式健康），spec 修订 +
  事务边界清单成文（同批次）。

### D7 · css rgba alpha 效果色未收口

- 位置：[check-tokens.ts](file:///scripts/check-tokens.ts) css 分支（hex 已管，rgba 边界如实记录）。
- 描述：globals.css 内 12+ 处 `rgba(…)` 带 alpha 效果色（白 3%-35%、语义色低透明度变体），
  收编需 color-mix + 令牌 alpha 体系改造。
- 处置：独立批次评估；铁律口径以「hex 硬编码 0 存量」先行。

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
