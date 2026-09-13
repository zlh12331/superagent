# AGENTS.md — code-agent-desktop

跨平台桌面端（Windows/macOS/Linux）生产级 Code Agent 桌面应用，Electron 44 + React 19 + TypeScript + Vercel AI SDK v7。

## 重要命令

```bash
pnpm dev                    # 启动 dev server + Electron 窗口
pnpm dev:web                # 浏览器模式 dev（vite.web.config.ts，配合 src/renderer/dev/mock-api.ts）
pnpm typecheck              # tsc --build（必须，不要用 --noEmit；不会自动增量编译）
pnpm lint                   # biome check .（含格式/import 排序）
pnpm test                   # 全部测试 && 链式（任一层失败即中断）: packages → main → renderer → integration → scripts（集成测试已在链内，也可单独 pnpm test:integration）
pnpm knip                   # 死代码/死依赖检测（files/deps/binaries 级，CI 卡关）
pnpm check:static           # 静态审计 11 项：tokens + i18n + comments（过期注释）+ file-size（净行 ≤600 棘轮；原始行 >600 仅告警，不卡关）+ functions（形参≤4 / 体≤100 棘轮；51–100 仅提示）+ complexity（认知复杂度≤15 棘轮）+ coverage-floors + docs + test-boundary + csp-hash + ui-consistency（写法一致性棘轮），pre-push/CI 卡关
pnpm check:tokens           # 令牌审计：裸色/dark:/space-*/w+h 双写/hex（依据 10-component-design-spec 铁律）
pnpm check:i18n             # i18n 审计：引用缺失 + 双语一致 + 冗余/硬编码文案（脚本已默认 --strict）卡关
pnpm check:compiler         # build 后断言产物含 react/compiler-runtime 痕迹（防 React Compiler 静默失效），CI e2e-electron job 卡关
pnpm check:bundle           # 构建产物体积门槛（build 后运行；单 chunk ≤5MB/总包 ≤16MB 基线）

# 单包/层测试
pnpm --filter @code-agent/shared run test
pnpm test:main              # vitest --root src/main
pnpm test:renderer
pnpm test:scripts

# E2E（3 套 Playwright 配置；@playwright/test 升级后需 `npx playwright install` 同步浏览器，否则本地全挂）
pnpm test:e2e               # 浏览器模式（dev server）
pnpm test:e2e:electron      # Electron 真实窗口
pnpm test:smoke             # 生产构建 smoke
pnpm test:perf              # e2e 性能子集（渲染性能/内存/IPC 基准）；主进程 perf 用 test:perf:main
pnpm test:visual            # e2e 视觉回归子集

# 脚手架（定义表体系专属红利）
pnpm scaffold:ipc --domain <name> --method <m> [--kind request|event]
pnpm scaffold:tool --name <snake_case> [--permission auto|ask]

# 工程化工具
pnpm analyze:bundle         # 包体积分析（ANALYZE_BUNDLE=1）
pnpm docs:types             # TypeDoc 契约文档（tools/typedoc 子包，TS6 隔离）
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
scripts/         → 脚手架与工具（scaffold / check-* / build-tokens）
tools/typedoc/   → TypeDoc 独立子包（TS6 隔离，规避 TS7 不兼容）
```

