# 发布手册（RELEASING）

本仓库采用 **release-please + 单发布分支（main）** 的发布模型。本文是发版的完整操作手册。

## 一、核心模型

| 环节 | 负责 | 说明 |
|---|---|---|
| 版本号推导 | release-please | 读 Conventional Commits 算下一个版本，写入 `.release-please-manifest.json` + `package.json` |
| CHANGELOG | release-please | 自动生成；**发版前在 Release PR 中人工润色为面向用户的文案** |
| 打 tag | release.yml | 三平台构建全部成功后才打 tag（防空版本占号） |
| label 收尾 | release.yml `release` job | 打 tag 后把 Release PR 标记为 `autorelease: tagged`。这是 release-please 的**进度游标**：`skip-github-release: true` 跳过了它自身的 label 更新路径，若不代收尾，label 会永久停在 `autorelease: pending`，导致**下一次发版被 abort**（详见第七节） |
| 对外可见 | release.yml `publish` job | 校验三平台安装包 + `latest*.yml` 齐全后，draft 才转正式 |

**只有 main 一条发布分支。** 预发布（beta）不靠分支实现，靠版本号后缀 + prerelease 版本化策略。

版本号推导配置见 `release-please-config.json`：

```json
{
  "versioning": "prerelease",
  "prerelease": true,
  "prerelease-type": "beta"
}
```

> ⚠️ release-please **不会按分支名自动识别 prerelease**。配置文件从「被发布分支的 tip」读取，
> 所以 prerelease 行为完全由上面几行决定，与分支叫什么名字无关。
>
> 三个字段的分工（2026-10-06 实证）：`versioning: "prerelease"` 选定 prerelease 版本化策略；
> `prerelease: true` 是**策略闸门**——缺省时策略会把 beta 后缀剥掉直接提案稳定版号；
> `prerelease-type: "beta"` 决定后缀名。⚠️ **workflow 不得传 `release-type` 输入**：
> release-please-action 收到它会走 `Manifest.fromConfig` 分支把配置文件整个绕过
> （versioning 落到输入默认值 `default`——此前配置形同虚设的根因，见第三节历史注）。

### 破坏性变更怎么写（2026-09-11 核实修正）

`release-please-config.json` 的 `changelog-sections` 曾有一行
`{ "type": "breaking", "section": "破坏性变更" }`——**这行是无效配置，已删除**。
原因：Conventional Commits 里 **没有名为 `breaking` 的 type**，破坏性变更的表达方式是
type 后缀 `!` 或 footer `BREAKING CHANGE:`，因此该 section 永远不会匹配到任何提交。

正确写法（两种，任选）：

```
feat(api)!: 移除旧的模型配置字段
```
```
feat(api): 移除旧的模型配置字段

BREAKING CHANGE: 旧字段 `modelConfig` 不再被读取，需迁移到 `models`。
```

**它们在 CHANGELOG 里的实际呈现**（由 release-please 底层 conventional-changelog 生成）：

- 该提交按**其主 type** 归入对应段落（`feat` → 「新增」）
- **额外**生成一个独立的 `### ⚠ BREAKING CHANGES` 段落列出破坏性说明（标题由工具固定，不可配置）
- 版本号：major 升版（0.x 期间按 `bump-minor-pre-major` 规则处理，本项目未启用该选项）

也就是说：**破坏性变更不需要、也无法在 `changelog-sections` 里配置**，它由工具内置处理。

### version-file / extra-files 是干什么的

这两个是 release-please 的「多文件版本同步」能力，**本项目不需要**：

| 选项 | 用途 | 本项目的判断 |
|---|---|---|
| `version-file` | 指定「版本号真源」文件（默认 `package.json`）。用于 Java/Gradle 等版本写在别处的生态 | 不需要，版本真源就是 `package.json` |
| `extra-files` | 除真源外，**额外**同步改写的文件列表。适合版本号在多个文件重复出现的场景（如 `Cargo.toml` + `package.json`、README 徽章里的版本） | 不需要，实测仓库内无第二处需同步的版本号（见下） |

**为什么本项目不需要 `extra-files`**：我核查了所有被跟踪文件中的版本号出现位置，只有
`package.json` 承载发布版本；`drizzle/meta/*.json` 的 `"version"` 是 Drizzle 的**格式版本**、
`.vscode/launch.json` 的 `0.2.0` 是 schema 版本、`packages/shared/package.json` 是
`0.0.0`（私有子包，不独立发版）——都不是发布版本，不应被 release-please 改写。

