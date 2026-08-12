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

### 3.5 测试文件清单（137 个）

> 以下按区域列出代表性文件，完整清单以 `Glob "**/*.test.{ts,tsx}"` 为准。

#### shared 包（4 个）

| 文件 | 说明 |
|------|------|
| [packages/shared/src/__tests__/channels.test.ts](file:///f:/TraeProjects/1/packages/shared/src/__tests__/channels.test.ts) | IPC_CHANNELS 常量与 IpcChannel 类型校验 |
| [packages/shared/src/__tests__/errors.test.ts](file:///f:/TraeProjects/1/packages/shared/src/__tests__/errors.test.ts) | AppError / ErrorCode 错误码体系 |
| [packages/shared/src/__tests__/api.test.ts](file:///f:/TraeProjects/1/packages/shared/src/__tests__/api.test.ts) | IpcApi 接口形状 |
| [packages/shared/src/__tests__/smoke.test.ts](file:///f:/TraeProjects/1/packages/shared/src/__tests__/smoke.test.ts) | shared 包 smoke |

#### main 主进程（59 个）

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

#### renderer 渲染层（22 个）

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

- **单元测试文件**：137 个（shared 4 + main 95 + renderer 33 + scripts 5）
- **E2E 文件**：6 个
- **总用例数**：约 400+（renderer 242 通过 + main/shared 用例；随测试增长）

> 2026-08-11 同步：测试文件 90 → 137（main 59 → 95、renderer 22 → 33，含对齐轮新增 goal-service / memory-service / im-service / approval-utils / fuzzy-search-dialog 等测试）；renderer 用例 242 全绿。


> **覆盖率门禁（2026-08-11 起 CI 卡关）**：`pnpm test:coverage` 三层门槛按实测基线设定（渐进收紧至规范值 80/75/80/80）：
> - shared：80/18/33/80（当前 84.73/18.57/33.33/84.49）
> - main：80/75/80/80（当前 92.45/84.59/89.57/92.45，2026-08-12 提升）
> - renderer：65/55/65/65（当前 67.34/59.34/67.72/68.66）
> CI Unit tests step 已改为 `pnpm test:coverage`（覆盖率低于基线即失败；补测试后同步上调门槛）。
### 7.2 已知覆盖率缺口

- `test:coverage` 脚本现已包含 renderer（shared + main + renderer 三套覆盖率）
- 整体覆盖率约 0.13（来自项目评估），与配置阈值 80 差距较大
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

### 9.1 renderer ������¼��2026-08-12 ���� 1-8 ���⣩

renderer �� 8 �����⣨stores/hooks/chat/agent/terminal/dev-common/layout-i18n-ui���󣬺����� 15 ģ���� 13 ��ֱ�Ӵ�꣨��֧ ��80% / ��� ��85%�����Ǻ����� 9 ģ��ȫ�� ��70%������δ���Ƿ�֧���������ж���ܡ���������⣺

| �ļ� | ��֧�� | �������� |
|---|---|---|
| settings-store.ts | 2 | L25/L187 IS_MAC ƽ̨��֧��macOS ��ݼ�·����win32 ���Ի������ɴ |
| use-conversation-search.ts | 3 | L100-101 navigate �� prev=-1 ��֧��search ���ñ�֤�ǿղ�ѯʱ currentMatch��-1��-1 ״̬�ذ����ƥ�䣨navigate ��ǰ return������Э�鲻���������� |
| use-api-key.ts | 2 | L96/L124 onError �� error instanceof Error false �ࣻunwrap ��֤�� Error��	hrow new Error ��һ·��������Э�鲻������������ |
| use-sessions.ts | 12 | v8 &&/?? ��ϼ�����֧ + L104 id-null throw��enabled:false ��֤��ִ�У������Ѵ� 80% ���¼ |
| ChatInput.tsx | ~30 | ��ק pointer �¼�������ϣ�jsdom �� PointerEvent ���֣��Ѳ���·�������·������applySuggestion �� action ��䣨��������ȫ�� action �����룩��applyMention atIndex<0��mention չ����֤��������֧ 85.7% ��� 92.7% |
| pproval-utils.ts / pproval-preview.tsx | 15 | v8 ��ϼ�����?? '' ��ֵ���ˡ�input �������� false �ࡢ���� case�������Ѳ���·���ķ����� |
| TerminalView.tsx | 3 | L50 containerRef null ���������غ�ǿգ���L97 exit ��ƥ����ˣ�output ͬģʽ�Ѳ⣩��L113 �����ظ����� clearTimeout���ڲ�ϸ�ڣ� |
| SectionErrorBoundary.tsx | 1 | L92 info.componentStack ?? undefined����react-error-boundary SDK ��Լ��֤��ֵ |
| Topbar.tsx / ThemeProvider.tsx / i18n/config.ts | 5 | L69 navigator.platform mac ƽ̨��֧��L63/L103 	ypeof window === 'undefined' SSR ��֧��Electron ���� window����v8 ������֧ |

����ԭ�򣺺�������ϣ���������/Э�鲻�����������Ǻ�����͹۲��ɴ�ܲⲻ�� = ��������������������д���֤�ݣ���
