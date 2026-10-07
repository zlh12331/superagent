# GitHub 开源项目自动化运维方案 v4（本机审批门控模型）

> 版本：v4.0（2026-10-07）· 状态：**模型与审批粒度已拍板，待实施（云端零新增）**
> 适用：superagent（公开仓库 · 单人维护者 · 运维与开发共用同一个本机 agent）
> 前置：v1.7.0 已发布 · 六平台 CI/CD + 发版三护栏 · L0/L1 已实施（见 §6 / §8）
>
> 本版是**模型重写**，不是 v1.1 的增补：v1.0/v1.1 的「分层信任模型 L0-L6 + 暂缓重启
> 条件 + 负面清单」框架整体废止。全文围绕一个模型展开——**agent 不是另一个维护者，
> 是维护者本人的手**。v1.1 中仍然成立的资产（L0/L1 实施记录、1.6.x 流程修正、L2
> 设计）收编进 §6 / §7 / §8，不随框架废止而丢失。

---

## 0. 设计前提

### 0.1 运行前提（五条，全部为用户给定的事实，不是假设）

1. **单人维护**——没有评审团队、没有轮换表、没有第二双眼睛。一切设计不得假设
   「还有别人在场」；反过来，一切「需要第二个人」的流程（交叉评审、值班响应）都不存在。
2. **本机 agent**——agent 运行在维护者电脑上，与开发共用同一套环境与 GitHub 登录态；
   电脑不开机 = agent 不存在。**不存在 7×24 在线的智能层**。
3. **issue 与外部 PR 活跃**——社区事件到达率按活跃开源项目设计，不按仓库当前存量。
4. **运维时间不固定**——系统里不允许存在任何「要求维护者必须在 X 时间内响应」的
   机制；一切人工决策进入待决队列，不响应就是安全搁置，绝不超时失败。
5. **发布节奏完全按需**——不存在发版列车、不存在 cadence。「想发就发」要成为系统
   的自然状态而不是一个流程。

### 0.2 八项拍板（2026-10-07）

| # | 事项 | 拍板 | 依据（一句话） |
|---|---|---|---|
| 1 | Agent 身份 | 用户本人账号，不建 bot 身份 | agent 就是本人；多账号是多余的审计装置 |
| 2 | Issue 自动回执 workflow | 不做 | 有 CI 与欢迎语在场，回执是锦上添花 |
| 3 | 后台自治面 | 概念作废 | 见 §1.2——自治模型在单人维护下不可修复 |
| 4 | 修复边界 | 本机 vs 出网 | 见 §4——本地修复全免审，push/PR 才卡审批 |
| 5 | README 诚实声明 | 不做 | — |
| 6 | 代码签名 | 不上 | 签名摩擦集中在首次安装，升级链路不受影响 |
| 7 | Actions 默认权限 | 维持 write | 7 个 workflow 全部显式声明权限，纪律已兜底 |
| 8 | 21 个本地提交 | 先不推送 | 等维护者指令（§6.3 有细目与风险状态） |

---

## 1. 模型总纲

### 1.1 权限拓扑

```
维护者电脑（agent · 用户本人账号 · 复用本机 gh/git 认证态）
 │
 ├─ 自由区（免审）——一切不出本机的动作
 │    读仓库状态 · 分析 diff · 跑测试 · 写代码 · 本地 commit · 起草一切对外内容
 │    性质：不可见外人、随时可撤销、不改变远端任何状态
 │
 └─ 审批区（出网）——一切以维护者账号落在 GitHub 上的动作
      评论 · 标签 · 开 PR · push · merge · publish · close
      性质：他人可见，或改变仓库状态；逐批/逐项经维护者同意后执行

GitHub（云端基线 · 本方案零新增）
 └─ CI 六平台 · CD 五段 · release-please · CodeQL · secret scanning + push
    protection · labeler · first-interaction · issue-metrics · Dependabot alerts ·
    Renovate（周末批次 + minimumReleaseAge 1 天）
```

### 1.2 为什么不是自治 bot（v3 方案的作废依据）

v3 曾按「云端自治 agent 分层（T0-T3 自治级别）」设计。该模型在单人维护下有三个
不可修复的失败模式，这是整个 v4 重写的动机：

1. **质量事故发生在无人复核时。** 单人项目里「agent 自治」实际等于「没有第二双人」；
   自动化出错的速度远快于人工纠错，而错误产出（误标、错评、坏修复）在无人值守时
   会持续累积而不是被拦住。