- 主进程是 Service Container 模式（`service-container.ts`），集中管理 20 个 lazy accessor（File/Search/ToolRegistry/Permission/ToolExecutor/MCP/Prompt/MemoryPort/MemoryHub/LSP/Goal/IM/RemoteControl/Terminal/Git/Codebase/Session/Update/Agent/Browser，2026-09-12 实测；Memory 已更名为 MemoryHub，dispose 顺序见文件头注释）按反向依赖。ConcurrencyGate 不是 accessor，是容器上直接初始化的 `readonly` 字段
- **agentAskService 与 cronService 都不是容器 accessor**，以模块级单例 import 引入（`service-container.ts:55,63`）；cronService 由 AgentService accessor 内部 `start()` + `onFire` 订阅（fire 触发 agent 回合），dispose 链中 `cronService.stop()` 排第一位（先于 AgentService 收尾）
- 桌面系统集成在 main 根目录：`tray.ts`（托盘）/ `deep-link.ts`（`code-agent://` 协议，scheme 常量与 electron-builder.yml 的 protocol 配置必须保持一致）/ `notification.ts`（回合通知）/ `theme-linkage`（系统主题联动，独立模块）
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
- **错误处理本地优先**（2026-09-13 移除 Sentry）：所有异常经 `infra/telemetry/error-report.ts`（main）/ `lib/error-report.ts`（renderer）单一出口落本地日志（渲染层经 electron-log 转发主进程，随诊断包导出），报障走 GitHub Issue 深链。⚠️ renderer 上报模块内 `electron-log/renderer` 必须**惰性加载**（CJS 首次 import >5s，静态导入会让 renderer 测试套件从 30s 劣化到 300s）。将来接任何后端只改这两个出口文件
- **dev 环境 userData 重定向到 `.electron-user-data/`**（避免沙箱拦截 %APPDATA%）
- **dev 环境开启远程调试端口 9222**（CDP over WebSocket）
- **.env** 由 `process.loadEnvFile()` 在 main 进程启动时加载（需在 whenReady 之前）
- **桌面端三平台**（Windows/macOS/Linux）：Windows NSIS x64 / macOS dmg+zip（x64+arm64）/ Linux AppImage+deb x64；release.yml 三平台矩阵构建（mac 需 macOS runner，签名走 CSC_LINK）
- **exactOptionalPropertyTypes 已启用**：可选字段传 undefined 需条件展开（`...(x !== undefined ? { x } : {})`）；同时启用了 `noUncheckedIndexedAccess`（索引访问返回 T|undefined）与 `isolatedDeclarations`（**所有导出必须显式标注类型**）
- **React Compiler 已启用**（2026-08-30 经 oxc 通道落地：`oxc-transform-react`（devDep）+ `react({ compiler: { compilationMode: 'infer' } })`；`@vitejs/plugin-react` v6 无 `babel` 选项，旧 `babel.plugins` 配置曾被 Vite 8/Rolldown 链路静默忽略、已删除）⇒ 新代码默认不写 useMemo/useCallback（编译器自动记忆化；存量手写 memo 与其共存无害，机会性清理）；hook 仍只能在顶层调用，禁止中间函数包装 hook。存量编译器 bail-out（try/finally 违规）已于 455c476 清零，新代码禁止引入。**防静默失效**：`pnpm check:compiler` 在 build 后断言产物含 react/compiler-runtime 痕迹（oxc-transform-react 是可选 peerDep，缺失时 compiler 选项无效且无报错），CI e2e-electron job 卡关
- **根级 `*.config.ts` 已纳入 typecheck 但 include 是枚举式**（根 `tsconfig.json` = `files: []` + 6 个 project references，其中 `tsconfig.configs.json` 显式枚举 electron.vite.config.ts / vite.web.config.ts / drizzle.config.ts / i18next.config.ts / vitest.workspace.ts / commitlint.config.js）⇒ **新增根级配置文件必须手动加进 `tsconfig.configs.json` 的 include**，否则 typecheck 查不出它的类型错误/excess property；改配置仍需 `pnpm exec vite build` 实测行为
- **渲染层动效统一走 MotionVault**（`src/renderer/lib/motion/`：transitions/variants 集中定义），不要散写 CSS transition/手搓动画；shiki 语言按需加载（`loadLanguage`），受首载体积门槛约束
- **网页预览绝不能回渲染层 iframe**：主进程对 defaultSession 统一注入 CSP/X-Frame-Options（`security/csp.ts` + `index.ts`），iframe 加载外站会被三层拦截（frame-src 回退 'self' / XFO 注入远端响应 / CSP 污染远端文档）。右面板浏览器走 `WebContentsView` + 独立内存分区 `browser-preview`（`infra/browser/preview-service.ts`，容器第 20 个 accessor）——新增网页承载能力必须用进程外视图 + 独立 session 分区

## 渲染层写法标准（2026-09 一致性收敛）

标准设施已全部建成，新代码必须使用（存量由 `check:ui-consistency` 棘轮看护，只许下降）：

