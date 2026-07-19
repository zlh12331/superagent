# Phase 10: E2E 测试 + 质量保障

> **日期**：2026-07-19
> **状态**：待执行
> **前置**：Phase 9 完成（删除会话全链路 + PDF 解析 + 集成测试基础设施），261 单测通过，typecheck/lint 0 errors
> **规模**：3 Task，预计 4 个 commit（含本计划）

---

## 1. 目标

按设计文档 §8.4 搭建 E2E 测试框架，并按 §8.6 配置覆盖率 CI 卡关：

1. **Playwright E2E 框架**：安装 `@playwright/test`，配置 `e2e/playwright.config.ts`，支持 Electron 应用启动
2. **E2E_MODE 测试模式**：主进程支持 `E2E_MODE=true` 环境变量，跳过 DB 初始化 + 注册 mock IPC handler，让应用在无 PG 二进制环境下启动
3. **关键流程 E2E 测试**：冒烟测试（应用启动）+ 项目列表页 + 路由导航 + Dialog 交互
4. **覆盖率卡关**：vitest coverage 阈值配置（§8.6：statements 80% / branches 75% / functions 80% / lines 80%）

> **范围限定**：
> - E2E 测试不依赖真实数据库（PG 二进制打包属 Phase 11 打包阶段）
> - E2E 聚焦 UI 交互验证（窗口启动、路由导航、组件渲染、Dialog 交互）
> - 真实 Service + PG 全链路已由 Phase 9 集成测试覆盖
> - AI 调用流程 E2E 留待 Phase 11（需 DeepSeek API Key + Ollama）

---

## 2. 前置条件核实

