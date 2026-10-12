# 07 · 工程化设计文档

> 本文档基于源码梳理 Code Agent 项目的工程化体系，包括 CI/CD、构建、质量门禁、发布管理。
> 所有结论均来自项目实际代码。

## 1. 工程化总览

| 维度 | 实现 |
|------|------|
| 包管理 | pnpm 12 workspace |
| Node 版本 | `>=26.0.0`（engines 强制） |
| 构建 | electron-vite 6.0.0-beta.1 + vite 8 |
| Lint/Format | Biome v2（替代 ESLint + Prettier） |
| 类型检查 | TypeScript 7.0.2 strict mode |
| 单元测试 | vitest 5.0.3 + @vitest/coverage-v8 |
| E2E 测试 | Playwright 1.64（3 套配置） |
| 安全审计 | audit-ci 7.1.0 |
| Git 钩子 | husky 9 + lint-staged 17 + commitlint 21 |
| 打包 | electron-builder 26（NSIS） |
| 错误处理 | error-report 单一出口落本地日志（Sentry 已于 2026-09-13 移除，见 §2.4） |

## 2. 构建脚本

来自 [package.json](file:///package.json)：

### 2.1 核心构建

| 脚本 | 命令 | 说明 |
|------|------|------|
| `dev` | `electron-vite dev -w` | 开发模式（watch） |
| `build` | `electron-vite build` | 构建 dev artifacts |
| `preview` | `electron-vite preview` | 预览构建 |
| `build:dist` | `pnpm prepare:build-info && pnpm prepare:memory-hub && pnpm prepare:codegraph && pnpm build && electron-builder --publish never` | 构建 + 打包（不发布） |
| `build:win` | `pnpm prepare:build-info && pnpm prepare:memory-hub && pnpm prepare:codegraph && pnpm build && electron-builder --win --x64 --arm64 --publish never` | Windows NSIS 安装器（x64 + arm64） |

另有 `build:mac` / `build:linux`（同样带三个 prepare 步骤，分别用 `--mac` / `--linux`，各自 x64 + arm64），
以及单架构变体 `build:{win,mac,linux}:{x64,arm64}`（2026-09-20 多架构发布改造后新增）。
以上均遵循 `build:win` 的形态，故不逐条列表——**本表约定一行只写一个脚本**，
以便 `scripts/check-docs-scripts.ts` 能逐行与 `package.json` 比对。

### 2.2 质量门禁

| 脚本 | 命令 | 说明 |
|------|------|------|
| `typecheck` | `tsc --build && tsc -p scripts/tsconfig.json` | TypeScript 类型检查（含 scripts/，2026-09-22 起） |
| `lint` | `biome check .` | Biome lint + format 检查 |
| `lint:fix` | `biome check --write .` | 自动修复 |
| `format` | `biome format --write .` | 仅格式化 |
| `audit` | `audit-ci --config .nsprc --moderate --high --critical --report-type summary --registry https://registry.npmjs.org` | 依赖安全审计 |

### 2.3 测试

| 脚本 | 命令 |
|------|------|
| `test` | `pnpm -r --filter "@code-agent/*" --filter "!@code-agent/typedoc-docs" run test && pnpm test:main && pnpm test:renderer && pnpm test:integration && pnpm test:scripts` |
| `test:scripts` | `vitest run --root scripts` |
| `test:main` | `vitest run --root src/main --silent=passed-only` |
| `test:main:watch` | `vitest --root src/main` |
| `test:renderer` | `vitest run --root src/renderer --silent=passed-only` |
| `test:renderer:watch` | `vitest --root src/renderer` |
| `test:e2e` | `cross-env E2E_MODE=true playwright test --config e2e/playwright.config.ts` |
| `test:e2e:electron` | `playwright test --config e2e/playwright.electron.config.ts` |
| `test:smoke` | `playwright test --config e2e/playwright.smoke.config.ts` |
| `test:visual` | `playwright test --config e2e/playwright.config.ts --grep "视觉回归"` |
| `test:a11y` | `playwright test --config e2e/playwright.config.ts --grep "可访问性"` |
| `test:perf` | `playwright test --config e2e/playwright.config.ts --grep "性能基准\|渲染性能基准\|内存基准\|IPC 基准"` |
| `test:coverage` | `pnpm --filter "@code-agent/shared" exec vitest run --coverage && pnpm test:main --coverage && pnpm test:renderer --coverage && pnpm coverage:settings` |

### 2.4 错误处理（Sentry 已移除）

2026-09-13 起**移除 Sentry**，改为**本地优先**错误处理：所有异常经
`utils/error-report.ts`（main）/ `lib/error-report.ts`（renderer）单一出口落本地日志
（渲染层经 electron-log 转发主进程，随诊断包导出），报障走 GitHub Issue 深链。
因此**不存在 `sentry:*` 脚本，也没有符号上传环节**（此前本节记录的
`sentry:release:new` / `sentry:upload:symbols` 已随移除一并删除）。

### 2.5 其他

| 脚本 | 命令 | 说明 |
|------|------|------|
| `knip` | `knip --include files,dependencies,devDependencies,binaries` | 死代码检测 |
| `depcruise` | `pnpm --filter @code-agent/depcruise run check` | 依赖循环检测 |
| `codegraph:sync` | `codegraph sync` | 同步 CodeGraph 索引 |
| `scaffold:ipc` | `tsx scripts/scaffold/scaffold-ipc.ts` | IPC 脚手架 |
| `scaffold:tool` | `tsx scripts/scaffold/scaffold-tool.ts` | 工具脚手架 |
| `analyze:bundle` | `cross-env ANALYZE_BUNDLE=1 pnpm build` | bundle 体积分析 |
| `docs:types` | `pnpm --filter @code-agent/typedoc-docs run gen` | 类型文档生成 |
| `postinstall` | `node scripts/postinstall-rebuild.mjs` | 安装后 native 模块重编译 |
| `prepare` | `husky` | 安装 git 钩子 |
| `coverage:settings` | `tsx scripts/measure-settings-coverage.ts` | settings 子集覆盖率聚合回填（renderer-settings 层真源，test:coverage 链尾自动执行） |

## 3. CI 流水线

源码：[.github/workflows/ci.yml](file:///.github/workflows/ci.yml)。

### 3.1 触发条件

```yaml
on:
  pull_request:
    branches: [main]
  merge_group: # merge queue 队列树把关（2026-10-07 接入）
  workflow_dispatch: # 允许手动触发（便于调试）
```

**由 PR 与 merge_group 触发，不再 push: main**（2026-09-10 方案二「CI on PR, CD on main」；2026-10-07 接入 merge queue 后增加 merge_group 监听，必需检查改在队列树上把关）：ruleset 强制 main 所有提交走 PR 且 PR 必含 main 最新提交（squash/rebase 合入树与 PR head 一致）⇒ 必需检查在合并前已对相同内容跑过，push 阶段重复无增益。合并后 main 仍有 CodeQL + secret scanning（GitHub 托管）。详细依据见 `docs/implementation/29-pipeline-spec.md`。

### 3.2 并发控制

```yaml
concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
```

同分支新 push 取消旧 run，节省 CI 时间。

### 3.3 Job 矩阵（2026-09-20 六平台改造后）

| Job | Runner | Timeout | 内容 |
|-----|--------|---------|------|
| **quality** | ubuntu-latest | 10min | typecheck / lint / gitleaks / check:static / tokens:check / knip / depcruise / schema 漂移 / test:scripts / audit（+ 润色门禁与发版门禁，仅 Release PR） |
| **unit** | 6 平台矩阵 | 20min | 各平台原生单测（`test:main` + `test:renderer`）；ubuntu 实例改跑 `test:coverage`（阈值唯一把关点） |
| **unit-summary** | ubuntu-latest | 5min | 汇总 unit 矩阵（`if: always()`，ruleset 稳定名） |
| **integration-tests** | ubuntu-latest | 10min | `test:integration`（tests/integration/） |
| **e2e-browser** | ubuntu-latest | 20min | `playwright install --with-deps chromium` + `test:e2e` |
| **e2e-electron** | 6 平台矩阵 | 20min | 装 Electron 二进制 → `build` → `check:bundle` → `check:compiler` → `test:e2e:electron` |
| **e2e-electron-summary** | ubuntu-latest | 5min | 汇总 e2e-electron 矩阵（`if: always()`，ruleset 稳定名） |

（smoke-prod 与原 package job 已移除：生产产物验证统一交给 CD 的 release.yml。）

### 3.4 关键步骤细节

#### quality job（Release PR 上 ①-⑩ 全跳，仅跑润色门禁 + 发版门禁）

```yaml
- run: pnpm install --frozen-lockfile
- run: pnpm typecheck
- run: pnpm lint
- run: pnpm check:static
- run: pnpm tokens:check
- run: pnpm knip
- run: pnpm depcruise
- run: pnpm check:schema-drift
- run: pnpm test:scripts      # 门禁脚本自身单测，与平台无关
- run: pnpm run audit         # audit-ci，moderate 起卡关（2026-08-30 收紧）
# 仅 Release PR 分支（if: startsWith(github.head_ref, 'release-please--')）：
- run: pnpm check:changelog-polish
- run: pnpm check:release-pr-scope --branch "$HEAD_REF" && pnpm check:release-anchor
```

#### e2e-electron job

需手动安装 Electron binary：

```yaml
- run: node node_modules/electron/install.js
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```


### 4.0 三平台发布（2026-08-11 起）

- release.yml 三平台矩阵：Windows NSIS x64 / macOS dmg+zip（x64+arm64）/ Linux AppImage+deb x64
- 各平台 runner 构建 + 独立 release job 合并上传 GitHub Release

**macOS 公证与签名**（正式发布必需）：
1. Apple Developer 证书（Developer ID Application）→ 配置 CI Secrets：`CSC_LINK`（.p12 base64）+ `CSC_KEY_PASSWORD`
2. 公证（notarize）：electron-builder.yml `mac.notarize: true`（2026-09-14 启用）——提供了公证凭据就执行公证，
   未提供时 electron-builder 仅 warn 跳过（本地/无证书 CI 构建照常通过）。凭据三选一（CI Secrets）：
   `APPLE_API_KEY` + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER`（推荐）或 `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`
3. 未签名/未公证版本仅限本地开发分发（macOS Gatekeeper 会拦截）

**Windows 签名**（可选）：Authenticode 证书 → 同一 `CSC_LINK`/`CSC_KEY_PASSWORD` 自动签名
## 4. Release 流水线（CD）

源码：[.github/workflows/release.yml](file:///.github/workflows/release.yml)。

### 4.1 触发条件

```yaml
on:
  push:
    branches: [main]   # Release PR（release-please 生成）合并产生的 push
  workflow_dispatch:
    inputs:
      confirm_version: # 手动重放防误触发：必须与 package.json 版本一致，gate 校验不符即拒绝
        required: true
        type: string
```

**tag 由工作流创建，不是触发条件**（2026-09-10 流程改造的核心语义）：三平台构建全部成功后，
release job 才打 tag `vX.Y.Z` 并创建 draft Release——任一环节失败则无 tag 无 release，
版本号不占号、可重试。

### 4.2 Job 流程（5 个 job）

```
gate     → 识别本次 push 是否 release-please 的发布提交（chore(main): release X.Y.Z），
           提取版本号 + 发布提交 SHA（tag 锚点）；附带 CHANGELOG 润色兜底检查。
           非发布 push → 后续 job 全部跳过。
build    → 6 个单架构 job（Windows/macOS/Linux × x64/arm64，全部原生 runner）：打包
           + SBOM 生成 + check:packaged-engine + check:native-arch + 生产 smoke 测试
           + 产物上传（安装包/blockmap/latest*.yml/SBOM，artifact 名带架构后缀）
merge    → 把 Windows/macOS 各自产出的双份同名更新元数据合并为双架构一份
           （latest.yml / latest-mac.yml；Linux 按架构天然分文件，不参与合并）
release  → 三平台构建全部成功后：打 tag（钉在 gate 找出的发布提交上）→ 创建 draft Release
           → 把 release PR 的 label 从 autorelease: pending 改为 tagged（代 release-please 收尾，
           防下次发版静默死锁）
publish  → 校验三平台安装包 + latest*.yml 齐全（含双架构条目断言、差分 blockmap 门禁）
           → draft 转正式；缺任一项保持草稿
```

### 4.3 必需 Secrets

| Secret | 用途 |
|--------|------|
| `CSC_LINK` / `CSC_KEY_PASSWORD` | 代码签名证书（可选；未配置时干净跳过签名） |
| `APPLE_API_KEY` / `APPLE_API_KEY_ID` / `APPLE_API_ISSUER` | macOS 公证凭据（App Store Connect API Key 模式，三件套齐备才导出） |
| `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` | macOS 公证凭据（Apple ID 模式回退，与上者二选一） |
| `GITHUB_TOKEN` | 自动提供：打 tag / 创建 Release / label 回写 |

## 5. 构建配置

### 5.1 electron.vite.config.ts

三入口构建：

- main：`src/main/index.ts` → `out/main/index.js`（CJS，preload 兼容）
- preload：`src/preload/index.ts` → `out/preload/index.js`（CJS + sandbox 兼容）
- renderer：`src/renderer/index.html` → `out/renderer/`（ESM）

### 5.2 electron-builder.yml（NSIS 配置要点）

- Windows NSIS 安装器
- 允许自定义安装目录
- electron-updater 配置：GitHub Releases（`provider: github`，electron-builder.yml publish）+ release.yml 上传 `latest*.yml` 元数据

## 6. 代码质量门禁

### 6.1 TypeScript 严格配置

tsconfig 启用以下严格选项：

- `strict: true`
- `noImplicitReturns`
- `noPropertyAccessFromIndexSignature`
- `noUncheckedSideEffectImports`
- `allowUnreachableCode: false`
- `allowUnusedLabels: false`
- `exactOptionalPropertyTypes`
- `lib`：包含 `ES2022.Error` + `DOM`（支持 `Error.cause`）

### 6.2 Biome 配置

源码：[biome.json](file:///biome.json)。

22 组 overrides 精细化命名约定，主要分类：

- `src/renderer/**/*.tsx`：关闭 `noDefaultExport`（React 组件默认导出）
- 常量/枚举文件（errors / pg-versions / age / enums / channels / agent-events / constants）：关闭 `useNamingConvention`
- AI 服务层 + storage + IPC handler：关闭 `strictCase`（保留 AI SDK / drizzle 官方 API 命名）
- `src/main/**/*.test.ts`：关闭 `strictCase`（测试文件宽松）
- `tests/integration/**` / `e2e/**` / `scripts/**`：关闭 `noConsole`
- `e2e/**`：关闭 `useNamingConvention`（Playwright API 命名）
- 配置文件（commitlint / drizzle / prisma / playwright）：关闭 `noDefaultExport`

### 6.3 依赖审计白名单

`.nsprc` 配置允许的已知漏洞列表，CI 中 `pnpm audit` `continue-on-error: true`，先警告不阻断。

## 7. Git 钩子

### 7.1 husky

`prepare` 脚本安装钩子（[package.json](file:///package.json)）。

### 7.2 lint-staged

[package.json](file:///package.json)：

```json
"lint-staged": {
  "*.{js,ts,cjs,mjs,d.cts,d.mts,jsx,tsx,json,jsonc,css}": [
    "biome check --write --no-errors-on-unmatched"
  ]
}
```

提交前自动 Biome 检查 + 修复。

### 7.3 commitlint

- `@commitlint/cli@^21.2.1`
- `@commitlint/config-conventional@^21.2.0`
- 强制 Conventional Commits 规范（feat / fix / chore / docs / refactor 等）

## 8. 环境管理

### 8.1 Node 版本

- engines 强制：`>=26.0.0`
- CI 使用：Node 26
- 已知问题：TRAE IDE 终端注入其 bundled Node 路径，可能与系统 Node 版本不一致（v22 vs v26），但仅影响 IDE 内终端，不影响 CI/外部工具

### 8.2 pnpm

- engines：`>=12.0.0`
- `packageManager: pnpm@12.10.1`
- CI：`pnpm/action-setup@v4`

### 8.3 .env 环境变量

| 变量 | 用途 | 风险 |
|------|------|------|
| `OPENAI_API_KEY`（如有） | LLM provider | 高 |

## 9. Source Map 策略

- 三入口统一 `sourcemap: 'hidden'`（electron.vite.config.ts）：生成 `.map` 文件但不写
  `sourceMappingURL` 注释（产物不暴露映射入口）
- `.map` 不入安装包：electron-builder.yml `files` 排除 `**/*.map`（源码不随包分发，
  实测 map 占 asar 约 24%）；构建机 `out/` 保留供本地排障
- 无云端符号上传：Sentry 已于 2026-09-13 移除（见 §2.4），错误堆栈经
  error-report.ts 落本地日志，随诊断包导出

## 10. CodeGraph 索引同步

### 10.1 工作流规则

每次代码变更后运行 `codegraph sync` 同步索引，保持代码知识图谱最新。

### 10.2 脚本

[package.json](file:///package.json)：

```json
"codegraph:sync": "codegraph sync"
```

### 10.3 CodeGraph 依赖

- 外部工具：`@colbymchenry/codegraph` v0.9.8，用户级 npm 全局安装
- 项目内通过 CLI 调用，不在 package.json dependencies 中
- 初始化：`codegraph init -i` 构建索引
- 服务：`codegraph serve --mcp`（stdio transport）

## 11. 已知工程化债务

### 11.1 高优先级

| 项 | 说明 | 建议 |
|----|------|------|
| ~~`.env` 硬编码 `SENTRY_AUTH_TOKEN`~~ | ~~安全风险~~ | 已解决：`.env` gitignore 未入仓，历史无真实 token；Sentry 已整体移除，该 Secret 已不复存在 |
| Lint 失败未修复 | 3 个 lint 格式化错误 | `pnpm lint:fix` |
| 设计文档同步滞后 | 旧文档已删除，新文档已生成 | 持续维护 |
| git 状态大量未提交修改 | 影响回滚 | 整理提交 |

### 11.2 中优先级

| 项 | 说明 |
|----|------|
| `test:bench` 脚本不存在 | 实际只有 `test:perf`（与文档/记忆中提及的不符） |
| service-container.ts 注释漂移 | 注释说"5 个内置工具"，实际 12 个（见 [service-container.ts#L205](file:///src/main/service-container.ts) / L239 / L246）；`tools/index.ts` 文件头注释说"7 个"（[L5](file:///src/main/infra/ai/tools/index.ts)），实际 12 个 |
| 整体覆盖率约 0.13 | 与 vitest 配置阈值 80 差距较大（`test:coverage` 现已包含 renderer） |

### 11.3 低优先级

| 项 | 说明 |
|----|------|
| electron-vite 版本约束 | 项目用 vite ^8，与 electron-vite 5.x 不兼容，需用 `6.0.0-beta.1`，待 6.0.0 stable 发布后升级 |
| audit-ci 白名单稳定后改卡关 | ~~当前 `continue-on-error: true`~~ 已完成（2026-08-30 收紧为卡关，ci.yml `Dependency audit` 步骤无 continue-on-error） |

## 12. 与参考项目的工程化对比

参考项目：qwen-code、gemini-cli、codex、opencode、MiMo-Code、cognee、cognee-rs、electron-shadcn 共 8 个公开仓库（本地副本已于 2026-08-30 清理，需要时从 GitHub 重新 clone）。

| 维度 | Code Agent | 参考项目常见做法 |
|------|-----------|----------------|
| 构建 | electron-vite + vite 8 | CLI 工具用 tsup / tsc，桌面应用用 electron-vite |
| Lint | Biome v2 | ESLint + Prettier（qwen-code）/ Biome（gemini-cli） |
| 测试 | vitest + Playwright | vitest（主流）/ jest（部分） |
| E2E | Playwright 3 套配置 | 多数 CLI 项目无 Electron E2E |
| 发布 | electron-builder + GitHub Release | CLI 工具用 npm publish |
| 监控 | OTel（可选外发）+ electron-log 本地日志 | 多数参考项目无结构化遥测 |

---

# 附录：运行方式与质量门禁实操（自 code-wiki 09 合并，2026-10-12）

> 门禁与命令的实然细节（含原生模块 ABI、Git 对象库损坏恢复 runbook），与上文工程纪律互补。

## 1. 环境要求

| 项 | 要求 |
|---|---|
| Node.js | `>=26.0.0`（`engines`）；IDE 终端可能注入自带 Node 导致版本不符，属环境限制，系统 Node 正确安装即可 |
| pnpm | `>=12.0.0`（`packageManager: pnpm@12.10.1`；**构建脚本决策在 `pnpm-workspace.yaml` 的 `allowBuilds`**——pnpm 11 起不再读 `package.json#pnpm.onlyBuiltDependencies`） |
| 原生模块 | better-sqlite3 / esbuild / node-pty 等（allowBuilds 放行编译；postinstall 走 `scripts/postinstall-rebuild.mjs`） |

## 2. 安装与启动

```bash
pnpm install            # 安装依赖 + 原生模块编译 + postinstall-rebuild
cp .env.example .env    # 可选：供应商 baseURL 等默认值（API Key 走应用内 safeStorage，不经 .env）
pnpm dev                # electron-vite dev -w
```

- `pnpm dev`：启动 dev server + Electron 窗口；dev 下 userData 重定向到 `.electron-user-data/`、CDP 端口 9222。
- `pnpm dev:web`：纯浏览器渲染（Vite web mode，配合前端 mock 层独立开发）。

## 3. 质量门禁（按顺序执行）

一条命令跑完全部质量层（与 CI quality job 的检查项对齐，约 4.5 分钟）：

```bash
pnpm verify:local        # 质量层
pnpm verify:local:full   # 追加产物层（构建/体积/编译/E2E/打包/引擎与架构断言/smoke）
```

拆开则是（`verify:local` 即按此顺序执行）：

```bash
pnpm check:secrets-git    # 密钥扫描（gitleaks git，扫 <远端 main>..HEAD）
pnpm typecheck            # tsc --build + tsc -p scripts/tsconfig.json（0 错误；不要用 --noEmit）
pnpm lint                 # biome check .（0 问题）
pnpm check:static         # 静态审计 16 项（tokens/i18n/comments/tsdoc/文件大小/函数/复杂度/覆盖率下限/docs/docs-scripts/test-boundary/csp-hash/css-vars/animations/ui-consistency/memory-engine:integrity）
pnpm tokens:check         # 令牌生成物一致性（tokens/aurora.json ↔ tokens.css）
pnpm knip                 # 未使用依赖/文件检测
pnpm depcruise            # 依赖方向与环检测（dependency-cruiser）
pnpm check:schema-drift   # schema.ts ↔ drizzle/ 迁移漂移 + 快照链
pnpm audit:registry       # pnpm audit --audit-level=moderate（npm 官方源）
pnpm test                 # shared → main → renderer 全部单元测试 + integration + scripts
```

> 2026-09-22 起，`tokens:check` 与 `check:schema-drift` 的判据是「重新生成前后是否一致」
> （而非对比 HEAD）——因此「改了源、已重新生成、尚未提交」不会误报，可安全用于开发中途。

## 4. 测试体系

### 4.1 单元（Vitest）

```bash
pnpm test:main        # vitest --root src/main（2026-09-30 实测 2135 用例）
pnpm test:renderer    # vitest --root src/renderer（实测 1845 用例）
pnpm test:scripts     # vitest --root scripts（实测 364）
pnpm test:integration # vitest --root tests/integration（实测 152）
pnpm test:coverage    # 覆盖率（下限棘轮，数字真源 scripts/coverage-floors.json）
```

- `pnpm test` 全链：packages(shared) → main → renderer → integration → scripts（任一层失败即中断）。
- 原生模块 ABI：Electron 44 内嵌 Node 24.21.0，Electron ABI（NODE_MODULE_VERSION）=**149**；dev/CI Node 26 线（26.8.1）ABI=**147**——两者**不同构**（2026-10-12 实测：`ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron -p process.versions.modules`）。postinstall 每次安装强制 `@electron/rebuild` 重编 better-sqlite3/node-pty 为 Electron ABI（失败仅告警不阻断，`SKIP_ELECTRON_REBUILD=1` 跳过）；ABI 数值如再漂移以同命令实测为准。

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
pnpm build:dist            # 构建 + electron-builder 全平台 --publish never
pnpm build:win             # 构建 + NSIS 安装包（x64 + arm64；含 prepare:memory-hub/codegraph）
pnpm build:mac / linux     # 对应平台包（各自 x64 + arm64）
pnpm build:all             # 全平台（electron-builder --publish never）
pnpm build:win:x64         # 单架构变体（build:{win,mac,linux}:{x64,arm64} 六变体齐备）
pnpm analyze:bundle        # 包体积分析（rollup-plugin-visualizer → stats/renderer-bundle.html）
```

> 打包脚本先跑三个 prepare：`prepare:build-info`（构建信息注入）→ `prepare:memory-hub`（记忆引擎运行目录）→ `prepare:codegraph`（按架构部署二进制——supportedArchitectures 双架构安装的配套）。

发布配置：`electron-builder.yml`（github provider，GitHub Releases 为更新源）。
CI/CD：`.github/workflows/ci.yml` 为 **5 个必需检查 job**（quality / unit 六平台矩阵 /
integration-tests / e2e-browser / e2e-electron 六平台矩阵，另有 2 个 summary job 暴露稳定名）；
**Release PR（release-please-- 前缀分支）跳过四个重 job 只跑 quality**（2026-10-01：其内容 =
来源 PR 已全绿验证的代码 + 版本号 + CHANGELOG，零新增可测面；job 级 if 跳过，被跳过的
必需检查按 GitHub 语义视为成功；润色门禁在 quality 中不跳）；
`release.yml` 为 **6 个单架构 build job**（win/mac/linux × x64/arm64）→ merge 更新元数据 →
release 打 tag → publish 转正式。打包验证不在 CI（PR 阶段），统一交给 CD（详见 29 号）。

> 错误处理已本地化（2026-09-13 移除 Sentry）：异常经 `utils/error-report.ts`（main）/ `lib/error-report.ts`（renderer）
> 落本地日志，随诊断包导出，报障走 GitHub Issue 深链；无符号上传环节。

## 6. 工程纪律要点

- **每次代码改动同步 CodeGraph 索引**：pre-commit 钩子内自动 `codegraph sync`（60s 超时容错，`SKIP_CODEGRAPH_SYNC=1` 跳过）。
- **每次实现轮次做 git commit**（`gh` / 常规 commit；commitlint conventional 规范 + husky 钩子）。钩子分工：`pre-commit` 跑 gitleaks 暂存区扫描 + lint-staged 自动修复 + codegraph sync；`commit-msg` 跑 commitlint + `check-commit-msg` 双 type 标题拦截（双 type 会静默阻断 release-please 发版通道，2026-09-20 实证）；`pre-push` **仅**密钥扫描（`gitleaks git` 扫待推送区间，约 1.5 秒，未安装即失败），其余检查交 CI / `pnpm verify:local`。
- **前端 mock 层保留**：渲染层 `dev/mock-api.ts`（浏览器 dev 模式走 IPC mock），前端可独立开发（不用 MSW，见 19 号 / renderer-spec）。
- **原生模块双环境**：Electron 运行时 ABI（44.7.0=149，内嵌 Node 24.21.0）与 Node 测试环境（26.8.1=147）**不同构**；postinstall 每次 install 强制按 Electron ABI 重编 better-sqlite3/node-pty（失败仅告警；`SKIP_ELECTRON_REBUILD=1` 跳过）。
- **CSS 令牌**：改令牌改 `tokens/aurora.json`（`pnpm tokens:build` 生成），禁止手改 `tokens.css`——生成物一致性由 `tokens:check` 卡关，设计令牌用法由 `check:tokens` 卡关。
- **i18n**：新增 key 需补全 en/zh-CN 两组（`check:i18n --strict` 卡缺失/冗余/双语不一致/JSX 硬编码中文）。
- **版本/CHANGELOG**：由 release-please 自动化（`.github/workflows/release-please.yml`），push main 开 Release PR；**合并 Release PR 不打 tag**——tag 与 Release 由 release.yml 在三平台构建全部成功后创建（防空版本占号，详见 RELEASING.md）。

## 7. 快速定位命令

| 意图 | 命令 |
|---|---|
| 只看主进程单测 | `pnpm test:main` |
| 只看渲染层单测 | `pnpm test:renderer` |
| 跑真实窗口 E2E | `pnpm test:e2e:electron` |
| 深度调试主进程 | `pnpm perf:inspect`（electron --inspect=9229） |
| 检查未用代码 | `pnpm knip` |
| 生成类型文档 | `pnpm docs:types`（@code-agent/typedoc-docs） |

## 8. Git 对象库损坏的识别与恢复

> 依据 2026-09-22 实发事故（提交时被中断的 `gc --auto` 重打包导致对象库散点式丢失，
> 影响 `28afb81` / `2059fcd` / `3e8b1f6` 等提交）。**远端始终是权威副本，恢复的前提是它完好。**

### 8.1 症状识别

| 症状 | 含义 |
|---|---|
| `git log` 报 `your current branch 'X' does not have any commits yet` | HEAD 指向的 ref 文件丢失 ⇒ unborn |
| `git cat-file -t <sha>` 报 `could not get object info` | 该对象缺失 |
| `git commit` 报 `failed to write commit-graph` / `unable to read tree <sha>` | 提交被维护任务中止 |
| `git fetch` 报 `unresolved deltas left after unpacking` | 本地缺的正是增量包的基线对象 |

**首要动作**：`git rev-parse HEAD` + `git log --oneline | wc -l` + `git fsck --no-progress`。
先确认「工作区文件是否完好」（`ls` 关键文件）——对象库损坏不影响工作区。

### 8.2 恢复流程（按序执行）

```bash
# ① 确认远端完好（权威副本）
git ls-remote origin | head

# ② 强制全量重取（--refetch 不假设本地已有哪些对象）
git fetch --refetch origin

# ③ 若 ② 报 "failed to write commit-graph"：清掉引用了缺失提交的失效图链，再重试 ②
rm -f .git/objects/info/commit-graphs/commit-graph-chain \
      .git/objects/info/commit-graphs/graph-*.graph

# ④ 关掉会触发重打包的自动维护（本地 config，可逆）
git config gc.auto 0
git config fetch.writeCommitGraph false
git config gc.writeCommitGraph false

# ⑤ ref 丢失时：直接写文件（唯一可靠方式）
mkdir -p .git/refs/heads/<dir>          # 分支名含 / 时
printf '%s\n' "<sha>" > .git/refs/heads/<branch>
# remote-tracking ref 同理写 .git/refs/remotes/origin/<branch>
# SHA 来源：tail -1 .git/logs/refs/heads/<branch> | awk '{print $2}'
```

### 8.3 三条硬经验

1. **提交后必须验证 `git rev-parse HEAD` 能解析**。`git commit` 可能打印成功的变更摘要，
   但分支 ref 未落盘——只看提交输出会误判成功。reflog（`.git/logs/`）通常仍有记录，
   可据此取 SHA 重建 ref。

2. **受限环境下 git 自身的 ref 写入按「扁平 / 嵌套」分裂**（2026-09-22 实测，加白名单后复测）：

   | ref 形态 | 例子 | git 自身写入 |
   |---|---|---|
   | 扁平 | `refs/heads/main`、`refs/stash` | ✅ 可用（故 `git stash` / lint-staged 能跑） |
   | 嵌套 | `refs/heads/fix/x`、`refs/remotes/origin/main` | ❌ 返回 0 但**静默不写**（需创建中间目录） |

   因此：`git commit` 在嵌套分支上会丢失 ref、`git fetch` 不会更新 remote-tracking ref，
   而 `mkdir -p` + `printf >` 直接写文件**始终可靠**——这是唯一的稳妥路径。

3. **⚠️ 分支名含 `/` 时禁用 `git update-ref`**。实测
   `git update-ref refs/heads/fix/<新名> HEAD` 不仅不写入，**还会删掉整个 `fix/` 目录**
   （连带删除该目录下已存在的分支 ref）。这不是「写入失败」，而是「破坏性失败」。
   恢复方式同上：`mkdir -p` + `printf`。

### 8.4 受限环境的根因与根治方案

**根因**（2026-09-22 深挖）：git 对嵌套 ref 报

```
fatal: update-ref failed for ref 'refs/heads/aaa/bbb':
  cannot lock ref 'refs/heads/aaa/bbb': unable to resolve reference 'refs/heads/aaa/bbb'
```

即 git **无法在 `.git/refs/heads/<子目录>/` 内创建锁文件**；失败后其清理逻辑会删除该子目录。
逐项排除过：路径不可写（shell 的 `mkdir`/`printf`/`rm` 在同一路径全部正常）、
仓库特有（在受限路径内新建的临时仓库 100% 复现）、git 不能建目录
（`git init` 能创建 `.git/objects/info`、`.git/refs/heads` 等嵌套目录）、
命令未放行（已把 `git update-ref`/`commit`/`fetch` 与项目目录加入白名单）。
⇒ 拦截点在**沙箱对 git 进程「锁文件创建 + rename」类文件操作的策略**，
**只加路径白名单无法解决**。

**根治方案（已验证）：分支改用扁平名**（`fix-residency-defects` 而非 `fix/residency-defects`）。
扁平 ref 在受限环境下**完全正常**：`git branch`、`git update-ref`、`git commit`、
`git push` 的 ref 写入全部成功，无需任何手工修补。迁移方式：

```bash
git branch <flat-name>                    # 从当前 HEAD 建扁平分支
git checkout <flat-name>                  # HEAD 是扁平文件，切换正常
git push -u origin <flat-name>            # 远端建新分支
git branch -D <old/nested-name>           # 删旧本地分支
# 远端旧分支可在 GitHub 上删，或 git push origin --delete <old/nested-name>
```

⚠️ 迁移后 remote-tracking ref（`refs/remotes/origin/<name>`）仍是嵌套路径，
`git push` 不会写入它——需手工 `mkdir -p` + `printf` 补一次（之后 `git fetch` 亦如此）。

### 8.5 索引与树层面的两种故障（2026-09-22 实测）

扁平化分支解决了 ref 写入，但对象库损坏还会以另外两种形式表现出来，**都能让提交
静默产出一个坏结果**，因此提交前后必须校验。

**故障 A：索引引用了已缺失的 blob ⇒ `git stash` / lint-staged 必然失败**

```
$ git stash push -m probe
error: invalid object 100644 <sha> for '<path>'
Cannot save the current index state
```

`git add` **修不了**（git 认为对象已存在，跳过写入），必须逐个强制重写：

```sh
for f in $(git diff --cached --name-only); do git hash-object -w "$f"; done
# 校验（用一次进程；循环调 cat-file 在 1900 文件规模下会超时）
git ls-files -s | awk '{print $2}' | git cat-file --batch-check='%(objecttype)' | grep -c missing
```

**故障 B：被中断的 `git commit` 会写出「部分树」**

`git commit` 从索引的 **cache-tree** 直接复用子树，而 cache-tree 可能引用已缺失的
子树且不做校验 ⇒ commit 成功但树不完整。症状是「看似成功却少了大量文件」：

```sh
git ls-tree -r HEAD --name-only | wc -l   # 实测 652
git ls-files | wc -l                      # 实测 1906 —— 不一致即为坏提交
git diff <parent> HEAD                    # fatal: unable to read tree <sha>
```

修复：`git reset --mixed <上一个完好提交>` 重建索引 → 重新 `git add` → 再提交。

**提交前后固定校验清单**

| 时机 | 命令 | 期望 |
|---|---|---|
| 提交前 | `git ls-files -s \| awk '{print $2}' \| git cat-file --batch-check='%(objecttype)' \| grep -c missing` | `0` |
| 提交后 | `git rev-parse HEAD` | 能解析 |
| 提交后 | `git ls-tree -r HEAD --name-only \| wc -l` vs `git ls-files \| wc -l` | **两者相等** |

**受限环境下的安全提交流程**：① 强制重写暂存 blob（`git hash-object -w`）→
② 手工执行钩子等价步骤（`biome check --write` + `gitleaks git --staged`）→
③ `git commit --no-verify`（lint-staged 因故障 A 不可用；且让提交在数秒内完成，
把「被中断」的窗口压到最小——中断正是故障 B 的成因）→ ④ 按上表校验 →
⑤ `git push` 后补 remote-tracking ref。
