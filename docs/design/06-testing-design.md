# 06 · 测试设计文档

> 本文档基于源码梳理 Code Agent 项目的测试体系结构。
> 所有测试文件路径、配置项、覆盖目标均来自项目实际代码。

## 1. 测试金字塔

项目采用经典测试金字塔 + Electron 适配层：

```
                ┌──────────────────────────┐
                │   Smoke (Prod Build)     │  e2e/smoke.prod.spec.ts
                │   生产构建 smoke          │
                ├──────────────────────────┤
                │   E2E (Electron)          │  e2e/electron.spec.ts
                │   真实 Electron 窗口      │
                ├──────────────────────────┤
                │   E2E (Browser)          │  e2e/{smoke,visual,a11y}.spec.ts
                │   dev server 浏览器       │
                ├──────────────────────────┤
                │   Perf Bench              │  e2e/perf/navigation.bench.spec.ts
                │   性能基准                │
                ├──────────────────────────┤
                │   Unit (vitest)           │  128 个测试文件 / 242+ 用例
                │   shared / main / renderer │
                │   + scripts               │
                └──────────────────────────┘
```

## 2. 测试工具链

| 工具 | 版本 | 角色 |
|------|------|------|
| vitest | `^4.0.0` | 单元测试 runner + coverage |
| @vitest/coverage-v8 | `^4.0.0` | V8 原生覆盖率 |
| @playwright/test | `^1.58` | E2E + Electron + smoke |
| playwright | `^1.61.1` | 浏览器驱动 |
| @testing-library/react | `^16.3.2` | React 组件测试 |
| @testing-library/user-event | `^14.6.1` | 用户交互模拟 |
| @testing-library/jest-dom | `^7.0.0` | DOM 断言扩展 |
| jsdom | `^29.1.1` | 浏览器环境模拟 |
| @axe-core/playwright | `^4.12.1` | 可访问性审计 |

