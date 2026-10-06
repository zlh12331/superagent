# GitHub 开源项目自动化运维方案（最终版）

> 版本：v1.1（2026-10-06）· 状态：**待审查（用户批准后按批次实施）**
> 适用：superagent（公开仓库 · 单人维护者 · agent 辅助）
> 前置：v1.6.2 已发布 · CI/CD 六平台 · release-please + 锚点护栏 · Renovate + Dependabot alerts

---

## 0. 设计原则（先于一切）

1. **合并权永远在维护者手里**——任何自动化（含 agent）的产物只到 draft PR / 评论 / label 为止；Release PR 只在 CD 全绿后**人工合并**（护栏 A）。
2. **公开仓库的 issue 正文是不可信输入**——agent workflow 中 issue 内容一律当数据不当指令（prompt injection 是公开仓库头号攻击面）。
3. **token 最小权限**——workflow `permissions:` 逐 job 声明；第三方 action 一律 pin 到 commit SHA；App 安装时审查权限范围（评审类 App 要 `contents: write` 直接拒）。
4. **先规则后 AI**——能用确定性规则（labeler、模板、快捷回复）解决的不上 LLM。
5. **每个 App 有观察期**——噪音超标即卸载，装卸记录于 §11 变更日志。

---

## 1. 现状盘点（2026-10-06）

| 已有 | 说明 |
|---|---|
| CI/CD 六平台 + 锚点护栏 | ci.yml（Release PR 已瘦身 1m26s）/ release.yml + check:release-anchor |
| release-please + Renovate + Dependabot alerts + CodeQL + gitleaks + SBOM | 版本与安全四层（互不撞车：Renovate 管升级 PR，Dependabot 只管 alerts） |
| Issue 报障深链 | 应用内预填版本/平台 |
| Discussions | **已开启，0 帖，无版块配置**（本文档 §6 补） |
| Labels | 11 个默认平铺 label，无 taxonomy（L0 地基本方案补） |
| 仓库设置 | delete_branch_on_merge ✓ · **auto-merge 关闭** · web_commit_signoff 关闭 |
| 社区量级 | open issue 1 · subscribers 0——按"起步期"设计，不过度建设 |

---

## 2. 分层信任模型（总架构）

```
L0 配置层   模板 / label taxonomy / 仓库设置 / dependabot.yml / gitignore   ← 一次性
L1 规则层   labeler / first-interaction / issue-metrics / reply templates   ← 确定性，零 LLM
L2 安全层   Socket（恶意包行为）+ Harden-Runner（runner 出口监控）           ← 加固，无噪音
L3 评审层   （暂缺位——CodeRabbit 与通用 agent 改造二选一，见 §7 待定项）
L4 分诊层   issue triage（暂缓——等社区量级，见 §7）
L5 修复层   （暂缓——zcode 通用 agent 改造试点，见 §8）
L6 永不自动化  Release PR 合并 / 正式发版 / 关用户 issue / 优先级判定         ← 负面清单
```

变化说明（相对 v1.0 草案）：**评审层暂缺位**——CodeRabbit 与"Claude 解绑的通用 agent"两个方向均暂缓（评审类等观察 batch 1 的 issue 质量，agent 类等 zcode headless 改造评估），本版只落 L0-L2 + Discussions，这三层零风险零成本且无依赖。

---

## 3. L0 配置层（批次 1，一次性）

### 3.1 Label taxonomy（四组，`组/子项` 命名）✅ 已实施

| 组 | labels | 用途 | 谁可以写 |
|---|---|---|---|
| `type/` | bug / feature / docs / question / chore | 类型分类 | labeler（PR）、人工（issue） |
| `platform/` | windows / macos / linux / all | 报障分流 | labeler + 人工 |
| `status/` | triaged / needs-info / duplicate / wontfix | 分诊流转 | **人工 + 未来 agent**（唯一 agent 可写组） |
| `priority/` | high / medium / low | 排期 | **仅人工**（agent 永不判优先级） |

实施方式（2026-10-06 已完成）：`gh label edit --name` 对 6 个旧标签做 **rename**
（rename 会自动迁移 issue 上的标签引用，无需手工逐个改）——`bug`→`type/bug`、
`documentation`→`type/docs`、`enhancement`→`type/feature`、`question`→`type/question`、
`duplicate`→`status/duplicate`、`wontfix`→`status/wontfix`；新建 10 个缺失标签；
`invalid` 保留原名（语义无法并入 wontfix，低频不动）；`good first issue` / `help wanted`
保留（GitHub 生态惯例名）。⚠️ 实施注意：GitHub label **没有"别名"机制**，rename 是
唯一迁移方式（v1.0 草案"旧名保留为别名一期"的表述有误，已修正）。

### 3.2 Issue 模板（已存在且质量高，只做增量对齐）✅ 已实施

实测发现模板三件套**9 月已存在**（含安全漏洞私密上报提示、脱敏警告、设计良好的
字段），方案 v1.0 的"新建"实为**增量对齐**：

