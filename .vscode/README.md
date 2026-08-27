# .vscode 工程化配置使用手册

本目录全部文件已入库（`.gitignore` 例外放行），团队成员 clone 后打开项目即获得一致的开发环境。

## 目录内容

| 文件 | 作用 |
|---|---|
| `settings.json` | 工作区设置：Biome 唯一格式化器 / TS7 / 排除噪音 / Vitest root / i18n Ally / Tailwind |
| `extensions.json` | 推荐插件清单（打开项目自动提示安装）+ 禁止安装清单 |
| `launch.json` | Electron 主/渲染进程调试配置（F5） |
| `tasks.json` | 常用 pnpm 脚本任务化（Ctrl+Shift+B / 终端→运行任务） |
| `project.code-snippets` | 项目规范代码片段（`rcomp` / `zstore`） |

## 首次上手

1. 打开项目后按提示「安装工作区推荐扩展」（12 个插件）
2. `pnpm install`（postinstall 自动重编译原生模块 ABI）
3. 右下角确认 TypeScript 版本为工作区 7.x（`typescript.tsdk` 已自动指向）
4. `Ctrl+Shift+B` 跑默认构建任务验证链路

## 禁止安装的插件

- **ESLint / Prettier**：lint 与格式化唯一真源是 Biome（`biome.json`），装它们会导致双写冲突（已写入 `unwantedRecommendations`）
- **Error Lens**：与当前 IDE 不兼容
- **electron-vite 官方扩展**：调试走 `launch.json`，避免与自定义配置冗余

## 调试（F5）

| 配置 | 场景 | 前置 |
|---|---|---|
| Electron: 主进程（构建后调试） | 断点打在 `src/main/**/*.ts` | 自动先跑 build 任务 |
| Electron: Attach 主进程（9229） | 性能剖析时附加 | 终端先跑 `pnpm perf:inspect` |
| 渲染进程: Attach Electron 窗口 | 断点打在渲染层源码 | `pnpm dev` 窗口运行中（CDP 9222） |
| 渲染进程: web 模式（5173） | 纯前端开发（mock window.api） | 自动先起 dev:web 后台任务 |
| Electron: 全栈 | 主进程 + 渲染进程同时调试 | compound 自动编排 |

注意：E2E Electron 测试用独立调试端口（`CODE_AGENT_DEBUG_PORT`），与 dev 的 9222 互不争抢。

## 任务（终端 → 运行任务）

- 默认构建任务（Ctrl+Shift+B）：`build`
- 后台常驻：`dev` / `dev:web` / `typecheck:watch` / `test:main (watch)` / `test:renderer (watch)`（带就绪探测 matcher）
- 质量门禁顺序对齐 CI：`typecheck` → `lint` → `check:static` → `test` → `knip`
- 覆盖率可视化：跑 `pnpm test:coverage` 后点状态栏 Coverage Gutters 的 Watch，行级覆盖直接显示在 gutter（自动从当前文件向上查找对应 root 的 `coverage/lcov.info`）

## 代码片段

| 前缀 | 文件类型 | 生成内容 |
|---|---|---|
| `rcomp` | `.tsx` | 组件骨架：named export + readonly props + useTranslation + cn + 文件头注释 |
| `zstore` | `.ts` | transient store 骨架：readonly state 接口 + create + 文件头注释 |

IPC / AI Tool 骨架不用 snippet——跑 `pnpm scaffold:ipc` / `pnpm scaffold:tool`，全链路注册（meta + definitions + handler）一步到位。

## 性能设计说明

- `files.watcherExclude`：排除 node_modules/out/release/.tmp/.electron-user-data/coverage/playwright 产物等 18 个噪音目录（Windows 下 watcher 是卡顿主因）
- `search.exclude` + `files.exclude`：搜索与资源管理器均不触碰生成产物
- TS CodeLens 默认关闭（大仓库语言服务性能），按需手动查引用
- Vitest Explorer 通过 `vitest.rootConfig` 显式声明 4 个 root，避免全仓扫描

## 常见问题

- **原生模块 ABI**（better-sqlite3 / node-pty）：Electron 44 与 Node 24 同 ABI（modules=137），无需切换（rebuild:native:* 脚本已删，2026-08）
- **9222 端口被占**：`$env:CODE_AGENT_DEBUG_PORT="9224"; pnpm dev`
- **i18n 缺失 key 标红**：门禁 `pnpm check:i18n` 同款规则，补 `src/renderer/i18n/locales/` 对应命名空间
