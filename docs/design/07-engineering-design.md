# 07 · 工程化设计文档

> 本文档基于源码梳理 Code Agent 项目的工程化体系，包括 CI/CD、构建、质量门禁、发布管理。
> 所有结论均来自项目实际代码。

## 1. 工程化总览

| 维度 | 实现 |
|------|------|
| 包管理 | pnpm 10 workspace |
| Node 版本 | `>=24.13.0`（engines 强制） |
| 构建 | electron-vite 6.0.0-beta.1 + vite 8 |
| Lint/Format | Biome v2（替代 ESLint + Prettier） |
| 类型检查 | TypeScript 7.0.2 strict mode |
| 单元测试 | vitest 4.0.0 + @vitest/coverage-v8 |
| E2E 测试 | Playwright 1.58（3 套配置） |
| 安全审计 | audit-ci 7.1.0 |
| Git 钩子 | husky 9 + lint-staged 17 + commitlint 21 |
| 打包 | electron-builder 26（NSIS） |
| 错误监控 | @sentry/electron 7.15 |
| 符号上传 | @sentry/cli 2.41 |

## 2. 构建脚本

来自 [package.json#L33-L72](file:///f:/TraeProjects/1/package.json#L33)：

### 2.1 核心构建

| 脚本 | 命令 | 说明 |
|------|------|------|
| `dev` | `electron-vite dev` | 开发模式 |
| `build` | `electron-vite build` | 构建 dev artifacts |
| `preview` | `electron-vite preview` | 预览构建 |
| `build:dist` | `pnpm build && electron-builder --publish never` | 构建 + 打包（不发布） |
| `build:win` | `pnpm build && electron-builder --win --publish never` | Windows NSIS 安装器 |
| `build:win:full` | `pnpm build:win && pnpm sentry:release:new && pnpm sentry:upload:symbols` | 构建 + 创建 Sentry release + 上传符号 |

### 2.2 质量门禁

| 脚本 | 命令 | 说明 |
|------|------|------|
| `typecheck` | `tsc --build` | TypeScript 类型检查 |
| `lint` | `biome check .` | Biome lint + format 检查 |
| `lint:fix` | `biome check --write .` | 自动修复 |
| `format` | `biome format --write .` | 仅格式化 |
| `audit` | `audit-ci --config .nsprc --moderate --high --critical --report-type summary --registry https://registry.npmjs.org` | 依赖安全审计 |

### 2.3 测试

| 脚本 | 命令 |
|------|------|
| `test` | `pnpm -r --filter "@code-agent/*" --filter "!@code-agent/typedoc-docs" run test && pnpm test:main && pnpm test:renderer && pnpm test:scripts` |
| `test:scripts` | `vitest run --root scripts` |
| `test:main` | `vitest run --root src/main` |
| `test:main:watch` | `vitest --root src/main` |
| `test:renderer` | `vitest run --root src/renderer` |
| `test:renderer:watch` | `vitest --root src/renderer` |
| `test:e2e` | `cross-env E2E_MODE=true playwright test --config e2e/playwright.config.ts` |
| `test:e2e:electron` | `playwright test --config e2e/playwright.electron.config.ts` |
| `test:smoke` | `playwright test --config e2e/playwright.smoke.config.ts` |
| `test:visual` | `playwright test --config e2e/playwright.config.ts --grep "视觉回归"` |
| `test:a11y` | `playwright test --config e2e/playwright.config.ts --grep "可访问性"` |
| `test:perf` | `playwright test --config e2e/playwright.config.ts --grep "性能基准"` |
| `test:coverage` | `pnpm --filter "@code-agent/shared" exec vitest run --coverage && pnpm test:main -- --coverage && pnpm test:renderer -- --coverage` |

### 2.4 Sentry

| 脚本 | 命令 |
|------|------|
| `sentry:upload:symbols` | `sentry-cli sourcemaps upload --org sentry --project electron --release "code-agent@1.0.0" --url-prefix "app:///out/" ./out && sentry-cli sourcemaps upload --org sentry --project electron --release "code-agent@1.0.0" --url-prefix "app:///renderer/" ./out/renderer` |
| `sentry:release:new` | `sentry-cli releases new "code-agent@1.0.0"` |

### 2.5 其他

| 脚本 | 命令 | 说明 |
|------|------|------|
| `knip` | `knip --include files,dependencies,devDependencies,binaries` | 死代码检测 |
| `depcruise` | `pnpm --filter @code-agent/depcruise run check` | 依赖循环检测 |
| `changelog` | `tsx scripts/changelog/changelog-gen.ts` | changelog 生成 |
| `codegraph:sync` | `codegraph sync` | 同步 CodeGraph 索引 |
| `scaffold:ipc` | `tsx scripts/scaffold/scaffold-ipc.ts` | IPC 脚手架 |
| `scaffold:tool` | `tsx scripts/scaffold/scaffold-tool.ts` | 工具脚手架 |
| `changeset` | `changeset` | 创建 changeset |
| `version:packages` | `changeset version` | 应用 changeset 版本 |
| `analyze:bundle` | `cross-env ANALYZE_BUNDLE=1 pnpm build` | bundle 体积分析 |
| `docs:types` | `pnpm --filter @code-agent/typedoc-docs run gen` | 类型文档生成 |
| `postinstall` | `node scripts/postinstall-rebuild.mjs` | 安装后 native 模块重编译 |
| `prepare` | `husky` | 安装 git 钩子 |

## 3. CI 流水线

源码：[.github/workflows/ci.yml](file:///f:/TraeProjects/1/.github/workflows/ci.yml)。

### 3.1 触发条件

```yaml
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  workflow_dispatch:
```

### 3.2 并发控制

```yaml
concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
```

同分支新 push 取消旧 run，节省 CI 时间。

### 3.3 4 Job 矩阵

| Job | Runner | Timeout | 内容 |
|-----|--------|---------|------|
| **quality** | ubuntu-latest | 10min | typecheck / lint / unit test / audit / upload coverage |
| **e2e-browser** | ubuntu-latest | 20min | `playwright install chromium` + `test:e2e` |
| **e2e-electron** | windows-latest | 20min | install Electron binary + `build` + `test:e2e:electron` |
| **smoke-prod** | windows-latest | 30min | `build:win` + `test:smoke` |

### 3.4 关键步骤细节

#### quality job

```yaml
- run: pnpm install --frozen-lockfile
- run: pnpm typecheck
- run: pnpm lint
- run: pnpm test  # shared + main + renderer + scripts
- run: pnpm audit
  continue-on-error: true  # 先警告不阻断（待 .nsprc 白名单稳定后再卡关）
- uses: actions/upload-artifact@v4
  with:
    name: coverage-${{ github.run_id }}
    path: |
      packages/shared/coverage/
      src/main/coverage/
      src/renderer/coverage/
    retention-days: 7
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
2. 公证（notarize）：electron-builder.yml `mac.notarize` 当前为 false；开启需 `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD`（或 `APPLE_TEAM_ID`）Secrets
3. 未签名/未公证版本仅限本地开发分发（macOS Gatekeeper 会拦截）

**Windows 签名**（可选）：Authenticode 证书 → 同一 `CSC_LINK`/`CSC_KEY_PASSWORD` 自动签名
## 4. Release 流水线

源码：[.github/workflows/release.yml](file:///f:/TraeProjects/1/.github/workflows/release.yml)。

### 4.1 触发条件

```yaml
on:
  push:
    tags:
      - 'v*.*.*'
  workflow_dispatch:
```

### 4.2 单 Job 流程

```
1. Checkout (fetch-depth: 0 全部历史，便于生成 changelog)
2. Setup pnpm + Node 24
3. pnpm install --frozen-lockfile
4. Release Gate:
   - pnpm typecheck
   - pnpm lint
   - pnpm test
5. pnpm build:win
   env:
     CSC_LINK: ${{ secrets.CSC_LINK }}         # 代码签名证书（可选）
     CSC_KEY_PASSWORD: ${{ secrets.CSC_KEY_PASSWORD }}
     GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
6. pnpm sentry:upload:symbols  # if: env.SENTRY_AUTH_TOKEN != ''
   env:
     SENTRY_AUTH_TOKEN: ${{ secrets.SENTRY_AUTH_TOKEN }}
7. pnpm exec playwright install --with-deps chromium
8. pnpm test:smoke  # 生产构建 smoke 测试
9. softprops/action-gh-release@v2  # 创建 GitHub Release
   with:
     generate_release_notes: true  # 自动从 commits 生成 changelog
     files: |
       release/*-setup.exe
       release/latest.yml
     draft: false
     prerelease: ${{ contains(github.ref_name, '-') }}  # v0.1.0-beta1 标记为 prerelease
   env:
     GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
10. upload-artifact  # release-${{ github.ref_name }}
    retention-days: 30
```

### 4.3 必需 Secrets

| Secret | 用途 |
|--------|------|
| `SENTRY_AUTH_TOKEN` | Sentry CLI 认证（符号上传） |
| `CSC_LINK` | 代码签名证书链接（可选） |
| `CSC_KEY_PASSWORD` | 代码签名证书密码（可选） |
| `GITHUB_TOKEN` | 自动提供，发布 GitHub Release |

## 5. 构建配置

### 5.1 electron.vite.config.ts

三入口构建：

- main：`src/main/index.ts` → `out/main/index.js`（CJS，preload 兼容）
- preload：`src/preload/index.ts` → `out/preload/index.js`（CJS + sandbox 兼容）
- renderer：`src/renderer/index.html` → `out/renderer/`（ESM）

### 5.2 electron-builder.yml（NSIS 配置要点）

- Windows NSIS 安装器
- 允许自定义安装目录
- electron-updater 配置：私有服务器 `https://code-agent.example.com/releases/`

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

源码：[biome.json](file:///f:/TraeProjects/1/biome.json)。

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

`prepare` 脚本安装钩子（[package.json#L72](file:///f:/TraeProjects/1/package.json#L72)）。

### 7.2 lint-staged

[package.json#L74-L78](file:///f:/TraeProjects/1/package.json#L74)：

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

- engines 强制：`>=24.13.0`
- CI 使用：Node 24
- 已知问题：TRAE IDE 终端注入其 bundled Node 路径，可能与系统 Node 版本不一致（v22 vs v24），但仅影响 IDE 内终端，不影响 CI/外部工具

### 8.2 pnpm

- engines：`>=10.0.0`
- `packageManager: pnpm@10.0.0`
- CI：`pnpm/action-setup@v4`

### 8.3 .env 环境变量

| 变量 | 用途 | 风险 |
|------|------|------|
| `SENTRY_DSN` | Sentry 项目 DSN | 低（公开 DSN） |
| `SENTRY_AUTH_TOKEN` | Sentry CLI 认证 | **高**（硬编码，应改由 CI secrets 注入） |
| `OPENAI_API_KEY`（如有） | LLM provider | 高 |

## 9. Source Map 与符号化

### 9.1 上传流程

```bash
# 上传主进程 + 渲染层 source map
sentry-cli sourcemaps upload \
  --org sentry --project electron \
  --release "code-agent@1.0.0" \
  --url-prefix "app:///out/" ./out

sentry-cli sourcemaps upload \
  --org sentry --project electron \
  --release "code-agent@1.0.0" \
  --url-prefix "app:///renderer/" ./out/renderer
```

### 9.2 Release 创建

```bash
sentry-cli releases new "code-agent@1.0.0"
```

每个版本发布前必须创建 Sentry release 并上传符号，否则错误堆栈无法符号化。

### 9.3 sentry.properties

[sentry.properties](file:///f:/TraeProjects/1/sentry.properties) 配置 sentry-cli 默认 org / project / url。

## 10. CodeGraph 索引同步

### 10.1 工作流规则

每次代码变更后运行 `codegraph sync` 同步索引，保持代码知识图谱最新。

### 10.2 脚本

[package.json#L65](file:///f:/TraeProjects/1/package.json#L65)：

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
| `.env` 硬编码 `SENTRY_AUTH_TOKEN` | 安全风险 | 改由 CI secrets 注入 |
| Lint 失败未修复 | 3 个 lint 格式化错误 | `pnpm lint:fix` |
| 设计文档同步滞后 | 旧文档已删除，新文档已生成 | 持续维护 |
| git 状态大量未提交修改 | 影响回滚 | 整理提交 |

### 11.2 中优先级

| 项 | 说明 |
|----|------|
| `test:bench` 脚本不存在 | 实际只有 `test:perf`（与文档/记忆中提及的不符） |
| service-container.ts 注释漂移 | 注释说"5 个内置工具"，实际 12 个（见 [service-container.ts#L205](file:///f:/TraeProjects/1/src/main/service-container.ts#L205) / L239 / L246）；`tools/index.ts` 文件头注释说"7 个"（[L5](file:///f:/TraeProjects/1/src/main/infra/ai/tools/index.ts#L5)），实际 12 个 |
| 整体覆盖率约 0.13 | 与 vitest 配置阈值 80 差距较大（`test:coverage` 现已包含 renderer） |

### 11.3 低优先级

| 项 | 说明 |
|----|------|
| electron-vite 版本约束 | 项目用 vite ^8，与 electron-vite 5.x 不兼容，需用 `6.0.0-beta.1`，待 6.0.0 stable 发布后升级 |
| audit-ci 白名单稳定后改卡关 | 当前 `continue-on-error: true` |

## 12. 与参考项目的工程化对比

参考项目（位于 `docs/参考项目/`）：qwen-code-main、gemini-cli-main、codex-main、opencode-dev、MiMo-Code-main、cognee-main、cognee-rs-main。

| 维度 | Code Agent | 参考项目常见做法 |
|------|-----------|----------------|
| 构建 | electron-vite + vite 8 | CLI 工具用 tsup / tsc，桌面应用用 electron-vite |
| Lint | Biome v2 | ESLint + Prettier（qwen-code）/ Biome（gemini-cli） |
| 测试 | vitest + Playwright | vitest（主流）/ jest（部分） |
| E2E | Playwright 3 套配置 | 多数 CLI 项目无 Electron E2E |
| 发布 | electron-builder + GitHub Release | CLI 工具用 npm publish |
| 监控 | Sentry + OTel + electron-log | 多数参考项目无远程监控 |