2. **审计归责不可辨。** agent 以维护者身份产出的内容与本人亲手产出无法区分——
   事后既不能可靠追责，也不能放心地信任历史内容（哪条评论是人的判断、哪条是机器的？）。
3. **时间分配权被旁路。** 自治修复意味着外部贡献者打个标签就能占用维护者的开发
   带宽——最稀缺资源的分配权落到了旁人手里。

审批门控把三条全部消解：agent 只提议、维护者放行，出网动作的每一次执行都是
维护者亲手批准的结果。

### 1.3 唯一边界：本机 vs 出网

判据不是动作大小，而是**可逆性与可见性**：

- **不出本机**（免审）：不可见外人、随时可撤销、不改变远端任何状态。读、分析、
  写码、测试、起草、**本地 commit** 均属此类——commit 只是本地版本控制操作，
  不出网；push 才是出网。
- **出网**（审批）：以维护者账号落在 GitHub、他人可见或改变仓库状态。哪怕小到
  打一个标签，也走批量审。

### 1.4 云端零新增原则

云端已有的自动化是历次事故换来的资产（§6），继续照旧运行。**本方案不为云端新增
任何基础设施**——watchdog、月报、issue 回执、告警 webhook 等 v3 设想全部搁置。
依据：审批门控模型下不存在无人值守的执行者，为它建设的监护设施没有服务对象；
而「自动化自身失效」的风险由既有必需检查与维护者上线清账覆盖（§3.5）。

---

## 2. 审批协议（三档，粒度跟随可逆性）

### 2.1 档位定义

| 档 | 判据（操作化） | 覆盖动作 | 形式 |
|---|---|---|---|
| **免审** | 不出本机 | 读、分析、摘要、写码、测试、本地 commit、起草 | 直接做，不打扰 |
| **批量审** | 出网但可逆——可以被一个后续动作完全撤销且无残留（删评论、删标签、关 PR），且撤销动作同样在维护者权限内 | 打标签、发评论、Q&A 回复 | 攒一批出预览，整批放行或单条拦下 |
| **逐项审** | 出网且不可逆——撤销需要外力（force push、重发版）或撤销有代价（已通知到人的内容收不回） | push、merge、publish、close issue | 每项单独确认，永不全批 |

### 2.2 批量审的形态

agent 呈现的批次预览必须包含三部分，缺一不可：

1. **逐条动作清单**——对象（issue/PR 号）、动作、内容全文（评论贴原文，不贴摘要）；
2. **影响面汇总**——这一批共动了多少个对象、涉及哪些标签/版块；
3. **回滚方式**——整批撤销的具体操作。

放行语义：整批放行，或逐条勾选后放行选中项。**幂等保证**：打标签是 set 语义，
重放无害；评论类按「已发内容指纹」（§3.2）去重，重放不会重复发送。

### 2.3 逐项审的形态

一次一项。预览必须包含**目标终态**与**回退路径**——例如 merge Release PR 的预览 =
版本号 + CHANGELOG 增量摘要 + 合并后 CD 将执行的五段说明 + 「失败不占号可重跑」
的回退说明。维护者确认的是终态，不是命令。

### 2.4 中断与恢复（批量审在「时间不固定」前提下的成立条件）

批次执行前先落本地状态（§3.2 的 `pending_batch`：动作清单 + 进度游标）。执行中途
关机/中断，恢复会话时 agent 必须先报告「上批 N 条执行到第 K 条」，剩余续跑。
**不允许出现半批已执行且无人知晓的状态**——这是时间不固定前提下的硬要求。

### 2.5 与 superagent 自身权限链的关系

三档审批通过对话完成（agent 出计划 → 维护者确认 → 执行），**不要求产品新增功能**。
它与产品自身的权限审批链（ask/auto 模式、审批等待通知）同构：用自己的产品、以
产品的审批交互运维自己的仓库。这是 39 号 v1.1 §7.1「用 superagent 维护 superagent」
愿景的落地形态——且比原试点设计更简单：原「本机监听 vs Actions runner」两形态
之争在本模型下自然消解（只本机、只审批门控）。

---

## 3. 运维会话（agent 一次上线的完整流程）

### 3.1 会话生命周期

```
上线清账（§3.3）→ 待决摘要（§3.2）→ 交互处理（修复/回答/发布，§4/§5）→ 收尾（更新状态锚点）
```

