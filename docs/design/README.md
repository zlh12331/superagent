# docs/design — 设计文档（常态化维护）

> 本目录是项目的**设计规范区**：长期有效的"怎么建"。与 [../implementation/](../implementation/)（实施记录，一次性归档）共同构成 docs/ 仅有的两个分区。
>
> 开发者向的代码库导航见 [code-wiki/](code-wiki/00-index.md)（基于代码真实实现整理，随代码同步维护）。

## 一、设计规范（长期有效）

| # | 文档 | 内容 | 挂钩门禁 |
|---|---|---|---|
| 01 | [架构设计](01-architecture.md) | 分层、进程模型、架构决策 | — |
| 02 | [技术栈](02-tech-stack.md) | 选型与版本 | — |
| 03 | [目录结构](03-directory-structure.md) | 全仓库目录地图 | — |
| 04 | [接口设计](04-interface-design.md) | 接口清单（是什么） | — |
| 05 | [功能设计](05-functional-design.md) | 功能模块设计（05 §14 为设置导航依据） | — |
| 06 | [测试设计](06-testing-design.md) | 测试体系与分层 | — |
| 07 | [工程化设计](07-engineering-design.md) | 门禁与工程纪律 | check:docs-scripts |
| 08 | [UX 设计规范](08-ux-guidelines.md) | UX 原则与验收清单 | — |
| 09 | [前端实现指南](09-ux-interaction-spec.md) | 交互实现（浏览器 pane 等） | — |
| 10 | [组件设计规范](10-component-design-spec.md) | 样式铁律 | check:tokens / check:comments / check:css-vars / check:animations |
| 11 | [可访问性](11-a11y-spec.md) | a11y 约定 | test:a11y |
| 12 | [性能规范](12-performance-spec.md) | 性能门槛与纪律 | check:bundle |
| 13 | [表单验证](13-form-validation-spec.md) | zod 单一真源 + 受控表单模式 | — |
| 14 | [i18n 规范](14-i18n-spec.md) | key 命名与新增流程 | check:i18n |
| 15 | [模型管理蓝图](15-model-management-spec.md) | 模型设置页形态（已落地） | — |
| 16 | [错误与日志](16-error-logging-spec.md) | 本地优先错误处理 | — |
| 17 | [安全规范](17-security-spec.md) | Electron 生产级基线 | check:csp-hash |
| 18 | [数据层规范](18-data-layer-spec.md) | SQLite + Drizzle 演化规范 | check:schema-drift |
| 19 | [IPC 集成规范](19-ipc-spec.md) | 契约开发流程（怎么加） | typecheck（handler 缺失编译期报错） |
| 20 | [自研资产对照](20-self-built-asset-audit.md) | 替换评估结论（勿重复讨论） | — |
| 21 | [状态管理规范](21-state-management-spec.md) | 四层架构与判定标准 | — |
| 22 | [AI 工具开发规范](22-ai-tool-spec.md) | 工具契约与脚手架 | scaffold:tool |
| 23 | [可观测性](23-otel-spec.md) | OTel 单通道（error-report 依据） | — |
| 24 | [IM 渠道集成](24-im-channel-spec.md) | 渠道适配器契约 | — |
| 32 | [新功能三阶段流程](32-feature-workflow-spec.md) | 需求 → 设计 → 实施（现行流程，试验性） | — |

## 二、治理（项目自身的健康度）

| 文档 | 内容 | 挂钩门禁 |
|---|---|---|
| [debt.md](debt.md) | 技术债台账（唯一可信清单；代码注释 `debt.md#dN` 指向它） | — |
| [data-ownership.md](data-ownership.md) | 数据所有权与缓存失效规范 | — |
| [typescript-dev-standards-ai.md](typescript-dev-standards-ai.md) | TypeScript 开发标准 | check:tsdoc / check:file-size / check:functions / check:complexity |
| [software-architecture-principles-ai.md](software-architecture-principles-ai.md) | 架构原则 | — |

## 三、代码导航（code-wiki/）

[code-wiki/00-index.md](code-wiki/00-index.md) 起，11 篇按编号即阅读顺序：01 架构 → 02 主进程入口 → 03 IPC 层 → 04 AI 层 → 05 工具系统 → 06 数据存储 → 07 支撑服务 → 08 渲染层 → 09 运行与门禁 → 10 依赖总览。

与规范区的分工：**design/ 讲"应该怎样"（规格），code-wiki/ 讲"实际是什么"（现状地图）**。两者都常态化维护。

## 四、常态化维护约定

1. **同 PR 同步**：代码改动涉及某篇规范时，同一 PR 内更新对应文档；源码注释里的 `docs/design/NN` 引用（含章节号 §x.y）一并核对，不留漂移。
2. **门禁兜底**：规范腐化由机器拦而非人工扫——`check:comments`（注释与代码漂移）、`check:docs-scripts`（文档脚本表 ↔ package.json 一致）、`tokens:check`（令牌生成物一致性）。漂移审计按 `verify:local:full` 节奏或重大改动后手动触发。
3. **编号规则**：设计规范 01~24 编号已固化；**新增设计规范用主题命名、不带编号**（如 `release-versioning-spec.md`），避免与实施记录的 NN 序列混淆。
4. **新功能落位**：按 32 号流程产出 `docs/implementation/NN-<slug>-spec.md`（实施记录编号从 40 续号）并在 [../implementation/README.md](../implementation/README.md) 登记。一次性交付归档进 `implementation/archive/`。
