# AGENTS.md — code-agent-desktop

Windows 桌面端生产级 Code Agent 桌面应用，Electron 43 + React 19 + TypeScript + Vercel AI SDK v7。

## 重要命令

```bash
pnpm dev                    # 启动 dev server + Electron 窗口
pnpm typecheck              # tsc --build（必须，不要用 --noEmit；不会自动增量编译）
pnpm lint                   # biome check .（含格式/import 排序）
pnpm test                   # 全部 unit tests（&& 链式，任一层失败即中断）: shared → main → renderer → scripts；集成测试单独跑 pnpm test:integration
pnpm knip                   # 死代码/死依赖检测（files/deps/binaries 级，CI 卡关）
pnpm check:static           # 静态审计：check:tokens（样式铁律）+ check:i18n（i18n 缺失卡关），pre-push/CI 卡关
pnpm check:tokens           # 令牌审计：裸色/dark:/space-*/w+h 双写/hex（依据 10-component-design-spec 铁律）
pnpm check:i18n             # i18n 审计：引用缺失卡关 + 双语一致性；冗余加 --strict 卡关
pnpm check:bundle           # 构建产物体积门槛（build 后运行；单 chunk ≤5MB/总包 ≤16MB 基线）
pnpm changelog              # 从 git log 自动生成 CHANGELOG [Unreleased] 段

# 单包/层测试
pnpm --filter @code-agent/shared run test
pnpm test:main              # vitest --root src/main
pnpm test:renderer
pnpm test:scripts

# E2E（3 套 Playwright 配置）
pnpm test:e2e               # 浏览器模式（dev server）
pnpm test:e2e:electron      # Electron 真实窗口
pnpm test:smoke             # 生产构建 smoke

# 脚手架（定义表体系专属红利）
pnpm scaffold:ipc --domain <name> --method <m> [--kind request|event]
pnpm scaffold:tool --name <snake_case> [--permission auto|ask]

# 工程化工具
pnpm analyze:bundle         # 包体积分析（ANALYZE_BUNDLE=1）
pnpm docs:types             # TypeDoc 契约文档（tools/typedoc 子包，TS6 隔离）
pnpm changeset              # 子包 changeset 记录（仅子包；根应用不走 changesets）
pnpm version:packages       # changesets 结算（仅子包）
```

质量门禁顺序：`pnpm typecheck` → `pnpm lint` → `pnpm check:static` → `pnpm test` → `pnpm knip`。
pre-push 钩子：gitleaks 密钥扫描（`gitleaks dir .`）+ typecheck + lint + check:static + depcruise + test:scripts（`SKIP_PREPUSH=1` 跳过）。

## 架构

```
src/main/        → 主进程（Node.js, sandbox: true）
src/preload/     → 桥接（CJS 格式 .cjs, contextBridge）
src/renderer/    → React 渲染层
packages/shared/ → 跨进程共享: 类型/IPC schema/常量（按进程拆分出口）
packages/tsconfig/→ base.json / node.json / web.json 三档
scripts/         → 脚手架与工具（scaffold / changelog）
tools/typedoc/   → TypeDoc 独立子包（TS6 隔离，规避 TS7 不兼容）
```

- 主进程是 Service Container 模式（`service-container.ts`），集中管理 18 个服务（Chat/File/Search/Terminal/Git/Codebase/Session/Update/Tool/Permission/ToolExecutor/MCP/Prompt/Agent/Memory/LSP/Goal/IM；2026-08-17 实测），dispose 顺序按反向依赖
- IPC 通过 `contextBridge.exposeInMainWorld('api', api)` 暴露，渲染层用 `window.api.*` 调用
- 流式事件用 subscribe 回调模式（返回 unsubscribe 函数）
- Channel 命名：`{domain}:{action}`（请求-响应）、`{domain}:stream:{event}`（流式）、`{domain}:event:{name}`（状态事件），常量表在 `packages/shared/src/ipc/channels.ts`

## IPC 自动化体系（自研，核心资产）

定义表驱动全链路自动生成，新增 IPC 方法只需改定义表 + handler：