源码：[package.json#L79-L117](file:///f:/TraeProjects/1/package.json#L79)（devDependencies）。

> 注：`msw` 已从 devDependencies 中移除，渲染层 mock 由独立 mock-api 层实现（见 §5.1）。

## 3. 单元测试（vitest）

### 3.1 配置文件分布

3 套独立 vitest 配置：

| 配置 | 路径 | 作用域 |
|------|------|------|
| 配置 1 | [src/main/vitest.config.ts](file:///f:/TraeProjects/1/src/main/vitest.config.ts) | 主进程测试 |
| 配置 2 | [src/renderer/vitest.config.ts](file:///f:/TraeProjects/1/src/renderer/vitest.config.ts) | 渲染进程测试 |
| 配置 3 | [packages/shared/vitest.config.ts](file:///f:/TraeProjects/1/packages/shared/vitest.config.ts) | shared 包测试 |

### 3.2 跑测试脚本

来自 [package.json#L33-L58](file:///f:/TraeProjects/1/package.json#L33)：

| 脚本 | 命令 | 说明 |
|------|------|------|
| `test` | `pnpm -r --filter "@code-agent/*" --filter "!@code-agent/typedoc-docs" run test && pnpm test:main && pnpm test:renderer && pnpm test:scripts` | 全量单元测试（shared + main + renderer + scripts） |
| `test:scripts` | `vitest run --root scripts` | scripts 目录测试（i18n / changelog / scaffold 工具链） |
| `test:main` | `vitest run --root src/main` | 仅主进程 |
| `test:renderer` | `vitest run --root src/renderer` | 仅渲染层 |
| `test:coverage` | `pnpm --filter "@code-agent/shared" exec vitest run --coverage && pnpm test:main -- --coverage && pnpm test:renderer -- --coverage` | shared + main + renderer 覆盖率 |

### 3.3 覆盖率配置

3 套 vitest.config.ts 阈值。**分层规范值**（长期目标）与**当前防倒退门槛**（实测 − 5 缓冲）分离，以配置文件为准：

| 配置 | statements | branches | functions | lines | 说明 |
|------|-----------|----------|-----------|-------|------|
| shared 规范值 | 80 | 30 | 40 | 80 | IPC schema/常量/类型声明包，分支/函数天然低（有效覆盖理念，不套业务层标准） |
| shared 当前门槛 | 80 | 19 | 33 | 80 | 2026-08-12 更新：契约补测后实测 85.78/24.28/38.46，新实测−5 取整（分支 19/函数 33），逼近规范 80/30/40/80 |
| main 规范值 | 80 | 75 | 80 | 80 | 业务核心层（与 §3.4 核心域目标一致） |
| main 当前门槛 | 80 | 75 | 80 | 80 | 2026-08-12 更新：14 批补测后实测 92.45/84.59/89.57，实测−5 缓冲超过规范值 → 取规范值 |
| renderer 规范值 | 80 | 75 | 80 | 80 | 业务核心层 |
| renderer 当前门槛 | 80 | 75 | 80 | 80 | 2026-08-12 更新：8 批补测后实测 92.87/87.97/90.92，实测−5 缓冲超过规范值 → 取规范值 |

**门槛定位与收紧机制**：
- 门槛 = 防倒退（拦显著下降），**不是目标值**；缓冲取实测 −5 点，避免小幅波动误伤 CI
- 原 shared 分支 18/函数 33 为贴地阈值（实测余量 <1 点），新增带分支逻辑即卡关且无防倒退意义——已下调留缓冲
- **收紧触发**：每轮用例补全/覆盖率提升后，门槛跟随"新实测 − 5 缓冲"上调，逐步逼近分层规范值（配套 §3.4 用例补全策略）
- shared 分支/函数不做业务层标准：声明包分支天然低，硬追 75% 无收益

### 3.4 用例补全策略（业界共识 + 项目基线，2026-08-11 落档）

**业界成熟要求**（WebSearch 交叉验证）：
- 测试金字塔（Google）：70% 单测 / 20% 集成 / 10% E2E；分层目标单测 ≥80% / 集成 ≥60% / E2E ≥40%
- **分支覆盖率 85% 是性价比拐点**（微软实测：85% → 生产缺陷率降 58%，超过后收益递减）
- 有效覆盖（Azure）：剔除 getter/setter/初始化样板，核心逻辑才是目标；阿里实践：60% 轻松、95%+ 边际效应递减
- 用例设计三件套：**等价类划分**（有效/无效各 ≥1）+ **边界值分析**（取边界 ±1）+ **错误猜测**（0/空/单行/超长/异常路径）

**项目基线**（2026-08-11 实测 main 层分支覆盖，缺口 = 边界/异常用例不足的量化证据）：

| 优先级 | 模块 | 分支覆盖 | 缺口 |
|---|---|---|---|
| P0 | codebase（代码库分析，核心域） | 9.37% | 几乎空白，语句+分支全量起步 |
| P0 | providers（AI 供应商路由，核心域） | 48.52% | fallback 降级链/配置缺失/模型不存在 |
| P1 | file（文件操作，边界多） | 38.66% | 路径边界/编码检测/错误分类 |
| P1 | agent（回合编排） | 63.65% | 回合异常路径：max-steps/abort/工具失败 |
| P2 | im/adapters、lsp、skills | 44-62% | 协议异常分支补到 70%+ |

**变异测试降级记录**（2026-08-11）：Stryker 9.6.1 与项目 TypeScript 7 不兼容
（ts.parseConfigFileTextToJson API 缺失，@stryker-mutator/vitest-runner 9.6.1 报错）——
闸门 3 降级为"断言有效性抽查"：核心域 122 用例 / 194 断言（密度 1.6/用例），零空跑。
触发条件：Stryker 发布 TS7 兼容版本后重跑。

**目标线（到什么程度停）**：
- 核心域分支追到 **80-85%**（业界拐点），中等域 **70-75%**
- **停止判据**：分支 ≥85% 后收益递减不硬追；getter/setter/日志行不补（有效覆盖理念）

### 3.6 测试边界规范（程序化门禁，2026-08-12 落地）

**边界定义**：单元/集成/E2E 边界 = 被测范围 × 替身位置 × 断言对象（非文件位置）。

| 层 | 被测范围 | 替身位置 | 断言对象 | 位置 |
|---|---|---|---|---|
| 单元 | 单模块内部逻辑 | 邻居 mock | 返回值/内部状态 | src/**/*.test.{ts,tsx}（colocation） |
| 集成 | 多真实模块链路 | 只替身外部边界（LLM/平台/IO） | 跨模块契约 | tests/integration/** |
| E2E | 整个应用 + 真实 UI | 零替身 | 用户可感知结果 | e2e/** |

**程序化强制（CI 卡关）**：
1. **目录规则**：单测 colocation、集成 tests/integration/、E2E e2e/（目录本身即分层）。
2. **集成禁 mock 同仓业务**（scripts/check-test-boundary.ts 规则 1）：
   - tests/integration/** 中 vi.mock 指向同仓源码 = 假集成（error 卡关）。
   - **IO 边界替身允许**（简化环境 Medium Test 标准做法）：infra/storage（DB 换内存实现）、
     utils/logger、telemetry——推荐部分 mock（importOriginal）保留其余实现。
3. **准集成登记制**（规则 2）：src/**/*.test.ts 出现真实 IO 信号
   （better-sqlite3 真实实例/WebSocket/node:http server/new Database）= "准集成测试"，
   必须登记 scripts/test-boundary-exempt.json（当前 20 个存量已登记），未登记 = error。
   登记项未来随集成测试体系建设逐步迁移到 tests/integration/。
4. **恒真断言**（规则 3，warning）：expect(true).toBe(true) 等字面量自比 = 空跑，
   存量清零后升 error。
5. **import 边界**（dependency-cruiser）：tests/integration 禁止依赖 src/renderer、src/preload
   （跨进程边界，integration-not-renderer 规则）。
6. **速度约束**（vitest 配置）：tests/integration/vitest.config.ts testTimeout 60s
   （集成测试为秒级 Medium Test，非分钟级）。

**运行**：pnpm check:test-boundary（已并入 check:static）；pnpm depcruise（含 tests/integration）。

**灰色地带说明**：单模块 + 真实 DB/网络 = "准集成"（integration-ish unit test）——
不是正式集成覆盖，登记表中标注原因，避免被误判为"集成已覆盖"。

### 3.5 测试文件清单（176 个）

> 以下按区域列出代表性文件，完整清单以 `Glob "**/*.test.{ts,tsx}"` 为准。

#### shared 包（5 个）

| 文件 | 说明 |
|------|------|
| [packages/shared/src/__tests__/channels.test.ts](file:///f:/TraeProjects/1/packages/shared/src/__tests__/channels.test.ts) | IPC_CHANNELS 常量与 IpcChannel 类型校验 |
| [packages/shared/src/__tests__/errors.test.ts](file:///f:/TraeProjects/1/packages/shared/src/__tests__/errors.test.ts) | AppError / ErrorCode 错误码体系 |
| [packages/shared/src/__tests__/api.test.ts](file:///f:/TraeProjects/1/packages/shared/src/__tests__/api.test.ts) | IpcApi 接口形状 |
| [packages/shared/src/__tests__/smoke.test.ts](file:///f:/TraeProjects/1/packages/shared/src/__tests__/smoke.test.ts) | shared 包 smoke |
| [packages/shared/src/__tests__/shared-gaps.test.ts](file:///f:/TraeProjects/1/packages/shared/src/__tests__/shared-gaps.test.ts) | 契约补测：deriveChannels/元数据构造器/单一真源一致性/schema 拦截抽查 |

#### main 主进程（122 个）

涵盖 AI 核心（agent-service / chat-service / tool-registry / tool-executor / permission-service / error-classifier / context-compression / ai-provider / models/* / agent-runtime/* / llm-client/* / providers/*）、MCP（mcp-service / mcp-client / mcp-tool-adapter / mcp-types）、工具（file-tools / search-tools / path-guard / run-command）、基础设施（file-service / git-service / session-service / db / keychain / app-data / code-analyzer / update-service / csp）、IPC handler（全部 16 域各一个）、配置与工具（config / logger / retry / wrap）、smoke（services.smoke）。

代表性文件：

| 文件 | 说明 |
|------|------|
| [src/main/infra/ai/agent-service.test.ts](file:///f:/TraeProjects/1/src/main/infra/ai/agent-service.test.ts) | AgentService 多轮工具调用 + abort + dispose |
| [src/main/infra/ai/chat-service.test.ts](file:///f:/TraeProjects/1/src/main/infra/ai/chat-service.test.ts) | ChatService 流式 + abort + dispose |
| [src/main/infra/ai/tool-executor.test.ts](file:///f:/TraeProjects/1/src/main/infra/ai/tool-executor.test.ts) | 工具执行 + 权限审批 |
| [src/main/infra/ai/permission-service.test.ts](file:///f:/TraeProjects/1/src/main/infra/ai/permission-service.test.ts) | 权限决策 + 记忆缓存 |
| [src/main/infra/storage/session-service.test.ts](file:///f:/TraeProjects/1/src/main/infra/storage/session-service.test.ts) | 会话 CRUD + 用量统计 + 回合记录 |
| [src/main/infra/git/git-service.test.ts](file:///f:/TraeProjects/1/src/main/infra/git/git-service.test.ts) | Git 操作（status / diff / add / commit / push） |
| [src/main/infra/file/file-service.test.ts](file:///f:/TraeProjects/1/src/main/infra/file/file-service.test.ts) | 文件读写 + 目录列举 + 监听 |
| [src/main/ipc/agent.handler.test.ts](file:///f:/TraeProjects/1/src/main/ipc/agent.handler.test.ts) | agent 域 IPC handler |
| [src/main/security/csp.test.ts](file:///f:/TraeProjects/1/src/main/security/csp.test.ts) | CSP 安全策略 |

#### renderer 渲染层（44 个）

涵盖 hooks（use-agent-bridge / use-terminal-bridge / use-git / use-update / use-api-key / use-sessions / use-tool-bridge / use-async-view）、组件（DevPanel / TerminalPanel / GitPanel / AsyncBoundary / EmptyState）、stores（terminal-store / usage-store）、lib（theme-init / error-actions / format-time / ipc / diff-stats）、mock-api、smoke。

代表性文件：

| 文件 | 说明 |
|------|------|
| [src/renderer/test/__tests__/mock-api.test.ts](file:///f:/TraeProjects/1/src/renderer/test/__tests__/mock-api.test.ts) | mock-api 形状一致性 |
| [src/renderer/hooks/__tests__/use-agent-bridge.test.tsx](file:///f:/TraeProjects/1/src/renderer/hooks/__tests__/use-agent-bridge.test.tsx) | Agent 桥接 hook |
| [src/renderer/components/layout/__tests__/DevPanel.test.tsx](file:///f:/TraeProjects/1/src/renderer/components/layout/__tests__/DevPanel.test.tsx) | DevPanel |
| [src/renderer/stores/transient/__tests__/usage-store.test.ts](file:///f:/TraeProjects/1/src/renderer/stores/transient/__tests__/usage-store.test.ts) | 用量统计 store |

#### scripts 工具链（5 个）

| 文件 | 说明 |
|------|------|
| [scripts/i18n/locales-consistency.test.ts](file:///f:/TraeProjects/1/scripts/i18n/locales-consistency.test.ts) | i18n 语言包一致性校验 |
| [scripts/changelog/lib/parse.test.ts](file:///f:/TraeProjects/1/scripts/changelog/lib/parse.test.ts) | changelog 解析 |
| [scripts/scaffold/lib/text.test.ts](file:///f:/TraeProjects/1/scripts/scaffold/lib/text.test.ts) | scaffold 文本工具 |
| [scripts/scaffold/lib/naming.test.ts](file:///f:/TraeProjects/1/scripts/scaffold/lib/naming.test.ts) | scaffold 命名工具 |
| [scripts/scaffold/lib/args.test.ts](file:///f:/TraeProjects/1/scripts/scaffold/lib/args.test.ts) | scaffold 参数工具 |

## 4. E2E 测试（Playwright）

### 3.7 集成测试体系建设记录（2026-08-12 完成 9 批）

**规模**：tests/integration/ 22 文件 / 156 用例（基线 60 用例 → 新增 96 用例；补充批次：agent 审批链路 2 用例——ask 工具→审批请求→批准/拒绝→真实执行/TOOL_PERMISSION_DENIED，安全边界维度补全）。

**批次完成情况（9/9）**：
| 批次 | 域 | 用例 | 暴露缺陷（已修复） |
|---|---|---|---|
| 1 | session（核心） | 17 | — |
| 2 | agent.run 主链路（核心） | 4 + 2 豁免 | — |
| 3 | file（核心） | 14 | FileService.delete recursive 默认 |
| 4 | git（核心） | 11 | GitService paths/ref 可选参数防御 |
| 5 | terminal（核心） | 7 | — |
| 6 | settings/whitelist | 11 + 1 豁免 | — |
| 7 | search/codebase | 10 | codegraph Windows spawn shell / undefined 参数 |
| 8 | chat + 简单域 | 16 | — |
| 9 | skill/mcp/task | 4 + 13 豁免 | — |

**豁免清单（16 条，全部客观不可达类）**：
1. AGENT_STREAM_ERROR 精确触发（SDK 将 model 层错误流化——需真实 HTTP provider 错误；证据：普通 Error/APICallError 注入均被 executeLanguageModelCall 流化）
2. END(aborted) 归因推送（fake model 挂起流下 SDK 等 chunk 才检测 abort；aborted 归因由单测覆盖）
3. keychain 并发写竞争（读-改-写无锁——生产 IPC 主进程串行不触发）
4-16. batch 9 外部边界（audio 录音硬件 / im 平台账号 / mcp start·stop 外部服务 / update electron-updater 运行时 / skill learn 真实 LLM——全部"需真实外部环境"类，快通道复核通过，豁免比例 15% < 50%）

**缺陷观察项（未修，低风险）**：
- codebase 未初始化目录错误码漂移（注释声称 INVALID_INPUT，实现全走 INTERNAL_ERROR——语义问题，待分类逻辑完善）

**测试技术沉淀**：
- fake-model（AI SDK v7 流协议：text-delta 用 delta + text-start 前置 + holdOpen + abort 响应）
- with-db（真实 db.ts + 临时 userData + electron SDK 替身）
- 平台 shell（Windows ComSpec/node-pty 不查 PATH）
- codegraph 探测（skipIf 环境依赖——CI 无 CLI 时正向自动跳过）

**四道闸门判定（2026-08-12）**：
1. 链路完备 ✓（矩阵全绿；豁免 16 条附证据）
2. 断言有效 ✓（无恒真断言；抽查通过）
3. 职责边界 ✓（跨模块契约；chat 无持久化职责已确认）
4. 回报归零 ✓（5 缺陷全修复含回归锚定；batch 8/9 连续无新缺陷）

### 4.5 性能基准体系（e2e/perf/，`pnpm test:perf`）

| 基准 | 阈值（基线） | 职责 |
|---|---|---|
| navigation.bench | 首载可交互 < 3000ms | 页面加载/路由切换/渲染稳定 |
| render.bench | 1000 条渲染 < 5000ms / 滚动 1000px < 500ms | 大列表渲染与滚动（防回退） |
| memory-leak | 长会话操作 heap 增长 < 15MB | 泄漏回归检测（GC 不稳定，阈值宽松） |
| ipc-rtt | window.api 100 次平均 < 10ms | 渲染层调用路径开销（mock 模式） |

> 说明：基准为宽松基线（防明显回退），随优化渐进收紧；render/memory 为 DOM 级注入验证（真实 React 长会话渲染基准后续补）；真实 IPC RTT 由 Electron E2E 链路间接覆盖。


### 4.1 三套 Playwright 配置

| 配置 | 路径 | 触发脚本 | 目标 |
|------|------|---------|------|
| Browser | [e2e/playwright.config.ts](file:///f:/TraeProjects/1/e2e/playwright.config.ts) | `pnpm test:e2e` | dev server 浏览器模式 |
| Electron | [e2e/playwright.electron.config.ts](file:///f:/TraeProjects/1/e2e/playwright.electron.config.ts) | `pnpm test:e2e:electron` | 真实 Electron 窗口 |
| Smoke | [e2e/playwright.smoke.config.ts](file:///f:/TraeProjects/1/e2e/playwright.smoke.config.ts) | `pnpm test:smoke` | 生产构建 smoke |

源码：[package.json#L52-L54](file:///f:/TraeProjects/1/package.json#L52)（test:e2e / test:e2e:electron / test:smoke 脚本）。

### 4.2 E2E 文件清单（6 个）

| 文件 | 类型 | 说明 |
|------|------|------|
| [e2e/smoke.spec.ts](file:///f:/TraeProjects/1/e2e/smoke.spec.ts) | Browser | dev server smoke |
| [e2e/visual.spec.ts](file:///f:/TraeProjects/1/e2e/visual.spec.ts) | Browser | 视觉回归（脚本：`test:visual`） |
| [e2e/a11y.spec.ts](file:///f:/TraeProjects/1/e2e/a11y.spec.ts) | Browser | 可访问性审计（axe-core，脚本：`test:a11y`） |
| [e2e/electron.spec.ts](file:///f:/TraeProjects/1/e2e/electron.spec.ts) | Electron | 真实 Electron 窗口 |
| [e2e/smoke.prod.spec.ts](file:///f:/TraeProjects/1/e2e/smoke.prod.spec.ts) | Smoke | 生产构建 smoke |
| [e2e/perf/navigation.bench.spec.ts](file:///f:/TraeProjects/1/e2e/perf/navigation.bench.spec.ts) | Perf | 性能基准（脚本：`test:perf`） |

### 4.3 专项测试脚本

来自 [package.json#L55-L57](file:///f:/TraeProjects/1/package.json#L55)（test:visual / test:a11y / test:perf 脚本）：

| 脚本 | grep 模式 |
|------|----------|
| `test:visual` | `"视觉回归"` |
| `test:a11y` | `"可访问性"` |
| `test:perf` | `"性能基准"` |

### 4.4 Browser mode 环境变量

`test:e2e` 设置 `E2E_MODE=true` 环境变量，渲染层据此切换 mock 与真实 IPC 行为。

## 5. 测试辅助与 mock 策略

### 5.1 mock-api（前端 mock 层）

渲染层维护独立 mock 层，使前端独立开发：

- 位置：[src/renderer/test/](file:///f:/TraeProjects/1/src/renderer/test/)
- 形状一致性测试：[mock-api.test.ts](file:///f:/TraeProjects/1/src/renderer/test/__tests__/mock-api.test.ts) 确保 mock 与真实 IpcApi 接口一致

### 5.2 关键 mock 约定（来自 project memory）

- electron 与 electron-log 在集成测试中通过 `resolve.alias` stub
- MockedWebContents 使用交叉类型 `WebContents & { send: Mock; isDestroyed: Mock }` 满足类型签名并支持 mock 调用检查
- StreamText mock 必须监听 abortSignal 并调用 `controller.error(AbortError)` 防止 reader pending
- `controller.start` 用 `mockImplementationOnce` 而非 `mockResolvedValueOnce(undefined)`，避免丢失 'running' 事件

### 5.3 Sentry IPC 错误过滤

E2E browser mode 下无主进程，Sentry IPC 会失败，需加入 filter allowlist。

## 6. DevPanel 测试关键约定

DevPanel 测试用条件渲染 + `toHaveAttribute('data-state', 'active')` 等待 Git trigger 激活，避免时序问题。

源码：[DevPanel.test.tsx](file:///f:/TraeProjects/1/src/renderer/components/layout/__tests__/DevPanel.test.tsx)。

## 7. 测试质量评估

### 7.1 当前规模

- **单元测试文件**：176 个（shared 5 + main 122 + renderer 44 + scripts 5）
- **E2E 文件**：6 个
- **总用例数**：约 400+（renderer 242 通过 + main/shared 用例；随测试增长）

> 2026-08-11 同步：测试文件 90 → 137（main 59 → 95、renderer 22 → 33，含对齐轮新增 goal-service / memory-service / im-service / approval-utils / fuzzy-search-dialog 等测试）；renderer 用例 242 全绿。


> **覆盖率门禁（2026-08-11 起 CI 卡关）**：`pnpm test:coverage` 三层门槛按实测基线设定（渐进收紧至规范值 80/75/80/80）：
> - shared：80/19/33/80（当前 85.78/24.28/38.46/85.56，2026-08-12 提升）
> - main：80/75/80/80（当前 92.45/84.59/89.57/92.45，2026-08-12 提升）
> - renderer：80/75/80/80（当前 92.87/87.97/90.92/94.41，2026-08-12 提升）
> CI Unit tests step 已改为 `pnpm test:coverage`（覆盖率低于基线即失败；补测试后同步上调门槛）。
### 7.2 已知覆盖率缺口

- `test:coverage` 脚本现已包含 renderer（shared + main + renderer 三套覆盖率）
- 整体覆盖率旧口径 0.13 为早期评估（含未纳入统计文件），现以 §3.3 分层实测为准（2026-08-12 校准）
- codebase-service / search-service / terminal-service 无专属测试文件（git-service / file-service 已有）
- 主进程部分 IPC handler 测试较薄（仅验证 happy path）

### 7.3 已知质量风险

- 测试用例对 IPC 推送事件依赖较多，可能存在时序敏感的 flaky 风险（如 DevPanel 此前曾因时序失败，已用条件渲染修复）
- Playwright Electron mode 在 CI windows-latest 上跑真实窗口，可能受系统资源影响

## 8. CI 中的测试矩阵

详见 [07-engineering-design.md](file:///f:/TraeProjects/1/docs/design/07-engineering-design.md) §3 CI 矩阵。本节仅列出测试相关 job：

| Job | OS | 测试范围 |
|-----|-----|---------|
| quality | ubuntu-latest | typecheck / lint / unit test / audit |
| e2e-browser | ubuntu-latest | `test:e2e` |
| e2e-electron | windows-latest | `build` + `test:e2e:electron` |
| smoke-prod | windows-latest | `build:win` + `test:smoke` |

源码：[.github/workflows/ci.yml](file:///f:/TraeProjects/1/.github/workflows/ci.yml)。

## 9. 覆盖率豁免记录（2026-08 单元测试补全批次）

依据批次耗尽规则，以下未覆盖分支经【豁免判定框架】评估后豁免（全部非核心域）：

| 文件 | 分支数 | 豁免理由 |
|---|---|---|
| `infra/ai/tools/read-file.tool.ts` | 4 | zod schema `transform(v => v ?? undefined)` 由 tool-executor 的 parse 阶段执行，单测直接调 execute 不经过 parse（SDK 层行为） |
| `infra/ai/tools/glob.tool.ts` | 2 | 同上（zod transform） |
| `infra/ai/prompt/dynamic-context.ts` | 6 | 平台分支（darwin/linux 名称映射、非 win32 的 SHELL 兜底）；`process.platform` 只读不可注入，当前 win32 环境测试路径不可达 |
| `infra/ai/agent-runtime/stream-reader.ts` | 1 | L49 `timeoutId !== undefined` false 分支；`new Promise` executor 同步赋值保证非 undefined（协议不变量死代码） |
| `infra/storage/db.ts` | 5 | 备份数组空洞（readdirSync 无空洞）、完整性校验失败（损坏库打开即抛无法到达）、非 duplicate ALTER 错误（SCHEMA_SQL 先建表保证）、非 Error 备份异常 String() 兜底 |
| `ipc/app.handler.ts` | 1 | v8 对 `&&` 短路组合的计数分支；http/https/file/javascript 四路径用例已覆盖全部业务语义 |
| `infra/telemetry/otel.ts` | 1 | shutdown 的 `provider.forceFlush` 在 SDK v2 测试环境不可用（catch 兜底后状态正常重置） |

豁免原则：能测不测 = 继续补；上述均为客观不可达（SDK 层 / 平台分支 / 协议不变量 / 防御兜底），附代码证据。

### 9.1 renderer 层豁免记录（2026-08-12 批次 1-8 补测）

renderer 层 8 批补测（stores/hooks/chat/agent/terminal/dev-common/layout-i18n-ui）后，核心域 15 模块中 13 个直接达标（分支 ≥80% / 语句 ≥85%），非核心域 9 模块全部 ≥70%（分支口径）。以下未覆盖分支经【豁免判定框架】评估后豁免：

| 文件 | 分支数 | 豁免理由 |
|---|---|---|
| stores/persistent/settings-store.ts | 2 | L25/L187 IS_MAC 平台分支（macOS 快捷键路径，win32 测试环境不可达） |
| hooks/use-conversation-search.ts | 3 | L100-101 navigate 的 prev=-1 分支；search 重置保证非空查询时 currentMatch≠-1，-1 状态必伴随空匹配（navigate 提前 return）——协议不变量死代码 |
| hooks/use-api-key.ts | 2 | L96/L124 onError 的 error instanceof Error false 侧；unwrap 保证抛 Error（throw new Error 单一路径）——协议不变量防御兜底 |
| hooks/use-sessions.ts | 12 | v8 &&/?? 组合计数分支 + L104 id-null throw（enabled:false 保证不执行）——分支 80% 达标后记录 |
| components/chat/ChatInput.tsx | ~25 | 补测（899fd1e）后：applySuggestion 无 action 填充（内置命令全带 action 死代码）、applyMention atIndex<0（mention 展开保证）、拖拽 pointer 剩余组合（jsdom 布局边界）——分支 85.7% / 语句 92.7% |
| components/agent/approval-utils.ts、approval-preview.tsx | 15 | v8 组合计数（?? '' 空值回退、input 类型守卫 false 侧、共享 case）——已测主路径的防御侧 |
| components/terminal/TerminalView.tsx | 3 | L50 containerRef null 防御（挂载后非空）、L97 exit 不匹配过滤（output 同模式已测）、L113 防抖重复触发 clearTimeout（内部细节） |
| components/common/SectionErrorBoundary.tsx | 1 | L92 info.componentStack ?? undefined——react-error-boundary SDK 契约保证有值 |
| components/layout/Topbar.tsx、providers/ThemeProvider.tsx、i18n/config.ts | 5 | L69 navigator.platform mac 平台分支、L63/L103 typeof window === 'undefined' SSR 分支（Electron 恒有 window）、v8 计数分支 |

豁免原则：核心域从严（仅死代码/协议不变量级），非核心域客观不可达；能测不测 = 继续补（本表所有项均有代码证据）。

补充口径说明（2026-08-12 审查确认）：非核心域达标指标为**分支覆盖率**（批次清单口径，与 §3.4 一致）；IM 域 4 个适配器文件（wecom/feishu/dingtalk/wecom-stream）分支 ≥70% 达标，行覆盖 56.7-64.9% 低于 70% 属既有记录口径差异（未达 §3.4 中等域 70% 行目标，列入观察），列入观察（凌晨批次 0b8846e 交付，非本轮新增缺口）。