> 若日后新增「需要跟随产品版本号的文件」（例如 README 徽章、`app-update.yml` 模板），
> 再往 `extra-files` 里加对应路径，并在该文件中用 `x-release-please-version` 注释锚定。

## 二、发正式版（常规流程）

1. 功能开发走 PR 合入 main（Conventional Commits；main 受 ruleset 保护，需 PR + 必需检查 + 线性历史）
2. release-please 自动开/更新 Release PR，标题形如 `chore(main): release 1.1.0`
3. 审阅该 PR：版本号是否符合预期、**润色 CHANGELOG（见下节，有门禁卡关）**
4. 合并 Release PR → 触发 `release.yml`
5. `release.yml` 依次：gate 识别发布提交 → 三平台构建（各平台原生打包 + 产物 smoke）→ 打 tag + 建 draft → 校验资产 → 转正式
6. 自动更新源（`latest*.yml`）随资产一起发布

> 想控制发版节奏，就**先不合并 Release PR**——提交会一直累积进下一个版本。这是天然的发版节流阀。

### 2.1 润色 CHANGELOG（必需步骤）

**为什么要人工润色**：release-please 以 **commit** 为粒度产出 CHANGELOG——一个 commit 一条记录，文案取该 commit 的标题。而本项目走 squash 合并，于是一个含几十个修复的 PR，合并后在 CHANGELOG 里**只剩一行 PR 标题**；squash 提交正文里保存的子提交明细它不解析（只从正文读破坏性变更 / `Release-As:` 这类 footer 指令）。

后果是用户打开 Release 页面看到的全是开发视角的措辞（如「渲染层全域审计收口」「三平行 switch 合并元数据表」），**看不出这次更新对自己有什么用**。

**操作**：

```bash
pnpm release:draft            # 生成底稿：展开版本区间内全部提交 + 明细（含 squash 正文里那些）
# 按底稿把 CHANGELOG.md 最新版本段改写成面向用户的话术，例如：
#   - **记忆功能恢复可用**：修复记忆引擎子进程从未启动（此前一直静默降级为「无记忆」）
#   - **亮色主题可读性**：修复首页/会话/设置共 59 处文字对比度不达 WCAG AA 的问题
#   —— 说清「用户得到什么」；纯内部工程改动（CI/静态分析/重构）可归入「内部改进」或略去
pnpm check:changelog-polish   # 验证通过后才能合并 Release PR
```

**门禁（两道，防止漏做）**：

| 位置 | 触发条件 | 作用 |
|---|---|---|
| `ci.yml` 的 `Typecheck / Lint / Unit Test / Audit` | PR 分支名以 `release-please--` 开头 | **阻塞合并**。塞进既有必需检查而非新开 job——ruleset 的必需检查清单是固定的 8 项，新 job 不阻塞合并 |
| `release.yml` 的 `Gate (release-please commit?)` | 发版提交且 gate 判定为发布 | **兜底**。即使 PR 阶段漏过，发版会在**打 tag 之前**失败（不占版本号、可重试）。处置：补一个小 PR 润色 CHANGELOG，合并后重跑 workflow |

判定口径：该版本段的**全部** bullet 都以提交链接结尾（`([abc1234](…/commit/abc1234))`）= 仍是机器原文 = 未润色。只要有一条不带链接即视为人工已介入（不依赖分组标题语言，故对中英文分组都成立）。

**显式放行标记**：在该版本段内加一行 `<!-- changelog:polished -->`（GitHub 渲染不可见）即通过。两种场景需要它：

1. 确实要直接使用机器原文（罕见）；
2. **润色时逐条保留了提交链接做溯源** —— 此时格式上与机器原文无法区分，会被判为「未润色」（假阳性）。这属于**有意为之的取舍**：宁可假阳性（补一行标记即可，成本极低），也不能假阴性（机器原文直接对外发布，成本高）。

所以推荐做法是：润色完成后顺手加标记，让判定不依赖格式巧合。

> ⚠️ 本门禁只能识别「完全没动」，识别不了「随手敷衍」——它拦的是**忘**，不是**差**。文案质量仍靠审阅。

## 三、发 beta（预发布）