免审的是读与分析；**摘要本身是会话唯一必须稳定产出的东西**——它是维护者决定
今天做什么的唯一信息源，宁可冗长不可遗漏。

### 3.2 状态锚点

存于本机 `.agent-ops/state.json`（**不进 git**）：

| 键 | 内容 | 丢失时的降级 |
|---|---|---|
| `last_sweep` | 上次清账时间戳 | 回退「近 7 天全量重扫」——所有写动作幂等或去重，重扫无害 |
| `pending_batch` | 在途审批批次 + 进度游标 | 批内动作逐条核对现状后续跑（§2.4） |
| `posted` | 已发评论/回复的内容指纹 | 按指纹去重，防重放重复发言 |

### 3.3 增量抓取清单（清账查什么）

| 面 | 查什么 | 方式 |
|---|---|---|
| Issue | 新开 issue / 有新评论的 issue | `gh issue list` |
| PR | 新 PR / 新 commit / CI 结果变化 | `gh pr list` + `gh pr checks` |
| Release PR | 存在性 + 内容变化（release-please 是否更新） | `gh pr list` + diff |
| 告警面 | 最近失败的 workflow run / CodeQL 告警增量 / Dependabot alerts | `gh run list` / Security 页 |
| Discussions | Q&A 版块新帖 | 本机轮询（无云端组件） |

### 3.4 能力项

**3.4.1 分诊打标**——对增量 issue 打 `type/` 与 `platform/` 标签（taxonomy 四组，
§8）；`status/` 组中 agent 只提议 `needs-info`/`triaged`，随批量审放行；`priority/`
只可提议 `suggested` 语义的候选，采纳在逐项审里定。失败模式与对策：打错标签可
直接删（可逆），这正是它落在批量审档的原因。

**3.4.2 PR 预审**——对外部 PR 出分析评论（正确性 / 测试 / 安全视角）与「接受 /
要改 / 拒绝」预判，进批量审。**approve 永不提议**：approve 是合并权的一部分，
合并权永远在维护者手里（v1.1 原则 1 在本模型下的残留形态）。维护者只细看预判
为「要改/拒绝」的 PR 与自己感兴趣的，「接受」类按摘要批量处理。

**3.4.3 修复流水线**——见 §4，触发无门槛，出网逐项审。

**3.4.4 发布预检**——见 §5.2，发布动作本体是维护者点合并。

**3.4.5 Q&A 起草**——对 Discussions Q&A 版块新帖起草引用式回答：必须给出处
（docs/ 链接或历史 issue 号），标注「AI 生成」；**答不了不硬答**，升级为 issue 的
判据：需要维护者判断、需要诊断包、超出文档与历史 issue 覆盖范围。公告版块
（仅维护者可发）不进入起草范围。**升级协议（2026-10-08 补，⑨）**：① issue 用
对应模板（缺陷走 bug_report）；② 正文首行必带原帖链接（互链双向可溯）；
③ 原帖回复固定话术「已转 issue #N，后续跟踪在那里」，原帖保持 open 不关闭。

**3.4.5.1 Discussions 运维协议（2026-10-08 补，⑤⑧⑥）**

| 项 | 协议 |
|---|---|
| **帖终态语义（⑤）** | Q&A：答案被勾选 = 闭环（可加 `discussion/answered`）；Ideas：采纳 = 转 issue 后原帖回复互链并关闭；重复 = `discussion/duplicate` + 链接原帖后关闭；缺信息 = `discussion/needs-info`（只标记，**永不自动关闭**——对齐 issue 面同一红线） |
| **moderation 预案（⑧）** | 三步 escalating：单帖违规 = 隐藏（hide）；版块被刷 = 临时锁版块（lock）；惯犯 = 拉黑（block user）。触发全人工——moderation 是定性判断，不自动化。维护者需在网页确认 Discussions 的 report 通知处于开启（Settings → Discussions → 勾选活动通知） |
| **SLO（⑥）** | Q&A 首答 < 48h（agent 上线时段内实际目标 < 1h）；周度量由 issue-metrics 的 discussions job 产出，Time to Answer 连续两周超标 = 提高清账频率而非加自动化 |

**3.4.6 告警分诊**——CI 失败 / CodeQL 告警增量归类为「真故障 / 已知 flaky / 噪音」；
处置（重跑、开修复分支、关单）逐项审。已知 flaky 沉淀为本机清单，避免每次重新归因。

