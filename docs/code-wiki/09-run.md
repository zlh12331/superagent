# 09 · 运行方式与质量门禁

> 覆盖：开发环境、构建、测试、发布、工程纪律（typecheck/lint/coverage/CSP 等）。

## 1. 环境要求

| 项 | 要求 |
|---|---|
| Node.js | `>=24.13.0`（`engines`）；TRAE IDE 终端可能注入自带 Node（v22）导致版本不符，属 TRAE 限制，系统 Node 正确安装即可） |
| pnpm | `>=11.0.0`（`packageManager: pnpm@11.24.0`） |
| 原生模块 | better-sqlite3 / esbuild / node-pty（`pnpm.onlyBuiltDependencies`） |

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
pnpm check:static         # 静态审计 14 项（tokens/i18n/注释/文件大小/函数体/复杂度/覆盖率下限等）
pnpm tokens:check         # 令牌生成物一致性（tokens/aurora.json ↔ tokens.css）
pnpm knip                 # 未使用依赖/文件检测
pnpm depcruise            # 依赖方向与环检测（dependency-cruiser）
pnpm check:schema-drift   # schema.ts ↔ drizzle/ 迁移漂移 + 快照链
pnpm audit:registry       # audit-ci（moderate 以上门禁）
pnpm test                 # shared → main → renderer 全部单元测试 + integration + scripts
```

> 2026-09-22 起，`tokens:check` 与 `check:schema-drift` 的判据是「重新生成前后是否一致」
> （而非对比 HEAD）——因此「改了源、已重新生成、尚未提交」不会误报，可安全用于开发中途。

## 4. 测试体系

### 4.1 单元（Vitest）

```bash
pnpm test:main        # vitest --root src/main（参考 ~1300+ 用例）
pnpm test:renderer    # vitest --root src/renderer（参考 ~490）
pnpm test:scripts     # vitest --root scripts
pnpm test:integration # vitest --root tests/integration
pnpm test:coverage    # 覆盖率（80% 门禁）
```

- 原生模块 ABI：Electron 44 与 Node 24 同构（NODE_MODULE_VERSION=137），无需切换脚本（rebuild-native.mjs 已删，2026-08）；若未来版本再次分叉，按 process.versions.modules 对比重新引入。

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
pnpm build:win             # 构建 + NSIS 安装包（x64 + arm64）
pnpm build:mac / linux     # 对应平台包（各自 x64 + arm64）
pnpm build:all             # 全平台
pnpm build:win:x64         # 单架构变体（另有 build:{win,mac,linux}:{x64,arm64}）
pnpm analyze:bundle        # 包体积分析（rollup-plugin-visualizer → stats/renderer-bundle.html）
```

发布配置：`electron-builder.yml`（github provider，GitHub Releases 为更新源）。
CI/CD：`.github/workflows/ci.yml` 为 **5 个必需检查 job**（quality / unit 六平台矩阵 /
integration-tests / e2e-browser / e2e-electron 六平台矩阵，另有 2 个 summary job 暴露稳定名）；
`release.yml` 为 **6 个单架构 build job**（win/mac/linux × x64/arm64）→ merge 更新元数据 →
release 打 tag → publish 转正式。打包验证不在 CI（PR 阶段），统一交给 CD。

> 错误处理已本地化（2026-09-13 移除 Sentry）：异常经 `infra/telemetry/error-report.ts`
> 落本地日志，随诊断包导出，报障走 GitHub Issue 深链；无符号上传环节。

## 6. 工程纪律要点

- **每次代码改动同步 CodeGraph 索引**：`pnpm codegraph:sync`（仓库根）。
- **每次实现轮次做 git commit**（`gh` / 常规 commit；commitlint conventional 规范 + husky 钩子）。钩子分工：`pre-commit` 跑密钥扫描（暂存区）+ lint-staged 自动修复；`commit-msg` 跑 commitlint + 双 type 标题拦截；`pre-push` **仅**密钥扫描（`gitleaks git` 扫待推送区间，约 1.5 秒），其余检查交 CI / `pnpm verify:local`。
- **前端 mock 层保留**：渲染层 `dev/mock-api.ts` + MSW，前端可独立开发。
- **原生模块双环境**：Node 测试环境与 Electron 运行时同 ABI（Electron 44 = Node 24，modules 137），无需重编译（rebuild-native.mjs 已删）。
- **CSS 令牌**：改令牌改 `tokens/aurora.json`（`pnpm tokens:build` 生成），禁止手改 `tokens.css`——生成物一致性由 `tokens:check` 卡关，设计令牌用法由 `check:tokens` 卡关。
- **i18n**：新增 key 需补全 en/zh-CN 两组（`check:i18n` 严格卡关）。
- **版本/CHANGELOG**：由 release-please 自动化（`.github/workflows/release-please.yml`），push main 开 Release PR，合并即打 tag 发版；无自研 changelog 脚本。

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