- **请求-响应**：TanStack Query，query 逻辑放 `hooks/` 域文件并导出 queryKey 常量（禁组件内联定义 key）；响应一律 `unwrap()`（`lib/ipc.ts`），禁手写 `'data' in` 判别
- **变更操作**：useMutation 定义处**必须挂 onError** → `toast.error(unwrapErrorMessage(error, getErrorMessage))`（错误码解析单一真源在 `lib/ipc.ts`，勿再抄正则）；调用层不重复挂 onError（防双弹）
- **危险操作**（删除/清空类）：一律命令式 `confirm()` store（`confirm-dialog-store`，DialogHost 全局宿主），禁内联 AlertDialog 重复造轮子
- **复制反馈**：统一 `useCopy()`（`hooks/use-copy.ts`，copied 2s 复位 + 失败 toast），勿手写 copied state + 定时器
- **条件 className**：一律 `cn()`；裸 `<button>` 禁止（用 `ui/button` 的 Button，icon 钮 `size="icon"`）
- **组件单实例多入口**：对话框状态收敛 ui-store（先例：settingsOpen/paletteOpen/shortcutHelpOpen），禁双份 state + 双份挂载

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
- **启动备份 + 损坏自愈**（`db.ts`，2026-09-04 落地）：启动期热备份轮转（`backups/sessions-<时间戳>.db`，超出 BACKUP_KEEP 删最旧）；`restoreCorruptDatabase` 用 quick_check 判损坏 → 从最近健康备份恢复/重建空库；probe 通过后才调度备份。better-sqlite3 的 `backup()` 是异步 API 必须 await
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
- 覆盖率阈值：statements 80% / branches 75% / functions 80% / lines 80%（**数字真源 = `scripts/coverage-floors.json`，本文件不维护任何实测值**）；**覆盖率下限是棘轮门禁**（`check:coverage-floors`，`coverage-floors:tighten` 收紧基线——继续收紧必须先补测试，renderer 覆盖率距规范仍有缺口）
- **fast-check 属性测试已试点**（如 clampOutputTokens/joinPath），纯函数适合用属性测试补强
- E2E 有 3 个 Playwright 配置：`e2e/playwright.config.ts`（浏览器）、`e2e/playwright.electron.config.ts`（Electron）、`e2e/playwright.smoke.config.ts`（生产构建）；另有 visual/a11y/perf 子集按 grep 分组
- 集成测试目录 `tests/integration/`（20+ 测试文件，CI 有独立 integration-tests job）

## 工程化工具链

- **knip**（`pnpm knip`）：死代码/死依赖检测，CI 卡关（files/deps/binaries 级）；exports 级报告人工审阅
- **版本管理 release-please**（`.github/workflows/release-please.yml`）：push main 时基于 Conventional Commits 自动创建/更新 Release PR（bump package.json version + 生成 CHANGELOG）；合并 Release PR **不打 tag、不建 Release**（`skip-github-release: true`）——tag 与 Release 移交 release.yml，在**三平台构建全部成功后**才创建（防空版本占号）。⚠️ 输入必须是 `skip-github-release`，此前误写的 `skip-tag` 非法且被 Actions 静默忽略，曾在合并时自行打 tag + 建空 Release，使 release.yml 落入 403 更新路径（2026-09-10 修复）。打 tag 由 release.yml 用 GITHUB_TOKEN 完成（本 workflow 不创建 tag）
- **发布策略：单分支（只 main）**。不发长期 beta 分支——`release-please-config.json` 的 `versioning: "prerelease"` + `prerelease-type: "beta"` 驱动预发布，beta 由提交 footer `Release-As: X.Y.Z-beta.N` 指定；毕业为正式版只需普通提交（prerelease 未开启时会把 `X.Y.Z-beta.N` 收敛为干净的 `X.Y.Z`）。⚠️ release-please **不按分支名识别 prerelease**，配置从被发布分支的 tip 读取。完整 runbook 见 `RELEASING.md`
- **CHANGELOG 由 release-please 全量接管**（`release-please-config.json`，keep-a-changelog 风格 + 中文分组）；不再有任何自研 changelog 脚本
- **Renovate**：依赖自动更新（周末批次，electron major 人工评审）
- **供应链加固**（2026-09 落地）：asar 完整性校验 + SBOM 生成 + `check:csp-hash`（CSP 内联脚本哈希锚定，防注释旧脚本静默放行）；`pnpm audit` 走 audit-ci（--moderate 起卡关）
- **主进程遥测**：EventLoopLagMonitor 事件循环延迟监控（基准按期望间隔推进，空闲不误报）
- **pre-push 钩子**：gitleaks 密钥扫描（`gitleaks dir .`）+ typecheck + lint + check:static（check:tokens + check:i18n）+ depcruise + test:scripts（`SKIP_PREPUSH=1` 跳过）
- **TypeDoc**：`pnpm docs:types` 在 tools/typedoc 子包运行（TS6 隔离，规避 TS7 不兼容）
- **包体积分析**：`pnpm analyze:bundle`（rollup-plugin-visualizer，ANALYZE_BUNDLE=1）

## 构建产物 & Git