### 3.5 离线窗口的降级语义（agent 不在线时仓库处于什么状态）

照常运转：CI 六平台对外部 PR 自动反馈（外部贡献者感知到的「维护者在场」由 CI
承担）、CD/release-please/labeler/CodeQL/Dependabot 全部照旧。无人承担：分诊、
回复、修复、发布——全部等上线清账。issue 无自动回执是 §0.2 #2 的拍板，外部在
离线窗口得到的是「提交成功 + CI 反馈」；这是有意取舍，不是遗漏。

---

## 4. 修复流水线（开发与运维共用同一条管道）

### 4.1 触发无门槛

任何 issue（含外部贡献者提交的）agent 都可以直接修。修复意愿 = 维护者的开发
时间分配；审批门控保证「修好了」永远只是本机事实，出不出网由维护者定。

### 4.2 本地段（全免审）

从 main 切分支（约定 `fix/<issue号>-<slug>`）→ 修复 → 补测试（业务逻辑不 mock、
基础设施可 stub 的既有原则）→ `pnpm typecheck && pnpm lint && pnpm check:static`
+ 相关测试 → commit（Conventional Commits，type 决定 release-please 升版——
feat/fix/perf 计入，其余不升）。

本段纪律与日常开发**完全一致**，因为这就是日常开发——运维与开发共用同一条
管道是本模型的自然结果，不需要第二套规范。

### 4.3 出网段（逐项审）

push 分支 → 开 PR（走仓库 PR 模板：变更内容/变更类型/自检三项）。两个既有纪律
自动生效：

- 涉及 `.github/`、打包链（`electron-builder.yml` / `scripts/prepare-*` / NSIS）的
  PR：本地打包全链验证后才请求合并（AGENTS.md 纪律）；
- 合并由维护者亲手执行——ruleset 本来也不允许任何其他人（bypass 为空）。

### 4.4 与 CI 门禁的关系

PR 上六平台 CI 自动跑，红灯先行原则不变。agent 备好的 commit 必须本地先过与
`verify:local` 同款的门禁——**不许拿 CI 当本地验证**（CI 反馈周期以分钟计，
本地以秒计；agent 时间便宜，CI 时间与并发位宝贵）。

---

## 5. 发布流水线（想发就发的操作化）

### 5.1 待命态语义

release-please 的**常驻 Release PR 就是「随时可发」状态**：只要有未发提交，它就在
页面上待着——版本号与中文 CHANGELOG 已算好，护栏 B/C 在 CI 里自动跑，beta 序列
自动递增。发布频率不进系统设计：任何 cadence 在「时间不固定」前提下都是违约源；
待命态把「发布」从一个流程压缩成一个按钮。

### 5.2 发布预检（逐项审的前置材料，agent 负责备齐）

| # | 检查 | 方式 |
|---|---|---|
| 1 | 锚点三态自洽（tag ↔ 已收尾 Release PR ↔ 待合并版本方向） | `pnpm check:release-anchor` |
| 2 | Release PR 内容边界（只含 CHANGELOG / manifest / 版本行） | `pnpm check:release-pr-scope` |
| 3 | Release PR CI 全绿（含 CHANGELOG 润色门禁） | `gh pr checks` |
| 4 | CHANGELOG 已人工润色 | agent 只提醒不代笔（润色是维护者的判断） |
| 5 | 本地无未推交付物 / 工作区干净 | `git status` + ahead/behind |

预检全绿 → 维护者在 GitHub 上点合并（逐项审的本体动作）。预检有红 → 不合并，
先修——CD 半成品态（tag 已打资产未齐）的代价在 1.6.x 已付过三倍学费。

### 5.3 合并后（全自动段）

CD 五段自动走完：gate → build（6 单架构，各带 packaged-engine / native-arch /
smoke 断言）→ merge（Win/mac 双架构更新元数据）→ release（打 tag + draft +
`autorelease: tagged` 收尾）→ publish（资产校验后转正式）。人工盯梢沿用既有
纪律：**按 run ID 精确核对 + 终验四件套**（tag 钉点 / 非 Prerelease / 资产数 /
Latest 切换）——`gh run list` 匹配旧 run 假绿的教训已入档。

### 5.4 stable 毕业

`Release-As: X.Y.Z` 提交 → release-please 开毕业 Release PR → 走同一预检与合并
流程。v1.7.0（#110→#111）为完整先例。

### 5.5 已知限制（如实登记）

