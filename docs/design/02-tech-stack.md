# 技术栈文档

> 基于 `code-agent-desktop` v1.0.0 实际 [package.json](file:///package.json) 整理。
> 整理时间：2026-07-23（依赖清单 2026-08-11 同步）

## 1. 项目基本信息

| 项 | 值 | 来源 |
|---|---|---|
| name | `code-agent-desktop` | [package.json#L2](file:///package.json#L2) |
| version | `1.0.0` | [package.json#L3](file:///package.json#L3) |
| description | Code Agent Desktop - 生产级 Electron Code Agent 桌面应用（Windows 桌面端） | [package.json#L4](file:///package.json#L4) |
| type | `module` | [package.json#L7](file:///package.json#L7) |
| main | `./out/main/index.js` | [package.json#L8](file:///package.json#L8) |
| packageManager | `pnpm@10.0.0` | [package.json#L9](file:///package.json#L9) |

## 2. engines 与运行时要求

| 依赖 | 版本要求 | 来源 |
|---|---|---|
| Node.js | `>=24.13.0` | [package.json#L10-L13](file:///package.json#L10) |
| pnpm | `>=10.0.0` | [package.json#L10-L13](file:///package.json#L10) |

`pnpm.onlyBuiltDependencies` 限制仅 3 个原生模块参与编译：`better-sqlite3` / `esbuild` / `node-pty`（[package.json#L14-L20](file:///package.json#L14)）。

## 3. 依赖分类清单

### 3.1 Electron / 构建工具

| 依赖 | 版本 | 类型 |
|---|---|---|
| `electron` | `^43.1.1` | devDep |
| `electron-vite` | `6.0.0-beta.1` | dep |
| `electron-updater` | `^6.8.9` | dep |
| `electron-log` | `^5` | dep |
| `electron-builder` | `^26` | devDep |
| `@electron/rebuild` | `^4.2.0` | devDep |
| `electron-devtools-installer` | `^4.0.0` | devDep |
| `vite` | `^8` | dep |
| `@vitejs/plugin-react` | `^6.0.3` | devDep |
| `babel-plugin-react-compiler` | `^1.0.0` | devDep |

### 3.2 React 全家桶

| 依赖 | 版本 |
|---|---|
| `react` | `^19.2` |
| `react-dom` | `^19.2` |
| `react-router` | `^8.3.0` |
| `react-i18next` / `i18next` / `i18next-browser-languagedetector` | `^17.0.10` / `^26.3.6` / `^8.2.1` |
| `@tanstack/react-query` | `^5.101.3` |
| `react-error-boundary` | `^6.1.2` |
| `react-hotkeys-hook` | `^5.3.3` |
| `react-markdown` / `remark-gfm` | `^10.1.0` / `^4.0.1` |
| `react-diff-viewer-continued` | `^4.4.0` |
| `react-activity-calendar` | `^3.2.1` |
| `react-arborist` | `^3.15.0` |

### 3.3 AI 相关

| 依赖 | 版本 | 用途 |
|---|---|---|
| `ai` (Vercel AI SDK) | `^7.0.32` | streamText / tools / stopWhen 多轮工具调用 |
| `@ai-sdk/openai` | `^4.0.27` | OpenAI provider |
| `@ai-sdk/anthropic` | `^4.0.27` | Anthropic provider |
| `@ai-sdk/openai-compatible` | `^3.0.13` | DeepSeek 等 OpenAI 兼容 provider |
| `@ai-sdk/react` | `^4.0.35` | useChat 等 React hooks |
| `@modelcontextprotocol/sdk` | `^1.30.0` | MCP server 集成（stdio / sse / streamable-http 三态 transport） |
| `gpt-tokenizer` | `^3.4.0` | token 计数 |

### 3.4 数据库

| 依赖 | 版本 | 用途 |
|---|---|---|
| `better-sqlite3` | `^12.11.1` | SQLite 原生绑定 |
| `drizzle-orm` | `^0.45.2` | TypeScript ORM |
| `drizzle-kit` | `^0.31.10` | devDep，迁移工具（[drizzle.config.ts](file:///drizzle.config.ts) 已在根目录提供） |
| `@types/better-sqlite3` | `^7.6.13` | devDep |

### 3.5 UI / 样式

| 依赖 | 版本 |
|---|---|
| `@tailwindcss/vite` / `tailwindcss` | `^4` / `^4` |
| `@radix-ui/react-{dialog,dropdown-menu,label,scroll-area,slot,tabs,tooltip,alert-dialog}` | 多个 |
| `class-variance-authority` / `clsx` / `tailwind-merge` / `tw-animate-css` | `^0.7.1` / `^2.1.1` / `^3.6.0` / `^1.4.0` |
| `lucide-react` / `cmdk` / `sonner` / `motion` | `^1.25.0` / `^1.1.1` / `^2.0.7` / `^13.0.0` |
| `shiki` | `^4.3.1` |

### 3.6 终端 / 文件系统 / 搜索

| 依赖 | 版本 | 用途 |
|---|---|---|
| `@xterm/xterm` / `@xterm/addon-fit` | `^6.0.0` / `^0.11.0` | 终端 UI |
| `node-pty` | `^1.1.0` | PTY 进程 |
| `chokidar` | `^5.0.0` | 文件监听 |
| `@vscode/ripgrep` | `^1.18.0` | grep 搜索 |
| `web-tree-sitter` | `^0.24.7` | tree-sitter 解析 |
| `tree-sitter-wasms` | `^0.1.13` | tree-sitter WASM 语法包 |
| `diff-match-patch` | `^1.0.5` | 文件 diff |
| `fuse.js` | `^7.5.0` | 模糊搜索 |

> 2026-08-11 同步：依赖清单对齐 package.json（radix 补 alert-dialog 去 separator；AI 栈补 openai/anthropic provider；react-virtuoso → react-activity-calendar；motion ^13；补 tree-sitter-wasms）。

### 3.7 状态 / 校验

| 依赖 | 版本 |
|---|---|
| `zustand` | `^5.0.14` |
| `zod` | `^4.0.0` |
| `@dnd-kit/core` | `^6.3.1` |

### 3.8 监控 / 可观测性

| 依赖 | 版本 | 用途 |
|---|---|---|
| `@sentry/electron` | `^7.15.0` | 错误聚合 + Performance + Replay |
| `@sentry/cli` | `^2.41.1` | devDep，source map 上传 |
| `@opentelemetry/api` | `^1.9.1` | OTel API |
| `@opentelemetry/exporter-trace-otlp-http` | `^0.221.0` | OTLP HTTP exporter |
| `@opentelemetry/resources` | `^2.10.0` | Resource 定义 |
| `@opentelemetry/sdk-trace-base` | `^2.10.0` | Tracer 基础 |
| `@opentelemetry/sdk-trace-node` | `^2.10.0` | Node Tracer |

### 3.9 测试

| 依赖 | 版本 | 用途 |
|---|---|---|
| `vitest` / `@vitest/coverage-v8` | `^4.0.0` / `^4.0.0` | 单测框架 + v8 coverage |
| `@playwright/test` / `playwright` | `^1.58` / `^1.61.1` | E2E 测试 |
| `@testing-library/react` / `jest-dom` / `user-event` | `^16.3.2` / `^7.0.0` / `^14.6.1` | 组件测试 |
| `@axe-core/playwright` | `^4.12.1` | a11y 审计 |
| `jsdom` | `^29.1.1` | DOM 环境 |

### 3.10 工程化 / 工具

| 依赖 | 版本 | 用途 |
|---|---|---|
| `@biomejs/biome` | `^2` | lint + format 二合一 |
| `typescript` | `^7.0.2` | TS 编译器 |
| `tsx` | `^4` | TS 脚本执行 |
| `husky` / `lint-staged` | `^9` / `^17.1.0` | Git hooks |
| `@commitlint/cli` / `config-conventional` | `^21.2.1` / `^21.2.0` | 提交规范 |
| `audit-ci` | `^7.1.0` | 依赖审计 |
| `cross-env` | `^10.1.0` | 跨平台环境变量 |
| `@types/node` | `^26.1.1` | Node.js 类型 |

### 3.11 workspace 内部包

- `@code-agent/shared`: `workspace:*`（devDep）
- `@code-agent/tsconfig`: `workspace:*`（devDep）

## 4. Monorepo 结构

[pnpm-workspace.yaml](file:///pnpm-workspace.yaml) 配置 `packages/*`，包含两个子包：

- [packages/shared](file:///packages/shared)：跨进程共享包（含独立 vitest.config.ts、tsconfig）
- [packages/tsconfig](file:///packages/tsconfig)：暴露 `base.json` / `node.json` / `web.json` 三个预设

## 5. TypeScript 配置

根 [tsconfig.json](file:///tsconfig.json) 是 solution-style 配置，无 `compilerOptions`，通过 `references` 编排 5 个子项目：

```
references: packages/tsconfig, packages/shared, src/main, src/preload, src/renderer
```

严格模式集中在 [packages/tsconfig/base.json](file:///packages/tsconfig/base.json)：

- `target`: `ES2024`
- `module`: `ESNext`
- `moduleResolution`: `bundler`
- `lib`: `["ES2024", "ES2022.Error", "DOM"]`
- `strict`: `true`

特殊严格选项（全部开启）：

- `noUncheckedIndexedAccess`
- `noImplicitOverride`
- `noFallthroughCasesInSwitch`
- `noUnusedLocals` / `noUnusedParameters`
- `exactOptionalPropertyTypes`
- `verbatimModuleSyntax`
- `isolatedModules` / `isolatedDeclarations`
- `forceConsistentCasingInFileNames`
- `noImplicitReturns`
- `noPropertyAccessFromIndexSignature`
- `noUncheckedSideEffectImports`
- `allowUnreachableCode`: `false`
- `allowUnusedLabels`: `false`

## 6. Vite 构建配置

[electron.vite.config.ts](file:///electron.vite.config.ts) 三入口分别配置：

| 入口 | input | sourcemap | 特殊处理 |
|---|---|---|---|
| main | `src/main/index.ts` | `hidden` | — |
| preload | `src/preload/index.ts` | `hidden` | `output.format: 'cjs'`、`entryFileNames: '[name].cjs'`（sandbox 要求 CJS） |
| renderer | `src/renderer/index.html` | `hidden` | `root: 'src/renderer'`、alias `@` → `src/renderer` |

关键配置：

- **Sourcemap 模式**：`'hidden'`（生成 `.map` 但不写 `sourceMappingURL`，便于 Sentry 上传）
- **renderer 插件**：`@vitejs/plugin-react`（启用 `babel-plugin-react-compiler`）+ `@tailwindcss/vite`（Tailwind v4 官方插件）
- **Sentry plugin**：未集成进 Vite 构建链，source map 通过独立 `sentry-cli` 命令上传

## 7. Biome 配置

[biome.json](file:///biome.json)（schema 2.5.4）：

- **formatter**：space 缩进 2，lineWidth 100，LF 行尾
- **linter**：`recommended` preset + 自定义规则
  - correctness: `noUnusedVariables` error、`noUnusedImports` error、`useExhaustiveDependencies` warn
  - suspicious: `noExplicitAny` error、`noConsole` warn
  - style: `useImportType` error、`useNamingConvention` error、`useConst` error、`noDefaultExport` error
  - complexity: `useLiteralKeys` off
- **javascript formatter**：单引号、分号必加、尾逗号 all、箭头括号 always
- **css parser**：`tailwindDirectives: true`
- **ignore 列表**：`resources/pg`、`release`、`coverage`、`node_modules`、`out`、`dist`、`.codegraph`、`playwright-report`、`playwright-report-electron`、`playwright-report-smoke`、`test-results`、`playwright/.cache`、`docs/design`、`docs/参考项目`、`prototype-v2.html`、`codex-desktop-prototype.design`、`_template`
- **overrides**（22 组）：`src/renderer/**/*.tsx` 关闭 `noDefaultExport`；常量/枚举文件关闭 `useNamingConvention`；AI 服务层 + storage + IPC handler 关闭 `strictCase`；`tests/**`、`e2e/**`、`scripts/**` 关闭 `noConsole`

## 8. 环境变量与配置文件

### .env / .env.example（项目根目录）

[.env.example](file:///.env.example) 提供环境变量模板，[.env](file:///.env) 为实际值：

- `SENTRY_DSN="http://b24f47b022820d979452bf4ef3d43473@127.0.0.1:9000/3"`
- `SENTRY_TRACES_SAMPLE_RATE=1.0`
- `SENTRY_URL` / `SENTRY_ORG` / `SENTRY_PROJECT`
- `SENTRY_AUTH_TOKEN`（仅本地 `.env` 持有，`.env` 已 gitignore；CI 经 `secrets.SENTRY_AUTH_TOKEN` 注入，仓库历史无真实 token）

### sentry.properties

[sentry.properties](file:///sentry.properties)：

- `defaults.url=http://127.0.0.1:9000`
- `defaults.org=sentry`
- `defaults.project=electron`
- 自托管 Sentry v26.6.0

## 9. 关键风险点

1. **Sentry 指向 127.0.0.1:9000**：本地自托管 Sentry，生产环境无法上报
2. **`SENTRY_TRACES_SAMPLE_RATE=1.0`**：100% 采样，生产规模下可能造成服务端压力
3. **`electron-vite 6.0.0-beta.1`**：构建链核心依赖使用 beta 版本，存在稳定性风险
4. **更新服务器地址为占位符**：[electron-builder.yml#L97](file:///electron-builder.yml#L97) `publish.url: https://code-agent.example.com/releases/` 是 example.com 占位域名，`electron-updater` 实际无法工作

## 10. 关键亮点

1. **顶配 TypeScript 严格度**：`base.json` 开启了几乎所有严格选项，远超默认 `strict: true`
2. **Biome v2 统一工具链**：用 Biome 2.5.4 同时替代 ESLint + Prettier，配合 22 组 overrides 精细化放宽命名约定
3. **React 19.2 + React Compiler**：渲染层启用 `babel-plugin-react-compiler`（React 19 官方推荐自动 memoize）
4. **Tailwind v4 官方 Vite 插件**：弃用 v3 postcss 流程，改用 `@tailwindcss/vite`，与 Vite 8 原生集成
5. **完整 monorepo**：pnpm workspace + 两个内部包，主应用三入口严格分离
6. **preload CJS 输出**：明确注释 sandbox: true 限制，preload 强制 `format: 'cjs'` + `.cjs` 扩展名
7. **原生模块编译管控**：`pnpm.onlyBuiltDependencies` 仅允许 `better-sqlite3`/`esbuild`/`node-pty` 触发 postinstall 编译