```
packages/shared/src/ipc/
├── meta.ts         # IPC_META 纯字符串元数据表（preload 沙箱安全，零 zod）
├── definitions.ts  # IPC_DEFINITIONS = meta + zod schema + 类型标记（单一真源）
├── derive.ts       # 类型推导：IpcApi / RequestMap / EventMap / InferHandlers
src/preload/utils/create-api.ts   # 生成器：遍历 meta 自动生成 window.api
src/main/ipc/register.ts          # 统一注册：遍历定义表 wrap 全部 handler
```

**新增一个 IPC 方法 = 改 meta.ts 一行 + definitions.ts 一行 + handler 加一个方法**，其余（通道常量 / preload API / 类型 / 注册）全部自动；handler 缺失编译期报错。

## 状态管理（前端四层架构）

```
L1 useState      组件内瞬态（输入框/折叠/编辑态）
L2 Zustand       客户端共享状态：persistent/（跨重启：settings/激活会话）+ transient/（会话内：file-tree/tool/approvals/usage）
L3 TanStack Query 服务端数据（IPC invoke 请求-响应：会话列表/git diff），缓存/失效/竞态
L4 IPC 事件流    主进程推送（tool:call/terminal:output/update:status）→ subscribe 直接写 transient store
```

判断标准：IPC invoke → TanStack Query；IPC on（持续推送）→ Zustand；UI 交互态 → Zustand transient；组件独享 → useState。
回合结束统一处理：`use-agent-bridge`（AppShell 挂载）→ invalidate 会话缓存 + 清理 L2 缓冲 + usage 累积。

## 关键约束（易踩坑）

- **preload 必须输出 CJS**（sandbox: true 限制，`electron.vite.config.ts` 中 format: 'cjs'），纯 ESM 包（如 zod）引入 preload 会静默失败导致 `window.api` 为 undefined。preload 必须通过 `@code-agent/shared/ipc/channels` / `@code-agent/shared/preload` 子路径导入（避开 shared 主入口中的 zod）
- **Sentry 初始化必须在 `app.whenReady()` 之前**（@sentry/electron 要求）
- **dev 环境 userData 重定向到 `.electron-user-data/`**（避免沙箱拦截 %APPDATA%）
- **dev 环境开启远程调试端口 9222**（CDP over WebSocket）
- **.env** 由 `process.loadEnvFile()` 在 main 进程启动时加载（需在 whenReady 之前）
- **桌面端三平台**（Windows/macOS/Linux）：Windows NSIS x64 / macOS dmg+zip（x64+arm64）/ Linux AppImage+deb x64；release.yml 三平台矩阵构建（mac 需 macOS runner，签名走 CSC_LINK）
- **exactOptionalPropertyTypes 已启用**：可选字段传 undefined 需条件展开（`...(x !== undefined ? { x } : {})`）
- **React Compiler 已启用**：hook 只能在顶层调用，禁止中间函数包装 hook

## 数据库

- SQLite（better-sqlite3），schema 在 `src/main/infra/storage/schema.ts`
- Drizzle Kit 从 `drizzle.config.ts` 读取配置
- 迁移：PRAGMA user_version 版本链（`src/main/infra/storage/migrations.ts`）；新增列需三处同步：schema.ts + schema-sql.ts（新库 DDL）+ migrations.ts（老库路径）
- **渲染层用户设置（theme/ai/editor/shortcuts/experimental）持久化真源 = SQLite `app_settings` 表**（用户决策：localStorage 合并到 SQLite）。渲染层 settings-store 保持内存态，写穿透经 `settings:set` 落库；启动快照经 `settings:getAll` 在 main.tsx 顶层 await 拉取（`settings-bootstrap.ts`）。legacy localStorage 数据首启自动迁移。draft/sidebar/activeSession 等纯 UI 态仍留 localStorage
- 路径由 `app.getPath('userData')` 动态决定：dev 为 `.electron-user-data/sessions.db`（重定向），prod 为 `%APPDATA%/<app name>/sessions.db`
- 原 PostgreSQL/Prisma/AGE 层已删除 — 不要尝试 prisma 相关命令

## 代码风格（Biome 非默认项）

- `useNamingConvention` 默认强制 `strictCase`（大量文件有 override，见 biome.json overrides；I 前缀接口需 biome-ignore）
- 禁止 `default export`（例外：renderer `*.tsx`、config 文件、scripts）
- 禁止 `console`（例外：集成测试 `tests/integration/`、E2E `e2e/`、scripts）