| 依赖 | 状态 | 文件 |
|------|------|------|
| electron-vite dev 启动 | ✅ | package.json scripts.dev |
| Electron 40 BrowserWindow | ✅ | src/main/index.ts |
| React Router 7 路由 | ✅ | src/renderer/router.tsx |
| 7 业务页面 + AppShell | ✅ | src/renderer/routes/*.tsx |
| TanStack Query + IPC client | ✅ | src/renderer/api/client.ts |
| Vitest 4 coverage 配置 | ✅ 部分 | src/main/vitest.config.ts（有 provider 但无阈值） |

### 2.1 缺口识别

| # | 缺口 | 影响 | 解决 |
|---|------|------|------|
| 1 | 无 E2E 测试框架 | 测试金字塔顶层空白 | Task 1 搭建 Playwright + Electron |
| 2 | 应用启动依赖 PG 二进制 | E2E 无法启动应用 | Task 1 引入 E2E_MODE 跳过 DB + mock handler |
| 3 | 无 E2E 测试用例 | 关键用户流程未验证 | Task 2 编写冒烟 + 导航 + Dialog 测试 |
| 4 | 覆盖率无阈值卡关 | §8.6 CI 卡关要求未满足 | Task 3 配置 vitest coverage thresholds |

---

## 3. 文件结构

```
f:\TraeProjects\1\
├─ e2e/                                    [Task 1/2 新增目录]
│  ├─ helpers/
│  │  └─ electron-launcher.ts              [Task 1 Electron 启动 helper]
│  ├─ smoke.spec.ts                         [Task 2 冒烟测试]
│  ├─ navigation.spec.ts                    [Task 2 路由导航测试]
│  └─ project-list.spec.ts                 [Task 2 项目列表 + Dialog 测试]
├─ src/main/
│  ├─ index.ts                              [Task 1 添加 E2E_MODE 分支]
│  └─ ipc/
│     └─ mock-handlers.ts                   [Task 1 新文件：mock IPC handler]
├─ src/main/vitest.config.ts               [Task 3 添加 coverage thresholds]
├─ tests/integration/vitest.config.ts       [Task 3 添加 coverage thresholds]
├─ package.json                             [Task 1/3 新增 @playwright/test + test:e2e + test:coverage]
└─ biome.json                               [Task 1 e2e 目录 override]
```

---

## 4. Task 分解

### Task 1：Playwright E2E 框架搭建 + E2E_MODE 支持

**目标**：安装 Playwright，配置 Electron 测试环境，让应用能在无数据库环境下启动。

**改动清单**：

1. **`package.json`**
   - 新增 devDependency：`@playwright/test` ^1.58
   - 新增 scripts：
     - `test:e2e`: `playwright test --config e2e/playwright.config.ts`
   - 新增 `e2e` 到 commitlint scope-enum 白名单

2. **`src/main/index.ts`** — 添加 E2E_MODE 分支
   - 在 `app.whenReady()` 中检测 `process.env.E2E_MODE === 'true'`
   - E2E 模式下：
     - 跳过 `initializeDatabase()`（无 PG 二进制）
     - 跳过 `startStatusBroadcaster()`（无 PG/Ollama 状态）
     - 调用 `registerMockIpcHandlers()` 替代 `registerIpcHandlers()`
     - 仍然创建窗口 + 加载渲染层
   - 非 E2E 模式：保持现有逻辑不变

3. **`src/main/ipc/mock-handlers.ts`**（新文件）
   - 注册 mock IPC handler，返回预置空数据
   - 覆盖渲染层查询会调用的所有 IPC channel：
     - `project:list` → `[]`
     - `project:get` → null
     - `chat:listSessions` → `[]`
     - `rag:listDocuments` → `[]`
     - `settings:getProjectSettings` → null
     - `settings:getAppSettings` → 默认值
     - `app:getStatus` → 空状态
   - mutation 类 channel（create/update/delete）：返回成功响应（不实际写入 DB）
   - 使用 `ipcMain.handle` 注册，与真实 handler 相同的 channel 名

4. **`e2e/playwright.config.ts`**（新文件）
   - 使用 `defineConfig` + `projects` 配置
   - `workers: 1`（串行执行，避免多 Electron 实例冲突）
   - `retries: 0`（E2E 调试时不重试）
   - 失败时截图 + 视频 + trace
   - `timeout: 30_000`（Electron 启动较慢）

5. **`e2e/helpers/electron-launcher.ts`**（新文件）
   - 封装 `electron.launch()` 启动逻辑
   - 设置 `env: { E2E_MODE: 'true' }` 环境变量
   - 等待窗口 `ready-to-show` 事件
   - 返回 `ElectronApplication` 对象
   - 提供 `closeElectronApp()` 清理函数

6. **`biome.json`**
   - 添加 `e2e/**` override，允许 `noConsole`（测试需要 console 输出调试信息）

**验收**：
- `pnpm test:e2e` 能启动 Electron 应用并完成空测试
- 应用在 E2E_MODE 下不退出，窗口正常显示
- `pnpm typecheck` 0 errors
- `pnpm lint` 0 errors

---

### Task 2：关键用户流程 E2E 测试用例

**目标**：覆盖设计文档 §8.4 的"关键用户流程"要求。

**改动清单**：

1. **`e2e/smoke.spec.ts`**（新文件）— 冒烟测试
   - 测试场景：
     - 应用启动后窗口可见
     - 标题栏显示"网文写作 Agent"
     - 默认路由跳转到 `/projects`
     - 侧边栏导航项可见（项目列表、设置）
     - 顶栏应用名称可见

2. **`e2e/navigation.spec.ts`**（新文件）— 路由导航测试
   - 测试场景：
     - 从项目列表页点击侧边栏"设置" → 跳转到 `/settings`
     - 设置页表单元素可见（API Key 配置区、Ollama 配置区）
     - 从设置页返回"项目列表" → 跳转回 `/projects`
     - 直接访问不存在的路由 → 显示错误边界

3. **`e2e/project-list.spec.ts`**（新文件）— 项目列表 + Dialog 交互
   - 测试场景：
     - 空状态显示"暂无项目"引导文案（mock 返回空数组）
     - 点击"新建项目"按钮 → Dialog 弹出
     - Dialog 内表单元素可见（项目名输入框、创建按钮）
     - 关闭 Dialog → Dialog 不可见
     - 点击侧边栏"设置" → 页面切换

**验收**：
- `pnpm test:e2e` 全部通过（≥ 8 个用例）
- E2E 测试运行时长 < 60s
- 单元测试 + 集成测试不受影响

---

### Task 3：覆盖率配置 + CI 卡关

**目标**：按设计文档 §8.6 配置 vitest coverage 阈值，CI 卡关。

**改动清单**：

1. **`src/main/vitest.config.ts`**
   - 添加 `coverage.thresholds`：
     ```ts
     coverage: {
       provider: 'v8',
       reporter: ['text', 'html', 'lcov'],
       thresholds: {
         statements: 80,
         branches: 75,
         functions: 80,
         lines: 80,
       },
       // 排除测试文件本身、类型声明文件、配置文件
       exclude: [
         '**/*.test.ts',
         '**/*.config.ts',
         '**/*.d.ts',
         'out/**',
         'node_modules/**',
       ],
     }
     ```

2. **`tests/integration/vitest.config.ts`**
   - 同样添加 `coverage.thresholds`（与 unit 一致）

3. **`package.json`**
   - 新增 script：`test:coverage`: `pnpm test:main -- --coverage`

**验收**：
- `pnpm test:coverage` 生成覆盖率报告
- 覆盖率低于阈值时命令失败（exit code ≠ 0）
- `pnpm test` 不受影响（不卡关，仅 `test:coverage` 卡关）

---

## 5. 验收清单

执行以下命令逐项验证，**全部通过后方可认为 Phase 10 完成**：

```powershell
# 1. 类型检查
pnpm typecheck                                # 0 errors

