# docs/design — 设计文档索引

> 本目录分三类：**规范**（长期有效的怎么建）、**实施记录**（一次性功能的需求→设计→实施状态）、
> **治理**（债务/所有权/开发标准）。新增文档按类归位并在本索引登记。
>
> 开发者向的代码库导航另见 [docs/code-wiki/00-index.md](../code-wiki/00-index.md)；
> 已完结的一次性交付记录（compose-spec 系列、UX 审计报告）在 [docs/archive/](../archive/)。

## 一、规范（长期有效）

| # | 文档 | 内容 |
|---|---|---|
| 01 | [架构设计](01-architecture.md) | 分层、进程模型、架构决策 |
| 02 | [技术栈](02-tech-stack.md) | 选型与版本 |
| 03 | [目录结构](03-directory-structure.md) | 全仓库目录地图 |
| 04 | [接口设计](04-interface-design.md) | 接口清单（是什么） |
| 05 | [功能设计](05-functional-design.md) | 功能模块设计（05 §14 为设置导航依据） |
| 06 | [测试设计](06-testing-design.md) | 测试体系与分层 |
| 07 | [工程化设计](07-engineering-design.md) | 门禁与工程纪律 |
| 08 | [UX 设计规范](08-ux-guidelines.md) | UX 原则与验收清单 |
| 09 | [前端实现指南](09-ux-interaction-spec.md) | 交互实现（浏览器 pane 等） |
| 10 | [组件设计规范](10-component-design-spec.md) | 样式铁律（check:tokens 依据） |
| 11 | [可访问性](11-a11y-spec.md) | a11y 约定 |
| 12 | [性能规范](12-performance-spec.md) | 性能门槛与纪律（check:bundle 依据） |
| 13 | [表单验证](13-form-validation-spec.md) | zod 单一真源 + 受控表单模式 |
| 14 | [i18n 规范](14-i18n-spec.md) | key 命名与新增流程（check:i18n 依据） |
| 15 | [模型管理蓝图](15-model-management-spec.md) | 模型设置页形态（已落地） |
| 16 | [错误与日志](16-error-logging-spec.md) | 本地优先错误处理 |
| 17 | [安全规范](17-security-spec.md) | Electron 生产级基线 |
| 18 | [数据层规范](18-data-layer-spec.md) | SQLite + Drizzle 演化规范 |
| 19 | [IPC 集成规范](19-ipc-spec.md) | 契约开发流程（怎么加） |
| 20 | [自研资产对照](20-self-built-asset-audit.md) | 替换评估结论（勿重复讨论） |
| 21 | [状态管理规范](21-state-management-spec.md) | 四层架构与判定标准 |
| 22 | [AI 工具开发规范](22-ai-tool-spec.md) | 工具契约与脚手架 |
| 23 | [可观测性](23-otel-spec.md) | OTel 单通道（error-report 依据） |
| 24 | [IM 渠道集成](24-im-channel-spec.md) | 渠道适配器契约 |

## 二、实施记录（一次性功能：需求 → 设计 → 实施状态）

> 形态与判级依据见 [32 号](32-feature-workflow-spec.md)。新功能按 32 号流程产出
> `NN-<slug>-spec.md` 并在本表登记。

| # | 文档 | 状态 |
|---|---|---|
| 25 | [远程控制](25-remote-control-spec.md) | 已实施（局域网配对） |
| 26 | [记忆引擎集成](26-memory-engine-spec.md) | 已实施（vendored 上游 + sidecar） |
| 27 | [自动更新](27-auto-update-spec.md) | 已实施（含 beta 更新通道语义） |
| 28 | [托盘与关窗语义](28-tray-spec.md) | 已实施 |
| 29 | [CI/CD 流水线](29-pipeline-spec.md) | 已实施（六平台质量 + 产物验证分层） |
| 30 | [后台驻留缺陷修复](30-residency-fix-spec.md) | 已全部实施 |
| 31 | [失效自动化](31-invalidation-automation-spec.md) | 已实施 |
| 32 | [新功能三阶段流程](32-feature-workflow-spec.md) | 现行流程（试验性） |
| 33 | [系统通知设置](33-notification-settings-spec.md) | 已实施 |
| 34 | [网络代理](34-network-proxy-spec.md) | 已实施 |
| 35 | [界面缩放](35-ui-zoom-spec.md) | 已实施 |
| 36 | [设置面缺口补全](36-settings-gaps-spec.md) | 已实施（审批通知/终端/快捷键/清空会话） |
| 37 | [设置面补全二期](37-settings-gaps-2-spec.md) | 已实施（编辑器域/备份可见性） |
| 38 | [Agent 回合 XState 编排化](38-agent-turn-xstate-spec.md) | 已全部实施（阶段 1 编排者 + 阶段 2 决策面，随 1.5.0 发布） |
| 39 | [GitHub 开源自动化运维](39-oss-automation-spec.md) | L0+L1 已实施（label 四组/三 workflow/护栏/gitignore）；L3-L5 按 §7 重启条件暂缓 |

## 三、治理

| 文档 | 内容 |
|---|---|
| [debt.md](debt.md) | 技术债台账（唯一可信清单） |
| [data-ownership.md](data-ownership.md) | 数据所有权与缓存失效规范 |
| [typescript-dev-standards-ai.md](typescript-dev-standards-ai.md) | TypeScript 开发标准（check:file-size/tsdoc 依据） |
| [software-architecture-principles-ai.md](software-architecture-principles-ai.md) | 架构原则 |
