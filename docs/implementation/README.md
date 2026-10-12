# docs/implementation — 实施记录（一次性归档）

> 本目录收录**已完结或阶段性完结的功能实施记录**：每个功能一篇 `NN-<slug>-spec.md`，
> 记录"需求 → 设计 → 实施"全过程与状态。与 [../design/](../design/README.md)（设计规范，常态化维护）相对——
> 规范讲"怎么建"，实施记录讲"当时怎么做的、为什么"。

## 一、实施记录索引

| # | 文档 | 状态 |
|---|---|---|
| 25 | [远程控制](25-remote-control-spec.md) | 已实施（局域网配对） |
| 26 | [记忆引擎集成](26-memory-engine-spec.md) | 已实施（vendored 上游 + sidecar） |
| 27 | [自动更新](27-auto-update-spec.md) | 已实施（含 beta 更新通道语义） |
| 28 | [托盘与关窗语义](28-tray-spec.md) | 已实施 |
| 29 | [CI/CD 流水线](29-pipeline-spec.md) | 已实施（六平台质量 + 产物验证分层） |
| 30 | [后台驻留缺陷修复](30-residency-fix-spec.md) | 已全部实施 |
| 31 | [失效自动化](31-invalidation-automation-spec.md) | 已实施 |
| 33 | [系统通知设置](33-notification-settings-spec.md) | 已实施 |
| 34 | [网络代理](34-network-proxy-spec.md) | 已实施 |
| 35 | [界面缩放](35-ui-zoom-spec.md) | 已实施 |
| 36 | [设置面缺口补全](36-settings-gaps-spec.md) | 已实施（审批通知/终端/快捷键/清空会话） |
| 37 | [设置面补全二期](37-settings-gaps-2-spec.md) | 已实施（编辑器域/备份可见性） |
| 38 | [Agent 回合 XState 编排化](38-agent-turn-xstate-spec.md) | 已全部实施（阶段 1 编排者 + 阶段 2 决策面，随 1.5.0 发布） |
| 39 | [GitHub 开源自动化运维](39-oss-automation-spec.md) | L0+L1 已实施（label 四组/三 workflow/护栏/gitignore）；L3-L5 按 §7 重启条件暂缓 |

> 32 号（新功能三阶段流程）是**现行流程规范**而非一次性记录，留在 [../design/32-feature-workflow-spec.md](../design/32-feature-workflow-spec.md)。

## 二、登记约定

1. 新功能按 32 号流程（`../design/32-feature-workflow-spec.md`）产出 `NN-<slug>-spec.md` 落本目录，**编号从 40 续号**，并在上方索引表登记。
2. 实施记录写完后**冻结**：后续语义演进时更新对应的设计规范（`../design/`），不在实施记录里追加；实施记录只补"实施状态"一栏。
3. 彻底过时的实施记录直接删除（git 历史可追回），不设归档目录。