## 测试规范

- **业务逻辑不 mock**：测试真实实现（DI 注入 fake）；基础设施（electron/SQLite 原生模块）可用 vi.mock/alias stub。注：src/renderer/dev/mock-api.ts 是运行时开发模拟层（浏览器模式 window.api），与测试原则无关
- 测试文件与源码 colocation：`**/*.test.ts` / `**/*.test.tsx`
- Vitest globals 启用（describe/it/expect 无需 import）
- renderer 测试用 jsdom + `test/setup.ts`（mock `window.api` 并 polyfill ResizeObserver/IntersectionObserver/matchMedia）
- 覆盖率阈值：statements 80% / branches 75% / functions 80% / lines 80%（以 CI 报告为准；main 实测 ~92%，数字不再在本文件维护）
- E2E 有 3 个 Playwright 配置：`playwright.config.ts`（浏览器）、`playwright.electron.config.ts`（Electron）、`playwright.smoke.config.ts`（生产构建）
- 集成测试目录 `tests/integration/`（20+ 测试文件，CI 有独立 integration-tests job）

## 工程化工具链

- **knip**（`pnpm knip`）：死代码/死依赖检测，CI 卡关（files/deps/binaries 级）；exports 级报告人工审阅
- **changelog 自动生成**（`pnpm changelog`）：从 git log（Conventional Commits）生成 CHANGELOG [Unreleased] 段；tag 锚点幂等（自最近 v*.*.* 起）；排除 docs/chore/test 等类型
- **CHANGELOG 手动维护**：根应用是 pnpm workspace 根包，changesets 不支持（known limitation）；发版时手动把 [Unreleased] 改为版本段 + 升 package.json version + 打 tag
- **Renovate**：依赖自动更新（周末批次，electron major 人工评审）
- **pre-push 钩子**：gitleaks 密钥扫描（`gitleaks dir .`）+ typecheck + lint + check:static（check:tokens + check:i18n）+ depcruise + test:scripts（`SKIP_PREPUSH=1` 跳过）
- **TypeDoc**：`pnpm docs:types` 在 tools/typedoc 子包运行（TS6 隔离，规避 TS7 不兼容）
- **包体积分析**：`pnpm analyze:bundle`（rollup-plugin-visualizer，ANALYZE_BUNDLE=1）

## 构建产物 & Git

- `out/` = electron-vite build 产物，`release/` = electron-builder 打包产物，`stats/` = 体积分析产物
- `docs/参考项目/`、`_template/` = 外部参考代码（codegraph 索引排除，见 `codegraph.json`）
- 预提交钩子：lint-staged（Biome 自动修复）+ codegraph sync（60s 超时，`SKIP_CODEGRAPH_SYNC=1` 跳过）
- 提交信息：commitlint 校验 Conventional Commits，scope 可选；type 需准确（feat/fix/perf 进 CHANGELOG，其余不进）
- 发版流程：`pnpm changelog` 生成 → 手动改版本号 + [Unreleased]→[vX.Y.Z] → `git tag vX.Y.Z` → release.yml 自动构建发布
- 自动更新：electron-updater（generic provider，electron-builder.yml publish 配置）；开发模式 check 返回明确错误

## 架构决策记录（用户已拍板，勿重复讨论）

- **IM 子系统不独立化**：7 渠道适配器（QQ/微信/钉钉/Telegram/飞书/企微/webhook）继续留在主进程包内，不拆子包。
- **TS7 工具链不收敛**：自研正则解析检查脚本（check-*）为 TS7 原生版无编译器 API 期间的临时方案，等待生态成熟稳定后再评估收敛，当前不投入。
- **设置持久化合并到 SQLite**：已完成（见「数据库」节 app_settings 说明）。

## 外部服务 / 凭据

- AI Provider API Key 用 Electron `safeStorage` 加密存储（Windows DPAPI / macOS Keychain / Linux libsecret）
- Sentry 自托管（http://127.0.0.1:9000），DSN 从 `.env` 读取
- CI Sentry 符号上传需要 `SENTRY_AUTH_TOKEN` 环境变量