**正常路径：什么都不用做。** beta 阶段（当前版本为 `X.Y.Z-beta.N`）的 fix/feat 提交合并进
main 后，release-please 自动把 Release PR 提案为 `X.Y.Z-beta.N+1`（prerelease 策略递增
prerelease 号，base 版本不动）：

- release-please 开/更新 `chore(main): release X.Y.Z-beta.N+1` 的 PR
- 合并后 `release.yml` 按版本含 `-` 自动标记为 GitHub **Prerelease**（同时打 tag）

**显式钉版本**（跨系列收敛/跳号）才需要 footer：

```
feat(ui): 某个新功能

Release-As: 1.1.0-beta.1
```

> 历史注（2026-10-06 修复前）：workflow 传了 `release-type` 输入导致配置文件被绕过、
> prerelease 策略从未生效，beta 序列只能靠逐个 footer 硬指定——漏写就提案出
> `1.7.1-beta.1` 这类 base bump 版本（实测）。

beta 与正式版共用 `latest*.yml` 更新源；已装 beta 版的应用（版本含 `-beta`）会自动开启预发布更新检查，
稳定版用户**默认**收不到 prerelease（GitHub `/releases/latest` 天然跳过 prerelease）。

> **稳定版用户想测 beta**：设置 → 关于 → 打开「接收预发布更新」（`update.allowPrerelease`，
> 2026-10-01 增补，见 27 号 spec §4）。主进程每次检查前重读该设置，开启后点一次
> 「检查更新」即可收到 beta 提示，无需重启；关闭即回退为只收正式版。装了 beta 的
> 用户恒收预发布（版本号判定），不受开关影响。

## 四、从 beta 毕业为正式版

`1.1.0-beta.N` 之后，**必须显式** footer（`prerelease: true` 常开时策略永不收敛
beta 后缀，普通提交只会继续递增 beta.N）：

```
Release-As: 1.1.0
```

合并后 Release PR 提案 `1.1.0`（干净正式版，无后缀）。

## 五、发版失败后重试

任一环节失败 → 无 tag、无 Release、版本号不占号，可直接重试：

- 本地修复后 push，或
- 手动重放 CD：`workflow_dispatch` 触发 Release workflow，`confirm_version` 必须填**与 `package.json` 当前版本一致**的版本号，否则 gate 拒绝

### ⚠️ 重放到「release job 已成功过」的阶段时注意 tag 锚点（2026-09-21 事故）

`release.yml` 的 release job 在 tag **已存在**时会走 update 路径。若其 `target_commitish`
指向"当前分支 tip"而不是**产出该版本的发布提交**，重跑会把已发布的 tag **挪到更新的提交上**。

后果不是立刻可见，而是**下一次发版时爆发**：release-please 靠「tag 指向
`chore(main): release X.Y.Z` 提交」建立版本锚点，tag 脱离发布提交后它认不出该版本，
会一路回退遍历更早的 release（那些也因 `SHA not found in recent commits` 被跳过），
最终以历史起点算出下一个版本 = **1.0.0**，并把**全量历史条目**塞进 CHANGELOG。

实测影响范围：v1.3.3 因此被从发布提交 `3b9b8fa` 移到 `1f1a66b`，release-please 随即开出
`chore(main): release 1.0.0`（PR #64）。

**已修复**（2026-09-21，#67）：gate 新增 `release_sha` 输出（回溯 git log 找出发布提交），
release job 显式传 `target_commitish: ${{ needs.gate.outputs.release_sha }}` ⇒ 重跑永远把 tag
钉在同一提交上。注意**不能**用 `github.sha`——手动 dispatch 时它是 main tip，往往已是发布提交
之后的修复提交。

**若事故已发生，补救三步**：

```bash
# 1. 把 tag 移回发布提交（先确认目标：该 tag 应对应 chore(main): release X.Y.Z）
gh api -X PATCH repos/{owner}/{repo}/git/refs/tags/vX.Y.Z -f sha=<发布提交SHA>

# 2. 关闭误开的 Release PR（版本倒退的那个）
gh pr close <PR号> --comment "误开：根因见 RELEASING.md 第五节"

# 3. 手动触发 release-please 复验（应开出正确的下一个版本）
gh workflow run release-please.yml --ref main
```

Release 资产与正文不受影响（tag 只是引用），用户侧无需任何动作。

## 六、热修复（待需要时启用）