- `bug_report.yml`：labels `bug` → `type/bug`（对齐 taxonomy）；
- `feature_request.yml`：labels `enhancement` → `type/feature`；
- `config.yml`：已有 contact_links 指向 Discussions 与私密安全上报，**不动**。

深链同步（应用内报障 URL 预填）：**单独立项挂 1.6.3**——GitHub issue forms 的
URL 预填只支持 `template/title/labels`，**不支持字段级正文预填**，应用内深链目前
已能预填 title/body（非 forms 模式），改用 forms 模板后正文预填会失效，需评估
迁移收益（实测无强需求，暂缓）。

### 3.3 Dependabot 配置 —— **不创建 `.github/dependabot.yml`**（v1.1 设计矛盾修正）

v1.1 草案写了"npm ecosystem weekly schedule"的 dependabot.yml——**自相矛盾**：
配置 `updates` 段 = 开启 Dependabot **version updates PR**，与 Renovate（升级
PR 独占）双 PR 轰炸。修正：**不创建该文件**。Dependabot 的角色收缩为
**security alerts only**（自动开启，无需配置文件）——它的价值在 GHSA 漏洞
告警，升级动作全部由 Renovate 承担。Python 系误报源（`参考项目/`）已物理删除
且 §3.4 gitignore 防复发条目确保研究性目录不再进 git。

### 3.4 gitignore 防复发（新增条目）

```gitignore
# 研究性目录永不进 git（Dependabot 30 条误报的总源头：参考项目/cognee-main 的 uv.lock）
参考项目/
参考*/
research/
vendor-ref/
```

### 3.5 仓库设置核对（已确认，无需动作）

auto-merge=false（护栏 A ✓）· delete_branch_on_merge=true ✓ · Discussions=true（§6 配置版块）。

---

## 4. L1 规则层（批次 2，三个官方 workflow + 纪律文档）

### 4.1 labeler（PR 按路径打标；`pull-requests: write`；pin SHA）

`.github/labeler.yml` 映射示例：`src/main/**`→`main-process`、`src/renderer/**`→`renderer`、`resources/memory-hub/**`→`memory-engine`、`e2e/**`→`e2e`、`docs/**`→`documentation`。

### 4.2 first-interaction（首次 issue/PR 欢迎；`issues: write` + `pull-requests: write`）

欢迎语要点：感谢 + 诊断包导出路径（降 needs-info 率）+ CONTRIBUTING 链接。

### 4.3 issue-metrics（每周 cron 统计；无写权限，只产出报告）

指标：首次响应时长 / 存量 / needs-info 占比 → 输出到 Actions 日志（起步期不建看板）。

### 4.4 CONTRIBUTING.md（一次性）

报障引导（诊断包导出步骤）+ PR 流程（ruleset 5 必需检查 + 本地打包纪律链接）+ Discussions 指引（Q&A/Ideas 该去哪）。

---

## 5. L2 安全层（批次 3，两个加固 App）

| App | 装什么 | 权限 | 噪音评估 |
|---|---|---|---|
| **Socket**（公开仓库免费） | GitHub App：依赖变更的恶意行为检测（与 CodeQL 漏洞检测互补） | read-only 评审 | 低（只在供应链风险时发声） |
| **StepSecurity Harden-Runner**（Action） | runner 出口监控（DNS/HTTP 外联审计，异常告警） | 无需额外 token | 低（只在异常时告警） |

两者均与既有四层（CodeQL/Dependabot/gitleaks/audit-ci）互补不重叠。观察期各 2 周。

---

## 6. Discussions 配置（批次 1 内，网页操作 ~10 分钟）

| 版块 | 类型 | 谁能发 | 用途 | 配套 |
|---|---|---|---|---|
| **Announcements** | Announcements 类型 | 仅维护者 | 版本发布公告（比 Release 页多社区触达） | — |
| **Q&A** | Q&A 类型 | 任何人 | 用户提问 | 开"接受答案" + 2 条 reply templates（求诊断包 / 重复指引） |
| **Ideas** | Ideas 类型 | 任何人 | 功能建议收集箱 | 1 条 template（已记录话术） |
| General | General | — | 兜底 | 可保留可删 |

App 自动化**暂缓**（生态不成熟）；将来记忆引擎成熟后可做 dogfooding（自己的 agent 答社区 Q&A）。

---

## 7. 暂缓项（明确不做，及重启条件）

| 项 | 为什么暂缓 | 重启条件 |
|---|---|---|
| **L3 评审层**（CodeRabbit 或通用 agent review） | 批次 1 的 issue 质量未验证；CodeRabbit（第三方托管）与通用 agent（zcode 改造）方向未定 | 观察 issue/PR 量与质量后二选一 |
| **L4 分诊层**（gemini triage） | 依赖 label taxonomy 稳定 + 有真实 issue 量 | 月 issue ≥5 或手动 /triage 需求出现 |
| **L5 修复层**（zcode 通用 agent 改造） | 试点设计见 §8（最小闭环 + 前提清单） | zcode headless 能力确认 + 最小闭环试点 |
| **stale bot** | 公开仓库早期会误关真实报障 | 月 issue ≥20 再评估 |
| **Claude 系（claude-code-action）** | 用户拍板不绑 Claude 生态 | 通用 agent 改造落地后可作对照参考 |