- `out/` = electron-vite build 产物，`release/` = electron-builder 打包产物，`stats/` = 体积分析产物
- 预提交钩子：lint-staged（Biome 自动修复）+ codegraph sync（60s 超时，`SKIP_CODEGRAPH_SYNC=1` 跳过）
- 提交信息：commitlint 校验 Conventional Commits，type 需准确（feat/fix/perf 才会被 release-please 计入升版）。规则（`commitlint.config.js`，2026-09-11 调整）：`header-max-length` 保持 100（Git 官方建议 50、Angular/commitlint 默认 100；实测本项目最长 subject 76 字符，无摩擦）；**`body-max-line-length` / `footer-max-line-length` 已关闭**（`0`，原 100）——排版约束会误伤 URL/日志/代码片段，且现代工具自动折行；`scope-enum` 为 **warning 级**（1）——即"提示但不阻断提交"，符合 Conventional Commits 中 scope 可选的定位，枚举已按真实用量补齐（新增 release/ci/about/chat/models/design/quality/tsconfig）。⚠️ 调整行宽规则必须显式写 `0`，直接删除规则会**继承**官方默认的 100。破坏性变更用 `feat!` 或 `BREAKING CHANGE:` footer——**没有 `breaking` 这个 type**，`changelog-sections` 里配它无效（已从 `release-please-config.json` 移除）
- 发版流程：push main → release-please 开 Release PR（版本号 + CHANGELOG）→ 人工审阅（可在 PR 中润色 CHANGELOG）→ 合并 PR → release.yml 三平台构建成功 → 打 tag vX.Y.Z → 校验三平台安装包/latest*.yml 齐全 → draft 转正式发布；任一环节失败则无 tag 无 release，版本号不占号、可重试（`workflow_dispatch` 需输入与 package.json 一致的版本号）。发 beta / 热修复等完整操作见 `RELEASING.md`
- **CI 触发策略：CI on PR, CD on main**（2026-09-10 方案二）——`ci.yml` **只由 pull_request 触发**（不再 push: main），因为 ruleset 强制 main 所有提交必须走 PR、禁用管理员绕过、`strict_required_status_checks_policy=true`（PR 必含 main 最新提交）、`required_linear_history`（只允许 squash/rebase ⇒ 合入树与 PR head 一致）⇒ 必需检查在合并前已对相同内容跑过，push 阶段重复无增益。`release.yml` 因此**不再轮询/等待 ci.yml**（旧 `ci-check` job 已删）。**打包验证只在 CD**：原 `ci.yml` 的 package job（三平台 electron-builder 打包，各约 5 分钟）已删除——它与 `release.yml` build job 执行完全相同的命令，属重复；打包正确性由 CD 保证（发版必经关卡，失败不占号可重试）。⚠️ 因此 ruleset 必需检查已移除 3 项 `Package (...)`（现 8 项）；若日后恢复该 job 需同步加回，反之只删 job 不改 ruleset 会让 PR 永远卡 pending。合并后 main 仍有 CodeQL + secret scanning（GitHub 托管，push 时运行）。⚠️ 不要给 `ci.yml` 加 workflow 级 `paths`/`paths-ignore`：必需状态检查一旦因路径被跳过就永不 report，PR 会卡 pending 无法合并（要省纯文档 PR 开销请用 job 级 `if`）
- 自动更新：electron-updater（github provider，electron-builder.yml publish 配置）；开发模式 check 返回明确错误

## 架构决策记录（用户已拍板，勿重复讨论）

- **IM 子系统不独立化**：7 渠道适配器（QQ/微信/钉钉/Telegram/飞书/企微/webhook）继续留在主进程包内，不拆子包。
- **技术选型：优先用成熟依赖，找不到合适的才自研兜底**（2026-09-11 转向）：需要解析/度量/校验等能力时，先查现成库（如 Biome 内置规则、`oxc-parser`、`@babel/parser` —— 后两者已在依赖图中），**能复用就复用**；只在无合适依赖时才写脚本兜底。实证：`check:complexity` 首版自研正则度量在一个函数内暴露 3 个 bug 且语义与 Biome 实测不符（Biome：if-else-if 得 2、try-catch 得 2），改用 Biome 内置规则后问题整体消失。**注意区分硬约束**：preload 零运行时依赖（CJS + 纯字符串 meta，Electron 沙箱要求，zod 进 preload 会静默失败）是**平台逼的**，不属本原则范围。`function-metrics.ts` 当前仍是正则实现，属**待评估迁移**（可换 oxc-parser），非禁改。
- **设置持久化合并到 SQLite**：已完成（见「数据库」节 app_settings 说明）。

## 外部服务 / 凭据

- AI Provider API Key 用 Electron `safeStorage` 加密存储（Windows DPAPI / macOS Keychain / Linux libsecret）
- 遥测为 **OpenTelemetry 单通道**（`OTEL_EXPORTER_OTLP_ENDPOINT` 配置，未配置即不外发；Sentry 已于 2026-09-13 移除，见 docs/design/23-otel-spec.md）
- 错误报障走 GitHub Issue + 诊断包导出（本地优先，无云端上报依赖）
