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
| `test:main` | `vitest run --root src/main` |
| `test:main:watch` | `vitest --root src/main` |
| `test:renderer` | `vitest run --root src/renderer` |
| `test:renderer:watch` | `vitest --root src/renderer` |
| `test:e2e` | `cross-env E2E_MODE=true playwright test --config e2e/playwright.config.ts` |
| `test:e2e:electron` | `playwright test --config e2e/playwright.electron.config.ts` |
| `test:smoke` | `playwright test --config e2e/playwright.smoke.config.ts` |
| `test:visual` | `playwright test --config e2e/playwright.config.ts --grep "视觉回归"` |
| `test:a11y` | `playwright test --config e2e/playwright.config.ts --grep "可访问性"` |
| `test:perf` | `playwright test --config e2e/playwright.config.ts --grep "性能基准\|渲染性能基准\|内存基准\|IPC 基准"` |
| `test:coverage` | `pnpm --filter "@code-agent/shared" exec vitest run --coverage && pnpm test:main --coverage && pnpm test:renderer --coverage` |

### 2.4 错误处理（Sentry 已移除）

2026-09-13 起**移除 Sentry**，改为**本地优先**错误处理：所有异常经
`infra/telemetry/error-report.ts`（main）/ `lib/error-report.ts`（renderer）单一出口落本地日志
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

## 3. CI 流水线

源码：[.github/workflows/ci.yml](file:///.github/workflows/ci.yml)。

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
| ~~`.env` 硬编码 `SENTRY_AUTH_TOKEN`~~ | ~~安全风险~~ | 已解决：`.env` gitignore 未入仓，历史无真实 token，CI 走 secrets 注入 |
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
| audit-ci 白名单稳定后改卡关 | 当前 `continue-on-error: true` |

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