---

## 7.1 L5 试点设计：zcode 通用 agent 改造（占位 → 最小闭环）

这是本方案的核心长期目标（用 superagent 维护 superagent）。按「最小闭环」
定义拆解，每个前提都是可独立验证的：

### 闭环四段

```
GitHub 事件（issue opened / label agent/zcode）
  → ① 触发路由（本地监听 or Actions runner）
  → ② 上下文提取（issue 正文按数据注入 prompt + 仓库 checkout）
  → ③ zcode headless 执行（非交互模式跑 agent 回合）
  → ④ 结果回写（gh：评论 / label / draft PR）
```

### 前提清单（全部为「需核实」状态，不编造能力）

| # | 前提 | 核实方式 |
|---|---|---|
| P1 | zcode CLI 有非交互/headless 模式（类似 `claude -p "prompt"`） | 查 zcode 文档 / `zcode --help` |
| P2 | headless 模式的认证方式（本机登录态？token？Actions 里如何注入） | 同上 |
| P3 | token 消耗模型（每次 agent 回合的成本可预估、可设上限） | 文档 / 实测一次 |
| P4 | 回合产出可结构化提取（最终评论文本 / 改动文件列表） | headless 输出格式确认 |

### 两种运行形态的取舍

| 形态 | 优点 | 缺点 |
|---|---|---|
| **Actions runner 跑**（凭证注入 runner） | 事件驱动全自动、无本机在线依赖 | 凭证需存 GitHub Secrets；agent 能力受 runner 环境限制 |
| **本机监听跑**（本机轮询/webhook → 本地 zcode） | 完整登录态与本地工具链；dogfooding 最真实 | 本机需开机；无自动触发时延 |

### 最小闭环定义（验收标准）

一个真实 issue（预设 `agent/zcode` label）→ agent 在独立分支提交一个可 review
的改动 → 维护者收到 PR 通知。**四段全通即闭环成立**，此后再扩展触发面与任务
类型；任一段无法打通即回到「暂缓」并记录阻塞点。

---

## 8. 负面清单（永不自动化）

1. Release PR 合并（护栏 A：CD 全绿 + `check:release-anchor` + 人工）；
2. 正式发版触发（release-please 流程 + 锚点三态自洽前置）；
3. 关闭/删除用户 issue（needs-info 14 天宽限 + 两次提醒后**人工**）;
4. priority 判定（agent/机器人永不判优先级）;
5. 依赖 automerge（Renovate 维持现状）。

---

## 9. 观察期与回退

| 层 | 观察期 | 成功标准 | 回退 |
|---|---|---|---|
| L0-L1 | — | 无 | 关 workflow 即回退 |
| L2 Socket/Harden-Runner | 2 周 | 零噪音或噪音有行动价值 | 卸载/删 step |
| Discussions | — | 有帖即运营 | 已是自带功能，无回退 |
| L3-L5 | 暂缓 | 重启条件见 §7 | 未启动 |

---

## 10. 成本

| 项 | 费用 |
|---|---|
| Actions（labeler/first-interaction/issue-metrics/Harden-Runner） | $0（公开仓库免费 runner） |
| Socket | $0（公开仓库免费档） |
| Discussions / 模板 / labeler | $0（自带功能） |
| **全部合计** | **$0** |

---

## 11. 变更日志（活文档）

| 日期 | 动作 | 层 | 备注 |
|---|---|---|---|
| 2026-10-06 | 本方案 v1.1 定稿（评审层/分诊层/修复层暂缓，L0-L2+Discussions 落地） | — | 用户审查通过后按批次实施 |
| （实施时追加） | | | |

---

## 12. 实施批次

| 批次 | 内容 | 工作量 | 谁 |
|---|---|---|---|
| **批次 1** | §3 全部（模板/label 迁移/dependabot.yml/gitignore）+ §6 Discussions 配置 + §4.4 CONTRIBUTING.md | ~1 小时 | agent（gh api + 文件） |
| **批次 2** | §4.1/4.2/4.3 三个 workflow + 验证 | ~1 小时 | agent |
| **批次 3** | §5 Socket + Harden-Runner（需维护者在网页各点一次安装授权） | ~30 分钟 | 用户授权 + agent 配置 |
| **持续** | §9 观察期评估 + §11 日志 | 每次 10 分钟 | — |

---

## 13. 附：1.6.x 发版事故的流程修正（已随 #90/#89/#93 落地，本方案引用）

- 护栏 A：Release PR 只在 CD 全绿后人工合并（`RELEASING.md §7.1`）；
- 护栏 B：`pnpm check:release-anchor` 三态自洽校验（合并前必跑，参照系=最近已收尾 Release PR）；
- CI 瘦身：Release PR quality 只跑润色门禁（实测 5min → 1m26s）；
- 本地打包验证先行：打包链路改动合并前本地全链验证（AGENTS.md 纪律）。