- **无签名**：Windows 首次安装遇 SmartScreen 警告（更多信息→仍要运行）、macOS
  需系统设置放行；**升级场景不受影响**（electron-updater 在已装应用内自更新）。
  摩擦集中在首次安装这一步。
- `stagingPercentage` 灰度：可选未拍板（一行配置，无监控配套，仅降低爆炸半径）。

---

## 6. 云端基线（2026-10-07 gh api 实测档案）

### 6.1 设置实测

| 项 | 实测值 |
|---|---|
| ruleset「protect-release-branches」 | active，bypass 为空；规则 = deletion + non_fast_forward + required_linear_history + required_status_checks×5（strict）。**无 merge queue（判定不可用，见 §8）、无 required reviews**（单人下正确：自审死锁）⇒ **直推 main 必被拒，一切变更必须走 PR** |
| 仓库合并设置 | `allow_auto_merge=false`（合并动作必须人点）/ **`allow_update_branch=true`（2026-10-07 开启：merge queue 不可用 + strict policy 组合下，贡献者可自助 update branch，免维护者手动 rebase）** / `delete_branch_on_merge=true` |
| 安全 | secret scanning ✅ / push protection ✅ / dependabot alerts ✅ |
| Actions | 默认 workflow 权限 = **write**（拍板维持）；`sha_pinning_required=false`（pin SHA 靠 workflow 纪律，7 个已全 pin）；`allowed_actions=all`；GITHUB_TOKEN 不可 approve PR |
| 密钥/环境 | Actions secrets 仅 `RELEASE_PLEASE_TOKEN`；**发布未签名**；environments 仅 copilot 自动项 |
| 社区面 | Discussions 5 版块（General / Ideas / Polls / Q&A / 公告[仅维护者]）；**开帖表单 ×2 已配置（2026-10-07：`.github/DISCUSSION_TEMPLATE/q-a.yml` + `ideas.yml`，开帖即收集版本/系统/查重确认——替代事后追问）**；labels 28 个 taxonomy 全生效；issue 模板三件套 + blank_issues 关闭 + 安全私密上报引导 |
| 社区面更正 | v1.1 §6 所写「Discussions reply templates」**不是真实存在的 GitHub 功能**（2026-10-07 实证：SavedReply 为 viewer 级个人便签且无 API 管理入口，262 个 mutation 无一可写）——其意图由 **Discussion category forms**（开帖侧结构化表单，真实功能）更优实现，见上 |
| Renovate | 周末批次 + 上海时区；非 major 归一组；electron major `enabled:false`；react-query 双包同 PR；`minimumReleaseAge: 1 day`（供应链 24h 缓冲） |

### 6.2 workflow 一览（7 个，全部 active、全 pin SHA、显式 permissions）

| workflow | 职责一句话 |
|---|---|
| ci.yml | PR 质量门禁（quality + unit/integration/E2E × 6 平台矩阵 + 两个 summary）；Release PR 瘦身至润色门禁 + scope/anchor 两闸门 |
| release.yml | CD 五段（gate→build 6 架构→merge→release→publish），tag 后置防空占号，concurrency 串行不取消 |
| release-please.yml | 版本推导 + Release PR（skip-github-release；禁 release-type 输入；独立 RELEASE_PLEASE_TOKEN） |
| codeql.yml | advanced setup（排除 vendored 路径），javascript-typescript + actions 双语言 |
| labeler.yml | PR 区域标签（8 个，v5，pin SHA） |
| first-interaction.yml | 首次 issue/PR 欢迎固定文案（**云端版本待修**，见 6.3） |
| issue-metrics.yml | 周一 cron 只读统计，输出 Job Summary |

### 6.3 已知缺口（21 个本地未推提交，拍板暂缓，推送需维护者指令）

| 组 | 提交 | 云端风险状态 |
|---|---|---|
| 安全修复 | e6a5e858（ci.yml `HEAD_REF` env 中转收口）/ 583bcb15（first-interaction 改 `pull_request_target`）/ 0be1fd0c（scope 闸门 patch 缺失 fail-closed）/ d74355e7（注释漂移） | 云端 first-interaction 仍为 `pull_request`（**fork PR 必红**，raw 内容实锤）；ci.yml 无 env 中转（注入面未收口） |
| 依赖收窄 | f627573f（dependabot.yml 收窄至根 npm） | 云端无 dependabot.yml（PR #112 已关未并），Dependabot 安全更新在无收窄状态下运行 |
| a11y / 测试 | a11y 二期三期（5 提交） | 不影响云端 |
| 文档同步 | 7 提交 | 不影响云端 |
| 清理 | displayName 死字段等（2 提交） | 不影响云端 |