若已发布的 `1.0.0` 爆出严重 bug，而 main 已累积了 1.1.0 的功能，需要出只含该修复的 `1.0.1`：

1. 从 tag `v1.0.0` 切维护分支 `release/1.0`
2. 在该分支 cherry-pick 修复提交
3. 该分支需要自己的 manifest 配置（`versioning: "always-bump-patch"`）与 workflow 触发分支
4. 单独发版

> 当前尚未启用。等真有 parallel 维护需求时再落地，不要提前复杂化。

## 七、常见坑

### 7.1 发版锚点自洽护栏（2026-10-05 落地，1.6.x 连环事故后）

**1.6.x 事故全景**：Release PR 合并时 CD 打包失败 → tag 缺失，但 manifest 已推进、
label 已收尾 tagged → release-please 三态（tag ↔ manifest ↔ Release PR）不一致 →
版本推导回退全量历史（#80/#87 两次误开把全部历史条目当增量、1.6.0 被消费、
版本链跳到 1.6.1）。两次补救均以「补钉缺失 tag 钉回对应 release commit」使
三态自洽（v1.6.0-beta.3 → b1bc81bc、v1.6.0-beta.4 → 3fdfabd8）。

**护栏 A（合并纪律）**：Release PR 的 squash 合并动作**只在 CD 全绿后人工执行**——
不发 auto-merge。CD 失败时不合并（失败不占号可重试），修复后重跑 CD 而不是
先把 PR 合进 main。这是本次事故的总根因防线。

**护栏 B（锚点检查）**：合并 Release PR 前必跑：

```bash
pnpm check:release-anchor     # tag ↔ manifest ↔ Release PR label 三态自洽校验
```

四项检查任一 ❌ 即禁止合并，按输出提示走 a/b/c 修复路径（补 tag / revert
release commit / 修 label）。脚本实现要点：零子进程（fetch 直连 GitHub REST），
动态值先过 SemVer 严格白名单再进 URL path，host 白名单 api.github.com（SSRF 防线）。

**版本号模型（本仓库实际行为，与 SemVer 标准一致）**：beta 版本挂在**下一个
未发布的正式版**之下（1.6.0-beta.1 → 1.6.0-beta.2 → …）；正式版发布后计数
从 beta.1 重新开始。⚠️ 若 beta 序列中途 CD 失败且选择了「补 tag 自洽」，该
beta 号即被消费（视为已发布）——后续版本会在其之上递进（fix 后 patch+1，
如 1.6.1-beta.4），这是事故的最小代价路径而非标准流；1.6.1-beta.4 已按此
接受为既成事实，1.6.2 正式版发布后链条重新干净（下个 beta 从 1.6.3-beta.1 起算）。

| 现象 | 原因 |
|---|---|
| 合并 Release PR 后没打 tag | 旧版曾用非法的 `skip-tag` 输入（被 Actions 静默忽略）；现用 `skip-github-release: true`，tag 一律由 `release.yml` 创建 |
| push 后 release-please 不再开 Release PR | 仓库里存在「已合并、但 label 仍是 `autorelease: pending`」的 Release PR，release-please 据此判定上一个发布未收尾，直接放弃本次 PR 创建（日志：`There are untagged, merged release PRs outstanding - aborting`）。⚠️ **该判定只读 PR label，不检查 tag 是否真实存在**（源码 `src/manifest.ts`：`DEFAULT_LABELS=['autorelease: pending']`）。根因：`skip-github-release: true` 跳过了 release-please 内部 `createReleasesForPullRequest` 的 label 更新，而打 tag 又移交给了 `release.yml`，两边都没更新它就永久停在 pending。2026-09-14 已由 release job 的「Mark release PR as tagged」步骤代收尾；**历史遗留**（如 PR #30）需手工修复：`gh pr edit <n> --remove-label "autorelease: pending" --add-label "autorelease: tagged"`，再手动重跑 Release Please workflow（改 label 不触发 push，不会自动重跑） |
| 更新 Release 报 403 | softprops 对**已存在**的 release 做 update 会被拒；正常路径是 create（用 `GITHUB_TOKEN`）。重放已存在 tag 的场景改用 `gh` CLI 手动处理 |
| 三平台构建成功但未发布 | `publish` job 校验资产未通过（缺安装包或 `latest*.yml`），Release 保持 draft |
