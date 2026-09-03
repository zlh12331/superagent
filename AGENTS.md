# AGENTS.md — code-agent-desktop

跨平台桌面端（Windows/macOS/Linux）生产级 Code Agent 桌面应用，Electron 44 + React 19 + TypeScript + Vercel AI SDK v7。

## 重要命令

```bash
pnpm dev                    # 启动 dev server + Electron 窗口
pnpm typecheck              # tsc --build（必须，不要用 --noEmit；不会自动增量编译）
pnpm lint                   # biome check .（含格式/import 排序）
pnpm test                   # 全部 unit tests（&& 链式，任一层失败即中断）: shared → main → renderer → scripts；集成测试单独跑 pnpm test:integration
pnpm knip                   # 死代码/死依赖检测（files/deps/binaries 级，CI 卡关）
pnpm check:static           # 静态审计：check:tokens（样式铁律）+ check:i18n（i18n 缺失卡关），pre-push/CI 卡关
pnpm check:tokens           # 令牌审计：裸色/dark:/space-*/w+h 双写/hex（依据 10-component-design-spec 铁律）
pnpm check:i18n             # i18n 审计：引用缺失 + 双语一致 + 冗余/硬编码文案（脚本已默认 --strict）卡关
pnpm check:bundle           # 构建产物体积门槛（build 后运行；单 chunk ≤5MB/总包 ≤16MB 基线）
pnpm changelog              # 从 git log 自动生成 CHANGELOG [Unreleased] 段

# 单包/层测试
pnpm --filter @code-agent/shared run test
pnpm test:main              # vitest --root src/main
pnpm test:renderer
pnpm test:scripts

# E2E（3 套 Playwright 配置；@playwright/test 升级后需 `npx playwright install` 同步浏览器，否则本地全挂）
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

- 主进程是 Service Container 模式（`service-container.ts`），集中管理 20 个 lazy accessor（ConcurrencyGate/File/Search/ToolRegistry/Permission/ToolExecutor/MCP/Prompt/MemoryPort/MemoryHub/LSP/Goal/IM/RemoteControl/Terminal/Git/Codebase/Session/Update/Agent，2026-08-30 实测；Memory 已更名为 MemoryHub，dispose 顺序见文件头注释）按反向依赖
- `agentAskService` 不是容器 accessor，在 `service-container.ts:50` 以模块级单例 import 引入
- IPC 通过 `contextBridge.exposeInMainWorld('api', api)` 暴露，渲染层用 `window.api.*` 调用
- 流式事件用 subscribe 回调模式（返回 unsubscribe 函数）
- Channel 命名：`{domain}:{action}`（请求-响应）、`{domain}:stream:{event}`（流式）、`{domain}:event:{name}`（状态事件），常量表在 `packages/shared/src/ipc/channels.ts`

## 进程与崩溃影响分级（显式取舍，对照 VS Code 六进程模型）

当前是**扁平三进程模型**（main / preload / renderer），所有重活（IM 长连接、LSP、node-pty 终端、Agent 回合、MCP 子进程）都在主进程内跑，无 VS Code 式 Extension Host / Shared Process / PtyHost 拆分。各故障域的影响：

| 故障 | 影响 | 恢复机制 |
|---|---|---|
| 渲染进程崩溃 | 整窗消失（单窗口设计，无独立重开） | Electron 自动重建 webContents；数据真源在 SQLite 无损 |
| 主进程崩溃 | 应用退出 | `.crash-marker` + 启动 `recoverFromCrash()` 把 running 回合标 interrupted |
| MCP server / LSP / pty / ripgrep 子进程崩溃 | 对应功能降级，主进程存活 | 各 service 自管重启/报错（run-command killTree 防孤儿） |
| MemoryHub sidecar 崩溃 | 记忆功能降级 | service 层报错，主流程不依赖 |
| 断电/强杀 | running 会话残留 | 下次启动 `markAllInterrupted()`（启动期无条件执行，不依赖崩溃标记） |

退出路径双层保障：**关窗协商**（`window.ts` close 拦截：运行中回合弹确认，`CODE_AGENT_SKIP_CLOSE_GUARD=1` 豁免）+ **退出善后**（dispose 链 `markInterruptedOnShutdown`：agentService drain 后把残留 running 标 interrupted，消除"干净退出留 stale running"窗口）。取舍说明：单窗口 Agent 应用暂不做进程拆分（重活隔离的收益 < utilityProcess 拆分的复杂度），若未来多窗口/插件化再评估。

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
- **React Compiler 已启用**（2026-08-30 经 oxc 通道落地：`oxc-transform-react`（devDep）+ `react({ compiler: { compilationMode: 'infer' } })`；`@vitejs/plugin-react` v6 无 `babel` 选项，旧 `babel.plugins` 配置曾被 Vite 8/Rolldown 链路静默忽略、已删除）⇒ 新代码默认不写 useMemo/useCallback（编译器自动记忆化；存量手写 memo 与其共存无害，机会性清理）；hook 仍只能在顶层调用，禁止中间函数包装 hook。**防静默失效**：`pnpm check:compiler` 在 build 后断言产物含 react/compiler-runtime 痕迹（oxc-transform-react 是可选 peerDep，缺失时 compiler 选项无效且无报错），CI e2e-electron job 卡关
- **根级 `*.config.ts` 不在任何 tsconfig 项目内**（根 `tsconfig.json` = `files: []` + 5 个 project references）⇒ `pnpm typecheck` 查不出配置文件里的类型错误/excess property，历史失效配置（如 React Compiler 旧 babel 通道）因此长期存活；改配置需 `pnpm exec vite build` 实测

## 数据库

- SQLite（better-sqlite3）+ Drizzle ORM，**schema.ts 是全库唯一真源**（`src/main/infra/storage/schema.ts`，11 张表 + 领域约束 CHECK/UNIQUE/外键 + 查询索引）
- Drizzle Kit（`drizzle.config.ts`）从 schema.ts **自动派生** DDL 与迁移（`drizzle/*.sql` + `drizzle/meta/` journal/snapshot）——**禁止手写第二份建表 SQL**
- 迁移运行时：`db.ts initDb()` 调 `drizzle-orm/better-sqlite3/migrator.migrate()`，按 `_journal.json` 的 `when`（folderMillis）前进执行，`__drizzle_migrations` 表幂等记录。迁移目录 dev 读 `drizzle/`、打包读 `process.resourcesPath/drizzle`（extraResources）
- **schema 演化规范**：
  - 加列/加表/改索引：改 `schema.ts` → `pnpm exec drizzle-kit generate`（自动出迁移）+ 登记 journal/snapshot。验证 `pnpm exec drizzle-kit check`
  - 给已有表加 CHECK/UNIQUE：SQLite 无法 `ALTER TABLE ADD CHECK`，两条路径——① 重建式迁移（`0001_legacy_upgrade` 先例，仅限**无其他表外键引用**的表，数据保真 INSERT SELECT）；② **触发器兜底**（`0002_sessions_last_run_status` 先例，被 FK 引用的表如 sessions——直接重建会触发 ON DELETE CASCADE 清空全部会话数据，绝对禁止）
- 领域约束策略：稳定枚举 → DB CHECK/触发器（`messages.role`、`sessions.last_run_status` 等）；演进枚举 → `$type<T>()` 应用层约束（`goals.status`、`tasks.status/kind`，SQLite 改 CHECK 需重建表代价高）
- 上层模块（ai 层）需要枚举类型时从 `schema.ts` 导入，勿重复定义
- **渲染层用户设置（theme/ai/editor/shortcuts/experimental）持久化真源 = SQLite `app_settings` 表**（用户决策：localStorage 合并到 SQLite）。渲染层 settings-store 保持内存态，写穿透经 `settings:set` 落库；启动快照经 `settings:getAll` 在 main.tsx 顶层 await 拉取（`settings-bootstrap.ts`）。legacy localStorage 数据首启自动迁移。draft/sidebar/activeSession 等纯 UI 态仍留 localStorage
- 路径由 `app.getPath('userData')` 动态决定：dev 为 `.electron-user-data/sessions.db`（重定向），prod 为 `%APPDATA%/<app name>/sessions.db`
- keychain.dat 损坏：读失败记日志并保留 `.corrupt` 副本（不静默丢失全部 API Key）
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