---

## 7. 安全姿态

### 7.1 既有防线（全部照旧运行）

CodeQL（含 actions 语言，扫 workflow 自身的权限与表达式问题）· secret scanning +
push protection（已开）· Dependabot alerts · gitleaks 三闸（pre-push / git 扫描 /
dir 自查）· audit-ci（--moderate 卡关）· SBOM + asar 完整性 + CSP 哈希锚定 ·
Renovate `minimumReleaseAge`（新版发布 24h 后才进升级 PR）+ electron major 禁自动升。

### 7.2 Agent 注入纪律（本模型下唯一新增的防线，也是唯一不能省的）

攻击链推演：恶意 issue 正文 → 诱导 agent 生成「看起来合理」的出网动作 → 诱导
维护者批准。**审批门控防的是无人值守执行，防不了被诱导的批准**——所以外部内容
（issue 正文 / PR 描述 / Discussions 帖）在会话全程**当数据不当指令**，且落地为
一条可检查的呈现纪律：批量审预览里，凡内容源自外部的部分必须**原文引用并显式
标注来源**，agent 不得转述美化——转述就是注入的载体。

### 7.3 知情接受的风险登记

| 风险 | 现状缓解 |
|---|---|
| agent 持本人全权账号（进程被注入 = 账号全权） | 事事事前审批是主要约束器；出网动作全部留痕于 GitHub（评论/PR 可见） |
| 发布未签名 | 摩擦集中首次安装；升级链路不受影响（§5.5） |
| Actions 默认 write | 7 个 workflow 均显式声明收窄权限；新增 workflow 时沿用同一纪律 |

---

## 8. 遗留未拍板（挂起，不阻塞本方案）

| 项 | 设计保留 | 现状与建议 |
|---|---|---|
| **L2-Socket** | 设计沿 v1.1 §5：GitHub App 只读评审，盯依赖变更的恶意行为——typosquat / postinstall 外联 / 代码混淆 / 包接管（已知 CVE 库之外的行为面，与 CodeQL/Dependabot 互补）；安装时索要 `contents: write` 直接拒 | **✅ 已安装（2026-10-07，维护者网页授权）**。自动评审每个依赖 PR；观察期至 **2026-10-21**（成功标准「零噪音或噪音有行动价值」，不达标即后台卸载） |
| **L2-Harden-Runner** | v1.1 §5 设计保留：runner 出口 DNS/HTTP 审计（step 形式，`egress-policy: audit` 起步，仅 release.yml 持密钥 job）；三平台采集能力需先核实 | **维持搁置**（2026-10-07 仅批 Socket） |
| 21 提交推送 | 分组 PR：安全修复组 / dependabot / a11y / 文档 | 安全修复组建议尽早——云端 first-interaction 现在是坏的 |
| **merge queue** | ruleset `merge_queue` 规则 + ci.yml 监听 `merge_group` | **⛔ 判定不可用（2026-10-07 关闭）**：REST / GraphQL / 网页 UI 三通道均无此能力（UI 的 Add rule 下拉无 Merge queue 项；API 双通道正确 schema 仍报 "Invalid rule 'merge_queue'"；独立 ruleset 探针同拒）——账号上下文门，社区 [#137097](https://github.com/orgs/community/discussions/137097) 同源。**防护不缺位**：strict policy（分支须含 main 最新提交）继续挡过时合并；ci.yml 的 merge_group 触发已合入 main、无害保留（将来功能开放即自动接通）。过期再评估 |

---

## 9. 变更日志（活文档）

| 日期 | 版本 | 动作 |
|---|---|---|
| 2026-10-07 | v4.0 | 模型重写：本机审批门控 agent（八项拍板 §0 + 三档审批协议 §2 + 运维会话 §3）；云端零新增原则（§1.4）；v1.1 分层/暂缓/负面清单框架废止；L0/L1 与 1.6.x 护栏收编 §6；L2 设计保留于 §8 遗留项 |
| 2026-10-06 | v1.1 | 定稿：分层信任模型 L0-L6；L0-L2 + Discussions 按批次实施，L3-L5 暂缓并设重启条件；负面清单五项 |
| 2026-10-06 | v1.0 | 初稿（编号 33，后因撞号改编 39 号） |