# 2. Lint
pnpm lint                                     # 0 errors

# 3. 单元测试（不受影响）
pnpm test                                     # 261+ 用例通过

# 4. E2E 测试
pnpm test:e2e                                 # 8+ 用例通过

# 5. 覆盖率（卡关）
pnpm test:coverage                            # 覆盖率 ≥ 阈值

# 6. 构建
pnpm build                                   # 三入口产物生成

# 7. CodeGraph 索引同步
codegraph sync                               # 更新代码图谱
```

---

## 6. 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| Electron 启动慢（>10s） | 中 | E2E 超时 | timeout 放宽到 30s，workers:1 串行 |
| Playwright 与 Electron 40 兼容性 | 低 | 启动失败 | Playwright 1.58 官方支持 Electron 40 |
| mock handler 不完整导致渲染层报错 | 中 | E2E 测试失败 | mock handler 覆盖所有渲染层调用的 channel |
| 覆盖率不达标 | 高 | test:coverage 失败 | 先运行查看实际覆盖率，不达标则调整阈值或补充测试 |
| E2E_MODE 泄漏到生产环境 | 低 | 生产跳过 DB | 仅在 `!app.isPackaged` 且环境变量为 'true' 时启用 |

---

## 7. 执行顺序

```
Task 1（E2E 框架 + E2E_MODE）──> Task 2（E2E 测试用例）
                                      │
Task 3（覆盖率配置）<──────────────────┘（独立，可并行）
```

- Task 1 是 Task 2 的前置（需要 E2E_MODE 才能启动应用）
- Task 3 独立于 Task 1/2，可并行执行
- 每个 Task 完成后立即 `codegraph sync` 并 git 提交

---

## 8. Commit 规划

| # | Commit Message | Scope |
|---|----------------|-------|
| 1 | `chore: 添加 Phase 10 计划文档` | docs |
| 2 | `test(e2e): 搭建 Playwright E2E 框架与 E2E_MODE 支持` | main, e2e |
| 3 | `test(e2e): 新增关键用户流程 E2E 测试用例` | e2e |
| 4 | `test: 配置 vitest 覆盖率阈值卡关` | main, tests |

> 注：每个 Task 完成后立即 `codegraph sync` 并 git 提交。

---

**文档结束。等待执行。**
