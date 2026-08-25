# 09 · 运行方式与质量门禁

> 覆盖：开发环境、构建、测试、发布、工程纪律（typecheck/lint/coverage/CSP 等）。

## 1. 环境要求

| 项 | 要求 |
|---|---|
| Node.js | `>=24.13.0`（`engines`）；TRAE IDE 终端可能注入自带 Node（v22）导致版本不符，属 TRAE 限制，系统 Node 正确安装即可） |
| pnpm | `>=10.0.0`（`packageManager: pnpm@10.0.0`） |
| 原生模块 | better-sqlite3 / esbuild / node-pty（`pnpm.onlyBuiltDependencies`） |

## 2. 安装与启动

```bash
pnpm install            # 安装依赖 + 原生模块编译 + postinstall-rebuild
cp .env.example .env    # 可选：Sentry DSN / 供应商 baseURL
pnpm dev                # rebuild-native electron --auto && electron-vite dev -w
```

- `pnpm dev`：启动 dev server + Electron 窗口；dev 下 userData 重定向到 `.electron-user-data/`、CDP 端口 9222。
- `pnpm dev:web`：纯浏览器渲染（Vite web mode，配合前端 mock 层独立开发）。

## 3. 质量门禁（按顺序执行）

```bash
pnpm typecheck     # tsc --build（0 错误；不要用 --noEmit）
pnpm lint          # biome check .（0 问题）
pnpm test          # shared → main → renderer 全部单元测试 + integration + scripts
```

其余检查：

```bash
pnpm knip           # 未使用依赖/文件检测
pnpm check:static   # tokens + i18n + comments + file-size + functions + docs + test-boundary
pnpm check:secrets  # gitleaks 扫描
pnpm depcruise      # 依赖环检测（dependency-cruiser）
pnpm audit          # audit-ci（moderate 以上门禁）
```

## 4. 测试体系

### 4.1 单元（Vitest）

```bash
pnpm test:main        # vitest --root src/main（参考 ~1300+ 用例）
pnpm test:renderer    # vitest --root src/renderer（参考 ~490）
pnpm test:scripts     # vitest --root scripts
pnpm test:integration # vitest --root tests/integration
pnpm test:coverage    # 覆盖率（80% 门禁）
```

- 主进程原生模块单测需先 `pnpm rebuild-native-mjs node --auto`（better-sqlite3 ABI 与 Electron 互斥，切换环境需重编译）。
- timeline：`pnpm test` 统一走 `scripts/rebuild-native.mjs node --auto`。

### 4.2 E2E / Electron / Smoke（Playwright）

```bash
pnpm test:e2e             # 浏览器模式 E2E（e2e/playwright.config.ts）
pnpm test:e2e:electron    # Electron 真实窗口（playwright.electron.config.ts；E2E_MODE 下 preload 沙箱限制）
pnpm test:smoke           # 生产构建 smoke（playwright.smoke.config.ts）
pnpm test:visual          # 视觉回归（视觉回归 tag）
pnpm test:a11y            # 可访问性（axe-core）
pnpm test:perf            # 性能基准（IPC 基准 / 渲染 / 内存 / 导航）
```

用例：`e2e/smoke.spec.ts`、`e2e/journey-*.spec.ts`（chat/agent/settings/terminal）、`e2e/a11y.spec.ts`、`e2e/visual.spec.ts`、`e2e/perf/*`（ipc-rtt / memory-leak / navigation / render）。

## 5. 构建与发布

```bash
pnpm build                 # electron-vite build（main/preload/renderer 三入口）
pnpm build:win             # 构建 + NSIS 安装包（允许自定义安装目录）
pnpm build:mac / linux     # 对应平台包
pnpm build:all             # 全平台
pnpm build:win:full        # build + Sentry 创建 release + 上传符号
pnpm analyze:bundle        # 包体积分析（rollup-plugin-visualizer → stats/renderer-bundle.html）
```

发布配置：`electron-builder.yml`（generic provider，publish.url = `https://code-agent.example.com/releases/`）；CI：`.github/workflows/ci.yml`（quality + integration-tests）+ `release.yml`（三平台矩阵）。

Sentry 符号：
```bash
pnpm sentry:release:new / pnpm sentry:upload:symbols
```

## 6. 工程纪律要点

- **每次代码改动同步 CodeGraph 索引**：`pnpm codegraph:sync`（仓库根）。
- **每次实现轮次做 git commit**（`gh` / 常规 commit；commitlint conventional 规范 + husky pre-commit/pre-push）。
- **前端 mock 层保留**：渲染层 `dev/mock-api.ts` + MSW，前端可独立开发。
- **原生模块双环境**：Node 测试环境 vs Electron 运行时需 `pnpm rebuild-native-mjs` 重编译（ABI 互斥）。
- **CSS 令牌**：改令牌改 `tokens/aurora.json`（`pnpm tokens:build` 生成），禁止手改 `tokens.css`（`check:tokens` 卡关）。
- **i18n**：新增 key 需补全 en/zh-CN 两组（`check:i18n` 严格卡关）。
- **changelog**：`pnpm changeset` 记录变更，`pnpm changelog` 生成（scripts/changelog）。

## 7. 快速定位命令

| 意图 | 命令 |
|---|---|
| 只看主进程单测 | `pnpm test:main` |
| 只看渲染层单测 | `pnpm test:renderer` |
| 跑真实窗口 E2E | `pnpm test:e2e:electron` |
| 深度调试主进程 | `pnpm perf:inspect`（electron --inspect=9229） |
| 检查未用代码 | `pnpm knip` |
| 生成类型文档 | `pnpm docs:types`（@code-agent/typedoc-docs） |