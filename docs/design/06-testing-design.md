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
                │   Unit (vitest)           │  22 个测试文件
                │   shared / main / renderer │
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
| msw | `^2.15.0` | HTTP mock |
| @axe-core/playwright | `^4.12.1` | 可访问性审计 |

源码：[package.json#L53-L88](file:///f:/TraeProjects/1/package.json#L53-L88)（devDependencies）。

## 3. 单元测试（vitest）

### 3.1 配置文件分布

3 套独立 vitest 配置：

| 配置 | 路径 | 作用域 |
|------|------|------|
| 配置 1 | [src/main/vitest.config.ts](file:///f:/TraeProjects/1/src/main/vitest.config.ts) | 主进程测试 |
| 配置 2 | [src/renderer/vitest.config.ts](file:///f:/TraeProjects/1/src/renderer/vitest.config.ts) | 渲染进程测试 |
| 配置 3 | [packages/shared/vitest.config.ts](file:///f:/TraeProjects/1/packages/shared/vitest.config.ts) | shared 包测试 |

### 3.2 跑测试脚本

来自 [package.json#L29-L38](file:///f:/TraeProjects/1/package.json#L29-L38)：

| 脚本 | 命令 | 说明 |
|------|------|------|
| `test` | `pnpm -r --filter "@novel-writer/*" run test && pnpm test:main && pnpm test:renderer` | 全量单元测试（shared + main + renderer） |
| `test:main` | `vitest run --root src/main` | 仅主进程 |
| `test:renderer` | `vitest run --root src/renderer` | 仅渲染层 |
| `test:coverage` | `pnpm --filter "@novel-writer/shared" exec vitest run --coverage && pnpm test:main -- --coverage` | shared + main 覆盖率（**未包含 renderer**） |

### 3.3 覆盖率配置

3 套 vitest.config.ts 统一阈值（来自总结数据，实际以配置文件为准）：

| 配置 | lines | functions | branches | statements |
|------|-------|-----------|----------|------------|
| shared | 80 | 75 | 80 | 80 |
| main | 80 | 75 | 80 | 80 |
| renderer | 80 | 75 | 80 | 80 |

### 3.4 测试文件清单（22 个）

#### shared 包（4 个）

| 文件 | 说明 |
|------|------|
| [packages/shared/src/__tests__/channels.test.ts](file:///f:/TraeProjects/1/packages/shared/src/__tests__/channels.test.ts) | IPC_CHANNELS 常量与 IpcChannel 类型校验 |
| [packages/shared/src/__tests__/errors.test.ts](file:///f:/TraeProjects/1/packages/shared/src/__tests__/errors.test.ts) | AppError / ErrorCode 错误码体系 |
| [packages/shared/src/__tests__/api.test.ts](file:///f:/TraeProjects/1/packages/shared/src/__tests__/api.test.ts) | IpcApi 接口形状 |
| [packages/shared/src/__tests__/smoke.test.ts](file:///f:/TraeProjects/1/packages/shared/src/__tests__/smoke.test.ts) | shared 包 smoke |

#### main 主进程（11 个）

| 文件 | 说明 |
|------|------|
| [src/main/infra/ai/chat-service.test.ts](file:///f:/TraeProjects/1/src/main/infra/ai/chat-service.test.ts) | ChatService 流式 + abort + dispose |
| [src/main/infra/ai/ai-provider.test.ts](file:///f:/TraeProjects/1/src/main/infra/ai/ai-provider.test.ts) | AI provider 单例 |
| [src/main/infra/ai/mcp/mcp-service.test.ts](file:///f:/TraeProjects/1/src/main/infra/ai/mcp/mcp-service.test.ts) | MCPService 多 server 管理 |
| [src/main/infra/ai/mcp/mcp-client.test.ts](file:///f:/TraeProjects/1/src/main/infra/ai/mcp/mcp-client.test.ts) | 单 MCP client |
| [src/main/infra/ai/mcp/mcp-tool-adapter.test.ts](file:///f:/TraeProjects/1/src/main/infra/ai/mcp/mcp-tool-adapter.test.ts) | MCP 工具转 Tool 格式 |
| [src/main/infra/ai/mcp/mcp-types.test.ts](file:///f:/TraeProjects/1/src/main/infra/ai/mcp/mcp-types.test.ts) | MCP 类型 |
| [src/main/infra/storage/app-data.test.ts](file:///f:/TraeProjects/1/src/main/infra/storage/app-data.test.ts) | 应用数据目录解析 |
| [src/main/infra/storage/keychain.test.ts](file:///f:/TraeProjects/1/src/main/infra/storage/keychain.test.ts) | keychain 凭证存储 |
| [src/main/config/config.test.ts](file:///f:/TraeProjects/1/src/main/config/config.test.ts) | AppConfig |
| [src/main/utils/logger.test.ts](file:///f:/TraeProjects/1/src/main/utils/logger.test.ts) | logger |
| [src/main/utils/retry.test.ts](file:///f:/TraeProjects/1/src/main/utils/retry.test.ts) | 重试策略 |
| [src/main/utils/wrap.test.ts](file:///f:/TraeProjects/1/src/main/utils/wrap.test.ts) | wrap 工具 |

#### renderer 渲染层（7 个）

| 文件 | 说明 |
|------|------|
| [src/renderer/test/__tests__/mock-api.test.ts](file:///f:/TraeProjects/1/src/renderer/test/__tests__/mock-api.test.ts) | mock-api 形状一致性 |
| [src/renderer/test/smoke.test.tsx](file:///f:/TraeProjects/1/src/renderer/test/smoke.test.tsx) | 渲染层 smoke |
| [src/renderer/stores/transient/__tests__/terminal-store.test.ts](file:///f:/TraeProjects/1/src/renderer/stores/transient/__tests__/terminal-store.test.ts) | terminal store |
| [src/renderer/hooks/__tests__/use-terminal-bridge.test.tsx](file:///f:/TraeProjects/1/src/renderer/hooks/__tests__/use-terminal-bridge.test.tsx) | 终端桥接 hook |
| [src/renderer/hooks/__tests__/use-git.test.tsx](file:///f:/TraeProjects/1/src/renderer/hooks/__tests__/use-git.test.tsx) | git hook |
| [src/renderer/components/layout/__tests__/DevPanel.test.tsx](file:///f:/TraeProjects/1/src/renderer/components/layout/__tests__/DevPanel.test.tsx) | DevPanel |
| [src/renderer/components/terminal/__tests__/TerminalPanel.test.tsx](file:///f:/TraeProjects/1/src/renderer/components/terminal/__tests__/TerminalPanel.test.tsx) | 终端面板 |
| [src/renderer/components/git/__tests__/GitPanel.test.tsx](file:///f:/TraeProjects/1/src/renderer/components/git/__tests__/GitPanel.test.tsx) | git 面板 |

## 4. E2E 测试（Playwright）

### 4.1 三套 Playwright 配置

| 配置 | 路径 | 触发脚本 | 目标 |
|------|------|---------|------|
| Browser | [e2e/playwright.config.ts](file:///f:/TraeProjects/1/e2e/playwright.config.ts) | `pnpm test:e2e` | dev server 浏览器模式 |
| Electron | [e2e/playwright.electron.config.ts](file:///f:/TraeProjects/1/e2e/playwright.electron.config.ts) | `pnpm test:e2e:electron` | 真实 Electron 窗口 |
| Smoke | [e2e/playwright.smoke.config.ts](file:///f:/TraeProjects/1/e2e/playwright.smoke.config.ts) | `pnpm test:smoke` | 生产构建 smoke |

源码：[package.json#L32-L34](file:///f:/TraeProjects/1/package.json#L32-L34)。

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

来自 [package.json#L35-L37](file:///f:/TraeProjects/1/package.json#L35-L37)：

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

- **单元测试文件**：22 个（shared 4 + main 11 + renderer 7）
- **E2E 文件**：6 个
- **总用例数**：约 260（来自 project memory，shared 17 + main 147 + renderer 96）+ E2E 17

### 7.2 已知覆盖率缺口

- `test:coverage` 脚本未跑 renderer（仅 shared + main）
- 整体覆盖率约 0.13（来自项目评估），与配置阈值 80 差距较大
- 主进程大量 service / IPC handler 文件未覆盖测试
- codebase-service / git-service / file-service / search-service / terminal-service 无专属测试文件

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
