# AGENTS.md — novel-writer-agent

Windows 桌面端网文写作 AI Agent，Electron + React 19 + TypeScript。

## 重要命令

```bash
pnpm dev                    # 启动 dev server + Electron 窗口
pnpm typecheck              # tsc --build（必须，不要用 --noEmit）
pnpm lint                   # biome check .
pnpm test                   # 全部 unit tests: shared → main → renderer

# 单包/层测试
pnpm --filter @novel-writer/shared run test
pnpm test:main
pnpm test:renderer

# E2E
pnpm test:e2e               # 浏览器模式（dev server）
pnpm test:e2e:electron      # Electron 真实窗口
pnpm test:smoke             # 生产构建 smoke
```

质量门禁顺序：`pnpm typecheck` → `pnpm lint` → `pnpm test`。类型检查不会自动增量编译，必须显式运行。

## 架构

```
src/main/        → 主进程（Node.js, sandbox: true）
src/preload/     → 桥接（CJS 格式 .cjs, contextBridge）
src/renderer/    → React 渲染层
packages/shared/ → 跨进程共享: 类型/IPC schema/常量
packages/tsconfig/→ base.json / node.json / web.json 三档
```

- 主进程是 Service Container 模式（`service-container.ts`），集中管理 10+ 服务（Chat/Agent/File/Search/Terminal/Git/Codebase/Session 等），dispose 顺序按反向依赖
- IPC 通过 `contextBridge.exposeInMainWorld('api', api)` 暴露，渲染层用 `window.api.*` 调用
- 流式事件用 subscribe 回调模式（返回 unsubscribe 函数）
- Channel 命名：`{domain}:{action}`（请求-响应）、`{domain}:stream:{event}`（流式）、`{domain}:event:{name}`（状态事件），常量表在 `packages/shared/src/ipc/channels.ts`

## 关键约束（易踩坑）

- **preload 必须输出 CJS**（sandbox: true 限制，`electron.vite.config.ts` 中 format: 'cjs'），纯 ESM 包（如 zod）引入 preload 会静默失败导致 `window.api` 为 undefined。preload 必须通过 `@novel-writer/shared/ipc/channels` 子路径导入 IPC 常量（避开 shared 主入口中的 zod）
- **Sentry 初始化必须在 `app.whenReady()` 之前**（@sentry/electron 要求）
- **dev 环境 userData 重定向到 `.electron-user-data/`**（避免 TRAE 沙箱拦截 %APPDATA%）
- **dev 环境开启远程调试端口 9222**（CDP over WebSocket）
- **.env** 由 `process.loadEnvFile()` 在 main 进程启动时加载（需在 whenReady 之前）
- **仅限 Windows 桌面端**，NSIS 安装器 x64

## 数据库

- SQLite（better-sqlite3），schema 在 `src/main/infra/storage/schema.ts`
- Drizzle Kit 从 `drizzle.config.ts` 读取配置
- dev: `.electron-user-data/sessions.db`，prod: `%APPDATA%/novel-writer-agent/sessions.db`
- 原 PostgreSQL/Prisma/AGE 层已删除 — 不要尝试 prisma 相关命令

## 代码风格（Biome 非默认项）

- `useNamingConvention` 默认强制 `strictCase`（大量文件有 override，见 biome.json overrides）
- 禁止 `default export`（例外：renderer `*.tsx`、config 文件、scripts）
- 禁止 `console`（例外：集成测试 `tests/integration/`、E2E `e2e/`、scripts）

## 测试规范

- **不使用 mock**：Vitest 配置均禁用 mocking 设施，测试真实实现
- 测试文件与源码 colocation：`**/*.test.ts` / `**/*.test.tsx`
- Vitest globals 启用（describe/it/expect 无需 import）
- renderer 测试用 jsdom + `test/setup.ts`（mock `window.api` 并 polyfill ResizeObserver/IntersectionObserver/matchMedia）
- 覆盖率阈值：statements 80% / branches 75% / functions 80% / lines 80%
- E2E 有 3 个 Playwright 配置：`playwright.config.ts`（浏览器）、`playwright.electron.config.ts`（Electron）、`playwright.smoke.config.ts`（生产构建）
- 集成测试目录 `tests/integration/` 当前为空

## 构建产物 & Git

- `out/` = electron-vite build 产物，`release/` = electron-builder 打包产物
- `docs/参考项目/` = 外部参考代码（codegraph 索引排除，见 `codegraph.json`）
- 预提交钩子：lint-staged（Biome 自动修复）+ codegraph sync（60s 超时，`SKIP_CODEGRAPH_SYNC=1` 跳过）
- 提交信息：commitlint 校验 Conventional Commits，scope 可选

## 外部服务 / 凭据

- AI Provider API Key 用 Electron `safeStorage` 加密存储（Windows DPAPI）
- Sentry 自托管（http://127.0.0.1:9000），DSN 从 `.env` 读取
- CI Sentry 符号上传需要 `SENTRY_AUTH_TOKEN` 环境变量
