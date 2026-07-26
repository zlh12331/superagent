# AI/Agent 网文写作软件 —— 产品需求文档（PRD）

> **版本**：v5.2
> **日期**：2026-04-18
> **状态**：设计阶段（B1-B8 设计完成，B9-B12 已删除——原计划模块经评估后合并至现有模块或降优先级）
> **产品定位**：以 AI/Agent 为中心的网文写作软件
> **数据策略**：不依赖任何读者数据，所有分析基于作品内部数据和公开信息

---

## 文档目录

- [术语表](#术语表)
- [第 1 章 产品概述](#第-1-章-产品概述)
- [第 2 章 核心设计理念](#第-2-章-核心设计理念)
- [第 3 章 系统架构](#第-3-章-系统架构)
- [第 4 章 Agent 体系](#第-4-章-agent-体系)
- [第 5 章 上下文管理系统](#第-5-章-上下文管理系统)
- [第 6 章 算法层](#第-6-章-算法层)
- [第 7 章 角色模拟 Agent](#第-7-章-角色模拟-agent)
- [第 8 章 角色记忆系统](#第-8-章-角色记忆系统)
- [第 9 章 B1 大纲系统](#第-9-章-b1-大纲系统)
- [第 10 章 B2 隐含信息不一致检测](#第-10-章-b2-隐含信息不一致检测)
- [第 11 章 B3 因果链断裂检测](#第-11-章-b3-因果链断裂检测)
- [第 12 章 B4 长程风格一致性](#第-12-章-b4-长程风格一致性)
- [第 13 章 B5 多线叙事同步](#第-13-章-b5-多线叙事同步)
- [第 14 章 B6 角色状态桥梁层](#第-14-章-b6-角色状态桥梁层)
- [第 15 章 B7 伏笔协调层](#ch15)
- [第 16 章 B8 节奏控制](#ch16)
- [第 17 章 跨问题运行时协调](#第-17-章-跨问题运行时协调)
- [第 18 章 产品功能与交互概览](#第-18-章-产品功能与交互概览)
- [第 19 章 技术规格](#第-19-章-技术规格)
  - [19.3.1 性能基准假设](#1931-性能基准假设)
  - [19.4.4 基础设施容错策略](#1944-基础设施容错策略)
  - [19.5 数据生命周期管理](#195-数据生命周期管理)
  - [19.6 可配置参数清单](#196-可配置参数清单)
- [第 20 章 实施路线图](#第-20-章-实施路线图)
- [附录 A 问题清单](#附录-a-问题清单)
- [附录 B 关键设计决策记录](#附录-b-关键设计决策记录)
- [附录 C B4 长程风格一致性完整设计方案](#appendix-c)
- [附录 D B5 多线叙事同步完整设计方案](#appendix-d)
- [附录 E B4 盲区补充与迭代设计（E.1-E.24）](#appendix-e)
- [附录 F 跨模块事件总线完整设计方案（F.1-F.9）](#appendix-f)
- [附录 G 统一底层架构完整设计方案（G.1-G.5）](#appendix-g)
- [附录 H 正文代码块完整实现（H.1-H.2）](#appendix-h)

---

## 阅读指南

### 文档结构

本文档采用"摘要+附录"三层结构：

<!-- 表格说明：文档阅读指南，按层级列出各章节内容概要及目标读者 -->
| 层级 | 内容 | 读者 |
|------|------|------|
| 第 1-8 章 | 产品概述、设计原则、架构、Agent 体系 | 全体读者 |
| 第 9-11 章 | B1-B3 完整设计 | 开发者 |
| 第 12-13 章 | B4/B5 设计摘要（→完整设计见附录 C/D） | 架构师、产品经理 |
| 第 14-16 章 | B6 角色状态桥梁 / B7 伏笔协调 / B8 节奏控制 | 开发者 |
| 第 17 章 | 跨问题运行时协调（事件总线/引擎/架构） | 架构师、开发者 |
| 第 16-19 章 | 核心模块、交互设计、技术规格（性能 SLA、容错策略、可配置参数）、路线图 | 全体读者 |
| 附录 A-B | 问题清单、设计决策 | 全体读者 |
| 附录 C | B4 长程风格一致性完整设计（C.1-C.32，含盲区补充索引→附录 E） | B4 开发者 |
| 附录 D | B5 多线叙事系统完整设计（D.1-D.23，共 23 节） | B5 开发者 |
| 附录 E | B4 盲区补充与迭代设计（E.1-E.24，从附录 C 分离） | B4 开发者 |
| 附录 F | 跨模块事件总线完整设计（F.1-F.9，共 9 节） | 事件总线开发者 |
| 附录 G | 统一底层架构完整设计（G.1-G.5，共 5 节） | 底层架构开发者 |
| 附录 H | 正文超长代码块完整实现（H.1-H.2） | 开发者 |

### 模块索引

<!-- 表格说明：模块索引，列出 B1-B8 各模块对应的设计章节和关键子节 -->
| 模块 | 设计章节 | 关键子节 |
|------|---------|------|
| B1 大纲系统 | 第 9 章 | 9.2 大纲系统六大核心功能、9.4 大纲数据模型与角色弧线 |
| B2 隐含信息检测 | 第 10 章 | 10.2 17条检查机制 |
| B3 因果链检测 | 第 11 章 | 11.2 核心机制（含读者记忆衰减模型） |
| B4 风格一致性 | 第 12 章 + 附录 C（C.1-C.32）+ 附录 E（E.1-E.24） | C.4 M1 风格宪法系统、C.8 M5 AI 味检测器 |
| B5 多线叙事 | 第 13 章 + 附录 D（D.1-D.23） | D.3 六层架构、D.4 M1 叙事线存档点系统 |
| B6 角色状态桥梁 | 第 14.1-14.4 章 | 14.2 CharacterStateBridge、14.3 弧线管理 |
| B7 伏笔协调层 | 第 15 章 | 15.2 统一伏笔视图、15.7 伏笔密度监控 |
| B8 节奏控制 | 第 16 章 | 16.2 节奏画像引擎、Pacing（5 值节奏枚举）、16.4 节奏检测器 |
| 第 19 章 技术规格 | 第 19 章 | 19.3.1 性能基准假设、19.4.4 基础设施容错策略、19.6 可配置参数清单 |

---

## 术语表

<!-- 表格说明：术语表，列出文档中核心术语的中英文名称及定义 -->
| 术语 | 英文 | 定义 |
|------|------|------|
| 大纲系统 | Outline System | B1 模块，管理三级大纲（卷纲→章纲→节纲）和写作上下文生成 |
| 隐含信息检测 | Hidden Info Detection | B2 模块，检测角色设定/世界观/时间线等隐含信息的矛盾 |
| 因果链检测 | Causal Chain Detection | B3 模块，追踪事件间的因果关系，检测因果断裂 |
| 风格一致性 | Style Consistency | B4 模块，通过 50 维特征向量监控写作风格的长程一致性 |
| 多线叙事 | Multi-Narrative | B5 模块，管理多条叙事线的并行推进和交织 |
| 角色状态桥梁 | Character State Bridge | B6 模块，连接大纲角色弧线与运行时角色状态的桥梁层 |
| 伏笔协调 | Foreshadow Coordinator | B7 模块，统一管理伏笔的埋设、追踪和回收 |
| 节奏控制 | Rhythm Control | B8 模块，通过节奏画像和检测器控制章节节奏 |
| 统一实体引擎 | UnifiedEntityEngine | 第 17 章，统一管理所有实体（角色/物品/地点/事件）的底层引擎 |
| 统一检测管线 | UnifiedDetectionPipeline | 第 17 章，统一的检测任务调度和执行管线 |
| 风格宪法 | Style Constitution | B4 模块 M1，定义作品风格的 50 维特征向量基准 |
| 风格守护 Agent | Style Guardian Agent | B4 模块 M16，实时监控风格漂移并触发纠偏的 Agent |
| 节奏画像 | Rhythm Profile | B8 模块，描述章节节奏特征的多维数据结构 |
| 伏笔密度 | Foreshadowing Density | B7 模块，衡量当前章节中活跃伏笔数量的指标 |
| 乐观锁 | Optimistic Lock | 使用 version 字段实现的并发控制机制，冲突时重试 |
| 插件化配置层 | PluginConfigLayer | 第 17 章，支持按题材/用户自定义配置的扩展机制 |
| 规则 DSL | Rule DSL | 第 17 章，用于定义自定义检测规则的领域特定语言 |
| 降级策略 | Degradation Strategy | LLM 或检测不可用时的备选方案，确保核心功能可用 |
| PostSavePipeline | Post-Save Pipeline | 章节保存后自动执行的异步检测和统计管线 |
| 漂移检测 | Drift Detection | B4 模块 M11，检测写作风格随时间偏移基准的程度 |

---

<a id="ch1"></a>
## 第 1 章 产品概述

### 1.1 产品愿景

以 AI/Agent 为中心的网文写作软件，不是一个"帮你写小说的 AI"，而是一个**"懂你的专业创作伙伴"**。

### 1.2 核心隐喻

**"作者为导演，AI 为剧组"**

| 角色 | 对应 | 职责 |
|------|------|------|
| 作者 | 导演 | 掌控创作方向、做出最终决策、拥有创作主权 |
| AI Agent | 专业剧组 | 每个 Agent 扮演一个专业角色（编剧、编辑、场记等） |
| 作品 | 电影 | 最终产出的网文作品 |

### 1.3 目标用户

| 用户层级 | 特征 | 核心需求 | AI 介入程度 |
|------|------|------|-----------|
| 新手作者 | 经验不足、易弃坑 | 引导式创作、降低门槛 | 高（AI 主导+人工审核） |
| 进阶作者 | 有一定经验、效率瓶颈 | 提效工具、灵感辅助 | 中（AI 辅助+人工主导） |
| 职业作者 | 日均更新 4000 字以上、商业导向 | 质量把控、数据洞察 | 中低（AI 辅助特定环节） |
| 大神作者 | 粉丝基础、品牌 IP | 创意激发、团队协作 | 低（按需调用） |

### 1.4 市场背景

- 中国网络文学创作者突破**1000 万**，完成率仅约**15%**
- 超过**68%**的头部作者已常态化使用 AI 工具辅助创作
- AI 生成内容同质化严重、逻辑断层频发，难以支撑百万字级长篇

> **文档状态**：当前处于设计阶段（v5.2），各模块设计已完成，待解决的设计问题汇总于 [附录 A 问题清单](#附录-a-问题清单)。

---

<a id="ch2"></a>
## 第 2 章 核心设计理念

### 2.1 四大设计原则

#### 原则一：创作主权不可侵犯
- AI 永远是建议者，不是决策者
- 所有 AI 生成内容必须经过作者确认
- 提供"撤销"、"回退"、"版本对比"等安全机制
- 作者可以随时覆盖、修改、拒绝 AI 的任何建议

#### 原则二：上下文是生命线
- 百万字级作品的上下文不能丢失
- 设定、角色、伏笔、时间线等信息全局可追溯
- Agent 之间共享统一的知识库
- "记忆系统"是产品的核心竞争力

#### 原则三：渐进式 AI 介入
- 从"完全手动"到"AI 辅助"到"AI 主导（人工审核）"可调节
- AI 介入程度应该是**滑块式**而非**开关式**

#### 原则四：透明可解释
- AI 的每一步"思考"过程都应可见
- 为什么建议这样写？依据是什么？参考了哪些设定？
- 让作者建立对 AI 的信任

### 2.2 核心设计哲学

```
初始认知                          最终认知
─────────                        ─────────
AI帮我写小说          →    AI是我的专业创作伙伴
上下文塞进Prompt       →    分层记忆+按需检索
单一LLM包打天下        →    多Agent协作+算法层
风格要保持一致         →    风格变化必须有意为之
检测所有问题           →    分级检查+宁可漏报不误报
问作者问题             →    给作者方案（含预设选项+自由输入）
```

### 2.3 千万字级分层治理

对于超长篇（1000 万字+），采用分层治理策略：

| 优先级 | 内容 | 约束强度 | 技术可行性 |
|------|------|------|-----------|
| 第一优先级 | 核心设定（主角属性、核心关系、顶层规则） | 硬约束，强制校验 | 完全可行 |
| 第二优先级 | 重要情节（成长线、关键伏笔、转折点） | 软约束，追踪+提醒 | 基本可行 |
| 第三优先级 | 细节描写（配角穿着、场景风格） | 不约束，尽力而为 | 部分可行 |
| 第四优先级 | 已遗忘细节（龙套台词、一次性场景） | 放弃 | 不适用 |

---

<a id="ch3"></a>
## 第 3 章 系统架构

### 3.1 整体架构

```text
┌─────────────────────────────────────────────────────────────┐
│                        用户交互层                             │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐  │
│  │ 编辑器    │ │ 设定面板  │ │ 大纲视图  │ │ 作品健康度仪表盘  │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────────┘  │
├─────────────────────────────────────────────────────────────┤
│                      Agent 编排层                             │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │  Orchestrator（编排器）                                   │  │
│  │  意图识别 → 任务分解 → 上下文装配 → Agent调度 → 结果整合  │  │
│  │  ┌─────────────────────────────────────────────────┐    │  │
│  │  │  ContextRouter（上下文路由器）                     │    │  │
│  │  │  根据任务类型，从记忆层按需拉取上下文               │    │  │
│  │  └─────────────────────────────────────────────────┘    │  │
│  └─────────────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────┤
│                      专业Agent层                              │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐      │
│  │写作  │ │审校  │ │设定  │ │大纲  │ │风格  │ │灵感  │      │
│  │Agent │ │Agent │ │Agent │ │Agent │ │Agent │ │顾问  │      │
│  └──────┘ └──────┘ └──────┘ └──────┘ └──────┘ └──────┘      │
│  ┌──────┐ ┌──────┐                                         │
│  │角色  │ │连续性│                                         │
│  │模拟  │ │检查  │                                         │
│  │Agent │ │Agent │                                         │
│  └──────┘ └──────┘                                         │
├─────────────────────────────────────────────────────────────┤
│                      算法层（零LLM成本）                       │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐  │
│  │一致性检查 │ │时间线校验│ │伏笔追踪  │ │ 实体倒排索引     │  │
│  │称谓检查  │ │数值校验  │ │状态追踪  │ │ 风格统计引擎     │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────────┘  │
├─────────────────────────────────────────────────────────────┤
│                      知识与记忆层                              │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐  │
│  │ 角色数据库│ │ 世界观库  │ │ 伏笔追踪  │ │ 风格样本库       │  │
│  │ 角色记忆库│ │ 世界状态  │ │ 因果图谱  │ │ 向量数据库       │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────────┘  │
├─────────────────────────────────────────────────────────────┤
│                      基础设施层                               │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐  │
│  │ LLM接入  │ │ PostgreSQL│ │ Redis    │ │ 多端同步          │  │
│  │ 多模型路由│ │ Neo4j    │ │ Milvus   │ │ 版本管理          │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 三层协同架构

```
算法层（拦截80%机械性错误）
  → 确定性、零成本、实时运行
  → 角色属性冲突、时间线、称谓、伏笔超期

LLM层（处理需要语义理解的20%）
  → 按需触发、有成本
  → 逻辑因果、情感基调、风格匹配

人工层（最终决策）
  → 创意判断
  → 作者确认/修改
```

### 3.3 统一底层架构概要

> 系统的核心数据层由四大统一组件构成（完整设计见 [附录 G](#appendix-g)），各 B 模块通过这些统一接口访问共享数据，避免模块间的直接耦合。
>
> | 统一组件 | 附录章节 | 核心职责 | 服务模块 |
> |---------|---------|---------|---------|
> | `UnifiedEntityEngine` | G.1 | 统一实体管理（角色/物品/地点/组织的 CRUD、属性更新、铁事实保护） | B2/B3/B5/B6/B7/B8 |
> | `UnifiedDetectionPipeline` | G.2 | 统一检测调度（检测器注册、结果标准化、严重性分级、去重合并） | B1/B2/B3/B4/B7/B8 |
> | `CrossModuleEventBus` | G.3 / 附录 F | 跨模块事件总线（章节保存/删除/合并时的级联通知与数据一致性维护） | 所有 B 模块 |
> | `VisualizationConfig` | G.4 | 统一可视化配置（检查结果展示格式、仪表盘布局、通知策略） | B2/B3/B4/B7/B8 |
>
> **设计原则**：各 B 模块的正文中保留独立的算法设计和接口定义，但运行时数据访问统一通过上述组件。迁移映射关系见 [附录 B](#附录-b-关键设计决策记录)。

---

<a id="ch4"></a>
## 第 4 章 Agent 体系

### 4.1 Agent 角色定义

#### 核心 Agent 组

| Agent | 剧组角色 | 职责 | 触发场景 |
|------|----------|------|----------|
| Orchestrator | 导演助理 | 意图识别、任务路由、上下文装配、结果整合 | 所有交互的入口 |
| WriterAgent | 编剧 | 正文生成、续写、扩写、改写 | 写作场景 |
| ReviewerAgent | 审稿编辑 | 逻辑检查、质量评估、问题标注 | 写作完成后 |
| StyleAgent | 文字编辑 | 风格润色、修辞优化、去 AI 味 | 润色场景 |

#### 设定 Agent 组

| Agent | 剧组角色 | 职责 | 触发场景 |
|------|----------|------|----------|
| WorldBuilderAgent | 美术指导 | 世界观构建、力量体系设计 | 设定阶段 |
| CharacterAgent | 选角导演 | 角色创建、性格分析、关系网管理；运行时状态持久化+弧线一致性自检（B6 V2 增强） | 角色设计、写作中状态同步 |
| ContinuityAgent | 场记 | 时间线管理、设定一致性检查；伏笔追踪已部分由 B7 ForeshadowCoordinator 接手 | 持续运行 |

#### 辅助 Agent 组

| Agent | 剧组角色 | 职责 | 触发场景 |
|------|----------|------|----------|
| OutlineAgent | 分集编剧 | 大纲生成、结构分析、节奏规划 | 大纲阶段 |
| InspirationAgent | 创意顾问 | 灵感激发、头脑风暴、创意组合 | 卡文时 |

#### 协调层组（B6/B7/B8 引入）

> **注**：协调层组件不直接面向用户，而是在 Agent 协作流程中作为中间件被 Orchestrator 或其他 Agent 调用，提供跨章节的状态持久化、伏笔统一管理和节奏分析能力。

| 组件 | 剧组角色 | 职责 | 触发场景 | 来源 |
|------|----------|------|----------|------|
| CharacterStateBridge | 角色状态桥梁 | 角色运行时状态的持久化存储、大纲衔接、记忆同步；确保角色在跨章节写作中保持弧线一致 | 每次涉及角色的写作/检查前 | B6 |
| ForeshadowCoordinator | 伏笔协调器 | 维护全局伏笔统一视图、AI 自动识别新伏笔、回收检测、密度监控；替代 ContinuityAgent 的部分伏笔追踪职责 | 每次章节生成/审阅时 | B7 |
| RhythmProfiler | 节奏画像引擎 | 基于已写章节计算节奏指纹（紧张/舒缓/高潮分布），生成前章节奏画像 | WriterAgent 生成初稿前 | B8 |
| RhythmDetector | 节奏检测器 | 对新生成章节进行节奏分析，输出节奏评分与异常段落标注 | ReviewerAgent 审阅完成后 | B8 |
| RhythmAdvisor | 节奏建议引擎 | 基于 RhythmDetector 的检测结果，生成具体的节奏优化建议（如"第 3 段需加速"、"对话密度过高"） | RhythmDetector 检测完成后 | B8 |

### 4.2 结构化通信协议

子 Agent 返回结构化结果而非自由文本，减少信息损失：

```json
{
  "task_id": "write_chapter_100",
  "output": {
    "content": "正文内容...",
    "metadata": {
      "characters_involved": ["林风", "苏瑶"],
      "settings_referenced": ["暗影秘境"],

      /* ===== 伏笔字段（B7 增强） ===== */
      /* 原始简单列表已升级为含B7元数据的结构化视图 */
      "foreshadowing": {
        "advanced": [
          {
            "id": "#023",
            "name": "神秘玉佩",
            "planted_chapter": 23,
            "status": "active",
            "expected_recall_chapter": null,
            "density_zone": "high"
          }
        ],
        "planted": [
          {
            "id": "#067",
            "name": "秘境守护者",
            "planted_chapter": 100,
            "status": "new",
            "expected_recall_chapter": null,
            "density_zone": "normal"
          }
        ]
      },

      /* ===== B7 增强伏笔视图 ===== */
      /* ForeshadowCoordinator 提供的完整伏笔分析 */
      "foreshadowing_enhanced": {
        "total_active": 12,
        "overdue_count": 2,
        "density_score": 0.73,
        "reader_memory_hint": "读者可能已遗忘#015_古剑残片，建议近期回收",
        "cross_line_foreshadows": ["#023_神秘玉佩 → #045_玉佩共鸣"],
        "suggested_recalls": ["#015_古剑残片"]
      },

      /* ===== B6 角色运行时状态 ===== */
      /* CharacterStateBridge 提供的角色持久化摘要 */
      "character_runtime_states": {
        "林风": {
          "current_arc_phase": "觉醒中期",
          "emotional_state": "坚定但隐忧",
          "key_relationships_changed": ["苏瑶：信任度+1"],
          "power_level": "筑基后期",
          "unresolved_conflicts": ["身世之谜"]
        },
        "苏瑶": {
          "current_arc_phase": "守护者觉醒",
          "emotional_state": "担忧",
          "key_relationships_changed": [],
          "power_level": "金丹初期",
          "unresolved_conflicts": ["家族压力"]
        }
      },

      /* ===== B6 弧线上下文 ===== */
      /* 当前章节在整体角色弧线中的位置 */
      "arc_context": {
        "primary_arc": "主角觉醒线",
        "arc_progress": 0.45,
        "current_beat": "挫折后的反思",
        "next_expected_beat": "突破契机"
      },

      /* ===== B8 节奏画像 ===== */
      /* RhythmProfiler 计算的前章节奏指纹 */
      "rhythm_fingerprint": {
        "tension_curve": [3, 5, 7, 8, 6, 4, 7, 9, 8, 5],
        "pace_pattern": "medium_fast",
        "dialogue_ratio": 0.35,
        "action_ratio": 0.25,
        "description_ratio": 0.40,
        "climax_position": 0.78
      },

      /* ===== B8 节奏评分 ===== */
      /* RhythmDetector 对新章节的节奏评估 */
      "rhythm_score": {
        "overall": 0.82,
        "tension_consistency": 0.75,
        "pacing_appropriateness": 0.88,
        "climax_timing": 0.85,
        "issues": [
          {
            "paragraph": 12,
            "type": "pacing_drop",
            "description": "连续3段静态描写，节奏明显下降",
            "suggestion": "插入对话或动作场景恢复节奏"
          }
        ]
      },

      "word_count": 3500,
      "emotion_curve": [3, 5, 7, 8, 6],
      "style_match_score": 0.87
    }
  }
}
```

### 4.3 Agent 协作流程

> **注**：检测类 Agent（审校 Agent、连续性检查 Agent）的检测逻辑通过 #G.2 `UnifiedDetectionPipeline` 统一调度，各检测器以 `BaseDetector` 子类注册。

以"写一个新章节"为例：

```text
用户请求 → Orchestrator（意图识别+任务分解+上下文装配）
  │
  ├──► CharacterStateBridge（B6：加载角色持久化状态、弧线上下文）
  ├──► ContinuityAgent（检查相关设定、角色状态）
  │     └──► ForeshadowCoordinator（B7：提供伏笔统一视图+密度监控数据）
  ├──► OutlineAgent（检查大纲位置、爽点/冲突、情感节奏）
  ├──► CharacterAgent（角色状态确认、记忆检索；B6 V2增强：弧线一致性自检）
  │
  ├──► RhythmProfiler（B8：计算前章节奏画像，生成节奏指纹）
  │
  ▼
WriterAgent（基于上下文+节奏画像 生成初稿）
  │     └── 注入节奏上下文（rhythm_fingerprint + rhythm_score）
  │
  ▼
ReviewerAgent（逻辑一致性、设定冲突检测）
  │
  ├──► RhythmDetector（B8：对新章节进行节奏检测，输出节奏评分）
  │     └──► RhythmAdvisor（B8：基于检测结果生成节奏优化建议）
  │
  ▼
StyleAgent（去AI味、风格统一、节奏优化；参考RhythmAdvisor建议）
  │
  ▼
Orchestrator（整合结果）→ 用户审阅 → 反馈进入学习循环
```

---

<a id="ch5"></a>
## 第 5 章 上下文管理系统

### 5.1 四层上下文架构

```text
                    信息量（从多到少）
                    ▲
         百万字全文  │
                    │
         全部设定    │
                    │
    ────────────────┼─────────────── 关键分界线
                    │
         摘要/索引   │  ← 决定注入什么
                    │
         精选上下文  │  ← 实际注入
                    │
                    └──────────────► 精度（从低到高）
```

#### 第一层：冷存储（不入上下文，按需查询）

```
容量：无限（数据库）
访问：Agent通过工具调用主动查询
内容：全部章节原文、完整角色数据库、完整世界观设定、完整伏笔追踪表
```

#### 第二层：温存储（摘要索引，自动注入）

```
容量：2K-8K tokens
内容：
  • 全书大纲摘要 ~500 tokens
  • 当前卷纲要 ~500 tokens
  • 角色索引（名字+一句话描述）~800 tokens
  • 活跃伏笔索引（编号+一句话）~500 tokens
  • 最近10章一句话摘要 ~1000 tokens
  • 世界观核心规则 ~800 tokens
```

> **合计**：约 4100 tokens

设计要点——给 Agent 一个**目录**，而不是全书：

```
❌ 注入全部角色详情 → 30个角色即超出上下文窗口限制
✅ 注入角色索引 → "相关角色：林风、苏瑶、云墨子。如需详情请调用 query_character(name)"
```

#### 第三层：热存储（当前任务强相关，精确注入）

```
容量：3K-10K tokens
由 ContextRouter 根据当前任务精准选择：
  • 当前章节直接相关角色的详细信息（2-3个）
  • 当前场景需要的设定细节
  • 当前需要推进的伏笔（1-2条）
  • 前一章结尾段落
  • 本章细纲
```

#### 第四层：动态压缩（运行时保障）

由 ContextBudgetManager（上下文预算管理器）确保（见 5.2 节）。

### 5.2 ContextBudgetManager

```python
class ContextBudgetManager:
    """上下文预算管理器：确保总注入量不超限"""

    def __init__(self, model_context_limit: int):
        self.budget = {
            "system_prompt": 2000,       # Agent指令
            "dialogue_history": 3000,    # 对话历史
            "user_input": 2000,          # 用户当前输入
            "injected_context": None,     # 动态计算
            "output_space": 8000,         # 预留生成空间
        }
        self.budget["injected_context"] = max(  # 防止负数预算
            0,
            model_context_limit
            - sum(v for k, v in self.budget.items() if v is not None)
        )

    def allocate(self, context_items: list) -> list:
        """按优先级分配上下文预算"""
        priorities = {
            "chapter_outline": 10,       # 本章细纲（最重要）
            "prev_chapter_ending": 9,    # 上章结尾
            "active_characters": 8,      # 当前角色
            "scene_setting": 7,          # 场景设定
            "foreshadowing": 6,          # 伏笔
            "style_samples": 5,          # 风格样本
            "recent_summary": 4,         # 近期摘要
            "world_index": 3,            # 世界观索引

            # B6/B7/B8 优先级定义
            "character_runtime": 2,      # B6 角色运行时状态（arc_phase, current_emotion, current_goals）
            "rhythm_context": 3,         # B8 节奏上下文（prev_chapter_rhythm, expected_pacing, rhythm_guide）
            "foreshadowing_enhanced": 5, # B7 增强伏笔视图（reader_memory, density, dependency_chain）
        }

        # B6/B7/B8 Token 预算分配
        # character_runtime: 约200 tokens/角色（核心角色3-5个，总计600-1000 tokens）
        # foreshadowing_enhanced: 约300 tokens（统一视图摘要+密度+依赖链）
        # rhythm_context: 约150 tokens（前章节奏画像+预期节奏+节奏指南）
        # 总预算需在 injected_context 中额外预留约1050-1450 tokens
        # 按优先级排序，超出预算则压缩或截断
        context_items.sort(key=lambda x: priorities.get(x.type, 0), reverse=True)
        # ...（完整实现见设计文档）
```

### 5.3 实时检索生成范式

核心转变：从"预加载上下文"到"写作中实时检索"

```
❌ 传统：准备上下文 → 一次性注入 → 生成 → 结束
✅ 新范式：最小启动 → 生成一段 → 遇到需要确认的细节
         → 暂停 → 精确查询 → 继续生成 → ...
```

三个层面：
1. **结构化存储**（消灭摘要损失）：永远不压缩，保持结构化原文+索引
2. **写作中实时检索**（消灭预加载盲区）：根据写作进度动态检索相关上下文
3. **多轮迭代生成**（消除一次性生成的质量问题）：粗生成→一致性检查→定向修正→风格润色→最终确认

### 5.4 ContextRouter

```python
# --- 摘要：ContextRouter —— 根据任务类型（写章/审核/世界观）智能选择注入的上下文，集成B6角色状态、B7伏笔、B8节奏 ---
class ContextRouter:
    """根据任务类型智能选择注入的上下文"""

    def route(self, task: Task) -> Context:
        context = Context()
        context.add(self.memory.get("novel_basic_info"))

        if task.type == "write_chapter":
            context.add(self.memory.get_related_characters(task.chapter))
            context.add(self.memory.get_recent_plot(task.chapter, n=3))

            # ── 伏笔上下文注入（B7增强版） ──
            # 原self.memory.get_active_foreshadowing()仅返回基础伏笔索引（编号+一句话）。
            # 现在同时调用B7的ForeshadowCoordinator.inject_writing_context()，
            # 获取更丰富的伏笔数据，包含：reader_memory（读者记忆衰减值）、
            # density（伏笔密度评估）、dependency_chain（伏笔依赖链）、
            # suggested_action（本章建议操作：progress/resolve/wake）。
            # B7增强数据替代基础伏笔索引，提供写作时更精准的伏笔参考。
            context.add(self.memory.get_active_foreshadowing())
            context.add(self.foreshadow_coordinator.inject_writing_context(
                work_id=task.work_id,
                chapter_num=task.chapter,
            ))
            context.add(self.memory.get_style_samples(task.scene_type))

            # B6 角色运行时状态（优先级2）：注入角色弧线阶段、当前情感、当前目标
            context.add(self.memory.get_character_runtime(
                task.chapter,
                fields=["arc_phase", "current_emotion", "current_goals"]
            ))

            # B8 节奏上下文（优先级3）：注入前章节奏画像、预期节奏、节奏指南
            context.add(self.memory.get_rhythm_context(
                task.chapter,
                fields=["prev_chapter_rhythm", "expected_pacing", "rhythm_guide"]
            ))

            # B7 增强伏笔视图（优先级5）：注入读者记忆、密度、依赖链
            context.add(self.memory.get_foreshadowing_enhanced(
                task.chapter,
                fields=["reader_memory", "density", "dependency_chain"]
            ))

        elif task.type == "review_continuity":
            context.add(self.memory.get_all_settings())
            context.add(self.memory.get_timeline())
            context.add(self.memory.get_foreshadowing_tracker())

        elif task.type == "world_build":
            context.add(self.memory.get_existing_worldview())
            context.add(self.memory.get_power_system())

        return context
```

---

<a id="ch6"></a>
## 第 6 章 算法层

> **注**：算法层通过 #G.1 `UnifiedEntityEngine`（统一实体引擎，统一管理所有实体的底层引擎）访问实体数据，通过 #G.2 `UnifiedDetectionPipeline` 统一调度检测。

> **算法-模块归属映射**：本章的算法作为共享基础设施服务于各 B 模块。
>
> | 算法 | 服务模块 | 说明 |
> |------|---------|------|
> | ConsistencyChecker（6.2） | B2 隐含信息检测 | 死亡角色出场、修为倒退、位置不合理等 |
> | TimelineValidator（6.3） | B2/B5 | 单线时间校验（B2）/ 跨线时间校验（B5 M4） |
> | EntityIndex（6.5） | 跨模块共享 | 被 B2/B3/B5/B6/B7/B8 共同使用的实体倒排索引 |
> | AppellationChecker（6.6） | B2 隐含信息检测 | 称谓一致性检查 |
> | ~~ForeshadowingTracker（6.4）~~ | ~~B7~~ | **已废弃**，由 B7 `ForeshadowCoordinator` 统一管理（见第 15 章） |

### 6.1 设计原则

**"能用 if/else 解决的就不要用 LLM"**

算法层拦截 80%的机械性错误（设计目标比例）（确定性、零成本、实时运行），LLM 层只处理需要语义理解的 20%。

### 6.2 算法一：ConsistencyChecker（结构化字段冲突检测）

```python
# --- 摘要：ConsistencyChecker —— 纯算法的一致性检查器，检测死亡角色出场、修为倒退、位置不合理等问题 ---
class ConsistencyChecker:
    """纯算法的一致性检查器"""

    def check_character(self, chapter_text: str, chapter_num: int) -> list:
        errors = []
        for char in self.db.get_all_characters():
            # 检查1：死亡角色不能出场
            if char.death_chapter and chapter_num > char.death_chapter:
                if char.name in chapter_text:
                    errors.append({
                        "type": "DEAD_CHARACTER_APPEARS",
                        "severity": "CRITICAL",
                        "message": f"{char.name}已在第{char.death_chapter}章死亡"
                    })

            # 检查2：修为等级不能倒退
            if char.cultivation_history:
                latest = char.get_cultivation_at(chapter_num - 1)
                mentioned = self._extract_cultivation(chapter_text, char.name)
                if mentioned and latest:
                    if self._realm_order(mentioned) < self._realm_order(latest):
                        errors.append({
                            "type": "REALM_REGRESSION",
                            "severity": "HIGH",
                            "message": f"{char.name}修为不应从{latest}倒退到{mentioned}"
                        })

            # 检查3：位置合理性
            if char.location_history:
                prev = char.get_location_at(chapter_num - 1)
                curr = self._extract_location(chapter_text, char.name)
                if prev and curr and not self._can_travel(prev, curr, char.realm):
                    errors.append({
                        "type": "LOCATION_IMPOSSIBLE",
                        "severity": "HIGH",
                        "message": f"{char.name}不可能在1章内从{prev}到达{curr}"
                    })
        return errors

    # ── 以下为辅助方法，具体实现依赖世界观配置 ──
    
    def _extract_cultivation(self, text: str, char_name: str) -> str:
        """从文本中提取修为/境界信息"""
        # 实现依赖具体世界观配置
        ...
    
    def _realm_order(self, realm: str) -> int:
        """获取境界的排序值（用于比较高低）"""
        # 实现依赖具体世界观配置
        ...
    
    def _extract_location(self, text: str, char_name: str) -> str:
        """从文本中提取地理位置信息"""
        # 实现依赖NLP地名识别
        ...
    
    def _can_travel(self, from_loc: str, to_loc: str, realm: str) -> bool:
        """判断给定境界下是否能从A地到达B地"""
        # 实现依赖世界观距离/传送规则配置
        ...
```

### 6.3 算法二：TimelineValidator（时间线校验）

```python
# --- 摘要：TimelineValidator —— 时间线校验器，用正则提取时间引用并校验全局时间线一致性 ---
class TimelineValidator:
    """时间线校验 - 纯算法"""

    def extract_time_references(self, chapter_num, chapter_text):
        """用正则提取时间引用"""
        patterns = [
            r'(\d+)年[前后]%s', r'(\d+)个%s月[前后]%s',
            r'(\d+)天[前后]%s', r'第(\d+)天',
            r'(%s:上|下)午', r'(%s:昨|前|明)天',
            r'(春|夏|秋|冬)(%s:天|季)',
        ]
        # ... 提取并校验时间顺序

    def validate(self):
        """校验全局时间线一致性"""
        # 规则1：时间不能倒流
        # 规则2：时间间隔与章节数的关系检查
        # 50章内不到7天 → 预警
```

### 6.4 ~~算法三：ForeshadowingTracker（伏笔追踪）~~ *[已废弃]*

> ⚠️ **迁移说明**：伏笔追踪已由 B7 `ForeshadowCoordinator` 统一管理（见第 15 章），使用 B3 读者记忆衰减模型替代基于章数倒计时的预警机制。
> 原始实现仅包含 `plant()`（埋设伏笔）和 `check_overdue()`（检查超期）两个方法，功能已被 B7 的 8 个子系统完整覆盖。
> 完整设计见附录 C（C.6 M6 伏笔追踪增强）和第 15 章（15.4 AI 伏笔识别引擎）。

### 6.5 算法四：EntityIndex（实体倒排索引）

```python
class EntityIndex:
    """实体倒排索引 - 基于哈希的O(1)查找，1000万字精度不变"""

    def __init__(self):
        self.index = defaultdict(list)  # 实体名 → [(chapter, paragraph, sentence)]
        self.aliases = {}               # 别名 → 标准名

    def query(self, entity_name, chapter_range=None):
        """精确返回所有包含目标实体的段落"""
        standard_name = self.aliases.get(entity_name, entity_name)
        results = self.index.get(standard_name, [])
        if chapter_range:
            results = [r for r in results
                       if chapter_range[0] <= r["chapter"] <= chapter_range[1]]
        return results

    def get_first_appearance(self, entity_name: str) -> int | None:
        """
        查询实体首次出现的章节号

        返回实体在倒排索引中记录的最早章节号。该方法被B3的
        calculate_memory_at_chapter()（读者记忆衰减模型）用于计算
        reader_memory，即读者对该实体的记忆强度随章节距离的衰减。

        参数:
            entity_name: 实体名称（支持别名，自动转换为标准名）

        返回:
            int | None: 首次出现的章节号；若实体不存在于索引中则返回None
        """
        standard_name = self.aliases.get(entity_name, entity_name)
        results = self.index.get(standard_name, [])
        if not results:
            return None
        # 返回所有出现记录中章节号最小的值
        return min(r["chapter"] for r in results)
```

与向量检索的区别：向量检索语义搜索但 1000 万字精度下降；倒排索引精确匹配且规模无关。

### 6.6 算法五：AppellationChecker（称谓一致性）

```python
class AppellationChecker:
    """称谓一致性 - 纯字符串匹配"""

    RULES = {
        ("林风", "苏瑶"): ["小瑶", "苏瑶", "她"],
        ("林风", "云墨子"): ["师父", "师傅", "老头子"],
        ("苏瑶", "林风"): ["林风", "林大哥", "他"],
    }
    # 检查对话中称谓是否在允许列表内
```

---

<a id="ch7"></a>
## 第 7 章 角色模拟 Agent

### 7.1 核心概念

```
传统模式：WriterAgent 一个人写所有角色的对话 → 风格趋同
角色模拟模式：每个角色有独立Agent写自己的对话和反应 → 风格鲜明
```

### 7.2 CharacterAgent 设计

```python
class CharacterAgent:
    """角色模拟Agent - "我就是这个角色" """

    def __init__(self, character_profile, knowledge_base):
        self.profile = character_profile
        self.internal_state = {
            "current_emotion": "平静",
            "emotional_triggers": {
                "苏瑶受威胁": "暴怒",
                "提到师父": "悲伤",
                "被轻视": "隐忍",
            },
            "behavioral_boundaries": [
                "不会主动攻击非敌对角色",
                "不会抛下同伴",
                "面对强者智取为主",
            ],
            "emotional_accumulation": {
                "对反派的恨意": 0.7,    # 0-1，随情节累积
                "对苏瑶的感情": 0.9,
                "对师父的思念": 0.6,
            }
        }

    def react_to(self, event: str) -> CharacterResponse:
        """基于内部状态判断反应"""
        # Step 1: 判断触发情绪
        # Step 2: 情感累积值影响反应强度
        # Step 3: 检查行为边界
        # 返回：action + justification + internal_monologue
```

### 7.3 情感履历追踪

```
emotional_history: [
    {chapter: 50, event: "师父失踪", emotion: "焦虑", intensity: 0.6},
    {chapter: 120, event: "得知师父可能已死", emotion: "悲痛", intensity: 0.8},
    {chapter: 300, event: "发现师父留下的信", emotion: "释然+悲伤", intensity: 0.5},
]

→ 写第800章时，林风Agent知道"师父"话题已经历焦虑→悲痛→释然
→ 不应该是"悲痛欲绝"（那是第120章的反应）
→ 应该是"平静中带着淡淡的怀念"
```

### 7.4 对话真实性改善示例

```
林风Agent（沉稳、话少、行动派）：
  "……"（沉默，直接上前检查苏瑶的伤势）

苏瑶Agent（倔强、不想被担心、内心柔软）：
  "别大惊小怪的，就擦破点皮。"（嘴硬，但悄悄把手藏到身后）

云墨子Agent（老顽童、关键时刻靠谱）：
  "哟，小风风这是心疼了？老夫当年追你师娘的时候也——"
  "咳，算了，先处理伤口。"
```

### 7.5 角色协调机制

- **方案 A**：WriterAgent 做导演（决定场景走向，角色 Agent 在框架内自由发挥）
- **方案 B**：角色 Agent 先提案，WriterAgent 裁决
- **方案 C**：角色 Agent 直接对话（最有趣但最难控制）

> **补充说明：与 B6 react_to()接口的解耦** —— 方案 A/B/C 的选择不影响 B6（第 14 章）的 `react_to()` 接口设计。
> `react_to()` 接收统一的输入格式 `{action, justification, internal_monologue}`，
> 与上层协调方案完全解耦。无论采用哪种协调方案，角色 Agent 最终都通过 `react_to()` 
> 产出反应结果，B6 桥梁层只关心反应结果的内容，不关心反应是如何被协调产生的。

### 7.6 成本控制：动态唤醒

| 角色类型 | 数量 | Agent 策略 |
|------|------|------|
| 核心角色 | 3-5 个 | 常驻 Agent，持续维护状态 |
| 重要角色 | 10-20 个 | 按需唤醒，出场时启动 |
| 龙套角色 | 不限 | 不需要 Agent，WriterAgent 直接写 |

---

<a id="ch8"></a>
## 第 8 章 角色记忆系统

### 8.1 核心区分

```
角色设定（Character Profile）= "简历"
  客观的、静态的、作者定义的
  例：林风，18岁，金丹期，性格沉稳

角色记忆（Character Memory）= "人生"
  主观的、动态的、角色自己积累的
  例：林风记得第50章师父教他练剑时的夕阳
```

### 8.2 五层记忆结构

| 层级 | 名称 | 内容 | 示例 |
|------|------|------|------|
| 1 | 事实记忆 | 知道什么（含"不知道什么"） | "我知道苏瑶是青梅竹马""我不知道反派的真正身份" |
| 2 | 情感记忆 | 感受过什么（附情感标签和强度） | "第一次杀人时的恶心感"(0.8) |
| 3 | 关系记忆 | 和别人之间发生过什么 | "赵天明在第 150 章背叛过我" |
| 4 | 技能/经验记忆 | 学会过什么 | "我学会了玄天剑诀前三式""我吃过亏：不能轻敌" |
| 5 | 目标/动机记忆 | 想要什么 | "我要找到师父""我要变强保护苏瑶" |

### 8.3 遗忘机制

```
可回忆度 = 情感强度 × 0.6 + 重要性 × 0.2 + 时间衰减 × 0.2，其中时间衰减 = max(0, 1 - 章节差/1000)

例：
  第50章，师父教剑（情感0.9，重要性0.9）
  → 500章后：0.9×0.6 + 0.9×0.2 + 0.3×0.2 = 0.78 → 仍然清晰 ✅

  第87章，客栈吃饭（情感0.1，重要性0.05）
  → 500章后：0.1×0.6 + 0.05×0.2 + 0.3×0.2 = 0.16 → 基本忘了 ✅
```

### 8.4 触发机制

| 触发方式 | 示例 |
|------|------|
| 场景触发 | 回到练剑场 → 想起师父教剑 |
| 人物触发 | 见到某人 → 想起和此人的记忆 |
| 话题触发 | 对话中提到某件事 → 想起相关记忆 |
| 感官触发 | 某种气味/声音 → 触发联想记忆 |
| 情境触发 | 类似处境 → 想起上次类似经历 |

### 8.5 存储规模管理

```
1000万字，一个核心角色约6000-10000条记忆

解决方案：
  常驻记忆（始终加载）：核心性格、关键事件 <20条 <2K tokens
  触发记忆（按需加载）：根据当前场景检索 3-5条 <1K tokens
  归档记忆（不加载）：早期不重要记忆，存在数据库

→ 角色Agent实际上下文 < 5K tokens，完全可控
```

### 8.6 主观记忆 vs 客观事实

需要区分三层：
- **角色认为的**（主观记忆）→ 影响角色行为
- **实际发生的**（客观事实）→ 影响情节逻辑
- **读者知道的**（叙事视角）→ 影响阅读体验

三者可以不同（真实的人也会记错、误解、有偏见），但需要有意识地管理。

---

<a id="ch9"></a>
## 第 9 章 B1 大纲系统

### 9.1 问题重构

B1"语义矛盾" 的本质不是独立检测问题，而是**系统架构问题**。解决方案从"矛盾检测"重构为"大纲系统深度设计"。

> 核心洞察：角色行为不一致 = 大纲没设计好。同样的行为，剧情设计好就是神来之笔，设计不当即为缺陷。

### 9.2 大纲系统六大核心功能

#### 功能一：角色弧线先行

大纲从"角色要经历什么变化"开始，而非从"事件"开始：

```
传统做法：想事件 → 让角色经历 → 角色因此变化（事件驱动）
正确做法：定义起点和终点 → 设计经历什么才能从起点到终点（角色驱动）
```

大纲必须回答：
1. 角色起点和终点是什么？
2. 变化需要经历什么（失去/获得）？
3. 变化的过程是怎样的（挣扎/渐进）？
4. 谁帮助/阻碍了变化？
5. 最终怎么接受的？
6. 接受后的第一个考验是什么？

#### 功能二：情感曲线设计

为每个核心角色画情感曲线，可视化检查起伏是否合理。

#### 功能三：事件→情感映射

每个事件必须标注对每个相关角色的影响：

```yaml
event:
  chapter: 50
  description: "师父失踪"
  character_impacts:
    - character: 林风
      emotion_before: "不安(0.6)"
      emotion_after: "崩溃(0.8)"
      emotion_delta: "+0.2"
      personality_change: "从依赖变为被迫独立"
  required_setup:
    - "师父在前面章节中建立了足够的情感基础"
    - "林风对师父的依赖已经被读者感知到"
  aftermath:
    - "林风的行为模式改变"
    - "林风和苏瑶的关系加深"
```

#### 功能四：铺垫检查算法

```python
# --- 摘要：SetupChecker —— 铺垫检查算法，检查角色重大变化是否有足够铺垫事件 ---
class SetupChecker:
    def check_character_change(self, outline, character):
        """检查角色重大变化是否有足够铺垫"""
        # 维度1：铺垫事件数量（至少2-3个）
        # 维度2：情感强度递增（读者感受到压力在累积）
        # 维度3：铺垫间隔合理（不超过15章）

    def check_catalyst(self, outline, character, change_point):
        """检查催化剂是否足够"""
        # 单一触发条件 → 建议叠加2-3个压力源
        # 多重触发条件互相加强 → 更有说服力
```

#### 功能五：大纲预演

大纲写完后，系统帮作者"预演"一遍，检查读者体验：
- 情感曲线是否有明确起伏
- 铺垫是否到位
- 节奏是否有连续低迷（可能弃书）
- 伏笔间距是否合理

#### 功能六：大纲→写作衔接

写作阶段，大纲系统告知 WriterAgent：
- "这是高潮前的铺垫章节"
- "需要让不安感从 0.4 提升到 0.6"
- "建议暗示师父可能有危险"
- "林风的情绪应该是：表面平静但内心不安"

### 9.3 大纲作为"宪法级"约束

| 层级 | 内容 | 约束强度 |
|------|------|------|
| 全书粗纲 | 核心设定、主线走向、结局 | 硬约束（不可违反） |
| 卷纲 | 分卷目标、角色发展、关键事件 | 强约束（偏离需预警） |
| 章纲 | 场景、字数、情绪节奏 | 中约束（偏离时建议） |

### 9.4 大纲数据模型与角色弧线

#### 9.4.1 大纲数据模型

三级大纲的完整 Schema：

```sql
# --- 摘要：大纲三级存储Schema —— master_outlines（全书粗纲）、volume_outlines（卷纲）、chapter_outlines（章纲） ---
-- 全书粗纲
CREATE TABLE master_outlines (
    -- === 主键与标识 ===
    id UUID PRIMARY KEY,
    work_id UUID REFERENCES works(id),
    title VARCHAR(200) NOT NULL,
    -- === 作品设定 ===
    genre VARCHAR(50),                    -- 类型
    target_audience VARCHAR(100),         -- 目标读者
    core_premise TEXT,                    -- 核心设定
    main_arc_summary TEXT,                -- 主线走向摘要
    ending_type VARCHAR(20),              -- 结局类型（happy/tragic/open/bittersweet）
    -- === 规模与版本 ===
    total_volumes INT,                    -- 预计卷数
    total_words INT,                      -- 预计总字数
    version INT DEFAULT 1,
    -- === 审计字段 ===
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
-- ER关系：本表通过 work_id 关联到 works(id)；被 volume_outlines(master_outline_id) 关联

-- 卷纲
CREATE TABLE volume_outlines (
    -- === 主键与标识 ===
    id UUID PRIMARY KEY,
    work_id UUID REFERENCES works(id),
    master_outline_id UUID REFERENCES master_outlines(id),
    volume_num INT NOT NULL,
    title VARCHAR(200),
    -- === 卷纲内容 ===
    volume_goal TEXT,                     -- 本卷目标
    character_development TEXT,           -- 角色发展计划
    key_events JSONB,                     -- 关键事件列表
    -- === 章节范围与数据 ===
    start_chapter INT,
    end_chapter INT,
    emotional_arc JSONB,                  -- 情感弧线数据
    line_plan JSONB,                      -- B5叙事线出场计划
    -- === 版本与审计 ===
    version INT DEFAULT 1,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
-- ER关系：本表通过 work_id 关联到 works(id)；通过 master_outline_id 关联到 master_outlines(id)；被 chapter_outlines(volume_outline_id) 关联

-- 章纲
CREATE TABLE chapter_outlines (
    -- === 主键与标识 ===
    id UUID PRIMARY KEY,
    work_id UUID REFERENCES works(id),
    volume_outline_id UUID REFERENCES volume_outlines(id),
    chapter_num INT NOT NULL,
    title VARCHAR(200),
    -- === 章节内容 ===
    scenes JSONB,                         -- 场景列表
    target_word_count INT,                -- 目标字数
    emotional_target JSONB,               -- 情感目标
    pacing VARCHAR(20) CHECK (pacing IN ('slow','medium','buildup','fast','climax') OR pacing IS NULL),  -- 节奏（5值枚举，允许NULL因大纲创建时pacing可能尚未确定）；枚举定义见B8 RhythmProfiler.Pacing
    -- === 关联与计划 ===
    narrative_line_id UUID REFERENCES narrative_lines(id),  -- 所属叙事线（B5关联）
    foreshadowing_plan JSONB,             -- 伏笔计划（结构定义见下方注释）
    -- foreshadowing_plan JSONB 结构定义：
    -- [
    --   {
    --     "id": "fp_xxxx",                  -- 伏笔唯一标识（可选，由B7生成时回填）
    --     "description": "伏笔描述文本",     -- 伏笔内容说明
    --     "type": "item|character|plot|worldview|misdirection",  -- 伏笔类型（可选，默认plot）
    --     "importance": "critical|normal|minor",  -- 重要性（可选，默认normal）
    --     "expected_event": "预期回收事件",  -- 预期回收时的剧情事件（可选）
    --     "expected_chapter": 50,           -- 预期回收章节号（可选，由大纲自动估算）
    --     "related_characters": ["角色名"],  -- 关联角色列表（可选）
    --     "notes": "作者备注"               -- 自由备注（可选）
    --   }
    -- ]
    -- 注意：此字段为B1大纲阶段的伏笔规划输入，B7 ForeshadowCoordinator
    -- 会在运行时将其转化为 UnifiedForeshadowing 对象进行全生命周期管理。
    -- === 备注与版本 ===
    notes TEXT,
    version INT DEFAULT 1,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
-- ER关系：本表通过 work_id 关联到 works(id)；通过 volume_outline_id 关联到 volume_outlines(id)；通过 narrative_line_id 关联到 narrative_lines(id)
```

# [注] foreshadowing_plan JSONB字段结构说明（与B7 #15.2 UnifiedForeshadowing对齐）
<!--
foreshadowing_plan 字段为 JSONB 数组，每个元素对应一条伏笔规划，结构如下：
[
  {
    "description": str,           -- 伏笔描述（必填），如"神秘戒指的来历"
    "foreshadow_type": str,       -- 伏笔类型（必填），见 #15.6 伏笔分类
    "importance": str,            -- 重要程度：critical / normal / minor
    "expected_chapter": int|null, -- 预期回收章节（根据大纲估算）
    "expected_event": str|null,   -- 预期回收事件描述，如"主角突破金丹期时"
    "depends_on": list[str],      -- 依赖的上游伏笔 ID 列表（须先于本伏笔回收）
    "triggers": list[str],        -- 本伏笔回收时触发的下游伏笔 ID 列表
    "cross_line": bool,           -- 是否跨线伏笔（来自 B5 M10）
    "target_lines": list[str]     -- 跨线目标叙事线 ID 列表
  }
]
B7 ForeshadowCoordinator 读取此字段时，会将上述结构映射为 UnifiedForeshadowing 数据类。
-->

#### 9.4.2 角色弧线数据结构

> ⚠️ **迁移说明**：已迁移至 #G.1 `UnifiedEntity`，保留作为设计参考。
> 原始设计内容已在统一架构合并过程中整合到对应章节，此处不再保留。
>
> **与 B6 模块 SQL 表的关系说明**：B6 桥梁层（#14.4.3）中的 `character_arcs`/`arc_phases`/`arc_milestones` 表是 B6 模块专用存储，通过 `entity_id` 外键关联到 `unified_entities`。这些表保留了弧线定义、阶段规划和里程碑事件的扩展结构（`arc_phases`/`arc_milestones`），与 `CharacterArc` 数据类迁移到 `UnifiedEntity` 不冲突——迁移的是数据类层面，而 B6 新增的是弧线生命周期管理的桥梁层存储。

#### 9.4.3 情感曲线存储与计算

```python
# --- 摘要：EmotionalCurve 情感曲线数据结构 —— 含EmotionalDataPoint数据点和情感波动/低迷段分析函数 ---
@dataclass
class EmotionalCurve:
    """情感曲线：角色在各章节的情感强度变化"""
    character_id: str
    data_points: list[EmotionalDataPoint]  # 情感数据点

@dataclass
class EmotionalDataPoint:
    """情感数据点"""
    chapter_num: int
    emotion_type: str                   # 情感类型（joy/sorrow/anger/fear/love/hate）
    intensity: float                    # 强度（0.0-1.0）
    trigger_event: str                  # 触发事件描述
    is_peak: bool = False               # 是否为情感峰值
    is_valley: bool = False             # 是否为情感谷值

def calculate_emotional_variance(curve: EmotionalCurve) -> dict:
    """
    计算情感曲线的波动指标
    
    返回:
        dict: 波动分析结果
    """
    intensities = [dp.intensity for dp in curve.data_points]
    
    import statistics
    return {
        "mean": round(statistics.mean(intensities), 3),
        "std": round(statistics.stdev(intensities), 3) if len(intensities) > 1 else 0,
        "max": max(intensities),
        "min": min(intensities),
        "range": max(intensities) - min(intensities),
        "flat_segments": _detect_flat_segments(curve),  # 连续低迷段
        "volatility_score": round(statistics.stdev(intensities) / (statistics.mean(intensities) + 0.01), 3),
    }

def _detect_flat_segments(curve: EmotionalCurve, threshold: float = 0.15, min_length: int = 5) -> list[dict]:
    """检测情感曲线的连续低迷段（可能导致读者弃书）"""
    flat_segments = []
    current_start = None
    
    for i, dp in enumerate(curve.data_points):
        if dp.intensity < threshold:
            if current_start is None:
                current_start = i
        else:
            if current_start is not None:
                length = i - current_start
                if length >= min_length:
                    flat_segments.append({
                        "start_chapter": curve.data_points[current_start].chapter_num,
                        "end_chapter": curve.data_points[i-1].chapter_num,
                        "length": length,
                        "avg_intensity": round(
                            sum(d.intensity for d in curve.data_points[current_start:i]) / length, 3
                        ),
                    })
                current_start = None
    
    return flat_segments
```

#### 9.4.4 铺垫检查算法实现 *[已迁移]*

> ⚠️ **迁移说明**：本节的 `SetupChecker` 应迁移为 #G.2 `BaseDetector` 子类（`ForeshadowCheckDetector`），通过 `UnifiedDetectionPipeline` 统一调度。保留本节作为**算法参考**。

#### 9.4.5 大纲预演引擎

```python
# --- 摘要：OutlinePreviewEngine —— 大纲预演引擎，模拟读者体验，检查情感曲线/铺垫/节奏/伏笔/角色平衡 ---
class OutlinePreviewEngine:
    """大纲预演引擎：模拟读者体验"""
    
    def preview(self, outline: dict) -> dict:
        """
        执行大纲预演
        
        返回:
            dict: 预演报告
        """
        report = {}
        
        # 检查1：情感曲线起伏
        report["emotional_curves"] = self._analyze_all_emotional_curves(outline)
        
        # 检查2：铺垫到位率
        report["setup_coverage"] = self._check_all_setups(outline)
        
        # 检查3：节奏低迷段
        report["pacing_issues"] = self._detect_pacing_issues(outline)
        
        # 检查4：伏笔间距
        report["foreshadowing_gaps"] = self._check_foreshadowing_intervals(outline)
        
        # 检查5：角色出场平衡
        report["character_balance"] = self._check_character_balance(outline)
        
        # 综合评分
        report["overall_score"] = self._calculate_overall_score(report)
        
        return report
    
    def _detect_pacing_issues(self, outline):
        """检测节奏问题
        ⚠️ 迁移说明：此方法已被B8 D2a替代（见 #16.7.3），
        B8的RhythmDetector.D2a基于实际节奏画像的标准差检测，比本方法更精确。
        保留此处作为B1大纲预演阶段的简化版参考。
        """
        issues = []
        chapters = outline.get("chapters", [])
        
        # 检测连续3+章节奏相同（可能单调）
        for i in range(2, len(chapters)):
            if (chapters[i]["pacing"] == chapters[i-1]["pacing"] == chapters[i-2]["pacing"]):
                issues.append({
                    "type": "monotone_pacing",
                    "chapters": [chapters[i-2]["num"], chapters[i]["num"]],
                    "pacing": chapters[i]["pacing"],
                    "suggestion": f"连续3章节奏均为{chapters[i]['pacing']}，建议调整"
                })
        
        return issues
    
    def _check_character_balance(self, outline):
        """检查角色出场平衡"""
        character_appearances = {}
        for chapter in outline.get("chapters", []):
            for char in chapter.get("characters", []):
                character_appearances[char] = character_appearances.get(char, 0) + 1
        
        total = len(outline.get("chapters", []))
        balance = {}
        for char, count in character_appearances.items():
            ratio = count / total if total > 0 else 0
            balance[char] = {
                "appearances": count,
                "ratio": round(ratio, 3),
                "warning": "出场过少" if ratio < 0.1 else "出场过多" if ratio > 0.8 else None
            }
        
        return balance
```

#### 9.4.6 大纲版本管理 *[已迁移]*

> ⚠️ **迁移说明**：已迁移至 #G.3 `unified_templates`，保留作为设计参考。

#### 9.4.7 大纲→写作衔接 API

```python
# --- 摘要：get_writing_context_from_outline() —— 从大纲获取写作上下文，集成B6角色弧线和B8节奏上下文 ---
def get_writing_context_from_outline(
    work_id: str,
    chapter_num: int
) -> dict:
    """
    从大纲获取写作上下文（供WriterAgent使用）

    【合并策略说明】
    本函数（B1）返回基础写作上下文。B6/B7/B8的运行时上下文由Orchestrator
    在调用本函数后追加合并，合并顺序为：B1基础 → B6角色弧线 → B7伏笔 → B8节奏。
    各模块上下文通过扁平字段追加到同一dict中，避免嵌套合并的复杂性。

    参数:
        work_id: 作品ID
        chapter_num: 当前章节号

    返回:
        dict: 写作上下文（含B1基础字段 + B6/B8运行时字段）
    """
    # 获取章纲
    chapter_outline = db.query(
        "SELECT * FROM chapter_outlines WHERE work_id = %s AND chapter_num = %s",
        work_id, chapter_num
    )[0]

    # 获取卷纲
    volume_outline = db.query(
        "SELECT * FROM volume_outlines WHERE id = %s",
        chapter_outline["volume_outline_id"]
    )[0]

    # ── B6 角色弧线进度（增强版） ──
    # 【B1与B6的调用关系说明】
    # 本函数（B1 get_writing_context_from_outline）通过调用B6的
    # get_character_arc_progress()获取角色弧线数据。两者是**调用关系**而非功能重叠：
    # - B1负责：从大纲获取章纲/卷纲、组装写作上下文（本函数）
    # - B6负责：计算角色弧线进度、管理角色状态（get_character_arc_progress）
    # B1是上下文组装的入口，B6是角色弧线数据的提供者。character_arcs字段的
    # 数据所有权属于B6，B1仅负责调用和传递。
    # 调用B6的get_character_arc_progress()，返回值现在包含运行时状态：
    #   - arc_phase: 当前弧线阶段（来自CharacterAgent运行时状态）
    #   - current_emotion: 角色当前情感（来自CharacterStateBridge持久化）
    #   - current_goals: 角色当前目标（来自CharacterAgent运行时状态）
    # 见 #14.2 M1 CharacterStateBridge 及 #14.3 CharacterAgent
    character_arcs = get_character_arc_progress(work_id, chapter_num)

    # 获取前一章的写作状态（辅助函数，由WriterAgent提供）
    # 实现参考：从 chapters 表读取前一章的写作上下文摘要
    prev_context = get_previous_chapter_context(work_id, chapter_num)

    # ── B8 节奏上下文 ──
    # B8的节奏上下文通过 PostSavePipeline（章节保存后自动执行的异步检测和统计管线，见附录 F.4）在章节保存后异步计算，
    # 计算结果存储在chapter_style_stats表中。写作时从该表读取上一章的节奏画像，
    # 用于指导当前章节的节奏走向。
    # 见 #16 B8 单线叙事节奏模块
    rhythm_context = get_chapter_rhythm_context(work_id, chapter_num)

    # ── B7 伏笔上下文 ──
    # TODO(P3): B7伏笔数据通过ForeshadowCoordinator.get_writing_context()单独获取，
    # 由Orchestrator在调用本函数后追加合并。见H31修复。
    # B7提供更丰富的伏笔数据（含reader_memory、密度、依赖链），
    # 替代下方foreshadowing_plan的基础伏笔规划字段。

    return {
        # ── B1 基础上下文 ──
        "chapter_goal": chapter_outline.get("title", ""),
        "scenes": chapter_outline.get("scenes", []),
        "emotional_target": chapter_outline.get("emotional_target", {}),
        "pacing": chapter_outline.get("pacing", "medium"),
        "volume_goal": volume_outline.get("volume_goal", ""),
        "foreshadowing_plan": chapter_outline.get("foreshadowing_plan", []),
        "narrative_line_id": chapter_outline.get("narrative_line_id"),
        "prev_chapter_emotion": prev_context.get("ending_emotion"),
        # TODO(P3): 待实现
        "suggestions": _generate_writing_suggestions(chapter_outline, prev_context),

        # ── B6 角色弧线上下文（含运行时状态） ──
        "character_arcs": character_arcs,

        # ── B8 节奏上下文（从chapter_style_stats读取） ──
        "rhythm_context": {
            "prev_chapter_rhythm": rhythm_context.get("prev_chapter_rhythm"),  # 前章节奏画像
            "expected_pacing": rhythm_context.get("expected_pacing"),          # 预期节奏方向
            "rhythm_direction": rhythm_context.get("rhythm_direction"),        # 节奏变化方向
            "rhythm_guide": rhythm_context.get("rhythm_guide"),                # 节奏写作指南
            "active_rhythm_issues": rhythm_context.get("active_rhythm_issues"),# 活跃的节奏问题
        },
    }
```

#### 9.4.8 大纲与 B5 叙事线的集成

卷纲中的线出场计划：

```python
# ⚠️ 已废弃：sync_outline_to_narrative_lines() 已被 B5 #13.4.1 节的同步机制完整替代。
# 新代码应使用 auto_create_narrative_lines_from_outline()。
# 完整实现见附录 H。
```

### 9.5 大纲编辑器交互设计

#### 9.5.1 编辑器布局与操作设计

**三级大纲的编辑器布局**：

| 区域 | 内容 | 交互 |
|------|------|------|
| 左侧面板 | 卷纲列表（折叠/展开） | 点击切换卷，拖拽排序 |
| 中间面板 | 当前卷的章纲列表 | 拖拽排序、批量编辑、字数统计 |
| 右侧面板 | 选中章节的详细编辑 | 情感目标/场景/角色/伏笔/节奏 |

**核心交互操作**：

| 操作 | 触发方式 | 系统行为 |
|------|---------|------|
| 创建章纲 | 点击"+"按钮或回车 | 自动继承上章情感目标，生成默认模板 |
| 拖拽排序 | 拖拽章纲卡片 | 自动重新计算章节号，更新卷纲范围 |
| 批量编辑 | Shift+点击多选 | 批量修改节奏/情感目标/所属线 |
| 大纲预演 | 点击"预演"按钮 | 运行 OutlinePreviewEngine，展示报告 |
| 冲突检查 | 保存时自动触发 | 检测与已有正文的不一致 |
| 版本对比 | 右键→"查看历史" | 并排展示两个版本的差异 |

**大纲与正文的联动**：

- 章纲变更后，如果该章已有正文，标记为"大纲与正文不一致"
- 正文写入时，实时显示章纲中的情感目标和节奏提示
- 大纲预演时，自动拉取已有正文进行对比分析

#### 9.5.2 大纲变更的冲突检测 *[已迁移]*

> ⚠️ **迁移说明**：本节的 `OutlineConflictDetector` 应迁移为 #G.2 `BaseDetector` 子类，通过 `UnifiedDetectionPipeline` 统一调度。

#### 9.5.3 大纲模板系统 *[已迁移]*

> ⚠️ **迁移说明**：已迁移至 #G.3 `UnifiedTemplate`，保留作为设计参考。

---

<a id="ch10"></a>
## 第 10 章 B2 隐含信息不一致检测

### 10.1 问题定义

作品中存在大量未明写但隐含成立的信息，这些隐含信息在后续章节中可能被无意违反。

核心原则：**系统不判断对错，只标记"待确认差异"，把判断权交给作者。**

### 10.2 17 条检查机制

#### 写作时·实时检查（毫秒级）

| 编号 | 检查名称 | 说明 |
|------|---------|------|
| 1 | 世界观规则引擎 | 硬规则硬拦截（金丹期不能飞等） |
| 2 | 铁事实拦截 | 作者声明的客观事实（苏瑶从未去过北方） |
| 3 | 角色能力边界 | 当前能力状态检查 |
| 4 | 身体状态约束 | 受伤/中毒/疲劳的持续性和限制效果 |
| 5 | 场景连续性 | 角色位置/物品状态追踪 |
| 6 | 叙事视角一致性 | 视角信息边界检查 |

#### 写作时·段落间检查（秒级）

| 编号 | 检查名称 | 说明 |
|------|---------|------|
| 7 | 角色 Agent 自检+沉默消解 | 角色 Agent 发现冲突先尝试自己消解 |
| 8 | 对话与角色状态匹配 | 角色说的话应与当前状态匹配 |
| 9 | 唯一性/最高级声明 | "最""唯一"声明冲突检查（加时间维度） |

#### 章节完成后·批量检查

| 编号 | 检查名称 | 说明 |
|------|---------|------|
| 10 | 增量属性交叉扫描 | 从 O(N)优化到 O(1)，语义角色标注提取 |
| 11 | 设定变更回查 | 连锁检查最多 3 层 |
| 12 | 数值/量级一致性 | 结合世界观设定判断 |
| 13 | 因果关系链追踪 | 事件间因果关系图 |
| 14 | 社会关系传递性 | 关系变化时检查相关方 |
| 15 | 角色认知偏差 | 角色说了超出认知范围的话 |
| 16 | 设定间逻辑推导 | 不同设定间的逻辑矛盾 |
| 17 | 世界状态变更追踪 | 城市/势力/角色位置状态时间线 |

### 10.3 渐进式四层检查

不是每次全跑 17 个检查，而是分层渐进：

| 层级 | 时机 | 检查内容 | 成本 |
|------|------|------|------|
| 第一层 | 实时 | 铁事实+世界观硬规则+死角色出场 | 毫秒级 |
| 第二层 | 段落间 | 能力边界+身体状态+场景连续性+视角+唯一性 | 秒级 |
| 第三层 | 章节完成后 | 隐含冲突+数值+因果+关系等 9 个 | 秒级 |
| 第四层 | 发布前（可选） | 全量深度扫描 | 分钟级 |

> **补充说明：B7/B8 检测项归属说明**
> - B7 伏笔协调层的检测（伏笔密度监控、回收时机评估等）通过 `ForeshadowCoordinator` 独立运行，不纳入 B2 四层检查流程，而是在章节保存后由 PostSavePipeline 异步触发（见 #F.4）。
> - B8 节奏控制的检测（D1-D4 共 8 项节奏异常检测）同样独立运行，由 `RhythmDetector` 在章节保存后异步执行（见 #16.4），不纳入 B2 四层检查。
> - B2 四层检查专注于设定一致性（铁事实、世界观、角色状态等），与 B7（伏笔）和 B8（节奏）的检测维度正交，互不重叠。

### 10.4 优先级分级

> ⚠️ **迁移说明**：P0-P3 严重性分级已由 #G.2 `DetectionSeverity`（critical/high/medium/low/info）统一替代。映射关系：P0→critical, P1→high, P2→medium, P3→low。
> （迁移说明见 #9.4.2 角色弧线数据结构）

### 10.5 作者回答执行流程

系统发现差异后，作者有四种回答：

| 回答类型 | 执行动作 |
|------|---------|
| **A. 确认矛盾** | 定位段落 → 手动/AI 辅助修改 → 更新索引 → 连锁检查（≤3 层） |
| **B. 补充设定** | 补充到属性库 → 回查已有章节 → 更新铁事实 → 记录变更日志 |
| **C. 故意设计** | 标记 INTENTIONAL → 创建伏笔追踪 → 后续监控 → 不再重复报警 |
| **D. 需要帮助** | 检索相关章节 → 高亮冲突点 → 给出建议 → 作者再选择 |

### 10.6 方案面板设计

> ⚠️ **迁移说明**：本节的 UI 布局已由 #G.4 `VisualizationConfig`（`"b2.issue_panel"`，`viz_type=PANEL`）统一替代。保留本节作为**交互设计参考**。

### 10.7 文本类型标注

| 文本类型 | 处理方式 |
|------|---------|
| NARRATIVE（叙事） | 提取事实 ✅ |
| DIALOGUE（对话） | 提取，标注"角色陈述" ✅ |
| INNER_THOUGHT（内心独白） | 提取，标注"内心独白" ✅ |
| METAPHOR（比喻） | **不提取** ❌ |
| DREAM（梦境） | **不提取** ❌ |
| FLASHBACK（闪回） | 提取，标注"回忆" ⚠️ |
| LIE（谎言） | **不提取** ❌ |
| HYPOTHETICAL（假设） | **不提取** ❌ |

### 10.8 反馈与优化机制

- **误报反馈学习**：同类误报超过 5 次 → 自动降低灵敏度或加入白名单
- **待处理保质期**：超过 20 章再次提醒，超过 50 章升级
- **检查冷却期**：高频维度每章检查，中频每 5 章，低频每 20 章
- **叙事阶段感知**：铺垫期宽松，高潮期降低性格/能力检查灵敏度，日常期严格
- **读者影响加权**：主角×3.0 / 主要角色×2.0 / 重要配角×1.0 / 龙套×0.3


> **📦 统一迁移说明（10.9-10.10 节）**
>
> 以下子节中的数据模型和类已迁移至统一底层架构（附录 G），
> 实现时应使用 `UnifiedEntityEngine`（#G.1）和 `UnifiedDetectionPipeline`（#G.2）。
> 完整迁移映射关系见 [附录 B 关键设计决策记录](#附录-b-关键设计决策记录)。

### 10.9 属性库与规则引擎

#### 10.9.1 属性库数据模型

> ⚠️ **迁移说明**：本节的 `character_attributes` 和 `attribute_change_log` 表已由 #G.1 `unified_entities`（`attributes` JSONB 字段）和 `entity_attribute_history` 表统一替代。保留本节作为**设计参考**。

#### 10.9.2 铁事实存储与查询

> ⚠️ **迁移说明**：本节的 `IronFactManager` 类已由 #G.1 `UnifiedEntityEngine.update_attribute()`（含铁事实保护逻辑）统一替代。铁事实存储在 `unified_entities.iron_facts` 字段中。

#### 10.9.3 世界观规则引擎

```python
# --- 摘要：WorldRuleEngine —— 世界观规则引擎，加载并检查角色行动是否违反世界观规则（含条件匹配和例外处理） ---
# 规则定义格式
WORLD_RULE_SCHEMA = {
    "rule_id": "cultivation_no_fly_below_golden_core",
    "category": "cultivation",             # 规则类别
    "description": "金丹期以下不能飞行",
    "conditions": {                        # 触发条件
        "character_realm": ["练气", "筑基"],
        "action": "fly",
    },
    "consequence": "block",                # block/warn/inform
    "message": "角色{character}当前为{realm}期，不能飞行",
    "exceptions": [                        # 例外条件
        {"condition": "has_flying_treasure", "message": "持有飞行法宝可以飞行"},
    ],
    "priority": 10,                        # 优先级（数字越大越优先）
}

class WorldRuleEngine:
    """世界观规则引擎"""
    
    def __init__(self, work_id: str):
        self.work_id = work_id
        self.rules: list[dict] = []
        self._load_rules()
    
    def _load_rules(self):
        """加载作品的世界观规则"""
        # world_rules 表Schema见统一架构 #17.8.1 unified_entities.attributes（domain='world_rule'）
        rows = db.query(
            "SELECT * FROM world_rules WHERE work_id = %s ORDER BY priority DESC",
            self.work_id
        )
        self.rules = [json.loads(r["rule_data"]) for r in rows]
    
    def check_action(self, character_state: dict, action: str) -> list[dict]:
        """
        检查角色行动是否违反世界观规则
        
        参数:
            character_state: 角色当前状态
            action: 行动描述
            
        返回:
            list[dict]: 违规列表
        """
        violations = []
        
        for rule in self.rules:
            # 检查条件是否匹配
            if self._match_conditions(rule["conditions"], character_state, action):
                # 检查例外
                if self._check_exceptions(rule.get("exceptions", []), character_state):
                    continue
                
                violations.append({
                    "rule_id": rule["rule_id"],
                    "category": rule["category"],
                    "consequence": rule["consequence"],
                    "message": rule["message"].format(**character_state),
                    "priority": rule["priority"],
                })
        
        return violations
    
    def _match_conditions(self, conditions, state, action):
        """检查条件是否匹配"""
        for key, expected in conditions.items():
            if key == "action":
                if action != expected:
                    return False
            elif key in state:
                if isinstance(expected, list):
                    if state[key] not in expected:
                        return False
                elif state[key] != expected:
                    return False
        return True
    
    def _check_exceptions(self, exceptions, state):
        """检查是否命中例外"""
        for exc in exceptions:
            if all(state.get(k) == v for k, v in exc["condition"].items()):
                return True
        return False
```

#### 10.9.4 增量扫描算法

> ⚠️ **迁移说明**：本节的 `IncrementalScanner` 应通过 #G.1 `UnifiedEntityEngine` 访问实体属性，而非直接查询 `character_attributes` 表。

#### 10.9.5 设定变更连锁检查

> ⚠️ **迁移说明**：本节应通过 #G.1 `UnifiedEntityEngine.get_effective_state()` 访问实体属性，而非直接查询 `character_attributes` 表。

#### 10.9.6 方案面板状态机

> ⚠️ **迁移说明**：本节的 `IssueStateMachine` 已由 #G.2 `unified_detection_results.status` 字段（open/acknowledged/dismissed/fixed）和 `UnifiedDetectionPipeline._route_results()` 事件路由统一替代。

### 10.10 属性提取管线与结果持久化

#### 10.10.1 属性提取的 NLP 管线

> ⚠️ **迁移说明**：本节的 `AttributeExtractionPipeline` 应作为 #G.2 `UnifiedDetectionPipeline` 的预处理步骤，或注册为 `BaseDetector` 子类。

#### 10.10.2 误报率监控与自适应阈值

> ⚠️ **迁移说明**：本节中 JOIN `check_results` 的查询应改为 JOIN `unified_detection_results`（#G.2），使用 `detector_id` 替代 `check_type`。

#### 10.10.3 检查结果的持久化与查询

> ⚠️ **迁移说明**：本节的 `check_results` 表和 `query_check_results()` API 已由 #G.2 `unified_detection_results` 表统一替代。保留本节作为**设计参考**。

---

<a id="ch11"></a>
## 第 11 章 B3 因果链断裂检测

### 11.1 问题定义

**"前面挖的坑后面忘了填，或者填得太突然"**

与设定矛盾的区别：设定矛盾可以用算法检测（对/错），因果链断裂需要理解叙事意图（该不该出现）。

### 11.2 核心机制

#### 机制一：元素三态管理 + 心跳

| 状态 | 定义 | 心跳周期 |
|------|------|------|
| active（活跃） | 正在参与当前剧情 | 每 20 章至少提及一次 |
| dormant（休眠） | 暂时不参与，未来可能激活 | 每 40 章至少提及一次 |
| dead（退休） | 已完成使命或被摧毁 | 不再追踪，保留历史 |

状态转换：引入 → active → dormant（不再需要）→ active（有铺垫）→ dead（完成使命）

心跳方式灵活：直接提及、间接暗示、他人提及、环境触发均可。

#### 机制二：重要性自动推断

不在引入时判断，而是观察作者后续行为：

```
重要性分数 = f(后续提及次数, 提及间隔, 提及时篇幅)
```

动态调整：
- 刚引入 → 默认 recurring（中等追踪）
- 后续频繁提及 → 升级 important（严格追踪）
- 长期不提及 → 降级 dormant（宽松追踪）

系统推断结果展示给作者确认。

#### 机制三：读者记忆衰减模型

# [注] L33补充：此衰减模型被B7伏笔协调层（#15 ForeshadowCoordinator）复用，
     用于伏笔预警列表计算（reader_memory < 阈值 → 预警）和回收质量评估。
     B7 通过 calculate_memory_at_chapter() 调用本模型。 -->

```
记忆强度变化：
  刚引入/刚提及 → +0.3（刷新）
  每过一章不提及 → ×0.98（衰减）
  间接提及/暗示 → +0.1（轻微刷新）

示例（神秘戒指）：
  chapter 50:  1.00（引入）
  chapter 100: 0.45
  chapter 150: 0.20
  chapter 200: 0.09（读者几乎忘了）

用途：记忆强度 < 0.3 → 预警"读者可能已遗忘，建议铺垫"
```

### 11.3 分层检查机制

| 时机 | 检查内容 | 成本 |
|------|---------|------|
| 每章必跑 | 消耗品数量、物理可达性、角色 Agent 自检 | 毫秒级 |
| 每 10 章 | 活跃度/心跳、叙事承诺、未兑现密度、引入密度、跨卷追踪 | 秒级 |
| 大纲变更时 | 大纲-正文一致性、回收计划、因果链可视化更新 | 秒级 |
| 发布前（可选） | 全量深度扫描 | 分钟级 |

### 11.4 辅助功能

#### 场景-元素共振推荐

写作时主动推荐"可以自然融入的休眠元素"：

```
当前场景：林风在夜晚独自修炼

休眠元素中适合当前场景的：
  - 神秘戒指（30章未提及）→ "修炼时戒指突然发热"
  - 父亲的第二封信（40章未提及）→ "修炼间隙犹豫要不要打开"

[融入] [不融入] [下次再说]
```

#### 元素"影子"检测

元素没被直接提及但通过"影子"影响了剧情：
- 影子出现 = 作者有意维持 → 不预警
- 完全没有影子 = 作者可能遗忘 → 预警

### 11.5 复用策略

**复用 B2 的**：属性提取、增量扫描、置信度评分、分级处理、作者回答流程、误报反馈学习、文本类型分类、检查结果合并

**复用算法层的**：实体索引、伏笔追踪表、时间线校验、角色状态表

**B3 只需新增**：元素三态管理、心跳机制、读者记忆衰减模型、场景-元素共振推荐、因果链可视化

### 11.6 设计原则

1. **宁可漏报，不要误报** —— 误报会杀死功能
2. **重要性由作者行为决定** —— 不靠猜测
3. **复用不重复建设**
4. **分层执行不打断**
5. **一屏展示不弹窗**
6. **主动推荐优于被动预警**

### 11.7 元素三态管理与心跳检测

#### 11.7.1 元素三态数据结构 *[已迁移]*

> ⚠️ **迁移说明**：已迁移至 #G.1 `unified_entities`，保留作为设计参考。
> （迁移说明见 #9.4.2 角色弧线数据结构）

#### 11.7.2 心跳检测算法 *[已迁移]*

> ⚠️ **迁移说明**：应迁移至 #G.2 `BaseDetector`，保留作为设计参考。

#### 11.7.3 记忆衰减精确公式 *[已迁移]*

> ⚠️ **迁移说明**：本节中查询 `story_elements.importance` 的代码应改为通过 #G.1 `UnifiedEntityEngine` 查询 `unified_entities.importance`。

#### 11.7.4 场景-元素共振匹配

> ⚠️ **迁移说明**：本节的 `dormant_elements` 参数使用旧字段名（element_name/element_type），实现时应替换为 `UnifiedEntity` 结构（name/domain），通过 `last_mentioned_chapter` 计算沉睡章数。

```python
# --- 摘要：SceneElementResonance —— 场景-元素共振推荐，根据场景类型/角色/情感/时间匹配休眠元素并生成融入建议 ---
class SceneElementResonance:
    """场景-元素共振推荐：推荐适合当前场景的休眠元素"""
    
    def recommend(
        self,
        work_id: str,
        current_scene: dict,
        dormant_elements: list[dict]
    ) -> list[dict]:
        """
        推荐适合当前场景的休眠元素
        
        参数:
            work_id: 作品ID
            current_scene: 当前场景信息
                {"location": "修炼室", "characters": ["林风"], 
                 "activity": "修炼", "time": "夜晚", "emotion": "孤独"}
            dormant_elements: 休眠元素列表
                
        返回:
            list[dict]: 推荐列表（按匹配度排序）
        """
        recommendations = []
        
        for elem in dormant_elements:
            score = self._calculate_resonance_score(current_scene, elem)
            if score > 0.3:  # 最低匹配阈值
                recommendations.append({
                    "element_id": elem["id"],
                    "element_name": elem["element_name"],
                    "element_type": elem["element_type"],
                    "resonance_score": round(score, 3),
                    "integration_hint": self._generate_integration_hint(current_scene, elem),
                    "chapters_since_mention": elem["chapters_since"],
                })
        
        # 按匹配度降序排序
        recommendations.sort(key=lambda r: -r["resonance_score"])
        
        return recommendations[:5]  # 最多推荐5个
    
    def _calculate_resonance_score(self, scene, element):
        """计算场景-元素共振分数"""
        score = 0.0
        metadata = element.get("metadata", {})
        
        # 场景类型匹配
        scene_activity = scene.get("activity", "")
        if metadata.get("related_activities"):
            if scene_activity in metadata["related_activities"]:
                score += 0.3
        
        # 角色关联匹配
        scene_characters = set(scene.get("characters", []))
        elem_characters = set(metadata.get("related_characters", []))
        if scene_characters & elem_characters:
            score += 0.3
        
        # 情感氛围匹配
        scene_emotion = scene.get("emotion", "")
        if metadata.get("emotional_tone") == scene_emotion:
            score += 0.2
        
        # 时间匹配
        scene_time = scene.get("time", "")
        if metadata.get("preferred_time") == scene_time:
            score += 0.1
        
        # 遗忘风险加权（越久没提加权越高）
        chapters_since = element.get("chapters_since", 0)
        urgency_bonus = min(0.1, chapters_since / 100)
        score += urgency_bonus
        
        return min(1.0, score)
    
    def _generate_integration_hint(self, scene, element):
        """生成融入建议"""
        hints = {
            "item": f"可以通过角色在{scene.get('activity', '当前活动')}时注意到{element['element_name']}",
            "character": f"可以通过{scene.get('characters', ['角色'])[0]}想起或提到{element['element_name']}",
            "location": f"可以通过环境描写暗示{element['element_name']}的存在",
        }
        return hints.get(element["element_type"], f"考虑在当前场景中融入{element['element_name']}")
```

#### 11.7.5 因果链可视化数据格式 *[已迁移]*

> ⚠️ **迁移说明**：已迁移至 #G.4 `VisualizationConfig`，保留作为设计参考。

#### 11.7.6 与 B5 跨线伏笔协同 *[已迁移]*

> ⚠️ **迁移说明**：本节中查询 `element_mentions` 的代码应改为查询 #G.1 `entity_attribute_history` 和 `entity_line_states` 表。

### 11.8 元素引入检测与伏笔回收

#### 11.8.1 元素引入的自动检测算法 *[已迁移]*

> ⚠️ **迁移说明**：应迁移至 #G.2 `BaseDetector`，保留作为设计参考。

#### 11.8.2 伏笔回收的质量评估

```python
# --- 摘要：evaluate_foreshadowing_payoff() —— 伏笔回收质量评估，从时机/方式/完整性/情感冲击四维度打分 ---
def evaluate_foreshadowing_payoff(
    plant_info: dict,    # 埋设信息
    reveal_info: dict,   # 回收信息
) -> dict:
    """
    评估伏笔回收的质量
    
    参数:
        plant_info: {"chapter": 30, "description": "神秘戒指", "importance": "critical"}
        reveal_info: {"chapter": 150, "description": "戒指是传承信物", "method": "direct"}
        
    返回:
        dict: 质量评估
    """
    scores = {}
    
    # 维度1：时机适当性（读者记忆衰减后是否还记得）
    chapters_gap = reveal_info["chapter"] - plant_info["chapter"]
    # TODO(P3): 待实现
    # 【跨模块依赖说明】
    # 该函数被 B7 ForeshadowCoordinator 依赖（见 #15.9 协调关系表），
    # 用于伏笔回收质量评估中的"时机适当性"维度。
    # 属于跨模块阻塞项：B7 的 evaluate_foreshadowing_payoff() 需要此函数返回值。
    #
    # 建议实现思路：
    #   1. 基于 B3 #11.2 的读者记忆衰减公式：memory = importance * 0.95^(chapters_gap)
    #   2. 输入：plant_info（含 importance、planted_chapter）、当前章节号
    #   3. 输出：float，范围 0.0~1.0，表示读者对该伏笔的当前记忆强度
    #   4. 可参考 #11.2 中的衰减曲线示例值（chapter 50: 0.77, chapter 100: 0.45 等）
    memory_at_reveal = calculate_memory_at_chapter(plant_info, reveal_info["chapter"])
    scores["timing"] = memory_at_reveal  # 越高越好（读者还记得）
    
    # 维度2：回收方式（直接揭示 vs 间接暗示）
    method_scores = {
        "direct": 0.6,       # 直接揭示：清晰但可能平淡
        "indirect": 0.9,     # 间接暗示：巧妙有惊喜感
        "partial": 0.8,       # 部分揭示：制造悬念
        "twist": 1.0,         # 反转揭示：最佳体验
    }
    scores["method"] = method_scores.get(reveal_info.get("method", "direct"), 0.5)
    
    # 维度3：回收完整性（是否回应了埋设时的所有暗示）
    scores["completeness"] = 0.7  # 需要NLP分析，默认中等
    
    # 维度4：情感冲击（回收时是否有情感高潮）
    scores["emotional_impact"] = 0.7  # 需要分析回收场景的情感
    
    # 综合评分
    total = (
        scores["timing"] * 0.30 +
        scores["method"] * 0.25 +
        scores["completeness"] * 0.25 +
        scores["emotional_impact"] * 0.20
    )
    
    return {
        "total_score": round(total, 3),
        "grade": "A" if total >= 0.8 else "B" if total >= 0.6 else "C" if total >= 0.4 else "D",
        "breakdown": scores,
        "suggestion": (
            "回收质量优秀" if total >= 0.8 else
            "可以考虑更巧妙的回收方式" if total >= 0.6 else
            "建议优化回收时机或方式" if total >= 0.4 else
            "回收质量较差，建议重新设计"
        ),
    }
```

#### 11.8.3 元素退役的清理流程 *[已迁移]*

> ⚠️ **迁移说明**：本节的 `retire_element()` 应改为调用 #G.1 `UnifiedEntityEngine.retire()` 方法，而非直接操作 `story_elements` 表。

---

<a id="ch12"></a>
## 第 12 章 B4 长程风格一致性

> B4 的完整 PRD 级设计（20 个核心机制、五层架构、完整算法/阈值/Prompt/存储方案）见独立文档：
> 📄 [附录 C](#appendix-c)

### 12.1 问题定义

长程写作中，AI 生成内容的风格与作者自身风格不一致，且随篇幅增长漂移越来越严重。

**终极目标重新定义**：不是"保持风格一致"，而是**"确保每一次风格变化都是作者有意为之"**。

### 12.2 20 个核心机制（M1-M20）

<!-- 表格说明：B4 长程风格一致性的 20 个核心机制（M1-M20）概览 -->
| 编号 | 机制 | 层级 | 简述 |
|------|------|------|------|
| M1 | 风格宪法系统 | 作者层 | 全书风格最高准则，由作者定义 |
| M2 | 风格意图注册表 | 作者层 | 记录作者每一次有意的风格变化 |
| M3 | 算法统计引擎 | 算法层 | 80%风格特征用算法统计，零 LLM 成本 |
| M4 | 词汇控制系统 | 算法层 | 禁用词+偏好词管理 |
| M5 | AI 味检测器 | 算法+LLM | 10 类检测模式，评分 0-100 |
| M6 | 场景-风格匹配 | 算法+LLM | 8 种场景类型，不同风格标准 |
| M7 | 对话/角色风格 | 算法+LLM | 角色对话指纹提取 |
| M8 | 叙事技术一致性 | LLM 层 | 视角、时态、叙事距离 |
| M9 | 感官/意象系统 | 算法层 | 五感词典、意象系统 |
| M10 | 文化/世界观一致性 | 算法+知识库 | 术语表达、文化氛围 |
| M11 | 风格漂移追踪 | 算法层 | 滑动窗口+20 维向量+PCA |
| M12 | 风格质量评估 | LLM 层 | 多维度评分 |
| M13 | 生成控制 | 生成层 | Prompt 分层+动态组装 |
| M14 | 反馈学习 | 学习层 | 5 种规则类型+审查面板 |
| M15 | 可视化工具集 | 展示层 | 雷达图+曲线+热力图 |
| M16 | 风格守护 Agent | Agent 层 | 独立审核 Agent，不参与生成 |
| M17 | 风格过渡控制 | 生成层 | 风格变化时的缓冲区 |
| M18 | 人机边界管理 | 系统层 | AI 生成内容标记 |
| M19 | 跨作品管理 | 系统层 | 多作品风格隔离 |
| M20 | 公开趋势分析 | 系统层 | 基于公开信息的风格趋势（无读者数据） |

### 12.3 五层架构

> 完整架构说明见附录 C [C.3 五层架构](#c3-五层架构)。

```
作者层：M1风格宪法 + M2意图注册表 → 定义"什么是正确风格"
算法层：M3统计+M4词汇+M5 AI味+M9感官+M11漂移 → 确定性统计，零LLM成本
LLM检测层：M6+M7+M8+M12 → 需要语义理解，定期/按需
生成控制层：M13+M17 → 从源头预防
系统支撑层：M14+M15+M16+M18+M19+M20 → 支撑以上所有层
```

### 12.4 中文特有风格维度

> 完整维度说明（含计算方式）见附录 C [C.24 中文特有风格维度](#c24-中文特有风格维度)。

| 维度 | 权重 | 说明 |
|------|------|------|
| "的"字密度 | 0.95 | AI 生成中文的最强信号 |
| 文白混用比例 | 0.8 | 半文半白风格检测 |
| 四字词语密度 | 0.7 | 成语/四字词使用频率 |
| 叠词密度 | 0.6 | 叠词使用频率 |
| 口语词密度 | 0.5 | 口语化程度 |
| 量词精确度 | 0.5 | 量词使用准确性 |

### 12.5 成本控制

> 完整成本优化策略见附录 C [C.25 成本控制](#c25-成本控制)。

| 阶段 | Token 预算/章 | 说明 |
|------|-------------|------|
| 算法层 | 0 | 零 LLM 成本 |
| LLM 检测层 | 2000-3000 | 按需触发 |
| 生成控制 | 800 | Style Prompt |
| **总计** | **4000-7000** | 从初始 17700 优化至此 |

### 12.6 5 级降级策略

> 完整降级策略（含触发条件与恢复机制）见附录 C [C.26 5 级降级策略](#c26-5-级降级策略)。

| 级别 | 状态 | 说明 |
|------|------|------|
| Level 0 | 完整运行 | 所有机制正常 |
| Level 1 | LLM 降频 | 检测频率降低 |
| Level 2 | 仅算法 | 关闭所有 LLM 调用 |
| Level 3 | 仅缓存 Prompt | 使用缓存的风格 Prompt |
| Level 4 | 全部暂停 | 不影响写作 |

### 12.7 MVP 规格

**包含机制**：M1 选择版 + M3(5 维) + M4 手动 + M5(4 模式) + M13 Prompt + M15 评分
**开发量**：约 18 个工作日
**覆盖率**：60-70%

### 12.8 深度优化记录

| 轮次 | 补充内容 | 版本 |
|------|---------|------|
| Round 9 | 50 维特征表、AI 味模式库、改写协议、学习 Schema、初始化问卷、场景字典、质量评估算法、统一管线 API | v1.1 |
| Round 10 | M2 意图状态机、M17 过渡曲线算法、M18 人机边界粒度、M19 跨作品导入、M3 Welford 增量算法、M13 完整 Prompt 模板、M15 可视化 API、M9 意象追踪系统 | v1.2 |
| Round 11 | M3 分词策略、M7 动态指纹、M11 自适应窗口、M16 审核时机、M1 宪法对齐、M14 冷启动、LLM 调度合并、漂移根因分析 | v1.3 |
| Round 12 | 风格检查点、多模型切换补偿、检测精度评估、章节内波动检测、风格恢复纠偏、数据隐私安全、风格模板市场、性能缓存策略 | v1.4 |
| Round 13 | 跨模块事件总线、统一验证仪表盘层、插件化配置层（合并 B1-B5 第三轮盲点） | v1.7 |

> 📄 完整设计（30 章，含 Round 9-12 所有补充）见：[附录 C](#appendix-c)

---

<a id="ch13"></a>
## 第 13 章 B5 多线叙事同步

> 📄 完整设计（23 章）见：[附录 D](#appendix-d)

### 13.1 问题定义（v2）

**核心问题**：多线叙事写作中，作者在管理多条叙事线时面临上下文切换成本高、跨线一致性维护困难、读者体验断裂三大类问题。

**三层 10 个子问题**：

<!-- 表格说明：B5多线叙事的三层10个子问题定义及已有覆盖情况 -->
| 层级 | # | 子问题 | B5 独有 | 已有覆盖 |
|------|---|------|--------|------|
| 上下文管理 | P1 | 线索切换成本 | ✅ | 部分（B1 大纲） |
| | P2 | 线索进度感知 | ✅ | 部分（B1 大纲） |
| | P3 | 线索关系理解 | ✅ | ❌ |
| 跨线一致性 | P4 | 时间一致性 | | 部分覆盖（B2 仅覆盖单线时间，跨线由 B5 M4 处理） |
| | P5 | 信息一致性 | | 部分覆盖（B2 仅覆盖单线认知，跨线由 B5 M5 处理） |
| | P6 | 状态一致性 | | 部分覆盖（B2 仅覆盖单线状态，跨线由 B5 M9 处理） |
| | P7 | 伏笔跨线追踪 | | 部分（B3 伏笔） |
| 读者体验 | P8 | 节奏断裂 | | ✅ B8 节奏控制（D3a 跨章断裂检测+D3b 跨卷断裂检测） |
| | P9 | 记忆负担 | | 部分（B3 衰减模型） |
| | P10 | 视角混乱 | | 部分（B2 视角检查） |

**精简为 8 个核心问题**（Q1-Q8），其中 Q1/Q3/Q4 是 B5 独有价值。

#### 13.1.1 设计原则

| 原则 | 说明 |
|------|------|
| **线程隔离** | 每条叙事线是独立的逻辑单元，拥有独立的状态空间和知识边界 |
| **按需同步** | 跨线信息只在必要时同步，避免不必要的耦合 |
| **作者主权** | 所有同步和检查建议都由作者最终决策，系统不自动修改内容 |
| **渐进自动化** | 从手动管理（L0）到半自动（L1）到全自动（L2），作者自主选择自动化程度 |

> 📄 完整设计哲学见附录 D D.2。

### 13.2 方案架构

**56 个思路 → 12 个核心机制 + 4 个辅助机制 → 6 层架构**

<!-- 表格说明：B5多线叙事的12个核心机制+4个辅助机制，按层级分类 -->
| 编号 | 机制名称 | 层级 | 解决问题 |
|------|---------|------|---------|
| M1 | 叙事线存档点系统 | 数据层 | Q1 上下文切换 |
| M2 | 交接文档自动生成 | AI 层 | Q1+Q9 读者体验 |
| M3 | 叙事线 AI 助手 | Agent 层 | Q1+Q4+Q8 |
| M4 | 全局时间轴引擎 | 算法层 | Q2 时间对齐 |
| M5 | 角色知识背包 | 数据层 | Q3 信息隔离 |
| M6 | 叙事线依赖图 | 算法层 | Q4 线间依赖 |
| M7 | 叙事线生命周期 | 状态层 | Q4+Q1 |
| M8 | 线拓扑变更 | 算法层 | Q4+Q5 |
| M9 | 双层状态模型 | 数据层 | Q5 状态同步 |
| M10 | 伏笔跨线标签 | 扩展层 | Q6 伏笔跨线 |
| M11 | 叙事线仪表盘 | 展示层 | Q7 进度可视化 |
| M12 | 跨线一致性审核 Agent | Agent 层 | Q2+Q3+Q5 |
| S1 | 节奏建议引擎 | 辅助 | Q8（与 B8 协同，B8 节奏控制已实现，见第 16 章） |
| S2 | 失败模式库 | 辅助 | 主动监控 |
| S3 | 网文三线模型预设 | 辅助 | 降低入门门槛 |
| S4 | 三级自动化策略 | 辅助 | 全局策略 |

### 13.3 MVP 规格

**包含机制**：M1 存档点 + M4 时间轴 + M5 知识背包 + M7 生命周期 + M11 仪表盘
**开发量**：约 15 个工作日
**覆盖率**：50-60%
**Token 消耗**：2000-4000 token/章

### 13.4 大纲集成与知识背包统一

#### 13.4.1 与 B1 大纲的深度集成

卷纲→线出场计划→叙事线创建的自动化流程：

```python
# --- 摘要：auto_create_narrative_lines_from_outline() —— 从大纲自动创建叙事线，含章纲归属同步和依赖创建 ---
def auto_create_narrative_lines_from_outline(work_id: str, volume_id: str) -> dict:
    """
    从卷纲自动创建B5叙事线
    
    流程：读取卷纲line_plan → 创建/更新叙事线 → 同步章纲归属 → 更新依赖图
    """
    volume = db.query("SELECT * FROM volume_outlines WHERE id = %s", volume_id)[0]
    line_plan = volume.get("line_plan", {})
    
    results = {"created": [], "updated": [], "chapter_assignments": 0}
    
    for line_config in line_plan.get("lines", []):
        # 查找或创建叙事线
        existing = db.query(
            "SELECT id FROM narrative_lines WHERE work_id = %s AND name = %s",
            work_id, line_config["line_name"]
        )
        
        if existing:
            line_id = existing[0]["id"]
            results["updated"].append(line_config["line_name"])
        else:
            line_id = str(uuid.uuid4())
            db.execute("""
                INSERT INTO narrative_lines (id, work_id, name, line_type, weight, color, status)
                VALUES (%s, %s, %s, %s, %s, %s, 'active')
            """, (line_id, work_id, line_config["line_name"],
                  line_config["line_type"], line_config.get("weight", 0.5),
                  line_config.get("color", "#888888")))
            results["created"].append(line_config["line_name"])
        
        # 同步章纲归属
        for ch in line_config.get("chapters", []):
            db.execute("""
                UPDATE chapter_outlines SET narrative_line_id = %s
                WHERE work_id = %s AND chapter_num = %s
            """, (line_id, work_id, ch))
            results["chapter_assignments"] += 1
    
    # 创建线间依赖
    dependencies = line_plan.get("dependencies", [])
    for dep in dependencies:
        # TODO(P3): 待实现
        from_line = _get_line_id(work_id, dep["from"])
        to_line = _get_line_id(work_id, dep["to"])
        if from_line and to_line:
            db.execute("""
                INSERT INTO line_dependencies (id, from_line, to_line, dependency_type, description)
                VALUES (gen_random_uuid(), %s, %s, %s, %s)
            """, (from_line, to_line, dep["type"], dep.get("description", "")))
    
    return results
```

#### 13.4.2 M5 知识背包与 B2 认知检查的统一

> ⚠️ **迁移说明**：本节的 `UnifiedKnowledgeSystem` 已由 #G.1 `UnifiedEntityEngine.get_effective_state(entity_id, line_id)` 和 #G.2 `BaseDetector` 体系完全替代。保留本节作为**设计参考**。
> （迁移说明见 #9.4.2 角色弧线数据结构）

### 13.5 叙事线编辑器交互设计

#### 13.5.1 叙事线面板布局设计

**叙事线管理面板**：

```text
┌─────────────────────────────────────────────────────────────┐
│  叙事线管理                                    [+新建线] [预设]  │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ 🔴 主线·京城暗流                    [活跃] [权重0.5] │    │
│  │    进度：████████░░ 45/60章  最后活跃：第60章        │    │
│  │    角色：林风、苏瑶、李将军                              │    │
│  │    [切换] [暂停] [编辑] [详情]                         │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ 🔵 感情线·月下之约                    [活跃] [权重0.25]│    │
│  │    进度：██████░░░░ 25/40章  最后活跃：第58章        │    │
│  │    角色：林风、苏瑶                                      │    │
│  │    [切换] [暂停] [编辑] [详情]                         │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ 🟡 势力线·宗门风云                    [暂停] [权重0.25]│    │
│  │    进度：████░░░░░░ 15/40章  最后活跃：第42章        │    │
│  │    ⚠️ 已18章未推进，建议尽快恢复                        │    │
│  │    [切换] [恢复] [编辑] [详情]                         │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  ─── 视图切换 ─── [概览] [甘特图] [依赖图] [热力图]        │
└─────────────────────────────────────────────────────────────┘
```

**切换线时的过渡动画**：

| 步骤 | UI 表现 | 耗时 |
|------|--------|------|
| 1. 保存当前线存档 | 右上角 Toast："A 线已保存" | <100ms |
| 2. 加载目标线存档 | 中央显示加载动画 | <500ms |
| 3. 展示恢复摘要 | 中央卡片滑入 | <300ms |
| 4. 进入编辑模式 | 恢复摘要收起到侧边栏 | 即时 |

#### 13.5.2 叙事线大纲模板预设 *[已迁移]*

> ⚠️ **迁移说明**：本节的 `NARRATIVE_LINE_TEMPLATES` 和 `apply_narrative_line_template()` 已由 #G.3 `UnifiedTemplate`（`type='narrative_line'`）统一替代。保留本节作为**模板内容参考**。

---

<a id="ch14"></a>
## 第 14 章 B6 角色状态桥梁层

> 本章包含：14.1-14.4 B6 角色状态桥梁层完整设计（B7 伏笔协调层见第 15 章，B8 节奏控制见第 16 章）

> **设计动机**：CharacterAgent 的运行时状态在会话结束后丢失，大纲弧线与角色状态之间缺乏数据流接口。
> B6 不是新建独立系统，而是打通已有模块间的三个数据流断层（详见 14.1 节）。

### 14.1 问题定义

> 📍 第 14 章导航：[14.1 问题定义](#141-问题定义) | [14.2 角色运行时状态持久化](#142-m1-角色运行时状态持久化) | [14.3 大纲→角色衔接 API](#143-m2-大纲角色衔接-api-实现) | [14.4 CharacterAgent 增强](#144-m3-characteragent-增强设计) | [14.4.1 B6 数据流全景](#1441-b6-数据流全景) | [14.4.2 B6 与现有模块集成](#1442-b6-与现有模块的集成点) | [14.4.3 B6 SQL Schema](#1443-b6-sql-schema) | B7 伏笔协调层见 [第 15 章](#ch15) | B8 节奏控制见 [第 16 章](#ch16)

**三个数据流断层**：

| 断点 | 上游 | 下游 | 现状 |
|------|------|------|------|
| 断点 1：运行时状态持久化 | CharacterAgent `internal_state` | `UnifiedEntity.global_state` | ❌ 无桥梁，会话结束后状态丢失 |
| 断点 2：大纲→角色初始化 | B1 大纲弧线定义（起点/终点/变化） | CharacterAgent `internal_state` | ❌ `get_character_arc_progress()`未实现 |
| 断点 3：角色↔记忆双向流 | CharacterAgent `emotional_history` | 第 8 章五层记忆结构 | ❌ 两套独立设计，格式不兼容 |

**设计原则**：

| 原则 | 说明 |
|------|------|
| 桥梁而非引擎 | B6 不新建独立系统，只提供接口层打通已有模块 |
| 持久化优先 | CharacterAgent 的运行时状态必须可持久化到`UnifiedEntity` |
| 大纲驱动初始化 | 角色状态由大纲弧线定义初始化，由实际写作演化 |
| 记忆作为唯一真相源 | 角色的情感履历以记忆系统为准，CharacterAgent 从中读取 |

---

### 14.2 M1 角色运行时状态持久化（CharacterStateBridge）

**核心思想**：CharacterAgent 的`internal_state`通过`UnifiedEntity.global_state`字段持久化，会话结束后不丢失。

> 📄 **完整实现见附录 [H.1 CharacterRuntimeState 完整实现](#appendix-h)**

**核心类**：

| 类名 | 类型 | 职责 |
|------|------|------|
| `CharacterRuntimeState` | dataclass | 角色运行时状态完整定义（含 B6 桥梁层扩展字段） |
| `CharacterStateBridge` | class | B6 桥梁层核心类，管理角色状态的持久化、大纲同步、记忆双向同步 |
| `ConcurrentStateError` | class | 并发修改冲突异常 |

**CharacterStateBridge 关键方法**：

| 方法 | 参数 | 说明 |
|------|------|------|
| `__init__` | db, event_bus | 初始化桥梁层，注册事件监听 |
| `get_or_create_state` | character_id, work_id | 获取或创建角色运行时状态 |
| `update_from_outline` | character_id, chapter_num, outline_context | 大纲变更时更新角色状态 |
| `_handle_outline_updated` | event | OUTLINE_UPDATED 事件处理器 |
| `sync_to_memory` | character_id, memory_type, content | 角色状态→记忆系统双向同步 |
| `_handle_foreshadow_resolved` | event | 伏笔回收事件响应（B7→B6 桥梁） |
| `advance_arc_phase` | character_id, new_phase | 弧线阶段推进 |
| `get_character_foreshadowings` | character_id | 获取角色相关伏笔列表（B7 数据消费） |

---

### 14.3 M2 大纲→角色衔接 API 实现

**补全 B1 中未实现的`get_character_arc_progress()`函数**：

```python
# --- 摘要：get_character_arc_progress() —— 获取当前章节所有活跃角色的弧线进度，被B1写作上下文调用 ---
def get_character_arc_progress(work_id: str, chapter_num: int) -> list:
    """
    获取当前章节所有活跃角色的弧线进度
    
    被B1 #9.4.7 get_writing_context_from_outline()调用
    
    注意：此数据同时注入WriterAgent写作上下文（通过 #5.4 ContextRouter 的
    character_runtime 通道），WriterAgent据此保持角色情感与弧线阶段一致。
    
    Returns:
        [
            {
                "character_id": "uuid",
                "character_name": "林风",
                "arc_position": 0.3,
                "arc_phase": "被迫面对",
                "current_emotion": "焦虑",
                "current_goals": ["找到师父", "变强保护苏瑶"],
                "next_milestone": "第一次主动保护他人",
                "emotional_accumulation": {"对反派的恨意": 0.7},
            },
            ...
        ]
    """
    bridge = CharacterStateBridge(entity_engine, memory_system)
    
    # 查询所有活跃角色
    characters = db.query(
        """SELECT * FROM unified_entities 
           WHERE work_id = %s AND domain = 'character' 
           AND lifecycle IN ('active', 'dormant')""",
        work_id
    )
    
    # 查询当前章节相关的未触发里程碑（用于next_milestone）
    upcoming_milestones = db.query(
        """SELECT ca.entity_id, am.name as milestone_name
           FROM character_arcs ca
           JOIN arc_milestones am ON ca.id = am.arc_id
           WHERE ca.work_id = %s AND am.triggered = false
           ORDER BY am.id""",
        work_id
    )
    milestone_map = {}
    for m in upcoming_milestones:
        eid = m["entity_id"]
        if eid not in milestone_map:
            milestone_map[eid] = m["milestone_name"]
    
    results = []
    for char in characters:
        runtime = bridge.load_runtime_state(char["id"])
        results.append({
            "character_id": char["id"],
            "character_name": char["name"],
            "arc_position": char["arc_position"],
            "arc_phase": runtime.arc_phase,
            "current_emotion": runtime.current_emotion,
            "current_goals": runtime.current_goals,
            "next_milestone": milestone_map.get(char["id"], ""),  # 从里程碑映射获取
            "emotional_accumulation": runtime.emotional_accumulation,
        })
    
    return results
```

---

### 14.4 M3 CharacterAgent 增强设计


**第 7 章 CharacterAgent 的增强版**，集成 B6 桥梁层：

```python
# --- 摘要：CharacterAgentV2 —— 集成B6角色状态桥梁层的增强版角色Agent，支持持久化状态和弧线感知 ---
class CharacterAgentV2:
    """
    CharacterAgent V2 —— 集成B6角色状态桥梁层
    
    与V1的区别：
    - __init__ 从 CharacterStateBridge 加载持久化状态
    - react_to() 结果自动同步到记忆系统
    - 新增 arc_context 字段，感知当前弧线阶段
    """
    
    def __init__(self, entity_id: str, state_bridge: CharacterStateBridge,
                 scene_context: dict):
        # 从桥梁层加载完整上下文
        ctx = state_bridge.get_character_agent_context(entity_id)
        self.profile = ctx["profile"]
        self.internal_state = ctx["internal_state"]
        self.arc_context = ctx["arc_context"]
        
        # 从记忆系统加载场景相关记忆
        memory_ctx = state_bridge.sync_memory_to_agent(entity_id, scene_context)
        self.relevant_memories = memory_ctx["relevant_memories"]
        self.active_goals = memory_ctx["active_goals"]
    
    def react_to(self, event: str, chapter_num: int) -> dict:
        """
        基于内部状态+弧线上下文+记忆 判断反应
        
        V1的三步流程 + 弧线感知增强：
        Step 1: 判断触发情绪（同V1）
        Step 2: 情感累积值影响反应强度（同V1）
        Step 3: 检查行为边界（同V1）
        Step 4 [新增]: 检查弧线阶段一致性
            - 当前反应是否符合arc_phase_expected_state？
            - 如果不符合，标记为"可能的退弧"（允许但记录）
        """
        # Step 1-3: 同V1逻辑（见 #7.2 CharacterAgent 基础实现）
        action = self._compute_action(event)  # 继承自V1
        
        # Step 4: 弧线一致性检查
        arc_consistency = None
        if self.arc_context.get("arc_phase_expected_state"):
            arc_consistency = self._check_arc_consistency(action)
        
        reaction = {
            "action": action,
            "justification": self._generate_justification(action),  # 继承自V1
            "internal_monologue": self._generate_monologue(action),  # 继承自V1
            "arc_consistency": arc_consistency,
        }
        
        return reaction
    
    def _check_arc_consistency(self, action: dict) -> dict:
        """
        检查反应与当前弧线阶段的一致性

        【L41补充说明：设计阶段占位】
        本方法为设计阶段占位实现，实际运行时使用B6的CharacterAgentV2进行
        1. 从 CharacterRuntimeState.arc_phase 获取角色当前弧线阶段
        2. 从 CharacterRuntimeState.arc_phase_expected_state 获取该阶段的预期状态
        3. 将 action 的情感倾向、行为模式与预期状态对比
        4. 由LLM判断一致性程度，输出 consistent/note 等字段
        5. 对比大纲定义的预期阶段（B1 get_character_arc_progress()），
           确保角色弧线推进方向与大纲一致

        Returns:
            {
                "consistent": True/False,
                "phase": "被迫面对",
                "expected": "被动中开始动摇",
                "actual": "主动冲锋",
                "note": "轻微超前（可能是成长的信号）",
            }
        """
        expected = self.arc_context["arc_phase_expected_state"]
        # 设计阶段占位：实际实现中由B6 CharacterAgentV2通过LLM判断
        # action是否符合expected_state，并对比大纲弧线定义的预期阶段
        return {"consistent": True, "note": "设计阶段占位，待B6 CharacterAgentV2集成后由LLM实现弧线一致性检查"}
```

---

#### 14.4.1 B6 数据流全景

```text
│                      B6 角色状态桥梁层                        │
│                                                              │
│  ┌──────────────┐    M1持久化    ┌──────────────────┐       │
│  │CharacterAgent │ ←──────────→ │  UnifiedEntity   │       │
│  │ internal_state│              │ global_state     │       │
│  │ (运行时)      │              │ ["character_     │       │
│  │              │              │  runtime"]       │       │
│  └──────┬───────┘              └──────────────────┘       │
│         │                           ▲                      │
│         │ M3双向同步                │ M2初始化              │
│         ▼                           │                      │
│  ┌──────────────┐              ┌──────────────────┐       │
│  │ 第8章记忆系统 │              │ B1大纲弧线定义    │       │
│  │ 五层记忆结构  │              │ 起点/终点/阶段   │       │
│  └──────────────┘              └──────────────────┘       │
│                                                              │
│  里程碑触发 → #17.4 事件总线 → B4风格系统                      │
│  弧线偏离 → B2检查管线（角色Agent自检，第7条）                 │
└─────────────────────────────────────────────────────────────┘
```

---

#### 14.4.2 B6 与现有模块的集成点

| 集成点 | 位置 | 说明 |
|------|------|------|
| B1 `get_writing_context_from_outline()` | #9.4.7 | 调用 M2 补全的`get_character_arc_progress()`，为 WriterAgent 提供角色弧线上下文 |
| WriterAgent 写作上下文 | #5.4 ContextRouter | B6 的 CharacterRuntimeState（arc_phase、current_emotion）通过 ContextRouter 注入 WriterAgent 写作上下文，确保写作时角色情感与弧线阶段一致 |
| B2 第 7 条"角色 Agent 自检" | #10.2 | CharacterAgentV2 的`_check_arc_consistency()`增强自检能力 |
| B4 `register_character_growth_intent()` | 附录 C 29.2.5 | M1 的`advance_arc_phase()`通过事件总线触发风格意图注册 |
| B5 `entity_line_states` | #G.1 | 不同叙事线中角色的`global_state["character_runtime"]`独立隔离 |
| #G.1 `UnifiedEntity` | #G.1 | `global_state["character_runtime"]`存储运行时状态 |
| #G.2 `BaseDetector` | #G.2 | 可注册`ArcConsistencyDetector`（可选，CharacterAgent 自检已覆盖） |
| 第 7 章 CharacterAgent | #7.2 | V2 版本集成 B6 桥梁层，替换 V1 |

---

#### 14.4.3 B6 SQL Schema

```sql
# --- 摘要：B6桥梁层弧线管理SQL Schema —— character_arcs/arc_phases/arc_milestones三表管理角色弧线生命周期 ---
-- ============================================================
-- B6桥梁层弧线管理专用存储
-- 说明：CharacterArc数据类虽已迁移到UnifiedEntity（#17.8.1），
--       但B6桥梁层新增了arc_phases（弧线阶段）和arc_milestones
--       （里程碑事件）的扩展结构，用于弧线生命周期管理。
--       这些表通过entity_id外键关联到unified_entities，
--       与数据类迁移不冲突。
-- ============================================================

-- 角色弧线定义表（补全#17.8.1迁移映射中"弧线定义保留独立表"的缺失）
CREATE TABLE character_arcs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    work_id UUID NOT NULL REFERENCES works(id),
    entity_id UUID NOT NULL REFERENCES unified_entities(id),
    name VARCHAR(200) NOT NULL,          -- 弧线名称
    description TEXT,                    -- 弧线描述（L21补充：概括弧线核心冲突与走向）
    starting_state JSONB NOT NULL,       -- 起点状态
    ending_state JSONB NOT NULL,         -- 终点状态
    status VARCHAR(20) DEFAULT 'planned', -- planned/active/completed/abandoned
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
-- ER关系：本表通过 work_id 关联到 works(id)；通过 entity_id 关联到 unified_entities(id)；被 arc_phases(arc_id)、arc_milestones(arc_id) 关联

-- 弧线阶段表
CREATE TABLE arc_phases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    arc_id UUID NOT NULL REFERENCES character_arcs(id),
    phase_order INT NOT NULL,
    name VARCHAR(200) NOT NULL,
    description TEXT,
    expected_state JSONB,                -- 该阶段角色预期状态
    start_chapter INT,
    end_chapter INT,
    created_at TIMESTAMP DEFAULT NOW(),  -- L22补充：阶段创建时间
    UNIQUE(arc_id, phase_order)
);
-- ER关系：本表通过 arc_id 关联到 character_arcs(id)；被 arc_milestones(phase_id) 关联

-- 弧线里程碑事件表
CREATE TABLE arc_milestones (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    arc_id UUID NOT NULL REFERENCES character_arcs(id),
    phase_id UUID REFERENCES arc_phases(id),
    name VARCHAR(200) NOT NULL,
    description TEXT,
    trigger_keywords TEXT[],
    trigger_chapter INT,                 -- 实际触发章节（NULL=未触发）
    triggered BOOLEAN DEFAULT FALSE,
    triggered_at TIMESTAMP,
    triggered_by_foreshadow_id VARCHAR(50),  -- 触发此里程碑的伏笔ID（可为NULL；当伏笔回收触发里程碑时，记录关联的伏笔实体ID）
    UNIQUE(arc_id, name)
);
-- ER关系：本表通过 arc_id 关联到 character_arcs(id)；通过 phase_id 关联到 arc_phases(id)

CREATE INDEX idx_arcs_entity ON character_arcs(entity_id);
CREATE INDEX idx_arcs_work ON character_arcs(work_id);
CREATE INDEX idx_milestones_triggered ON arc_milestones(arc_id, triggered);
```

---

<a id="ch15"></a>
## 第 15 章 B7 伏笔协调层（ForeshadowCoordinator）

### 15.1 设计定位与原则

**定位**：B7 作为伏笔系统的**薄协调层**，不重写已有功能，而是统一入口、补齐缺口、协调各模块。

> **补充说明：数据访问权限** ——B7 伏笔协调层的数据访问遵循 `collaborator_read_only` 规则（见附录 E E.22.3 数据安全策略），协作者可查看伏笔仪表盘和统一视图，但不能修改伏笔状态、添加/删除伏笔或调整密度阈值。

**设计背景**：伏笔相关能力分散在 6 个模块中（算法层 ForeshadowingTracker、B1 大纲铺垫检查、B2 故意设计转化、B3 因果链三态+衰减+回收评估、B5 M10 跨线伏笔、统一架构），已覆盖伏笔生命周期的绝大部分环节。B7 的职责是整合这些分散能力，并补充三个关键缺口。

**设计原则**：

1. **事件驱动，非章数驱动** —— 伏笔回收由剧情事件触发，而非预设章数倒计时
2. **作者可选预期** —— 作者可填写预期回收事件（可选），系统据此提供时机建议
3. **衰减统一** —— 废弃 ForeshadowingTracker 的章数预警，统一使用 B3 读者记忆衰减模型
4. **AI 只建议不决策** ——AI 识别和回收检测均需作者确认，符合创作主权原则

**已有能力分布**（B7 不重复实现）：

| 模块 | 已有能力 | 章节引用 |
|------|---------|------|
| 算法层 ForeshadowingTracker | 伏笔 CRUD、状态管理 | #6.4 |
| B1 大纲系统 | 铺垫检查算法、伏笔间距检查、大纲预演 | #9.2、#9.4.4、#9.4.5 |
| B2 隐含信息检测 | "故意设计"→伏笔转化通道 | #10.5 |
| B3 因果链检测 | 元素三态管理、读者记忆衰减、场景共振推荐、回收质量评估 | #11.2、#11.4 |
| B5 多线叙事 | M10 跨线伏笔标签、跨线回收提醒 | 附录 D #13 |
| 统一架构 | UnifiedEntity 关联、事件总线 | #G.1、#附录 F |

### 15.2 统一伏笔视图

**问题**：ForeshadowingTracker 的状态机（planted/progressing/resolved/abandoned）与 B3 元素三态（active/dormant/dead）是两套独立体系，开发者需要跨模块理解。

**方案**：B7 提供 `get_unified_view(work_id)` 方法，返回每个伏笔的合并视图。

```python
@dataclass
class UnifiedForeshadowing:
    id: str                         # 统一ID（fp_xxxx）
    description: str                # 伏笔描述
    foreshadow_type: str            # 伏笔类型（见 #15.6）
    importance: str                 # critical / normal / minor
                                     # 【语义说明】此字段为B7专用的伏笔重要性分级（字符串枚举），
                                     # 与 unified_entities.importance（B3元素重要性，0-1浮点数）是不同语义。
                                     # 映射关系：critical → 0.9, normal → 0.5, minor → 0.2
                                     # B7内部使用字符串枚举便于业务逻辑判断（如alerts优先展示critical），
                                     # 而B3的浮点数用于元素三态计算和心跳衰减模型。
    planted_chapter: int            # 埋设章节

    # 预期回收规划（作者可选填）
    expected_event: str | None      # 预期回收事件描述，如"主角突破金丹期时"
    expected_chapter: int | None    # 根据大纲自动估算的参考章数

    # 运行时状态（B7统一状态）
    status: str                     # PLANNED → ACTIVE → DORMANT → RESOLVED | ABANDONED
    reader_memory: float            # 读者记忆强度 0.0~1.0（来自B3衰减模型）
    last_mentioned_chapter: int     # 最后一次被提及/推进的章节

    # 跨线信息（来自B5 M10）
    cross_line: bool                # 是否跨线伏笔
    target_lines: list[str]         # 跨线目标叙事线ID列表

    # 依赖链（见 #15.8）
    depends_on: list[str]           # 依赖的上游伏笔ID（必须先于本伏笔回收）
    triggers: list[str]             # 本伏笔回收时触发的下游伏笔ID

    # 质量评估（已回收时）
    actual_resolved_chapter: int | None
    actual_resolved_event: str | None
    quality_score: dict | None      # 来自B3 evaluate_foreshadowing_payoff()
```

**状态映射规则**：

| ForeshadowingTracker 状态 | B3 元素三态 | B7 统一状态 | 含义 |
|------|-----------|------|------|
| planted | — | PLANNED | 已规划，尚未在正文中出现 |
| progressing | active | ACTIVE | 正在推进中，读者记忆活跃 |
| — | dormant | DORMANT | 休眠中，读者记忆衰减 |
| resolved | dead | RESOLVED | 已回收/揭示 |
| abandoned | dead | ABANDONED | 作者主动放弃 |

**状态转换触发**：

```python
# 状态转换由事件驱动，非章数驱动
TRANSITIONS = {
    "PLANNED": ["ACTIVE"],                    # 首次在正文中提及
    "ACTIVE": ["DORMANT", "RESOLVED"],        # 20章未提及→DORMANT；被回收→RESOLVED
    "DORMANT": ["ACTIVE", "RESOLVED", "ABANDONED"],  # 被提及→ACTIVE；被回收→RESOLVED；作者放弃→ABANDONED
    "RESOLVED": [],                           # 终态
    "ABANDONED": [],                          # 终态
}
```

### 15.3 AI 伏笔识别引擎

**问题**：目前所有伏笔都依赖作者手动埋设（ForeshadowingTracker.plant()）或间接转化（B2"故意设计"），容易遗漏。

**方案**：写作完成后，AI 分析新章节，自动识别潜在的伏笔信号，建议作者标记。

**识别规则**（算法层，零 LLM 成本）：

| 信号类型 | 检测方式 | 置信度 |
|------|---------|------|
| 悬而未决的描述 | 包含"神秘""未知""秘密"等标记词 + 后续 5 章内未解释 | 高 |
| 异常强调的细节 | 段落中对某物品/人物的描写篇幅显著高于周围段落（>2 倍均值） | 中 |
| 角色异常反应 | 角色对某事物的反应与其性格/立场不符（需 CharacterAgent 辅助） | 中 |
| 重复出现的元素 | 同一元素在 3 章内出现 2 次以上但未被标记为伏笔 | 低 |

**处理流程**：

```python
# --- 摘要：scan_chapter_for_foreshadowing() —— 扫描新章节识别潜在伏笔信号（悬而未决/异常强调/反常行为等） ---
def scan_chapter_for_foreshadowing(work_id: str, chapter_num: int, chapter_text: str) -> list[dict]:
    """
    扫描新章节，识别潜在伏笔信号。
    返回候选列表，仅展示置信度≥中 的信号。
    """
    candidates = []

    # 信号1：悬而未决的描述
    mystery_patterns = ["神秘", "未知", "秘密", "奇怪", "不对劲", "似乎"]
    for match in find_mystery_descriptions(chapter_text, mystery_patterns):
        # 检查后续5章是否已解释
        if not is_explained_in_next_chapters(work_id, chapter_num, match["entity"], window=5):
            candidates.append({
                "signal_type": "unresolved_mystery",
                "entity": match["entity"],
                "description": match["context"],
                "confidence": "high",
                "suggested_type": "plot",  # 默认建议类型
            })

    # 信号2：异常强调的细节（篇幅统计）
    for paragraph in split_paragraphs(chapter_text):
        entities = extract_entities(paragraph)
        if entities and len(paragraph) > avg_paragraph_length * 2:
            candidates.append({
                "signal_type": "unusual_emphasis",
                "entity": entities[0],
                "description": truncate(paragraph, 100),
                "confidence": "medium",
                "suggested_type": "item",
            })

    # 信号3：角色异常反应（需CharacterAgent辅助）
    # TODO(P2): 待CharacterAgentV2（B6增强版）稳定后实现
    # 【L40补充说明】
    # CharacterAgentV2（第14章B6增强版）的 react_to() 输出包含 internal_monologue 字段，
    # 可作为角色性格基线参考。实现时，对比角色的 internal_monologue 与其性格设定，
    # 检测是否存在"异常反应"（如性格沉稳的角色突然表现出冲动行为）。
    # 此功能为P2依赖，需B6 V2的 react_to() 接口稳定后再实现。
    # 当前MVP阶段，角色异常反应的检测依赖作者手动标记或B2检查管线的间接覆盖。

    # 信号4：重复出现的元素
    recent_entities = get_entity_frequency(work_id, chapter_num - 3, chapter_num)
    for entity, count in recent_entities.items():
        if count >= 2 and not is_existing_foreshadowing(work_id, entity):
            candidates.append({
                "signal_type": "repeated_element",
                "entity": entity,
                "description": f"近3章出现{count}次",
                "confidence": "low",  # 低置信度不展示
                "suggested_type": "item",
            })

    # 过滤：仅返回置信度≥medium的候选
    return [c for c in candidates if c["confidence"] != "low"]
```

**关键设计决策**：
- AI 只**建议**，不自动创建（符合"创作主权不可侵犯"原则）
- 低置信度信号不展示，避免误报干扰写作
- 已排除的信号有冷却期（10 章内不再提示同一元素）

### 15.4 回收自动检测器

**问题**：目前回收依赖作者手动标记 `FORESHADOW_RESOLVED`，容易遗忘。

**方案**：审校时自动检测"某个伏笔是否在本章被自然回收或推进"。

**检测逻辑**（两步检测）：

```python
# --- 摘要：detect_foreshadowing_recovery() —— 伏笔回收检测，两阶段策略（算法层关键词匹配 + LLM层语义判断） ---
def detect_foreshadowing_recovery(work_id: str, chapter_num: int, chapter_text: str) -> list[dict]:
    """
    检测本章中是否有伏笔被自然回收或推进。
    Step 1（算法层）：关键词/实体匹配，零LLM成本
    Step 2（LLM层）：仅对Step 1命中项进行语义判断
    """
    dormant_foreshadowing = get_unified_view(work_id, status=["DORMANT", "ACTIVE"])
    hints = []

    # 函数入口日志：记录检测开始，便于追踪检测行为
    logger.info(f"开始伏笔回收检测，work_id={work_id}, chapter={chapter_num}")

    for fp in dormant_foreshadowing:
        # Step 1：算法层 —— 检查伏笔关键实体是否出现在本章
        entities = extract_key_entities(fp.description)
        if not any(e in chapter_text for e in entities):
            continue

        # Step 2：LLM层 —— 判断是否真的被回收/推进
        # LLM调用前日志：记录即将进行的LLM判断，便于排查调用链
        logger.debug(f"调用LLM判断伏笔回收: foreshadowing_id={fp.id}")
        try:
            import asyncio
            # 设置30秒超时，防止LLM调用阻塞过久
            result = await asyncio.wait_for(
                llm_analyze(  # TODO(P3): 待实现
                    prompt=f"""分析以下文本中，伏笔是否被回收或推进。

伏笔描述：{fp.description}
埋设章节：第{fp.planted_chapter}章
当前章节：第{chapter_num}章
本章文本：{chapter_text[:2000]}

判断标准：
- RESOLVED：读者能将当前情节与伏笔建立明确因果联系（真相揭示）
- PROGRESSED：伏笔被提及或暗示，但未完全揭示（部分推进）
- UNRELATED：虽然提到了相关实体，但与伏笔无关

返回格式：{{"verdict": "RESOLVED|PROGRESSED|UNRELATED", "evidence": "依据"}}""",
                    max_tokens=200,
                ),
                timeout=30.0,  # LLM调用超时：30秒
            )

            # 校验LLM返回格式，确保verdict字段存在
            if not isinstance(result, dict) or "verdict" not in result:
                logger.warning(f"伏笔回收检测LLM返回格式异常，降级为关键词匹配: {result}")
                result = None  # 标记为无效，后续走降级逻辑

        except asyncio.TimeoutError:
            # LLM超时 → 降级为关键词匹配
            logger.warning(f"伏笔回收检测LLM调用超时（30s），降级为关键词匹配: foreshadow_id={fp.id}")
            result = None
        except Exception as e:
            # LLM调用异常（网络错误、API限流等）→ 降级为关键词匹配
            # 降级日志：记录LLM失败原因，便于监控LLM可用性
            logger.warning(f"LLM判断失败，使用关键词降级: foreshadow_id={fp.id}, error={e}")
            result = None

        # 降级策略：LLM不可用时，使用关键词匹配作为降级
        # 检查章节文本中是否包含伏笔描述的关键词，若命中则标记为PROGRESSED
        if result is None:
            # 关键词降级：Step 1已确认实体出现在本章，直接标记为推进
            result = {"verdict": "PROGRESSED", "evidence": "LLM不可用，基于关键词匹配降级判断"}

        if result["verdict"] in ("RESOLVED", "PROGRESSED"):
            hints.append({
                "foreshadow_id": fp.id,
                "description": fp.description,
                "verdict": result["verdict"],
                "evidence": result["evidence"],
                "reader_memory": fp.reader_memory,
                "expected_event": fp.expected_event,
                "timing_assessment": _assess_timing(fp, chapter_num, result["verdict"]),
            })

    # 函数出口日志：记录检测结果摘要，便于监控检测效率
    confirmed = len([h for h in hints if h["verdict"] == "RESOLVED"])
    logger.info(f"伏笔回收检测完成，处理{len(dormant_foreshadowing)}个候选，确认{confirmed}个回收")

    return hints


def _assess_timing(fp: UnifiedForeshadowing, actual_chapter: int, verdict: str) -> str:
    """评估回收时机"""
    if not fp.expected_chapter:
        return "no_expectation"  # 作者未设定预期

    diff = actual_chapter - fp.expected_chapter

    if verdict == "RESOLVED":
        if abs(diff) <= 5:
            return "on_time"       # 按预期回收
        elif diff < -5:
            return "early"         # 提前回收（读者记忆可能更高，效果可能更好）
        else:
            return "late"          # 延后回收（读者记忆已衰减）
    else:  # PROGRESSED
        return "progressing"       # 推进中，不评估时机
```

**三种回收场景的处理**：

| 场景 | 预期事件 | 实际事件 | 系统提示 |
|------|---------|------|---------|
| 按预期回收 | "主角突破金丹期" | 主角突破金丹期 | "✅ 按预期回收，读者记忆 0.6，质量评分：A 级" |
| 提前回收 | "主角突破金丹期" | 主角筑基期就用了戒指力量 | "⚡ 提前回收（预期：金丹期），读者记忆 0.8，效果可能更好。确认回收？" |
| 延后回收 | "主角突破金丹期" | 主角已元婴期才用戒指 | "⚠️ 延后回收（预期：金丹期），读者记忆已衰减至 0.15，建议先铺垫唤醒" |
| 无预期事件 | 作者未填写 | 任意时机 | 纯事件驱动，无预期对比 |

**与回收质量评估的衔接**：确认回收后，自动调用 B3 的 `evaluate_foreshadowing_payoff()` 生成四维度质量评分。

### 15.5 伏笔仪表盘 API

**对外统一接口**，供编辑器 UI、审校 Agent、健康度计算等调用。

> 📄 **完整实现见附录 [H.2 ForeshadowCoordinator 完整实现](#appendix-h)**

**类定位**：`ForeshadowCoordinator` 是 B7 伏笔协调层的统一入口，管理伏笔全生命周期。

**公开方法**：

| 方法 | 参数 | 返回值 | 说明 |
|------|------|------|------|
| `get_dashboard` | work_id, chapter_num | `UnifiedForeshadowing` | 获取统一伏笔视图（含所有类型的伏笔列表） |
| `inject_foreshadowing` | work_id, chapter_num, content, foreshadowing_data | dict | AI 辅助注入伏笔 |
| `detect_new_foreshadowings` | work_id, chapter_num, chapter_content | list | AI 自动识别新伏笔 |
| `check_recall_opportunities` | work_id, chapter_num, chapter_content | list | 回收机会检测 |
| `send_recall_reminder` | work_id, foreshadowing_id | bool | 发送回收提醒 |
| `update_foreshadowing_status` | work_id, foreshadowing_id, new_status | bool | 更新伏笔状态 |
| `get_density_metrics` | work_id, chapter_num | dict | 获取伏笔密度指标 |
| `get_dependency_chain` | work_id, foreshadowing_id | list | 获取伏笔依赖链 |

### 15.6 伏笔分类体系

**问题**：现有设计只有重要性分级（critical/normal/minor），没有按伏笔类型分类。不同类型的伏笔管理策略差异很大。

**五种伏笔类型**：

<!-- 表格说明：伏笔分类体系，定义五种伏笔类型及其管理策略 -->
| 类型 | 代码 | 说明 | 回收特点 | 衰减速率 | 管理策略 |
|------|------|------|---------|------|---------|
| 道具伏笔 | `item` | 神秘戒指、古老地图、特殊武器等 | 通常有明确的"使用时机" | 标准（x0.98/章） | 绑定预期事件 |
| 人物伏笔 | `character` | 角色的秘密身份、隐藏目的、身世之谜 | 回收时通常伴随角色弧线转折 | 标准（x0.98/章） | 关联角色弧线（B6） |
| 情节伏笔 | `plot` | 预示未来事件走向的暗示、预言 | 回收=预言事件发生 | 标准（x0.98/章） | 关联大纲事件（B1） |
| 世界观伏笔 | `worldview` | 力量体系上限、世界秘密、远古历史 | 可能贯穿全书，回收周期极长 | 慢速（x0.99/章） | 降低预警频率 |
| 误导伏笔 | `misdirection` | 故意引导读者错误推理的线索 | "回收"=揭示真相，推翻误导 | 标准（x0.98/章） | 不触发常规回收提醒 |

**差异化处理规则**：

```python
# --- 摘要：TYPE_CONFIG —— 5种伏笔类型的默认参数配置（衰减速率/记忆预警/回收提醒），支持 PluginConfigLayer（插件化配置层，按题材/用户自定义配置的扩展机制）覆盖 ---
# 配置项说明：TYPE_CONFIG 定义了5种伏笔类型（item/character/plot/worldview/misdirection）
# 的默认参数，包括衰减速率、记忆预警阈值、回收提醒开关等。
# 可通过 PluginConfigLayer 按题材覆盖默认值，加载优先级：
#   作者自定义 > PluginConfigLayer题材覆盖 > TYPE_CONFIG内置默认值
#
# 覆盖示例（通过 PluginConfigLayer）：
#   config_layer.set_override("foreshadowing", "item", {
#       "decay_rate": 0.95,              # 加快道具伏笔衰减（短篇节奏更快）
#       "memory_warning_threshold": 0.4, # 提高预警阈值
#   })
TYPE_CONFIG = {
    "item": {
        "decay_rate": 0.98,           # 标准衰减
        "memory_warning_threshold": 0.3,
        "recovery_reminder": True,     # 触发回收提醒
        "default_suggested_type": None,  # AI识别时不预设类型
    },
    "character": {
        "decay_rate": 0.98,
        "memory_warning_threshold": 0.3,
        "recovery_reminder": True,
        "arc_link": True,              # 关联B6角色弧线
        # 人物伏笔与角色弧线的数据关联路径：
        #   伏笔实体(unified_entities, domain=foreshadowing, type=character)
        #   → 通过 related_entities 关联角色ID
        #   → character_arcs 表（通过 entity_id 外键）
        #   → arc_milestones 表（伏笔回收时触发里程碑更新）
        # 回收时通过 FORESHADOW_RESOLVED 事件通知 B6 CharacterStateBridge，
        # 由 on_foreshadowing_resolved() 方法自动更新 arc_milestones。
        # 也可通过 ForeshadowCoordinator.get_character_foreshadowings() 
        # 查询指定角色的所有伏笔。
    },
    "plot": {
        "decay_rate": 0.98,
        "memory_warning_threshold": 0.3,
        "recovery_reminder": True,
        "outline_link": True,          # 关联B1大纲事件
    },
    "worldview": {
        "decay_rate": 0.99,            # 慢速衰减（读者对世界观的记忆更持久）
        "memory_warning_threshold": 0.2,  # 更低的预警阈值
        "recovery_reminder": True,
        "check_interval": 30,          # 每30章检查一次（而非20章）
    },
    "misdirection": {
        "decay_rate": 0.98,
        "memory_warning_threshold": 0.3,
        "recovery_reminder": False,    # 不触发回收提醒（误导型伏笔的"回收"是揭示真相，时机由作者掌控）
        "truth_reveal": True,          # 回收时标记为"真相揭示"事件
    },
}
```

**误导伏笔的特殊处理**：

误导伏笔的核心特征是：**它的"回收"不是常规的伏笔回收，而是揭示真相推翻误导**。

```python
# 误导伏笔的完整生命周期
# 1. 埋设：作者标记为 misdirection 类型
# 2. 维持：系统不触发"建议回收"提醒（避免干扰作者的误导节奏）
# 3. 真相揭示：作者主动标记"揭示真相"
#    → 系统记录揭示章节和揭示方式
#    → 调用回收质量评估（评估维度调整为"误导效果"而非"回收完整性"）
# 4. 后续追踪：揭示后的伏笔转为 ABANDONED，但保留"误导记录"供读者前情提要参考
```

### 15.7 伏笔密度监控

**问题**：同时活跃的伏笔过多会导致读者混乱，回收太少会导致"烂尾"感。现有 B3 有密度指标但缺少主动建议。

**监控指标**：

```python
@dataclass
class ForeshadowingDensity:
    # 当前活跃伏笔数（按重要性和类型分组）
    active_count: int
    active_by_importance: dict[str, int]    # {"critical": 2, "normal": 4, "minor": 2}
    active_by_type: dict[str, int]          # {"item": 3, "character": 2, "plot": 2, ...}

    # 近期趋势（近10章）
    # L37补充：当作品总章节数不足10章时，窗口不完整，
    # 近期趋势指标应按比例缩放（如仅5章则将指标乘以2进行年化估算），
    # 或直接标注"数据不足"跳过趋势评估，避免误导。
    recent_planted: int                      # 近10章新埋设的伏笔数
    recent_resolved: int                     # 近10章回收的伏笔数
    recent_progressed: int                   # 近10章推进的伏笔数

    # 比率指标
    unresolved_ratio: float                  # 未兑现/已兑现比（DORMANT+ACTIVE / RESOLVED）
    critical_unresolved_ratio: float         # critical级别未兑现比

    # 密度评估
    assessment: str                          # "healthy" | "warning" | "danger"
    suggestions: list[str]                   # 改进建议
```

**密度评估规则**：

```python
DENSITY_THRESHOLDS = {
    # 活跃伏笔数上限（按重要性）
    "max_active": {
        "critical": 3,     # critical伏笔同时活跃不超过3个
        "normal": 8,       # normal不超过8个
        "minor": 15,       # minor不超过15个
        "total": 20,       # 总计不超过20个
    },
    # 近10章趋势
    "recent_planted_range": (1, 4),     # 正常范围：每10章引入1-4个
    "recent_resolved_min": 1,            # 每10章至少回收1个
    # 比率指标
    "max_unresolved_ratio": 3.0,         # 未兑现/已兑现比不超过3:1
    "max_critical_unresolved": 2.0,      # critical未兑现比不超过2:1
}
```

**密度评估示例**：

```
📊 伏笔密度监控
━━━━━━━━━━━━━━━━━━━━━━━━━━
当前活跃伏笔：8个（critical: 2, normal: 4, minor: 2）
近10章趋势：引入 2个 | 回收 1个 | 推进 3个
未兑现/已兑现比：2.5:1
━━━━━━━━━━━━━━━━━━━━━━━━━━
评估：✅ 健康
建议：当前伏笔密度健康，无需调整。
```

```
📊 伏笔密度监控
━━━━━━━━━━━━━━━━━━━━━━━━━━
当前活跃伏笔：18个（critical: 4, normal: 9, minor: 5）
近10章趋势：引入 5个 | 回收 0个 | 推进 1个
未兑现/已兑现比：5.0:1
━━━━━━━━━━━━━━━━━━━━━━━━━━
评估：⚠️ 警告
建议：
1. critical伏笔过多（4>3），建议回收或推进至少1个
2. 近10章无回收，读者可能感到伏笔"只埋不收"
3. 未兑现比偏高（5:1>3:1），建议安排回收
```

### 15.8 伏笔依赖链

**问题**：网文中常见"伏笔套伏笔"——第一个伏笔回收时，揭示的信息本身又成为新的伏笔。现有设计不支持伏笔之间的关联关系。

**方案**：在 UnifiedForeshadowing 中增加依赖链字段。

```python
# 依赖链示例
# 伏笔A：神秘戒指的力量来源（道具伏笔）
#   triggers: [伏笔B]  → A回收时，揭示戒指原主人的身份，触发B
# 伏笔B：戒指原主人是主角前世（人物伏笔）
#   depends_on: [伏笔A]  → B必须在A回收后才能回收

# 数据模型（已在 UnifiedForeshadowing 中定义）
# depends_on: list[str]   # 上游依赖（必须先于本伏笔回收）
# triggers: list[str]     # 下游触发（本伏笔回收时触发）
```

**依赖链约束规则**：

```python
def validate_dependency_chain(foreshadowing: UnifiedForeshadowing) -> list[str]:
    """
    验证伏笔依赖链的合法性。
    返回违规列表。
    """
    violations = []

    # 规则1：不能循环依赖
    # A triggers B, B triggers A → 循环依赖
    if has_cycle(foreshadowing.id):
        violations.append(f"循环依赖：{foreshadowing.id}")

    # 规则2：上游伏笔必须先于下游回收
    for dep_id in foreshadowing.depends_on:
        dep = get_foreshadowing(dep_id)
        if dep and dep.status == "RESOLVED":
            if dep.actual_resolved_chapter > foreshadowing.planted_chapter:
                violations.append(f"上游伏笔{dep_id}已回收，但本伏笔尚未埋设")

    # 规则3：误导伏笔不能作为上游依赖
    # （误导伏笔的"回收"是揭示真相，不适合作为其他伏笔的前置条件）
    for dep_id in foreshadowing.depends_on:
        dep = get_foreshadowing(dep_id)
        if dep and dep.foreshadow_type == "misdirection":
            violations.append(f"误导伏笔{dep_id}不能作为上游依赖")

    return violations
```

**触发链执行**：

```python
def on_foreshadowing_resolved(foreshadow_id: str, chapter_num: int):
    """伏笔回收时的触发链执行"""
    fp = get_foreshadowing(foreshadow_id)

    # 1. 检查下游触发
    for trigger_id in fp.triggers:
        target = get_foreshadowing(trigger_id)
        if target and target.status == "PLANNED":
            # 下游伏笔从PLANNED转为ACTIVE
            target.status = "ACTIVE"
            target.last_mentioned_chapter = chapter_num
            # 通知作者："伏笔A的回收触发了伏笔B，B现在可以开始推进"
            # 通过 CrossModuleEventBus（跨模块事件总线，见 #17.4）发送事件（签名对齐 #17.4 CrossModuleEvent）
            event_bus.emit(
                EventType.FORESHADOWING_RECOVERY_DETECTED,
                source="B7",
                payload={
                    "source_id": foreshadow_id,
                    "target_id": trigger_id,
                    "chapter": chapter_num,
                }
            )

    # 2. 检查上游依赖是否全部已回收
    for dep_id in fp.depends_on:
        dep = get_foreshadowing(dep_id)
        if dep and dep.status != "RESOLVED":
            # 通过 CrossModuleEventBus 发送事件（签名对齐 #17.4 CrossModuleEvent）
            event_bus.emit(
                EventType.FORESHADOWING_DEPENDENCY_VIOLATION,
                source="B7",
                payload={
                    "foreshadow_id": foreshadow_id,
                    "unresolved_dependency": dep_id,
                    "chapter": chapter_num,
                }
            )
```

### 15.9 与现有模块的协调关系

<!-- 表格说明：B7伏笔协调层与现有模块的协调关系及接口 -->
| 协调模块 | 协调方式 | 接口 |
|------|---------|------|
| 算法层 ForeshadowingTracker | B7 调用其 CRUD 方法，废弃其 check_overdue()章数预警 | `ForeshadowingTracker.plant()` / `.update()` / `.get()` |
| B1 大纲系统 | B7 从章纲 foreshadowing_plan 字段获取伏笔规划 | 读取 `chapter_outlines.foreshadowing_plan` |
| B2 隐含信息检测 | B2"故意设计"转化通道创建的伏笔自动注册到 B7 | 监听 `CAUSAL_BREAK_INTENTIONAL` 事件 |
| B3 因果链检测 | B7 复用 B3 的读者记忆衰减模型和回收质量评估 | 调用 `calculate_memory_at_chapter()` / `evaluate_foreshadowing_payoff()` |
| B5 M10 跨线伏笔 | B7 从 M10 获取跨线标签，合并到统一视图 | 读取 `cross_line_foreshadowing_reminders` |
| B6 角色弧线 | 人物伏笔关联角色弧线，回收时通知 B6 | 监听 `FORESHADOW_RESOLVED` 事件，触发 `arc_milestones` 更新 |
| 统一架构 #附录 G | B7 通过 UnifiedEntity 和 EventBus 实现跨模块通信 | 使用 `UnifiedEntity.foreshadow_ids` / `EventBus.emit()` |
| 作品健康度 #17.5 | B7 提供铺垫回收率数据 | `ForeshadowCoordinator.get_dashboard().health_score` |
| WriterAgent 写作上下文 | B7 通过 inject_writing_context()将伏笔摘要注入写作上下文，WriterAgent 据此推进/回收伏笔 | `ForeshadowCoordinator.inject_writing_context()` → ContextRouter `foreshadowing_enhanced` 通道 |

### 15.10 数据模型扩展

```sql
# --- 摘要：B7伏笔协调层扩展字段SQL —— unified_entities表扩展伏笔类型/预期事件/预期章节等字段，含依赖和候选表 ---
-- B7 伏笔协调层扩展字段（在现有表基础上ALTER）
-- 注意：核心伏笔数据存储在 unified_entities（domain='foreshadowing'）中
-- 以下为B7新增的扩展表

-- 伏笔分类与预期规划
ALTER TABLE unified_entities ADD COLUMN IF NOT EXISTS
    foreshadow_type VARCHAR(20) DEFAULT 'plot'
        CHECK (foreshadow_type IN ('item', 'character', 'plot', 'worldview', 'misdirection'));

ALTER TABLE unified_entities ADD COLUMN IF NOT EXISTS
    expected_event TEXT;  -- 预期回收事件描述（作者可选填）

ALTER TABLE unified_entities ADD COLUMN IF NOT EXISTS
    expected_chapter INT;  -- 根据大纲自动估算的参考章数

-- 伏笔运行时状态字段（对齐 #15.2 UnifiedForeshadowing 数据类）
ALTER TABLE unified_entities ADD COLUMN IF NOT EXISTS
    reader_memory FLOAT DEFAULT 1.0;  -- 读者记忆强度 0.0~1.0（来自B3衰减模型）

ALTER TABLE unified_entities ADD COLUMN IF NOT EXISTS
    planted_chapter INT;  -- 伏笔埋设章节号

ALTER TABLE unified_entities ADD COLUMN IF NOT EXISTS
    foreshadow_status VARCHAR(20) DEFAULT 'PLANNED'
        CHECK (foreshadow_status IN ('PLANNED', 'ACTIVE', 'DORMANT', 'RESOLVED', 'ABANDONED'));
    -- B7统一状态（对齐 UnifiedForeshadowing.status）

ALTER TABLE unified_entities ADD COLUMN IF NOT EXISTS
    cross_line BOOLEAN DEFAULT FALSE;  -- 是否跨线伏笔（来自B5 M10）

ALTER TABLE unified_entities ADD COLUMN IF NOT EXISTS
    target_lines TEXT[] DEFAULT '{}';  -- 跨线目标叙事线ID列表

ALTER TABLE unified_entities ADD COLUMN IF NOT EXISTS
    actual_resolved_chapter INT;  -- 实际回收章节号（已回收时填写）

ALTER TABLE unified_entities ADD COLUMN IF NOT EXISTS
    actual_resolved_event TEXT;  -- 实际回收事件描述

ALTER TABLE unified_entities ADD COLUMN IF NOT EXISTS
    quality_score JSONB;  -- 回收质量评分（来自B3 evaluate_foreshadowing_payoff()）

-- 伏笔依赖链
CREATE TABLE IF NOT EXISTS foreshadowing_dependencies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    work_id UUID NOT NULL REFERENCES works(id),
    source_id UUID NOT NULL REFERENCES unified_entities(id),   -- 上游伏笔
    target_id UUID NOT NULL REFERENCES unified_entities(id),   -- 下游伏笔
    dependency_type VARCHAR(10) NOT NULL DEFAULT 'triggers'
        CHECK (dependency_type IN ('depends_on', 'triggers')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(source_id, target_id, dependency_type)
);
-- ER关系：本表通过 source_id/target_id 关联到 unified_entities(id)

CREATE INDEX idx_fdep_work ON foreshadowing_dependencies(work_id);
CREATE INDEX idx_fdep_target ON foreshadowing_dependencies(target_id);

-- AI伏笔识别候选记录（避免重复提示）
CREATE TABLE IF NOT EXISTS foreshadowing_candidates (
    -- === 主键与标识 ===
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    work_id UUID NOT NULL REFERENCES works(id),
    entity_name TEXT NOT NULL,
    description TEXT,                          -- 伏笔候选描述（AI识别的伏笔内容说明）
    suggested_type VARCHAR(20),               -- AI建议的伏笔类型（item/character/plot/worldview/misdirection）
    -- === 候选信息 ===
    signal_type VARCHAR(30) NOT NULL,
    confidence VARCHAR(10) NOT NULL,
    chapter_num INT NOT NULL,
    -- === 状态与审计 ===
    status VARCHAR(10) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'accepted', 'dismissed')),
    dismissed_until_chapter INT,  -- 排除冷却期截止章节
    created_at TIMESTAMPTZ DEFAULT NOW()
);
-- ER关系：本表通过 entity_id 关联到 unified_entities(id)

CREATE INDEX idx_fc_work ON foreshadowing_candidates(work_id, status);

-- 伏笔候选实体名称索引（加速按作品+实体查询伏笔候选）
CREATE INDEX idx_fc_work_entity ON foreshadowing_candidates(work_id, entity_name);
```

### 15.11 实施优先级

| 优先级 | 能力 | 理由 |
|------|------|------|
| P0 | 统一伏笔视图 + 状态映射 | 基础设施，其他能力依赖此视图 |
| P0 | 伏笔分类体系 | 数据模型扩展，影响所有后续功能 |
| P1 | 回收自动检测器 | 直接解决"作者遗忘回收"的核心痛点 |
| P1 | 伏笔密度监控 | 简单但价值高，可快速实现 |
| P2 | AI 伏笔识别引擎 | 需要较多调优，可后续迭代 |
| P2 | 伏笔依赖链 | 高级功能，长篇作品才需要 |
| P3 | 误导伏笔特殊处理 | 小众需求，可最后实现 |

---

<a id="ch16"></a>
## 第 16 章 B8 节奏控制（RhythmController）

### 16.1 设计定位与原则

**设计模式**：薄协调层（与 B7 伏笔协调层一致）。

> **补充说明：数据访问权限** ——B8 节奏控制的数据访问遵循 `collaborator_read_only` 规则（见附录 E E.22.3 数据安全策略），协作者可查看节奏画像、节奏曲线面板和检测结果，但不能修改节奏模板、调整检测阈值或变更节奏预算配置。

**核心问题**：作者在写作过程中缺乏对"当前章节实际节奏是什么"的运行时感知，也无法得到"下一章节奏应该往什么方向走"的智能建议。

**已有覆盖盘点**：

| 来源 | 能做什么 | 不能做什么 |
|------|----------|------|
| B1 章纲 pacing | 5 种枚举标记（fast/medium/slow/buildup/climax） | 不自动计算，不验证实际内容是否匹配 |
| B1 `_detect_pacing_issues` | 检测连续 3 章 pacing 相同 | 仅此一种模式，不检测渐变/交替/分布 |
| B5 S1 张力计算 | 基于存档点算 0-1 张力值 | 冲突只看数量、趋势窗口仅 2 章、不识别 buildup/climax |
| B5 S1 线推荐 | 基于张力推荐切换线 | 不考虑线权重、不决定切换位置 |
| B4 节奏偏好 | 快/中/慢映射到短句比+对话比 | 不覆盖段落节奏、场景切换频率 |
| B4 情感/节奏 7 维 | 统计对话/独白/描写/动作占比 | 没有直接的节奏度量指标 |

**B8 独有领地**：单线叙事节奏的运行时感知、检测与建议。与 B5 S1（多线切换时机）互补，不重叠。

**设计原则**：

1. **作者意图优先**：章纲 pacing > 模板建议 > 类型默认值。只有"偏离章纲"才预警，"偏离模板"只提示。
2. **算法为主，LLM 为辅**：P0/P1 核心功能全部是纯算法（零 Token 成本），LLM 仅用于建议的自然语言表述（按需触发）。
3. **复用优先**：5 维节奏指纹中 4 维可从 B4 的 50 维风格特征直接复用或简单派生。
4. **中文优先**：每个维度标注中文文本的特殊处理规则。

**与其他模块的边界**：

```
B1（大纲阶段）  →  规划期望节奏（输入），B8验证执行偏差
B4（风格层）    →  提供风格级节奏基准（输入），B8做内容级节奏检测
B5 S1（多线）  →  多线切换时机（并行），B8专注单线内部节奏
B8（本模块）   →  从正文提取节奏特征 → 检测异常 → 可视化 → 建议
```

### 16.2 节奏画像引擎（RhythmProfiler）

从正文自动提取节奏特征，输出**节奏指纹（5 维向量）+ 综合节奏值（0-1 标量）**。

#### 5 维节奏指纹

| 维度 | 计算方式 | B4 复用 | 中文特殊处理 |
|------|----------|------|-------------|
| 叙事速度 | `1 / (1 + avg_sentence_len / 20)` | ✅ `avg_sentence_length` 取倒数归一化 | 句子边界：`。！？…` 为断句；省略号算长句结尾；对话内的 `。` 不算断句 |
| 对话比 | `dialogue_ratio` | ✅ 直接复用 | 对话边界：`""` 内的内容；`XX 道/说/笑/怒` 标记的后续内容；对话提示语不算对话 |
| 动作比 | `action_ratio` | ✅ 直接复用 | 动作词：`拔/斩/闪/跃/冲/挡/踢/抓/掷` 等物理动词；需预编译动作词表（含修仙/科幻/都市各类型扩展） |
| 情感强度 | `pos_density + neg_density` | ✅ 取绝对值之和 | 情感词表：需中文情感词库；注意修仙文特有情感词（"道心不稳"、"心魔"等） |
| 信息密度 | `新实体率 × 新设定率` | ❌ 新增 | 实体识别：用 B2 的 EntityIndex 查询首次出现；设定术语：用 B4 M10 的 `worldview_terms` 表 |

**综合节奏值**：
```python
rhythm_score = (
    narrative_speed * 0.25 +
    dialogue_ratio * 0.20 +
    action_ratio * 0.25 +
    emotion_intensity * 0.15 +
    info_density * 0.15
)
# 权重可按类型配置调整（见16.3）
```

**数据结构**：
```python
@dataclass
class RhythmFingerprint:
    narrative_speed: float    # 叙事速度 (0-1)
    dialogue_ratio: float     # 对话比 (0-1)
    action_ratio: float       # 动作比 (0-1)
    emotion_intensity: float  # 情感强度 (0-1)
    info_density: float       # 信息密度 (0-1)
    extra_dims: dict = field(default_factory=dict)  # 预留扩展

@dataclass
class RhythmProfile:
    chapter_id: int
    fingerprint: RhythmFingerprint
    rhythm_score: float       # 综合节奏值 (0-1)
    pacing_label: str         # 映射后的pacing标签: slow/medium/buildup/fast/climax
    word_count: int           # 章节字数
```

**pacing 标签映射**：
```python
def score_to_pacing(score: float) -> str:
    """将节奏分数(0-1)映射为5级pacing标签，区间与D1检测器对齐
    
    注意：D1检测器通过 detector_thresholds.D1_pacing（默认0.6）判断偏差程度，
    该阈值作用于连续的rhythm_score，而非离散的pacing标签。
    因此D1检测器的判断与score_to_pacing()的区间边界无直接依赖关系，
    D1允许±0.05的容差（即边界附近的0.15-0.25、0.35-0.45等区间内，
    检测结果可能因微小波动而在相邻标签间切换，属于正常行为）。
    """
    if score < 0.2:  return "slow"       # [0, 0.2) 慢节奏
    if score < 0.4:  return "medium"     # [0.2, 0.4) 中等节奏（修复：原错误返回"slow"）
    if score < 0.6:  return "buildup"    # [0.4, 0.6) 铺垫蓄力
    if score < 0.8:  return "fast"       # [0.6, 0.8) 快节奏
    if score < 0.9:  return "climax"     # [0.8, 0.9) 高潮
    return "climax"                      # [0.9, 1.0] 高潮
```

**约束**：章节字数 < 500 字时不计算节奏画像（样本太小，结果不可靠），返回 `None`。

**存储**：作为 `chapter_style_stats`（B4 M3）的扩展字段，无需独立表。

**触发时机**：每章完成时自动计算。

**Token 成本**：0（纯算法）。

**RhythmProfiler 类实现**：
```python
# --- 摘要：RhythmProfiler —— B8节奏画像引擎，计算章节节奏画像（5维向量），含Pacing枚举和检测器定义 ---
class RhythmProfiler:
    """B8 节奏画像引擎 —— 负责计算和缓存章节节奏画像

    响应大纲变更事件（OUTLINE_UPDATED），当章纲的pacing字段被修改时，
    标记受影响章节的节奏画像为"待重算"，确保后续检测和建议基于最新数据。
    """

class Pacing(Enum):
    """章节节奏标签枚举，用于标注大纲节点的预期节奏。"""
    SLOW = "slow"           # 慢节奏：描写、铺垫、过渡
    MEDIUM = "medium"       # 中等节奏：日常推进、对话
    BUILDUP = "buildup"     # 渐强：冲突酝酿、悬念升级
    FAST = "fast"           # 快节奏：动作、冲突爆发
    CLIMAX = "climax"       # 高潮：决战、真相揭示

# 兼容性常量（供SQL CHECK约束和模板引用）
VALID_PACING_VALUES = {p.value for p in Pacing}

    def __init__(self, db):
        """初始化节奏画像引擎

        参数:
            db: 数据库连接实例
        """
        self.db = db

    def on_outline_updated(self, work_id: str, outline_diff: dict) -> dict:
        """响应大纲变更事件（OUTLINE_UPDATED），检查章纲pacing字段变更

        当作者修改大纲中章节的pacing字段时，该章节的节奏画像基准需要重新计算。
        本方法不立即重算（重算发生在章节保存后的PostSavePipeline中），
        而是标记受影响章节的节奏画像为"待重算"状态，避免使用过期的画像数据。

        Args:
            work_id: 作品ID
            outline_diff: 大纲变更差异，结构如下：
                {
                    "added_chapters": [{"chapter_num": 5, "title": "..."}],   # 新增的章节
                    "removed_chapters": [{"chapter_num": 10, "title": "..."}], # 删除的章节
                    "moved_chapters": [{"old_num": 8, "new_num": 12}],        # 移动的章节
                    "modified_chapters": [                                    # 修改的章节
                        {
                            "chapter_num": 3,
                            "changes": {
                                "pacing": {"old": "slow", "new": "buildup"},  # pacing变更
                                "title": {"old": "...", "new": "..."}         # 其他变更（忽略）
                            }
                        }
                    ]
                }

        Returns:
            处理结果摘要：
                {
                    "stale_chapters": [3, 7],     # 被标记为"待重算"的章节号列表
                    "total_affected": 2,           # 受影响的章节总数
                    "skipped": 0                   # 跳过的章节数（如无pacing变更）
                }
        """
        stale_chapters = []
        skipped = 0

        # 1. 检查修改的章节中是否有pacing字段变更
        for mod in outline_diff.get("modified_chapters", []):
            changes = mod.get("changes", {})
            pacing_change = changes.get("pacing")

            if pacing_change is None:
                # 该章节的修改不涉及pacing字段，跳过
                skipped += 1
                continue

            old_val = pacing_change.get("old")
            new_val = pacing_change.get("new")

            # 校验新的pacing值是否合法
            if new_val is not None and new_val not in self.VALID_PACING_VALUES:
                # 非法值不处理，由B1大纲系统的CHECK约束拦截
                skipped += 1
                continue

            # 标记该章节的节奏画像为"待重算"
            chapter_num = mod["chapter_num"]
            self._mark_stale(work_id, chapter_num)
            stale_chapters.append(chapter_num)

        # 2. 检查新增的章节（新章节尚无节奏画像，无需标记）
        #    但如果新章节插在已有章节之间，后续章节的节奏曲线基准可能需要调整
        added_nums = [ch["chapter_num"] for ch in outline_diff.get("added_chapters", [])]
        if added_nums:
            # 查询该作品所有已有节奏画像的章节
            existing_profiles = self.db.query(
                "SELECT chapter_num FROM chapter_style_stats "
                "WHERE work_id = %s AND rhythm_fingerprint IS NOT NULL "
                "ORDER BY chapter_num",
                work_id
            )
            existing_nums = [row["chapter_num"] for row in existing_profiles]

            # 新增章节之后的所有已有章节，其节奏曲线位置发生偏移，标记为待重算
            for added_num in sorted(added_nums):
                for existing_num in existing_nums:
                    if existing_num >= added_num and existing_num not in stale_chapters:
                        self._mark_stale(work_id, existing_num)
                        stale_chapters.append(existing_num)

        # 3. 检查删除的章节（删除后节奏曲线断裂，后续章节标记为待重算）
        removed_nums = [ch["chapter_num"] for ch in outline_diff.get("removed_chapters", [])]
        if removed_nums:
            existing_profiles = self.db.query(
                "SELECT chapter_num FROM chapter_style_stats "
                "WHERE work_id = %s AND rhythm_fingerprint IS NOT NULL "
                "ORDER BY chapter_num",
                work_id
            )
            existing_nums = [row["chapter_num"] for row in existing_profiles]

            for removed_num in sorted(removed_nums):
                for existing_num in existing_nums:
                    if existing_num > removed_num and existing_num not in stale_chapters:
                        self._mark_stale(work_id, existing_num)
                        stale_chapters.append(existing_num)

        # 4. 检查移动的章节（移动影响前后章节的节奏曲线连续性）
        for move in outline_diff.get("moved_chapters", []):
            old_num = move["old_num"]
            new_num = move["new_num"]
            # 标记移动范围内的章节为待重算
            affected_range = range(min(old_num, new_num), max(old_num, new_num) + 1)
            for ch_num in affected_range:
                if ch_num not in stale_chapters:
                    self._mark_stale(work_id, ch_num)
                    stale_chapters.append(ch_num)

        return {
            "stale_chapters": sorted(set(stale_chapters)),
            "total_affected": len(set(stale_chapters)),
            "skipped": skipped,
        }

    def _mark_stale(self, work_id: str, chapter_num: int) -> None:
        """标记指定章节的节奏画像为"待重算"状态

        通过在 chapter_style_stats 表中设置 rhythm_stale 标记位，
        PostSavePipeline 在下次保存时检测到该标记后会触发重新计算。

        Args:
            work_id: 作品ID
            chapter_num: 章节号
        """
        # 设置节奏画像为待重算状态
        # rhythm_stale 字段为布尔标记，True表示需要重新计算
        # TODO(P2): 待 chapter_style_stats 表添加 rhythm_stale 列后实现
        ...

    def get_rhythm_context(self, work_id: str, chapter_num: int) -> dict:
        """获取指定章节的节奏上下文摘要，供 ContextRouter 注入 Prompt Layer 3

        在 PostSavePipeline 的 B8 节奏画像更新步骤完成后调用，
        将当前章节的节奏分析结果压缩为结构化摘要，供写作 Agent 参考。

        Args:
            work_id: 作品ID
            chapter_num: 当前章节号

        Returns:
            节奏上下文摘要字典：
            {
                "prev_chapter_rhythm": "slow",      # 上一章实际节奏（Pacing 枚举值）
                "expected_pacing": "buildup",        # 当前章预期节奏（来自大纲）
                "rhythm_direction": "accelerating",  # 节奏趋势：accelerating/decelerating/stable
                "active_rhythm_issues": [             # 当前活跃的节奏异常列表
                    {"type": "pacing_mismatch", "severity": "warning", ...}
                ]
            }

        数据流向：ContextRouter → Prompt Layer 3 `{rhythm_context_summary}` 变量
        调用位置：PostSavePipeline 步骤 2（B8 节奏画像更新后）
        """
        # TODO(P3): 待实现 —— 需要查询 chapter_style_stats 和 rhythm_issues 表
        ...
```

### 16.3 节奏规划系统（RhythmPlanner）

#### 16.3.1 节奏模板库

预设经典节奏模式，作者在卷纲阶段选择。

| 模板 ID | 名称 | 模式 | 适用类型 |
|------|------|------|----------|
| wave | 波浪式 | slow→buildup→fast→slow→buildup→fast→climax→slow | 通用 |
| escalate | 阶梯式 | slow→buildup→fast→fast→climax | 玄幻/科幻/军事 |
| three_act | 三幕式 | setup(slow)→confrontation(buildup→fast)→resolution(climax→slow) | 单元剧/独立事件 |
| slow_burn | 慢热铺垫 | slow→slow→buildup→buildup→fast→climax | 修仙开局 |
| high_tension | 持续高压 | fast→fast→fast→climax→slow | 大决战/高潮卷 |
| suspense | 锯齿式 | medium→slow→fast→slow→medium→fast→climax | 悬疑/推理 |
| reversal | 欲扬先抑 | slow→buildup→CLIMAX→slow→slow | 含反转的章节 |
| battle | 战斗模式 | probe(medium)→escalate(fast)→peak(climax)→stop(slow) | 战斗场景 |

**用途**：
1. 作者创建卷纲时选择模板 → 自动填充章纲 pacing 字段
2. 写作时对比实际节奏与模板偏差
3. 作者可自定义模板并保存

**数据结构**：
```python
@dataclass
class RhythmTemplate:
    template_id: str
    name: str
    description: str
    pattern: list[str]        # pacing标签序列
    applicable_genres: list[str]
    is_custom: bool = False
```

#### 16.3.2 类型节奏配置

不同类型的节奏容忍度和参数配置。

| 类型 | 慢容忍（章） | 快容忍（章） | 理想标准差范围 | 默认模板 |
|------|-------------|------|---------------|------|
| 修仙 | 8 | 3 | 0.10-0.18 | slow_burn |
| 都市 | 4 | 5 | 0.10-0.20 | wave |
| 悬疑 | 5 | 2 | 0.12-0.22 | suspense |
| 科幻 | 5 | 4 | 0.10-0.20 | wave |
| 言情 | 6 | 2 | 0.08-0.15 | wave |
| 军事 | 3 | 5 | 0.12-0.22 | escalate |
| 通用 | 5 | 3 | 0.08-0.20 | wave |

# [注] R8-C6 补充说明：类型节奏配置运行时加载方式
> **运行时加载说明**：
> - 类型节奏配置通过 `GenreConfig`（题材配置）数据类在运行时加载（见下方 GenreConfig 定义）
> - 默认配置见 `GENRE_DEFAULTS` 字典，可通过 PluginConfigLayer 按题材覆盖
> - 加载时机：作品创建时根据题材自动加载，可通过设置面板手动切换
> - 加载优先级：**作者自定义 > PluginConfigLayer 题材覆盖 > GENRE_DEFAULTS 内置默认值**

**GenreConfig 数据类定义**：

```python
# --- 摘要：GenreConfig 完整dataclass定义 —— 题材节奏配置，含单调检测阈值/慢容忍度/快节奏上限等参数 ---
from dataclasses import dataclass

@dataclass
class GenreConfig:
    """题材节奏配置 —— 定义不同题材的节奏容忍度与检测参数。
    
    说明：GenreConfig 可通过 PluginConfigLayer 按题材动态加载，
    作者也可在作品设置中自定义覆盖默认值。
    加载优先级：作者自定义 > PluginConfigLayer题材覆盖 > 内置默认值
    """
    genre: str                    # 题材名称（如 "修仙"、"都市"）
    mono_threshold: int           # 单调检测阈值：连续N章相同节奏触发D1检测
    slow_tolerance: int           # 慢容忍度：连续慢节奏章数上限
    fast_tolerance: int           # 快容忍度：连续快节奏章数上限
    ideal_std_range: tuple[float, float]  # 理想标准差范围（最小, 最大）

# 7种题材的默认配置
GENRE_DEFAULTS: dict[str, GenreConfig] = {
    "修仙": GenreConfig(
        genre="修仙",
        mono_threshold=6,         # 修仙文节奏偏慢，允许较长铺垫
        slow_tolerance=8,
        fast_tolerance=3,
        ideal_std_range=(0.10, 0.18),
    ),
    "都市": GenreConfig(
        genre="都市",
        mono_threshold=4,
        slow_tolerance=4,
        fast_tolerance=5,
        ideal_std_range=(0.10, 0.20),
    ),
    "悬疑": GenreConfig(
        genre="悬疑",
        mono_threshold=4,         # 悬疑文需要节奏变化来维持紧张感
        slow_tolerance=5,
        fast_tolerance=2,
        ideal_std_range=(0.12, 0.22),
    ),
    "言情": GenreConfig(
        genre="言情",
        mono_threshold=5,
        slow_tolerance=6,
        fast_tolerance=2,
        ideal_std_range=(0.08, 0.15),
    ),
    "科幻": GenreConfig(
        genre="科幻",
        mono_threshold=4,
        slow_tolerance=5,
        fast_tolerance=4,
        ideal_std_range=(0.10, 0.20),
    ),
    "历史": GenreConfig(
        genre="历史",
        mono_threshold=5,
        slow_tolerance=6,
        fast_tolerance=3,
        ideal_std_range=(0.10, 0.20),
    ),
    "通用": GenreConfig(
        genre="通用",
        mono_threshold=4,
        slow_tolerance=5,
        fast_tolerance=3,
        ideal_std_range=(0.08, 0.20),
    ),
}
```

**影响范围**：
- 16.4 检测器的异常阈值（D2a/D2b/D2c 的参数）
- 16.2 画像引擎的维度权重
- 16.3 模板库的默认推荐

#### 16.3.3 节奏预算（可选功能）

默认关闭，作者在卷纲设置中手动开启。

```
开启后追踪:
  卷级配额（基于模板自动计算）:
    fast/climax章数:  X章（默认20%）
    buildup章数:      Y章（默认30%）
    slow/medium章数:  Z章（默认50%）

  执行追踪:
    已用快节奏: 3/4章  ████████░░ 75%
    已用铺垫:   2/6章  ███░░░░░░░ 33%
    已用慢节奏: 1/10章 █░░░░░░░░░ 10%

  预算预警:
    - 快节奏预算即将用完，但还有大量高潮剧情未写
    - 慢节奏预算剩余过多，可能导致字数膨胀
```

#### 16.3.4 作者意图规则

| 场景 | 规则 | 说明 |
|------|------|------|
| 作者已填章纲 pacing | 以章纲为唯一期望基准 | 检测实际节奏与章纲偏差；模板仅作参考对比，不触发预警 |
| 作者未填章纲 pacing | 以类型配置为弱基准 | 检测趋势异常（单调/高潮疲劳/低谷过长）；不检测单章偏差；如有模板则以模板为参考 |
| 连续 N 章填相同 pacing | 触发"规划可能不合理"提示 | info 级别（非 warning）；例："连续 8 章都标记为 slow，请确认是否合理" |
| 频繁修改章纲 pacing | 提示"建议先调整正文" | 同一章改了 3 次以上时触发 |

### 16.4 节奏检测器（RhythmDetector）

统一检测器，每个检测项自带默认建议。

#### 输出格式

```python
# --- 摘要：RhythmIssue 完整dataclass定义 —— 节奏问题数据结构，含to_detection_result()转换方法 ---
@dataclass
class RhythmIssue:
    detector_id: str           # "D1", "D2a", "D4a" 等
    severity: str              # "warning" | "info"
    chapters: list[int]        # 涉及章节
    rhythm_values: list[float] # 相关节奏值
    default_suggestion: str    # 默认建议（确定性文本）
    detail: dict               # 细节数据

    def to_detection_result(self) -> 'DetectionResult':
        """
        转换为统一检测结果 DetectionResult（见 #17.8 BaseDetector）。
        用于将B8节奏检测结果接入统一检测管线。

        映射规则：
        - detector_id: 保留，加 "b8." 前缀标识来源模块
        - module: 固定为 "B8"
        - severity: "warning" → WARNING, "info" → INFO
        - location: 多章节问题时使用第一个章节的信息
        - title: 由 detector_id 和章节范围生成
        - description: 使用 default_suggestion
        - suggestion: 使用 default_suggestion
        - metadata: 包含完整的 chapters、rhythm_values、detail
        """
        from dataclasses import fields

        # 确定章节范围描述
        if len(self.chapters) == 1:
            chapter_desc = f"第{self.chapters[0]}章"
        else:
            chapter_desc = f"第{self.chapters[0]}-{self.chapters[-1]}章"

        return DetectionResult(
            detector_id=f"b8.{self.detector_id}",
            module="B8",
            severity=DetectionSeverity.WARNING if self.severity == "warning" else DetectionSeverity.INFO,
            title=f"节奏问题（{self.detector_id}）{chapter_desc}",
            description=self.default_suggestion,
            location={
                "chapter": self.chapters[0],       # 多章节时取第一个章节
                "chapters": self.chapters,          # 完整章节列表
                "paragraph": None,
                "start_offset": None,
                "end_offset": None,
            },
            suggestion=self.default_suggestion,
            metadata={
                "chapters": self.chapters,
                "rhythm_values": self.rhythm_values,
                "detail": self.detail,
            },
        )
```

#### MVP 检测项（8 项）

**D1: 单章偏差检测**（仅当章纲已填 pacing 时）

```
触发条件: 偏差度 > 1.0
  偏差度 = |实际节奏值 - 期望中值| / 期望区间半宽

期望区间:
  slow    → [0.0, 0.3], 中值 0.15
  medium  → [0.3, 0.6], 中值 0.45
  buildup → [0.5, 0.7], 中值 0.60
  fast    → [0.7, 0.9], 中值 0.80
  climax  → [0.85, 1.0], 中值 0.925

默认建议: "本章实际节奏({score})与章纲期望({pacing})偏差较大"
细粒度分析（用节奏指纹）: "本章对话比0.8但章纲标记slow → 对话过多导致节奏偏快"
```

**D2: 趋势异常检测**

# [注] L36补充：D2检测器依赖最近N章的节奏值序列，当作品章节数不足N章时
     （如 N=8 但作品仅 3 章），检测器应跳过并返回空结果，不产生误报。 -->

| 子项 | 检测规则 | 阈值（类型自适应） | 默认建议 |
|------|----------|------|----------|
| D2a 节奏单调 | 最近 N 章节奏值标准差 < 0.08 | N = 类型配置（默认 8） | "节奏过于平稳，建议制造变化" |
| D2b 高潮疲劳 | 最近 M 章中 fast+climax 占比 > 60% | M = 类型配置（默认 3） | "高潮过于密集({M}章)，建议安排过渡" |
| D2c 低谷过长 | 连续 K 章节奏值 < 0.3 | K = 类型配置（默认 5） | "过渡章节过长({K}章)，建议推进剧情" |

**D3: 衔接异常检测**

| 子项 | 检测规则 | 默认建议 |
|------|----------|------|
| D3a 跨章断裂 | 上章末尾节奏值与下章开头节奏值差 > 0.5 | "相邻章节节奏跳跃过大，建议平滑过渡" |
| D3b 跨卷断裂 | 上卷末章与下卷首章节奏值差 > 0.5 | "跨卷节奏断裂，建议卷首增加过渡" |

**D4: 内容异常检测**

| 子项 | 检测规则 | 默认建议 |
|------|----------|------|
| D4a 灌水嫌疑 | 信息密度<0.1 且 动作比<0.1 且 情感强度<0.1 且 节奏值<0.25 且 非章纲规划 slow | "检测到灌水嫌疑，建议增加信息/冲突/情感增量" |
| D4b 断章节奏过低 | 章末 500 字节奏值 < 0.2 且 非卷末章 | "章末节奏过低，建议增加钩子或悬念" |

> **【MVP 降级方案】D4b 分段节奏画像依赖说明**
>
> D4b 的完整检测规则需要"章末 500 字"的段落级节奏值（分段画像），但 MVP 阶段
> B8 节奏画像模块（第 16 章）仅提供章节级节奏值（整章 RhythmProfile），不支持
> 段落级分段画像。
>
> **MVP 降级策略**：
> - 使用整章节奏值（chapter_style_stats.rhythm_score）近似替代"章末 500 字"节奏值。
> - 降级后的检测规则调整为：`整章节奏值 < 0.2 且 非卷末章`。
> - 降级方案的误报率较高（整章节奏低不代表章末一定低），但能覆盖最明显的断章问题。
> - 降级建议文案调整为："本章整体节奏偏低，章末可能缺乏钩子或悬念，建议检查"。
>
> **P2 完整实现**（依赖 B8 分段画像能力）：
> - B8 需扩展 RhythmProfile 支持段落级节奏值（每 500 字一个采样点）。
> - 完整规则恢复为：`章末500字节奏值 < 0.2 且 非卷末章`。
> - D4b 完整实现标记为 P2 依赖，MVP 阶段输出上述降级结果。

**灌水检测的精确区分**：

```
慢节奏（正常）: 节奏值低 但 满足以下任一条件:
  - 章纲规划为slow/buildup（作者有意为之）
  - 信息密度 > 0.1（有新内容）
  - 情感强度 > 0.1（有情感推进）
  - 动作比 > 0.1（有冲突推进）

灌水（异常）: 节奏值低 且 全部不满足上述条件
  → 四个维度都是低值 = 纯填充内容
```

#### P2 迭代检测项（3 项，MVP 不做）

| 子项 | 检测规则 | 依赖 | 默认建议 |
|------|----------|------|----------|
| D5a 爽点前铺垫不足 | 爽点章 + 前章节奏值 < 0.4 | B1 爽点数据 | "爽点前缺少铺垫，建议增加 buildup" |
| D5b 伏笔埋设节奏过快 | 伏笔埋设章 + 节奏值 > 0.7 | B7 伏笔数据 | "伏笔埋设节奏过快，建议放慢自然融入" |
| D5c 冲突-节奏不匹配 | B2 高强度冲突 + 低节奏值 | B2 冲突数据 | "冲突强度与节奏不匹配，建议调整" |

### 16.5 节奏建议引擎（RhythmAdvisor）

#### 修复技巧匹配

根据检测结果，匹配适用的不改变剧情的节奏微调技巧：

| 技巧 | 效果 | 适用检测项 |
|------|------|------|
| 加短句 | 提升叙事速度 | D2a, D2c |
| 加对话 | 提升推进感 + 降低描写比 | D2a, D2c |
| 加动作描写 | 提升紧张感 | D1(slow 偏差), D2c |
| 拆长段落 | 提升视觉节奏 | D2a |
| 加场景切换 | 提升信息密度 | D2a, D4a |
| 加内心独白 | 提升情感强度（慢节奏方向） | D2b |
| 加环境描写 | 降低叙事速度（快→慢） | D2b |
| 延长对话回合 | 降低叙事速度 + 提升角色深度 | D2b |

#### LLM 自然语言表述（按需）

将检测器的 `default_suggestion` + 修复技巧翻译为具体、自然、可操作的建议。

```
输入: D2c(低谷过长, 5章) + 技巧["加对话", "加动作描写", "加场景切换"]
输出: "你连续5章都在写日常对话，读者可能开始跳读了。
       建议在第6章插入一个小冲突（200-300字的对话对抗），
       不需要改变主线，就能打破节奏单调。"
```

**Token 成本**：500-1000/次（按需触发，作者请求时才调用）。

**降级策略**：
```
降级1 - LLM不可用:
  - 直接展示③的 default_suggestion（确定性文本，零成本）
  - 展示修复技巧列表（结构化数据，零成本）
  - 不展示LLM生成的自然语言建议
  → 核心功能不受影响，只是建议不够"自然"
  - 日志：logger.warning(f"节奏建议降级至级别1，原因：LLM不可用")
  - 恢复日志：logger.info(f"节奏建议从降级级别1恢复至正常")

降级2 - RhythmProfiler算法计算失败（数值溢出、空输入等异常）:
  - 使用前一章的节奏画像（rhythm_fingerprint）替代当章计算结果
  - 若前一章画像也不可用，则使用默认节奏画像 [0.5, 0.3, 0.3, 0.3, 0.3]
    （对应medium节奏的中性基准值）
  - 检测器基于替代画像正常执行，结果标注"基于前章画像（降级）"
  → 检测精度略有下降，但不会完全失效
  - 日志：logger.warning(f"节奏建议降级至级别2，原因：RhythmProfiler计算失败")

降级3 - B4风格统计不可用（4维特征缺失）:
  - RhythmProfiler的5维指纹中，4维依赖B4（叙事速度、对话比、动作比、情感强度）
  - 降级时使用默认值替代4维特征：叙事速度=0.5, 对话比=0.3, 动作比=0.3, 情感强度=0.3
  - 仅信息密度（新实体率×新设定率）可独立计算，正常产出
  - 综合节奏值基于降级特征计算，结果标注"基于默认特征（降级）"
  → 节奏画像粗略但可用，避免完全无数据
  - 日志：logger.warning(f"节奏建议降级至级别3，原因：B4风格统计不可用")
```

### 16.6 节奏曲线面板（RhythmCurvePanel）

纯前端可视化，复用 B4 M15 可视化框架。

**面板内容**：
```
┌─────────────────────────────────────────────────┐
│ 节奏曲线  [最近20章 ▼]  [第3卷 ▼]  [全书 ▼]      │
│                                                   │
│ 1.0 ┤                              ╭─●(climax)   │
│     │                        ╭──●╯               │
│ 0.8 ┤                  ╭──●╯                    │
│     │            ╭──●╯                          │
│ 0.6 ┤      ╭──●╯    ╭──●(异常:高潮疲劳)          │
│     │ ╭──●╯         │                           │
│ 0.4 ┤─●╯             ●(异常:低谷过长)             │
│     │●                                                  │
│ 0.2 ┤                                                  │
│     └──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬  │
│       Ch1 Ch2 Ch3 Ch4 Ch5 Ch6 Ch7 Ch8 Ch9 ...     │
│                                                   │
│ ── 实际节奏值  ┄┄ 章纲期望区间  ● 异常点           │
│ ── 节奏模板参考曲线（如果选择了模板）                  │
└─────────────────────────────────────────────────┘
```

**健康评分（分级制）**：

| 等级 | 条件 | 含义 |
|------|------|------|
| A（优秀） | 无 warning + 无 info | 节奏健康 |
| B（良好） | 无 warning + 有 info | 有小问题但无严重异常 |
| C（注意） | 1 个 warning | 存在需要关注的节奏问题 |
| D（警告） | 2 个以上 warning | 节奏问题严重，建议立即调整 |

**附加信息**：
- 节奏趋势线（整体呈上升/下降/平稳）
- 卷级节奏预算进度条（如果开启了预算功能）

**Token 成本**：0（纯前端渲染）。

### 16.7 跨模块集成（RhythmIntegration）

#### 16.7.1 写作上下文注入

将节奏画像写入 `get_chapter_writing_context()`，实现写作时控制而非写完后检测。

```python
# 注入到写作上下文
{
    "prev_chapter_rhythm": {
        "score": 0.65,
        "fingerprint": [0.7, 0.3, 0.8, 0.6, 0.4],
        "pacing": "buildup"
    },
    "expected_pacing": "fast",           # 来自章纲
    "rhythm_direction": "加速",           # 基于趋势分析
    "rhythm_guide": "短句为主、对话密集、  # 转化为具体写作指导
                    动作描写多、段落短",
    "active_rhythm_issues": [             # 活跃的节奏问题
        {"detector_id": "D2a", "suggestion": "节奏过于平稳..."}
    ]
}
```

**Prompt 注入示例**：
```
【节奏要求】
上一章节奏值0.65（buildup），本章期望节奏fast。
建议写作风格：短句为主（平均句长<12字）、对话占比30-50%、
动作描写密集、段落长度控制在3-5行。
注意：避免长段环境描写，保持推进感。
```

#### 16.7.2 存档点 pacing 统一

存档点 pacing 字段从手动填写改为自动从节奏画像映射，统一为 5 值枚举（与章纲一致）。

```python
# 原: 存档点pacing为3值（快/中/慢），手动填写
# 新: 从节奏画像自动映射为5值
savepoint.pacing = score_to_pacing(rhythm_profile.rhythm_score)
```

**注意**：不修改 S1 的张力计算内部算法（避免影响 B5 稳定性），仅替换数据源。

#### 16.7.3 B1 单调检测替代

B1 的 `_detect_pacing_issues()` 替换为调用 B8 的 D2a 检测。

```python
# 原: 仅检测连续3章pacing相同
# 新: 调用B8 RhythmDetector.D2a（基于实际节奏画像的标准差检测）
def _detect_pacing_issues(self, outline):
    return RhythmDetector.detect_trend_monotone(
        recent_chapters=self.get_recent_rhythm_profiles(n=8),
        threshold=self.genre_config.mono_threshold
    )
```

### 16.8 分段节奏画像（P2 增强）

章节内微观节奏分析，按场景切换自然分割。

```python
@dataclass
class SegmentRhythmProfile:
    chapter_id: int
    segments: list[dict]  # [{"start": 0, "end": 500, "score": 0.2}, ...]
    segment_scores: list[float]  # [0.2, 0.3, 0.6, 0.9]

    # 微观检测
    def detect_head_heavy(self) -> bool:
        """虎头蛇尾: 开头>0.7 且 结尾<0.3"""

    def detect_long_buildup(self) -> bool:
        """铺垫过长: 前80%都<0.4，最后才>0.6"""

    def detect_micro_wave(self) -> float:
        """微观波浪: 段间标准差（理想0.10-0.20）"""
```

**优先级**：P2（MVP 只做章节级）。

### 16.9 数据模型扩展

```sql
# --- 摘要：B8节奏存储SQL —— chapter_style_stats扩展节奏画像字段 + rhythm_templates/rhythm_budgets/rhythm_issues表 ---
-- 节奏画像存储（扩展B4的chapter_style_stats）
ALTER TABLE chapter_style_stats ADD COLUMN IF NOT EXISTS
    rhythm_fingerprint JSONB,      -- 5维向量 + extra_dims
    rhythm_score FLOAT,            -- 综合节奏值 (0-1)
    rhythm_pacing_label VARCHAR(10) CHECK (rhythm_pacing_label IN ('slow','medium','buildup','fast','climax') OR rhythm_pacing_label IS NULL), -- 映射后的pacing标签（允许NULL因画像计算可能失败）；枚举定义见B8 RhythmProfiler.Pacing

-- 节奏模板
CREATE TABLE rhythm_templates (
    template_id VARCHAR(50) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    pattern TEXT[] NOT NULL,       -- pacing标签序列
    -- ⚠️ 应用层校验说明：pattern数组中的每个元素必须为合法的pacing枚举值
    --    （slow/medium/buildup/fast/climax）。PostgreSQL对数组元素的CHECK约束
    --    支持有限（需自定义函数或触发器），因此枚举校验在应用层RhythmPlanner
    --    的模板创建/更新方法中执行，确保不会写入非法值。
    applicable_genres TEXT[],
    is_custom BOOLEAN DEFAULT FALSE,
    created_by VARCHAR(50)         -- 'system' 或 user_id
);
-- ER关系：本表为独立配置表，被 rhythm_budgets(template_id) 关联

-- 节奏预算（可选，卷级）
CREATE TABLE rhythm_budgets (
    volume_id INT PRIMARY KEY,
    -- ⚠️ 已知限制：volume_id 引用 volume_outlines.id，但此处使用 INT 类型，
    --    而 volume_outlines.id 为 UUID 类型，类型不匹配。
    --    建议后续统一为 UUID 类型并添加 REFERENCES 外键约束。
    template_id VARCHAR(50) REFERENCES rhythm_templates(template_id),
    enabled BOOLEAN DEFAULT FALSE,
    budget_config JSONB            -- {"fast": 4, "buildup": 6, "slow": 10}
);
-- ER关系：本表通过 template_id 关联到 rhythm_templates(template_id)

-- 节奏检测历史（字段对齐 #16.4 RhythmIssue 数据类）
CREATE TABLE rhythm_issues (
    issue_id SERIAL PRIMARY KEY,
    work_id UUID NOT NULL REFERENCES works(id),  -- 所属作品
    chapters INT[] NOT NULL,                      -- 涉及章节（多章节支持，对齐 RhythmIssue.chapters: list[int]）
    -- ⚠️ chapters 为 INT[] 数组类型，无法添加 REFERENCES chapters(id) 外键约束。
    --    原因：chapters 表的 id 为 UUID 类型，而此处存储的是章节编号（INT），
    --    类型不匹配且一对多关系不适合用数组外键。数据完整性由应用层保证。
    detector_id VARCHAR(10) NOT NULL,             -- 检测器标识，如 "D1", "D2a", "D4a"
    severity VARCHAR(10) NOT NULL,                -- 严重级别：'warning' | 'info'
    rhythm_values FLOAT[],                        -- 相关节奏值（对齐 RhythmIssue.rhythm_values: list[float]）
    default_suggestion TEXT NOT NULL,             -- 默认建议（原suggestion重命名，对齐 RhythmIssue.default_suggestion）
    detail JSONB,                                 -- 细节数据（对齐 RhythmIssue.detail: dict）
    created_at TIMESTAMP DEFAULT NOW()
);
-- ER关系：本表通过 entity_id 关联到 unified_entities(id)；通过 work_id 关联到 works(id)

-- 节奏检测历史章节索引（加速按章节查询）
CREATE INDEX idx_rhythm_issues_chapter_id ON rhythm_issues USING GIN (chapters);

-- 节奏检测历史作品索引（加速按作品查询）
CREATE INDEX idx_rhythm_issues_work ON rhythm_issues(work_id);

-- 数据保留：已解决（fixed）且超过100章的记录归档到 rhythm_issues_archive 表，
-- 归档操作由每日清理任务执行（见 #19.5.2），保留归档记录30天供审计查询。
```

### 16.10 实施优先级

| 优先级 | 功能 | 理由 |
|------|------|------|
| P0 | 节奏画像引擎（16.2） | 所有后续功能的基础，5 维中 4 维复用 B4 |
| P0 | 节奏规划系统（16.3） | 模板+类型配置，提供期望基准 |
| P1 | 节奏检测器（16.4） | 8 项 MVP 检测，每项自带建议 |
| P1 | 节奏建议引擎（16.5） | 修复技巧匹配+LLM 表述 |
| P1 | 节奏曲线面板（16.6） | 可视化+健康评分 |
| P1 | 跨模块集成（16.7） | 写作上下文注入+存档点统一+B1 替代 |
| P2 | 分段节奏画像（16.8） | 章节内微观节奏，锦上添花 |
| P2 | 跨模块检测 D5 | 需要 B1/B2/B7 数据联动，待各模块稳定后实现 |

**每章 Token 成本**：0（算法为主，建议按需 500-1000）。

### 16.11 边界条件与系统级失败模式

#### 系统级失败模式

B8 模块在运行过程中可能遇到以下系统级故障，需确保降级后不影响核心写作流程：

| 故障场景 | 影响范围 | 降级策略 | 恢复条件 |
|------|---------|------|---------|
| RhythmProfiler 算法计算异常（数值溢出、空输入等） | 节奏画像无法生成，影响后续检测和建议 | 返回 None，写作上下文使用默认节奏建议（"保持当前节奏"）；检测器跳过当章 | 下一章重新计算 |
| B4 风格统计不可用（步骤 1 失败） | RhythmProfiler 缺少 4 维输入特征 | PostSavePipeline 步骤 2 捕获异常后回滚保存（见#F.4），不产生部分数据 | 修复 B4 后重试保存 |
| RhythmDetector 检测超时 | 单项检测结果缺失 | 跳过超时检测项，其余检测项正常返回；汇总报告中标注"部分检测未完成" | 下次保存时补检 |
| LLM 不可用（RhythmAdvisor 自然语言表述） | 建议不够自然，但核心功能不受影响 | 直接展示 default_suggestion（确定性文本）+ 修复技巧列表（见#16.5 降级策略） | LLM 恢复后自动切换 |
#### 降级原则

1. **写作不中断**：B8 的所有降级策略均不影响 WriterAgent 的核心写作流程
2. **数据不污染**：降级期间不写入部分/错误的节奏画像数据，宁可缺失也不写入脏数据
3. **自动恢复**：降级原因消除后，下一章自动恢复正常计算，无需人工干预

---

<a id="ch17"></a>
## 第 17 章 跨问题运行时协调

> 📍 本章包含：17.1 统一检测管线 | 17.2 LLM 预算跨问题分配 | 17.3 共享基础设施 | 17.4 跨模块事件总线 | 17.5 统一验证与仪表盘层 | 17.6 插件化配置层 | 17.7 三大机制协作关系 | 17.8 统一底层架构

---

### 17.1 统一检测管线

> ⚠️ **迁移说明**：本节已被 #G.2 `UnifiedDetectionPipeline` 替代。
>
> ⚠️ **迁移说明**：本节的 6 步管线是 #G.2 `UnifiedDetectionPipeline`（触发器→预处理→检测器→评分器→路由器）的早期简化版本。实现时应以 #G.2 为准。

---

### 17.2 LLM 预算跨问题分配

> 📍 第 17 章导航：[17.1 统一检测管线](#) | [17.2 LLM 预算分配](#) | [17.3 共享基础设施](#) | [附录 F 跨模块事件总线](#) | [17.5 统一验证与仪表盘](#) | [17.6 插件化配置层](#) | [17.7 三大机制协作](#) | [附录 G 统一底层架构](#)

| 问题 | Token 预算/章 | 优先级 |
|------|-------------|------|
| B1 大纲系统 | 2000 | 中（大纲预演、铺垫检查等按需调用） |
| B2 隐含信息 | 4000 | 最高 |
| B3 因果链 | 3000 | 中 |
| B4 风格一致性 | 8000 | 最低（可降级） |
| B5 多线叙事同步 | 3000 | 中 |
| B6 角色状态桥梁 | 500 | 低（仅 `_derive_triggers_from_state` 使用 LLM 辅助） |
| B8 节奏控制 | 1000 | 低（RhythmAdvisor 自然语言表述 500-1000/次，按需调用） |

---

### 17.3 共享基础设施

<!-- 表格说明：共享基础设施使用矩阵，展示B1-B8各模块对公共设施的依赖 -->
| 基础设施 | B1 使用 | B2 使用 | B3 使用 | B4 使用 | B5 使用 | B6 使用 | B7 使用 | B8 使用 |
|------|--------|------|--------|------|--------|------|--------|------|
| 实体索引 | ✅ | ✅ | ✅ | - | ✅ | ✅ | ✅ | ✅ |
| 属性提取 | ✅ | ✅ | - | - | ✅ | - | - | - |
| 增量扫描 | - | ✅ | ✅ | - | ✅ | - | - | ✅ |
| 置信度评分 | - | ✅ | ✅ | ✅ | ✅ | - | ✅ | - |
| 作者回答流程 | - | ✅ | ✅ | - | - | - | - | - |
| 误报反馈学习 | - | ✅ | ✅ | ✅ | ✅ | - | - | - |
| 文本类型分类 | - | ✅ | ✅ | ✅ | ✅ | - | - | - |
| 检查结果合并 | - | ✅ | ✅ | ✅ | ✅ | - | ✅ | - |
| 风格统计引擎 | - | - | - | ✅ | - | - | - | ✅（复用 4 维） |
| 向量数据库 | - | - | - | ✅ | - | - | - | - |
| 事件总线 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |


### 17.4 跨模块事件总线（CrossModuleEventBus）

> **解决盲点**：B1 大纲变更传播、B1 软/硬约束弹性、B2 规则优先级冲突、B3 合理断裂标记、B4 风格-节奏耦合、B5 叙事线合并冲突

**设计定位**：B1-B5 不是孤立的模块，而是有机协作的系统。事件总线是模块间的"神经系统"——不是简单的消息队列，而是带语义理解的协调引擎。

**核心能力概述**：
- **事件类型定义**（F.2）：覆盖 B1-B8 共 8 模块约 40 种事件类型
- **事件传播矩阵**（F.3）：定义模块间事件传播规则和优先级
- **PostSavePipeline**（F.4）：章节保存后自动执行的异步检测和统计管线
- **约束弹性系统**（F.5）：软约束 vs 硬约束的分级处理机制
- **ChapterCascadeHandler**（F.6）：章节删除/合并/拆分时的级联数据一致性维护
- **规则冲突仲裁引擎**（F.7）：多规则冲突时的自动仲裁策略
- **叙事线合并冲突解决**（F.8）：多线叙事合并时的冲突检测与解决
- **SQL Schema**（F.9）：事件总线的完整数据库表设计

> 📄 **完整设计见附录 F：跨模块事件总线完整设计方案（F.1-F.9）**

---

### 17.5 统一验证与仪表盘层（UnifiedVerificationLayer）


> **解决盲点**：B1 大纲健康度仪表盘、B1 大纲-写作偏差追踪、B2 跨章节聚合趋势、B2 检查静默期策略、B3 元素重要性校准、B4 风格 A/B 测试

#### 17.5.1 设计哲学
B1-B5 各自有检测能力，但缺少**统一的验证入口**和**全局健康度视图**。作者需要一眼看到"我的作品整体健康吗？"，而不是分别查看 5 个模块的独立报告。

#### 17.5.2 作品健康度评分模型
```python
# --- 摘要：WorkHealthScore 完整dataclass定义 —— 作品健康度评分模型，八维雷达图+总分，含各维度权重和评分算法 ---
@dataclass
class WorkHealthScore:
    """
    作品健康度评分模型
    
    八维雷达图 + 总分，每个维度对应一个B模块
    """
    work_id: str
    
    # 八维评分（0-100）
    outline_health: float = 100.0         # B1 大纲完成度与偏差
    consistency_health: float = 100.0     # B2 隐含信息一致性
    causal_health: float = 100.0          # B3 因果链完整度
    style_health: float = 100.0           # B4 风格一致性
    narrative_health: float = 100.0       # B5 多线叙事协调度
    character_state_health: float = 100.0 # B6 角色状态一致性健康度
    foreshadowing_health: float = 100.0   # B7 伏笔管理健康度（复用B7的get_dashboard().health_score）
    rhythm_health: float = 100.0          # B8 节奏健康度（复用B8的A/B/C/D分级）

    # ── B7/B8健康度到0-100分值的映射说明 ──
    # B7的health_score：B7内部已输出0-100的数值型健康度（基于铺垫回收率、
    #   逾期率等指标加权计算），直接作为foreshadowing_health使用，无需额外映射。
    # B8的A/B/C/D分级：B8的节奏曲线面板（#16.6）使用字母分级表示节奏健康度，
    #   映射关系为：A=优秀(95), B=良好(80), C=注意(60), D=警告(30)。
    #   rhythm_health取最近N章（默认10章）的分级均值映射到0-100。
    #   例如：最近10章中6章B级+4章C级 → (6×80 + 4×60) / 10 = 72.0
    
    # 加权总分
    weights: dict = field(default_factory=lambda: {
        "outline": 0.12,
        "consistency": 0.25,
        "causal": 0.20,
        "style": 0.12,
        "narrative": 0.12,
        "character_state": 0.07,   # B6 角色状态
        "foreshadowing": 0.07,     # B7 伏笔管理
        "rhythm": 0.05,            # B8 节奏分析
    })
    
    @property
    def total_score(self) -> float:
        """加权总分"""
        return (
            self.outline_health * self.weights["outline"]
            + self.consistency_health * self.weights["consistency"]
            + self.causal_health * self.weights["causal"]
            + self.style_health * self.weights["style"]
            + self.narrative_health * self.weights["narrative"]
            + self.character_state_health * self.weights["character_state"]
            + self.foreshadowing_health * self.weights["foreshadowing"]
            + self.rhythm_health * self.weights["rhythm"]
        )
    
    @property
    def status(self) -> str:
        """总体状态"""
        score = self.total_score
        if score >= 90:
            return "healthy"       # 🟢 健康
        elif score >= 70:
            return "attention"     # 🟡 需关注
        elif score >= 50:
            return "warning"       # 🟠 警告
        else:
            return "critical"      # 🔴 严重


def compute_outline_health(work_id: str) -> float:
    """
    计算B1大纲健康度
    
    综合指标：
    - 大纲完成度（已写章节/总规划章节）
    - 角色弧线覆盖度（已触发弧线事件/总弧线事件）
    - 情感曲线偏差度（实际情感曲线 vs 大纲规划曲线）
    - 铺垫回收率（已回收铺垫/总铺垫数）
    """
    # 大纲完成度
    total_chapters = db.query(
        "SELECT COUNT(*) as c FROM chapter_outlines WHERE work_id = %s", work_id
    )[0]["c"]
    written_chapters = db.query(
        "SELECT COUNT(*) as c FROM chapters WHERE work_id = %s", work_id
    )[0]["c"]
    completion_rate = written_chapters / max(total_chapters, 1)
    
    # 角色弧线覆盖度
    triggered_milestones = db.query(
        """SELECT COUNT(*) as c FROM character_arcs ca
       JOIN arc_milestones am ON ca.id = am.arc_id
       WHERE ca.work_id = %s AND am.triggered = true""", work_id
    )[0]["c"]
    total_milestones = db.query(
        """SELECT COUNT(*) as c FROM character_arcs ca
       JOIN arc_milestones am ON ca.id = am.arc_id
       WHERE ca.work_id = %s""", work_id
    )[0]["c"]
    arc_coverage = triggered_milestones / max(total_milestones, 1)
    
    # 情感曲线偏差度（实际 vs 规划）
    # TODO(P3): 待实现
    emotion_deviation = _compute_emotion_curve_deviation(work_id)
    
    # 铺垫回收率
    foreshadow_stats = db.query(
        """SELECT 
           COUNT(*) FILTER (WHERE lifecycle = 'dead') as resolved,
           COUNT(*) as total
           FROM unified_entities
           WHERE work_id = %s AND domain = 'concept' AND tags @> ARRAY['foreshadow']""", work_id
    )[0]
    foreshadow_rate = foreshadow_stats["resolved"] / max(foreshadow_stats["total"], 1)
    
    # 综合评分
    health = (
        completion_rate * 0.25
        + arc_coverage * 0.25
        + (1.0 - min(emotion_deviation, 1.0)) * 0.25
        + foreshadow_rate * 0.25
    ) * 100
    
    return round(health, 1)


def compute_consistency_health(work_id: str) -> float:
    """
    计算B2一致性健康度
    
    综合指标：
    - 未解决检查问题数（按严重度加权）
    - 近10章问题趋势（改善/恶化）
    - 误报率
    """
    # 未解决问题
    open_issues = db.query(
        """SELECT severity, COUNT(*) as c FROM unified_detection_results
           WHERE work_id = %s AND status = 'open'
           GROUP BY severity""", work_id
    )
    severity_weights = {"critical": 10, "high": 5, "medium": 2, "low": 1}
    issue_score = sum(
        severity_weights.get(row["severity"], 1) * row["c"]
        for row in open_issues
    )
    
    # 趋势（近10章问题数变化）
    recent_trend = db.query(
        """SELECT 
           COUNT(*) FILTER (WHERE chapter_num > %s) as recent,
           COUNT(*) FILTER (WHERE chapter_num <= %s) as older
           FROM unified_detection_results WHERE work_id = %s AND status = 'open'""",
        # 参数: (recent_start, recent_end, work_id) — 按SQL占位符顺序
        (recent_start, recent_end, work_id)
    )
    # TODO(P3): 用于趋势展示
    
    # 误报率
    # TODO(P3): 待实现
    false_positive_rate = _get_false_positive_rate(work_id)
    
    # 综合评分（issue_score越高越差）
    base_score = max(0, 100 - issue_score * 2)
    health = base_score * (1 - false_positive_rate * 0.3)
    
    return round(health, 1)
```

#### 17.5.3 检查静默期策略
```python
# --- 摘要：CheckSilencePolicy —— 检查静默期策略，根据场景类型和创作节奏动态调整检查频率（高潮不打断心流） ---
class CheckSilencePolicy:
    """
    检查静默期策略：根据场景类型和创作节奏动态调整检查频率
    
    核心思想：高潮场景不打断心流
    """
    
    # 场景类型 → 检查策略
    SCENE_POLICIES = {
        "battle": {
            "check_frequency": "low",          # 低频检查
            "allowed_severity": ["critical"],  # 只显示严重问题
            "batch_mode": True,                # 批量显示（不打断）
            "delay_minutes": 30,               # 延迟30分钟显示
            "description": "战斗场景：降低检查频率，避免打断创作心流",
        },
        "climax": {
            "check_frequency": "minimal",
            "allowed_severity": ["critical"],
            "batch_mode": True,
            "delay_minutes": 60,
            "description": "高潮场景：最小化干扰",
        },
        "dialogue_heavy": {
            "check_frequency": "normal",
            "allowed_severity": ["critical", "high"],
            "batch_mode": False,
            "delay_minutes": 0,
            "description": "重对话场景：正常检查（对话易出人设问题）",
        },
        "description": {
            "check_frequency": "normal",
            "allowed_severity": ["critical", "high", "medium"],
            "batch_mode": False,
            "delay_minutes": 0,
            "description": "描写场景：正常检查",
        },
        "transition": {
            "check_frequency": "high",
            "allowed_severity": ["critical", "high", "medium", "low"],
            "batch_mode": False,
            "delay_minutes": 0,
            "description": "过渡场景：高频检查（适合处理积压问题）",
        },
        "default": {
            "check_frequency": "normal",
            "allowed_severity": ["critical", "high"],
            "batch_mode": False,
            "delay_minutes": 0,
            "description": "默认策略",
        },
    }
    
    def should_show_check(
        self,
        check_result: dict,
        current_scene_type: str,
        writing_speed: float  # 字/分钟
    ) -> dict:
        """
        判断是否应该立即显示检查结果
        
        Args:
            check_result: 检查结果 {severity, module, description}
            current_scene_type: 当前场景类型
            writing_speed: 当前写作速度（字/分钟）
        
        Returns:
            {should_show: bool, delay_until: timestamp, reason: str}
        """
        policy = self.SCENE_POLICIES.get(
            current_scene_type, self.SCENE_POLICIES["default"]
        )
        
        # 规则1：严重度过滤
        if check_result["severity"] not in policy["allowed_severity"]:
            return {
                "should_show": False,
                "delay_until": None,
                "reason": f"当前场景（{current_scene_type}）不显示{check_result['severity']}级别问题",
            }
        
        # 规则2：高速写作时延迟显示（心流保护）
        if writing_speed > 60 and policy["delay_minutes"] > 0:
            delay_until = datetime.now() + timedelta(minutes=policy["delay_minutes"])
            return {
                "should_show": False,
                "delay_until": delay_until,
                "reason": f"写作速度过快（{writing_speed:.0f}字/分），延迟{policy['delay_minutes']}分钟显示",
            }
        
        # 规则3：批量模式
        if policy["batch_mode"]:
            return {
                "should_show": False,
                "delay_until": None,
                "reason": "批量模式：等待场景结束后统一显示",
                "batch": True,
            }
        
        return {"should_show": True, "delay_until": None, "reason": "正常显示"}
```

#### 17.5.4 风格 A/B 测试
```python
# --- 摘要：StyleABTest —— 风格A/B测试，同一段落生成多种风格变体供作者对比选择 ---
class StyleABTest:
    """
    风格A/B测试：同一段落生成多种风格变体，供作者对比选择
    
    与B4 M13生成控制协同工作
    """
    
    def generate_variants(
        self,
        context: str,          # 上下文（前文）
        outline_hint: str,     # 大纲提示
        style_profiles: list,  # 风格配置列表
    ) -> list:
        """
        生成风格变体
        
        Args:
            context: 前文上下文
            outline_hint: 大纲对这段的预期
            style_profiles: 风格配置列表，每项含 {
                "name": "华丽",
                "description": "辞藻华丽，修辞丰富",
                "prompt_override": "...",  # 覆盖M13的Style Prompt
            }
        
        Returns:
            变体列表，每项含 {name, text, style_scores}
        """
        variants = []
        
        for profile in style_profiles:
            # 使用B4 M13的Prompt架构，替换Style Prompt部分
            prompt = self._build_variant_prompt(
                context, outline_hint, profile
            )
            
            # 生成文本
            text = llm_generate(prompt, max_tokens=500)
            
            # 使用B4 M3算法统计引擎计算风格特征
            style_scores = self._compute_style_scores(text)
            
            variants.append({
                "name": profile["name"],
                "text": text,
                "style_scores": style_scores,
                "prompt_used": profile.get("prompt_override"),
            })
        
        return variants
    
    def _build_variant_prompt(
        self, context: str, outline_hint: str, profile: dict
    ) -> str:
        """构建变体生成Prompt（复用B4 M13四层架构）"""
        return f"""[Layer 1: 风格宪法]
{self._get_constitution_summary()}

[Layer 2: 场景匹配]
当前场景类型：{self._detect_scene_type(context)}

[Layer 3: 风格变体]
风格方向：{profile['name']}
风格描述：{profile['description']}
{profile.get('prompt_override', '')}

[Layer 4: 生成约束]
上下文：{context[-1000:]}
大纲预期：{outline_hint}

请按上述风格方向续写一段（200-300字）："""
```

#### 17.5.5 统一仪表盘 API
```python
# --- 摘要：作品健康度仪表盘API —— GET /api/works/{work_id}/health，返回五维健康度评分和各模块详情 ---
# 作品健康度仪表盘 API
@app.get("/api/works/{work_id}/health")
async def get_work_health(work_id: str):
    """获取作品五维健康度评分"""
    health = WorkHealthScore(work_id=work_id)
    health.outline_health = compute_outline_health(work_id)
    health.consistency_health = compute_consistency_health(work_id)
    # TODO(P3): 待实现
    health.causal_health = compute_causal_health(work_id)
    # TODO(P3): 待实现
    health.style_health = compute_style_health(work_id)
    # TODO(P3): 待实现
    health.narrative_health = compute_narrative_health(work_id)
    
    return {
        "work_id": work_id,
        "total_score": health.total_score,
        "status": health.status,
        "dimensions": {
            "B1_大纲": health.outline_health,
            "B2_一致性": health.consistency_health,
            "B3_因果链": health.causal_health,
            "B4_风格": health.style_health,
            "B5_叙事线": health.narrative_health,
        },
        "weights": health.weights,
        # TODO(P3): 待实现
        "trend": _get_health_trend(work_id),  # 近10章趋势
        # TODO(P3): 待实现
        "top_issues": _get_top_issues(work_id, limit=5),  # 最需关注的问题
    }

# 跨章节趋势 API
@app.get("/api/works/{work_id}/trends")
async def get_consistency_trends(work_id: str, dimension: str = "all"):
    """
    获取跨章节一致性趋势
    
    dimension: outline/consistency/causal/style/narrative/all
    """
    trends = {}
    if dimension in ("all", "consistency"):
        # TODO(P3): 待实现
        trends["consistency"] = _get_consistency_trend(work_id)
    if dimension in ("all", "style"):
        # TODO(P3): 待实现
        trends["style"] = _get_style_drift_trend(work_id)
    # ... 其他维度
    
    return {"work_id": work_id, "trends": trends}

# 风格A/B测试 API
@app.post("/api/works/{work_id}/style-ab-test")
async def create_style_ab_test(
    work_id: str,
    context: str,
    outline_hint: str,
    style_profiles: list,
):
    """创建风格A/B测试"""
    tester = StyleABTest()
    variants = tester.generate_variants(context, outline_hint, style_profiles)
    return {"variants": variants}
```

#### 17.5.6 仪表盘 SQL Schema
```sql
-- 作品健康度快照表（每章结束时记录）
CREATE TABLE work_health_snapshots (
    -- === 主键与标识 ===
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    work_id UUID NOT NULL REFERENCES works(id),
    chapter_num INT NOT NULL,
    total_score FLOAT NOT NULL,
    -- === 健康度维度 ===
    outline_health FLOAT NOT NULL,
    consistency_health FLOAT NOT NULL,
    causal_health FLOAT NOT NULL,
    style_health FLOAT NOT NULL,
    narrative_health FLOAT NOT NULL,
    status VARCHAR(20) NOT NULL,
    top_issues JSONB DEFAULT '[]',
    -- === 审计字段 ===
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(work_id, chapter_num)
);
-- ER关系：本表通过 work_id 关联到 works(id)

-- 数据保留：UNIQUE(work_id, chapter_num)约束自动去重，完结作品保留最终快照，活跃作品保留最近100章

-- 检查静默期配置表
CREATE TABLE check_silence_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    work_id UUID NOT NULL REFERENCES works(id),
    scene_type VARCHAR(30) NOT NULL,
    check_frequency VARCHAR(10) NOT NULL,   -- minimal/low/normal/high
    batch_mode BOOLEAN DEFAULT FALSE,
    delay_minutes INT DEFAULT 0,
    is_custom BOOLEAN DEFAULT FALSE,         -- 是否用户自定义
    UNIQUE(work_id, scene_type)
);
-- ER关系：本表通过 work_id 关联到 works(id)

-- 风格A/B测试记录表
CREATE TABLE style_ab_tests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    work_id UUID NOT NULL REFERENCES works(id),
    chapter_num INT,
    context_preview TEXT,                    -- 上下文预览
    variants JSONB NOT NULL,                 -- 变体列表
    selected_variant INT,                    -- 作者选择的变体索引
    created_at TIMESTAMP DEFAULT NOW()
);
-- ER关系：本表通过 work_id 关联到 works(id)

-- 数据保留：已完成的测试（status='completed'）保留90天，进行中的测试永久保留
```


### 17.6 插件化配置层（PluginConfigLayer）

> **解决盲点**：B1 大纲分支探索、B2 自定义检查规则、B3 因果链-大纲联动

# [注] R8-C3 补充说明：PluginConfigLayer 设计定位
> **设计定位说明**：PluginConfigLayer 是本系统配置扩展机制的统称，并非单一类。它包含三个核心子系统：
> 1. **OutlineBranchSystem**（大纲分支探索系统，见 15.6.2）—— 支持剧情分支的创建、探索与合并
> 2. **CustomCheckRuleDSL**（自定义检查规则 DSL，见 15.6.3）—— 允许作者定义个性化的文本检查规则
> 3. **CausalOutlineComparator**（因果链-大纲联动比较器，见 15.6.4）—— 实现因果链与大纲的自动比对与偏离检测
>
> 各模块的运行时配置（如 B7 的 `TYPE_CONFIG`、B8 的 `GenreConfig` 等）通过 PluginConfigLayer 的配置注册机制按题材动态加载。
> 加载优先级：**作者自定义 > PluginConfigLayer 题材覆盖 > 内置默认值**。

# [注] R8-C3 补充：ModuleConfigRegistry 接口契约
```python
class ModuleConfigRegistry(ABC):
    """
    统一配置管理注册表 —— PluginConfigLayer 的核心接口契约。

    职责：
    - 注册各模块（B3/B7/B8等）的配置项及其默认值
    - 按题材（genre）加载覆盖配置
    - 提供配置查询接口，供运行时模块获取参数
    - 支持配置变更的热更新通知

    接口方法：
    - register(module_name, config_schema, defaults): 注册模块配置
    - get(module_name, key, genre=None): 获取配置值
    - override(module_name, key, value, genre=None): 覆盖配置值
    - list_all(genre=None): 列出所有配置项

    使用示例：
        registry = ModuleConfigRegistry()
        registry.register("b7_foreshadow", {
            "decay_weights": [0.6, 0.2, 0.2],
            "retention_factors": [0.95, 0.98, 0.99],
        })
        # 按题材覆盖
        registry.override("b7_foreshadow", "decay_weights", [0.5, 0.3, 0.2], genre="悬疑")
    """

    @abstractmethod
    def register(self, module_name: str, config_schema: dict, defaults: dict) -> None:
        """注册模块配置项及其默认值"""
        ...

    @abstractmethod
    def get(self, module_name: str, key: str, genre: str | None = None) -> Any:
        """获取配置值，支持按题材覆盖"""
        ...

    @abstractmethod
    def override(self, module_name: str, key: str, value: Any, genre: str | None = None) -> None:
        """覆盖指定模块的配置值（可限定题材）"""
        ...

    @abstractmethod
    def list_all(self, genre: str | None = None) -> dict:
        """列出所有配置项（可按题材过滤）"""
        ...
```

#### 17.6.1 设计哲学
B1-B5 的预设规则不可能覆盖所有创作场景。不同题材（仙侠/都市/科幻）、不同风格（轻松/黑暗/文艺）、不同经验水平的作者需要不同的配置。插件化配置层让系统从"一刀切"变为"可定制"。

#### 17.6.2 大纲分支探索系统
```python
# --- 摘要：OutlineBranchSystem —— 大纲分支探索系统（类Git分支模型），支持创建/切换/合并/对比分支 ---
class OutlineBranchSystem:
    """
    大纲分支探索系统
    
    作者可以创建"假设性分支"来探索不同剧情走向，
    不影响主线，随时可以合并或放弃。
    
    类似Git的分支模型：
    - main：主线大纲
    - experiment/*：探索分支
    - merged：已合并回主线的分支
    """
    
    def create_branch(
        self,
        work_id: str,
        branch_name: str,
        from_chapter: int,
        description: str = ""
    ) -> dict:
        """
        从指定章节创建大纲分支
        
        Args:
            work_id: 作品ID
            branch_name: 分支名称（如 "experiment/hero_death"）
            from_chapter: 从第几章开始分支
            description: 分支描述（如 "如果主角在第50章死亡会怎样？"）
        
        Returns:
            分支信息
        """
        branch_id = str(uuid.uuid4())
        
        # 快照当前状态（B2规则、B3元素状态、B4风格配置、B5叙事线）
        # TODO(P3): 待实现
        snapshot_id = self._create_full_snapshot(work_id, from_chapter)
        
        # 创建分支记录
        db.execute("""
            INSERT INTO outline_branches 
            (id, work_id, branch_name, from_chapter, snapshot_id, description, status)
            VALUES (%s, %s, %s, %s, %s, %s, 'active')
        """, (branch_id, work_id, branch_name, from_chapter, snapshot_id, description))
        
        # 复制受影响的大纲条目到分支
        db.execute("""
            INSERT INTO branch_outline_items (branch_id, outline_item_id, original_data)
            SELECT %s, id, row_to_json(t)
            FROM chapter_outlines t
            WHERE work_id = %s AND chapter_num >= %s
        """, (branch_id, work_id, from_chapter))
        
        return {
            "branch_id": branch_id,
            "branch_name": branch_name,
            "snapshot_id": snapshot_id,
            "status": "active",
            "message": f"已从第{from_chapter}章创建分支 '{branch_name}'",
        }
    
    def merge_branch(
        self,
        branch_id: str,
        strategy: str = "replace"  # replace/merge/selective
    ) -> dict:
        """
        将分支合并回主线
        
        Args:
            branch_id: 分支ID
            strategy: 合并策略
                - replace: 分支完全替换主线
                - merge: 智能合并（保留主线和分支的优点）
                - selective: 作者逐条选择要合并的变更
        
        Returns:
            合并结果
        """
        branch = db.query(
            "SELECT * FROM outline_branches WHERE id = %s", branch_id
        )[0]
        
        if strategy == "replace":
            # 直接替换
            branch_items = db.query(
                "SELECT * FROM branch_outline_items WHERE branch_id = %s", branch_id
            )
            for item in branch_items:
                db.execute("""
                    UPDATE chapter_outlines 
                    SET scenes = %s
                    WHERE id = %s AND work_id = %s
                """, (item.get("modified_data") or item["original_data"], item["outline_item_id"], branch["work_id"]))
        
        elif strategy == "merge":
            # 智能合并（需要LLM辅助）
            # TODO(P3): 待实现
            merge_plan = self._generate_merge_plan(branch_id)
            return {"requires_author_review": True, "merge_plan": merge_plan}
        
        elif strategy == "selective":
            # 返回差异列表供作者选择
            # TODO(P3): 待实现
            diffs = self._compute_branch_diffs(branch_id)
            return {"requires_author_selection": True, "diffs": diffs}
        
        # 更新分支状态
        db.execute(
            "UPDATE outline_branches SET status = 'merged', merged_at = NOW() WHERE id = %s",
            branch_id
        )
        
        # event_bus 通过 CrossModuleEventBus 初始化（见 #17.4）
        # 触发事件总线：大纲变更
        event_bus.emit(EventType.OUTLINE_UPDATED, source="B1", payload={
            "branch_merged": branch_id,
            "strategy": strategy,
        })
        
        return {"status": "merged", "message": "分支已合并到主线"}
```

#### 17.6.3 自定义检查规则 DSL
```python
# --- 摘要：CustomCheckRuleDSL —— 自定义检查规则DSL，让作者用自然语言定义检查规则并编译为可执行函数 ---
class CustomCheckRuleDSL:
    """
    自定义检查规则DSL（领域特定语言）
    
    让作者用自然语言定义检查规则，系统自动编译为可执行的检查函数。
    
    示例规则：
    - "角色张三说话时必须使用方言"
    - "每次战斗场景结束后必须有伤势描写"
    - "主角不能连续3章没有内心独白"
    """
    
    # 规则模板库（预设+用户自定义）
    RULE_TEMPLATES = {
        "character_dialogue_style": {
            "name": "角色对话风格检查",
            "description": "检查指定角色的对话是否符合特定风格",
            "parameters": ["character_name", "style_description"],
            "check_type": "realtime",  # realtime/batch
            "llm_required": True,
        },
        "scene_mandatory_element": {
            "name": "场景必备元素检查",
            "description": "检查特定场景类型后是否包含必备元素",
            "parameters": ["scene_type", "required_element"],
            "check_type": "batch",
            "llm_required": False,
        },
        "character_frequency": {
            "name": "角色出场频率检查",
            "description": "检查角色是否在指定章节范围内出场",
            "parameters": ["character_name", "max_absent_chapters"],
            "check_type": "batch",
            "llm_required": False,
        },
        "narrative_element_balance": {
            "name": "叙事元素平衡检查",
            "description": "检查对话/描写/动作/心理的比例是否在范围内",
            "parameters": ["dialogue_ratio", "description_ratio"],
            "check_type": "batch",
            "llm_required": False,
        },
    }
    
    def compile_rule(
        self,
        natural_language_rule: str,
        work_id: str
    ) -> dict:
        """
        将自然语言规则编译为可执行的检查规则
        
        Args:
            natural_language_rule: 自然语言描述的规则
            work_id: 作品ID
        
        Returns:
            编译后的规则配置
        """
        # Step 1: LLM解析自然语言 → 结构化规则
        # TODO(P3): 待实现
        parsed = llm_parse(f"""
            将以下自然语言检查规则解析为结构化格式：
            规则：{natural_language_rule}
            
            可用模板：{json.dumps(list(self.RULE_TEMPLATES.keys()), ensure_ascii=False)}
            
            返回JSON格式：
            {{
                "template": "模板名称",
                "parameters": {{...}},
                "check_type": "realtime/batch",
                "severity": "critical/high/medium/low",
                "scope": "specific/general"
            }}
        """)
        
        # Step 2: 验证规则合法性
        template = self.RULE_TEMPLATES.get(parsed["template"])
        if not template:
            return {"error": f"未知模板: {parsed['template']}", "suggestions": list(self.RULE_TEMPLATES.keys())}
        
        # Step 3: 生成规则ID并存储
        rule_id = f"custom_{uuid.uuid4().hex[:8]}"
        db.execute("""
            INSERT INTO custom_check_rules 
            (id, work_id, template, parameters, natural_language, 
             check_type, severity, scope, enabled, created_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, true, NOW())
        """, (rule_id, work_id, parsed["template"], 
              json.dumps(parsed["parameters"]),
              natural_language_rule,
              parsed["check_type"], parsed["severity"],
              parsed["scope"]))
        
        # event_bus 通过 CrossModuleEventBus 初始化（见 #17.4）
        # Step 4: 注册到B2检查管线
        event_bus.emit(EventType.RULE_CREATED, source="B2", payload={
            "rule_id": rule_id,
            "template": parsed["template"],
            "check_type": parsed["check_type"],
        })
        
        return {
            "rule_id": rule_id,
            "template": parsed["template"],
            "check_type": parsed["check_type"],
            "severity": parsed["severity"],
            "message": f"规则已创建并启用",
        }
```

#### 17.6.4 因果链-大纲联动对比
```python
# --- 摘要：CausalOutlineComparator —— 因果链-大纲联动对比，对比计划与实际因果链发现偏离和意外收获 ---
class CausalOutlineComparator:
    """
    因果链-大纲联动对比
    
    对比"大纲中规划的因果链"与"实际写作中形成的因果链"，
    帮助作者发现计划偏离和意外收获。
    """
    
    def compare(
        self,
        work_id: str,
        chapter_range: Optional[tuple] = None  # (start, end)，默认全部
    ) -> dict:
        """
        对比计划vs实际因果链
        
        Returns:
            对比结果
        """
        # Step 1: 提取大纲中规划的因果链
        planned_causals = self._extract_planned_causals(work_id, chapter_range)
        
        # Step 2: 提取实际写作中的因果链（从B3元素状态日志）
        actual_causals = self._extract_actual_causals(work_id, chapter_range)
        
        # Step 3: 对比分析
        result = {
            "planned_count": len(planned_causals),
            "actual_count": len(actual_causals),
            "matched": [],       # 计划且实际发生了
            "deviated": [],      # 计划了但偏离了
            "unexpected": [],    # 没计划但自然形成了
            "abandoned": [],     # 计划了但完全没发生
        }
        
        for planned in planned_causals:
            match = self._find_best_match(planned, actual_causals)
            if match and match["similarity"] > 0.7:
                result["matched"].append({
                    "planned": planned,
                    "actual": match,
                    "similarity": match["similarity"],
                })
            elif match and match["similarity"] > 0.3:
                result["deviated"].append({
                    "planned": planned,
                    "actual": match,
                    "similarity": match["similarity"],
                    "deviation_type": self._classify_deviation(planned, match),
                })
            else:
                result["abandoned"].append({"planned": planned})
        
        # 发现意外形成的因果链
        matched_actual_ids = {
            m["actual"]["id"] for m in result["matched"] + result["deviated"]
        }
        for actual in actual_causals:
            if actual["id"] not in matched_actual_ids:
                result["unexpected"].append({"actual": actual})
        
        # Step 4: 生成建议
        result["insights"] = self._generate_insights(result)
        
        return result
    
    def _generate_insights(self, comparison: dict) -> list:
        """生成对比洞察"""
        insights = []
        
        if comparison["unexpected"]:
            insights.append({
                "type": "serendipity",
                "message": f"发现了{len(comparison['unexpected'])}条意外形成的因果链，考虑是否纳入正式大纲",
                "items": comparison["unexpected"][:3],
            })
        
        if comparison["abandoned"]:
            insights.append({
                "type": "abandoned",
                "message": f"有{len(comparison['abandoned'])}条计划因果链未实现，考虑是否需要补写或调整大纲",
                "items": comparison["abandoned"][:3],
            })
        
        if comparison["deviated"]:
            insights.append({
                "type": "deviation",
                "message": f"有{len(comparison['deviated'])}条因果链发生了偏离，偏离可能带来更好的效果",
                "items": comparison["deviated"][:3],
            })
        
        return insights
```

#### 17.6.5 插件化配置 SQL Schema
```sql
-- 大纲分支表
CREATE TABLE outline_branches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    work_id UUID NOT NULL REFERENCES works(id),
    branch_name VARCHAR(100) NOT NULL,       -- 分支名称
    from_chapter INT NOT NULL,               -- 起始章节
    snapshot_id UUID NOT NULL,               -- 状态快照ID
    description TEXT,                         -- 分支描述
    status VARCHAR(20) DEFAULT 'active',     -- active/merged/abandoned
    created_at TIMESTAMP DEFAULT NOW(),
    merged_at TIMESTAMP
);
-- ER关系：本表通过 work_id 关联到 works(id)；通过 parent_branch_id 自关联；被 branch_outline_items(branch_id) 关联

-- 分支大纲条目表
CREATE TABLE branch_outline_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    branch_id UUID NOT NULL REFERENCES outline_branches(id),
    outline_item_id UUID NOT NULL,           -- 原大纲条目ID
    original_data JSONB NOT NULL,            -- 原始数据
    is_modified BOOLEAN DEFAULT FALSE
);
-- ER关系：本表通过 branch_id 关联到 outline_branches(id)

-- 自定义检查规则表
CREATE TABLE custom_check_rules (
    -- === 主键与标识 ===
    id VARCHAR(50) PRIMARY KEY,              -- 规则ID（custom_xxxxxxxx）
    work_id UUID NOT NULL REFERENCES works(id),
    template VARCHAR(50) NOT NULL,           -- 规则模板名称
    parameters JSONB NOT NULL,               -- 模板参数
    natural_language TEXT NOT NULL,           -- 自然语言描述
    check_type VARCHAR(10) NOT NULL,         -- realtime/batch
    severity VARCHAR(10) NOT NULL,           -- critical/high/medium/low
    scope VARCHAR(10) NOT NULL,              -- specific/general
    -- === 状态与审计 ===
    enabled BOOLEAN DEFAULT TRUE,
    trigger_count INT DEFAULT 0,             -- 触发次数
    false_positive_count INT DEFAULT 0,       -- 误报次数
    created_at TIMESTAMP DEFAULT NOW(),
);
-- ER关系：本表通过 work_id 关联到 works(id)
```


### 17.7 三大机制协作关系

```text
┌─────────────────────────────────────────────────────┐
│                   作品健康度仪表盘                      │
│            （#17.5 统一验证与仪表盘层）                  │
│    ┌──────┬──────┬──────┬──────┬──────┐              │
│    │ B1   │ B2   │ B3   │ B4   │ B5   │  五维评分    │
│    │ 大纲  │ 一致性│ 因果链│ 风格  │ 叙事线│              │
│    └──┬───┴──┬───┴──┬───┴──┬───┴──┬───┘              │
        │      │      │      │      │
┌───────┴──────┴──────┴──────┴──────┴──────────────────┐
│              跨模块事件总线（#17.4）                      │
│   OUTLINE_UPDATED → B2/B3/B4/B5 自动响应              │
│   RULE_CONFLICT → 仲裁引擎自动/人工解决                 │
│   LINE_MERGED → 冲突解决器协调多模块                    │
│   CAUSAL_BREAK_INTENTIONAL → 抑制误报                  │
└───────┬──────┬──────┬──────┬──────┬──────────────────┘
        │      │      │      │      │
┌───────┴──────┴──────┴──────┴──────┴──────────────────┐
│              插件化配置层（#17.6）                        │
│   大纲分支探索 │ 自定义检查规则DSL │ 因果链-大纲联动对比   │
└─────────────────────────────────────────────────────┘
```

**数据流**：
1. **配置层**（#17.6）提供用户定制能力 → 注入到各 B 模块
2. **事件总线**（#附录 F）协调模块间通信 → 确保一致性
3. **仪表盘层**（#17.5）汇总各模块状态 → 提供全局视图


---

### 17.8 统一底层架构（合并 B1-B5 重叠设计）

> **设计动机**：B1-B5 各自独立设计导致 10 个重叠领域（实体状态、检测管线、模板版本、可视化等），存在数据冗余、接口不统一、维护成本高的问题。本节将重叠设计合并为 4 大统一底层。

**架构概述**：四大统一底层构成了所有 B 模块的共享基础设施：

| 统一底层 | 核心类/接口 | 替代的重叠设计 |
|------|------------|------|
| ① 统一实体状态引擎 | `UnifiedEntityEngine` | B1 角色弧线、B2 属性库/铁事实、B3 元素三态、B5 双层状态 |
| ② 统一检测管线 | `UnifiedDetectionPipeline` + `BaseDetector` | B2 四层检查、B3 心跳检测、B4 风格检测、B5 跨线审核 |
| ③ 统一模板与版本系统 | `UnifiedTemplateVersionSystem` | B1 大纲模板、B3 叙事线模板、B4 风格模板 |
| ④ 统一可视化框架 | `UnifiedVisualizationFramework` + `VisualizationConfig` | B2 面板、B3 因果图、B4 雷达图、B5 仪表盘、B7 伏笔仪表盘、B8 节奏曲线 |

**合并收益**：数据表从 12+ 张减至 6 张统一表；检测入口从 5 个独立管线统一为 1 个；新模块接入只需注册检测器 + 定义实体属性。

> 📄 **完整设计见附录 G：统一底层架构完整设计方案（G.1-G.5）**

---

<a id="ch18"></a>
## 第 18 章 产品功能与交互概览

> 本章为产品层面的功能总览和交互策略，各功能的详细设计见对应章节。

### 18.1 智能写作编辑器
- **内联 AI 建议**：续写建议（3 个方向）、选区操作（改写/扩写/缩写/对话优化/描写增强）
- **上下文感知面板**：当前场景角色、主角状态、活跃伏笔、本章节奏
- **实时检查标记**：算法层检查结果行内标记（critical 红色实时、high 黄色段落间）

### 18.2 世界观与设定管理
- 结构化设定卡片（力量体系、地理设定、阵营势力）
- 关系图谱可视化（角色关系、势力关系、地理关系）
- AI 辅助设定构建（WorldBuilderAgent 引导式创建）
- 设定冲突实时检测

### 18.3 审校系统
> 审校系统汇总了 B1-B8 各模块的检测能力，完整实现见第 17 章（统一检测管线）和各 B 模块章节。

| 维度 | 检查内容 | 执行方式 | 对应模块 |
|------|---------|---------|---------|
| 设定一致性 | 角色属性、世界观规则 | 算法实时 | B2 |
| 逻辑连贯性 | 因果关系、时间线 | 算法+LLM | B2/B3 |
| 人设一致性 | 性格、说话方式 | 角色 Agent | B6/B7 |
| 伏笔管理 | 埋设/追踪/回收 | 算法 | B7 |
| 文风统一性 | 叙述风格、用词 | 算法+LLM | B4 |
| 节奏分析 | 爽点分布、情感曲线 | 算法 | B8 |
| 基础质量 | 错别字、病句 | 算法 | B2 |
| 跨线一致性 | 叙事线状态、角色知识隔离 | Agent+算法 | B5 |

### 18.4 灵感与素材库
- 全局快捷键快速捕捉
- AI 自动分类（角色/情节/设定/对话）
- 关联推荐（写作时主动推荐相关素材）
- 灵感碰撞（InspirationAgent 组合碎片为完整情节）

### 18.5 AI 介入度控制
```text
AI介入度: ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
          0%        30%        60%        100%
          │         │          │           │
     完全手动    轻度辅助    协作共创    AI主导
```

### 18.6 三种交互模式
| 模式 | 适用场景 | 特点 |
|------|---------|------|
| 沉浸写作模式 | 正文创作 | AI 建议内联显示，不打断心流 |
| 设定编辑模式 | 世界观/角色管理 | 面板式操作，AI 辅助检查 |
| AI 对话模式 | 头脑风暴/讨论 | 对话式交互，探索性任务 |

### 18.7 通知策略
> **注**：以下 P0-P3 为 UI 展示层的用户友好标签，内部实现使用 #G.2 的 `DetectionSeverity`（critical/high/medium/low）。

| 级别 | 对应 Severity | 方式 | 冷却时间 |
|------|-------------|------|---------|
| P0 硬约束违反 | critical | 行内红色标记 | 无冷却 |
| P1 高概率问题 | high | 侧边栏黄色标记 | 同类问题 10 分钟冷却 |
| P2 可能问题 | medium | 后台记录 | 无主动通知 |
| P3 参考 | low | 后台记录 | 无主动通知 |

> **注**：大纲系统的详细设计见第 9 章（B1 大纲系统），此处不再重复列举功能清单。

---

<a id="ch19"></a>
## 第 19 章 技术规格

### 19.1 技术栈
| 层级 | 技术选型 |
|------|---------|
| 前端 | React/Next.js + TipTap/ProseMirror |
| Agent 框架 | LangGraph / pydantic-ai |
| LLM | 多模型接入（GPT-4o/Claude/DeepSeek） |
| 向量数据库 | Milvus |
| 知识图谱 | Neo4j |
| 后端 | Python (FastAPI) |
| 主数据库 | PostgreSQL |
| 缓存 | Redis |

### 19.2 MVP 数据库 Schema
```sql
# --- 摘要：MVP数据库Schema —— works/style_constitutions/chapters/banned_words/chapter_style_stats/ai_flavor_results ---
-- 作品表
CREATE TABLE works (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100),
    genre VARCHAR(20),
    created_at TIMESTAMP DEFAULT NOW()
);
-- ER关系：本表为核心主表，被几乎所有业务表通过 work_id 外键关联

-- 风格宪法表
CREATE TABLE style_constitutions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    work_id UUID REFERENCES works(id),
    version INT DEFAULT 1,
    philosophy_text TEXT,
    structured_preferences JSONB
);
-- ER关系：本表通过 work_id 关联到 works(id)

-- 章节表
CREATE TABLE chapters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    work_id UUID REFERENCES works(id),
    chapter_num INT NOT NULL,
    content TEXT NOT NULL,
    word_count INT,
    UNIQUE(work_id, chapter_num)
);
-- ER关系：本表通过 work_id 关联到 works(id)；被 chapter_style_stats(chapter_id)、ai_flavor_results(chapter_id) 关联

-- 禁用词表
CREATE TABLE banned_words (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    work_id UUID REFERENCES works(id),
    word VARCHAR(50) NOT NULL,
    source VARCHAR(20) DEFAULT 'manual',
    UNIQUE(work_id, word)
);
-- ER关系：本表通过 work_id 关联到 works(id)

-- 章节风格统计表
CREATE TABLE chapter_style_stats (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chapter_id UUID REFERENCES chapters(id),
    work_id UUID REFERENCES works(id),
    stats JSONB NOT NULL,
    style_vector FLOAT[],
    computed_at TIMESTAMP DEFAULT NOW()
);
-- ER关系：本表通过 chapter_id 关联到 chapters(id)；通过 work_id 关联到 works(id)

-- AI味检测结果表
CREATE TABLE ai_flavor_results (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chapter_id UUID REFERENCES chapters(id),
    work_id UUID REFERENCES works(id),
    overall_score FLOAT NOT NULL,
    pattern_hits JSONB NOT NULL,
    detected_at TIMESTAMP DEFAULT NOW()
);
-- ER关系：本表通过 chapter_id 关联到 chapters(id)；通过 work_id 关联到 works(id)
```

> ⚠️ **迁移说明**：以上为 MVP 核心表。完整数据库 Schema 见 #附录 G 各小节（`unified_entities`、`unified_detection_results`、`unified_templates` 等统一表），实现时应以 #附录 G 为准。

### 19.3 性能 SLA
| 指标 | 目标 |
|------|------|
| 算法层检查延迟 | < 50ms（每章） |
| LLM 层检测延迟 | < 5s（章节完成后） |
| 上下文装配延迟 | < 200ms |
| 编辑器响应 | < 100ms |
| 风格统计计算 | < 3s（每章完成后） |

#### 19.3.1 性能基准假设

以上性能 SLA 基于以下基准假设：

| 假设项 | 说明 |
|------|------|
| 目标场景 | 单用户桌面应用（本地部署） |
| 并发用户 | 1 个作者同时编辑 1 个作品 |
| 单作品规模上限 | 2000 章 / 1000 万字 |
| 数据库 | 本地 PostgreSQL 15+，SSD 存储 |
| LLM 调用 | 远程 API 调用，网络延迟 < 100ms |
| 可用内存 | ≥ 4GB |
| 索引假设 | 所有推荐索引已创建，数据量 < 100 万行 |

> **注**：若实际部署环境超出上述假设（如多用户并发、超大规模作品），需重新评估性能 SLA 并进行专项优化。

### 19.4 日志与可观测性策略

#### 19.4.1 日志级别规范

| 级别 | 用途 | 示例场景 |
|------|------|------|
| `DEBUG` | 各步骤执行耗时、数据装配详情 | 上下文装配耗时、特征提取中间值、管线步骤耗时分解 |
| `INFO` | 管线开始/完成、状态转换、降级触发 | PostSavePipeline 开始/完成、伏笔状态 DORMANT→ACTIVE、降级策略触发 |
| `WARNING` | 乐观锁冲突、降级触发、检测器失败 | 乐观锁冲突重试、LLM 降级为关键词匹配、单个检测器执行失败 |
| `ERROR` | 保存失败、数据库错误、LLM 调用失败 | 保存回滚、数据库连接超时、LLM API 返回 5xx |

#### 19.4.2 Logger 初始化方案

```python
import logging

# 按模块名创建logger，遵循Python标准logging模块规范
# 每个模块/子系统使用自己的logger实例，便于按模块过滤日志
logger = logging.getLogger(__name__)

# 各模块logger命名约定：
#   - 写作引擎：logging.getLogger("writer_engine")
#   - B4风格引擎：logging.getLogger("b4_style")
#   - B6角色状态：logging.getLogger("b6_character")
#   - B7伏笔管理：logging.getLogger("b7_foreshadowing")
#   - B8节奏控制：logging.getLogger("b8_rhythm")
#   - 检测管线：logging.getLogger("detection_pipeline")
#   - PostSavePipeline：logging.getLogger("post_save_pipeline")
```

#### 19.4.3 日志格式

```python
# 统一日志格式：[{module}] {level} {message}
# 示例输出：
#   [b7_foreshadowing] WARNING 伏笔回收检测LLM调用超时（30s），降级为关键词匹配: foreshadow_id=abc123
#   [post_save_pipeline] INFO PostSavePipeline开始执行: chapter_id=def456, chapter_num=12
#   [b8_rhythm] DEBUG 节奏画像计算完成，耗时: 0.23s

LOG_FORMAT = "[{name}] {levelname} {message}"
logging.basicConfig(
    format=LOG_FORMAT,
    level=logging.INFO,  # 生产环境默认INFO，开发环境可设为DEBUG
)
```


#### 19.4.4 基础设施容错策略

系统依赖数据库和 LLM 两大外部基础设施，本节定义统一的容错、重试与降级策略，确保核心写作功能在任何基础设施故障下均不受影响。

##### 数据库容错

```python
# --- 摘要：数据库连接池配置 —— min/max连接数、超时、空闲回收等参数定义 ---
# ═══════════════════════════════════════════════════════════
# 数据库连接池配置
# ═══════════════════════════════════════════════════════════
DB_POOL_CONFIG = {
    "min_connections": 5,       # 最小连接数：保证冷启动响应速度
    "max_connections": 20,      # 最大连接数：防止连接耗尽导致雪崩
    "connection_timeout": 30,   # 连接超时：30秒，超时后触发重试
    "idle_timeout": 300,        # 空闲连接回收：5分钟
    "max_lifetime": 1800,       # 连接最大生命周期：30分钟，防止长连接泄漏
}

# ═══════════════════════════════════════════════════════════
# 数据库重试策略：指数退避
# ═══════════════════════════════════════════════════════════
async def db_retry_wrapper(func, *args, max_retries=3, **kwargs):
    """
    数据库操作重试包装器，采用指数退避策略。
    重试间隔：1s → 2s → 4s，最多重试3次。
    仅对瞬时错误（连接超时、连接池耗尽）进行重试，
    对业务错误（约束违反、数据不存在）直接抛出。
    """
    import asyncio
    for attempt in range(max_retries):
        try:
            return await func(*args, **kwargs)
        except TransientDBError as e:
            if attempt < max_retries - 1:
                wait_time = 2 ** attempt  # 1s, 2s, 4s
                logger.warning(f"数据库操作失败，第{attempt+1}次重试，等待{wait_time}s: {e}")
                await asyncio.sleep(wait_time)
            else:
                raise

# ═══════════════════════════════════════════════════════════
# 事务安全：SAVEPOINT嵌套
# ═══════════════════════════════════════════════════════════
# 所有写操作使用SAVEPOINT嵌套，确保部分失败时可回滚到安全点，
# 而不影响同一事务中的其他操作。
async def execute_with_savepoint(db_session, operation_name: str, operation_func):
    """
    在SAVEPOINT中执行数据库写操作。
    失败时ROLLBACK TO SAVEPOINT，不影响事务中其他已提交的操作。
    """
    savepoint_name = f"sp_{operation_name}"
    await db_session.execute(f"SAVEPOINT {savepoint_name}")
    try:
        result = await operation_func()
        await db_session.execute(f"RELEASE SAVEPOINT {savepoint_name}")
        return result
    except Exception as e:
        await db_session.execute(f"ROLLBACK TO SAVEPOINT {savepoint_name}")
        logger.error(f"数据库写操作失败，已回滚SAVEPOINT({savepoint_name}): {e}")
        raise

# ═══════════════════════════════════════════════════════════
# 数据库降级策略
# ═══════════════════════════════════════════════════════════
# 数据库不可用时：
# - B6/B7/B8 的检测功能暂停（返回缓存的上一次检测结果）
# - 写作功能（WriterAgent/StyleAgent）不受影响（使用内存缓存数据）
# - 检测功能恢复后自动重新计算，无需手动干预
DB_DEGRADE_POLICY = {
    "affected_modules": ["B6", "B7", "B8"],  # 检测类模块受影响
    "unaffected_modules": ["WriterAgent", "StyleAgent"],  # 写作核心不受影响
    "fallback": "cache",  # 降级时使用最近一次缓存的检测结果
    "auto_recovery": True,  # 数据库恢复后自动重新执行检测
}
```

##### LLM 容错

```python
# --- 摘要：LLM容错配置 —— 超时设置、指数退避重试策略、降级方案（缓存/跳过/默认值） ---
# ═══════════════════════════════════════════════════════════
# LLM调用超时配置
# ═══════════════════════════════════════════════════════════
LLM_TIMEOUT = 30.0  # 单次LLM调用超时：30秒（asyncio.wait_for）

# ═══════════════════════════════════════════════════════════
# LLM重试策略：指数退避
# ═══════════════════════════════════════════════════════════
async def llm_retry_wrapper(func, *args, max_retries=2, **kwargs):
    """
    LLM调用重试包装器，采用指数退避策略。
    重试间隔：1s → 2s，最多重试2次（含首次调用共3次机会）。
    仅对瞬时错误（超时、API限流、网络错误）进行重试，
    对业务错误（参数错误、模型不支持）直接抛出。
    """
    import asyncio
    for attempt in range(max_retries + 1):
        try:
            return await asyncio.wait_for(
                func(*args, **kwargs),
                timeout=LLM_TIMEOUT,
            )
        except (asyncio.TimeoutError, LLMRateLimitError, LLMNetworkError) as e:
            if attempt < max_retries:
                wait_time = 2 ** attempt  # 1s, 2s
                logger.warning(f"LLM调用失败，第{attempt+1}次重试，等待{wait_time}s: {e}")
                await asyncio.sleep(wait_time)
            else:
                raise

# ═══════════════════════════════════════════════════════════
# LLM速率限制：令牌桶算法
# ═══════════════════════════════════════════════════════════
class LLMRateLimiter:
    """
    LLM调用速率限制器，基于令牌桶算法。
    每分钟最多20次调用，超出时排队等待。
    """
    def __init__(self, max_calls: int = 20, window_seconds: int = 60):
        self.max_calls = max_calls       # 窗口期内最大调用次数
        self.window_seconds = window_seconds  # 窗口期（秒）
        self._timestamps: list[float] = []  # 调用时间戳记录

    async def acquire(self):
        """获取调用许可，超出速率限制时排队等待"""
        import asyncio, time
        while True:
            now = time.monotonic()
            # 清理过期时间戳
            self._timestamps = [
                t for t in self._timestamps
                if now - t < self.window_seconds
            ]
            if len(self._timestamps) < self.max_calls:
                self._timestamps.append(now)
                return
            # 计算等待时间：最早的时间戳过期后即可调用
            wait_time = self.window_seconds - (now - self._timestamps[0])
            logger.debug(f"LLM速率限制触发，等待{wait_time:.1f}s后重试")
            await asyncio.sleep(wait_time)

# 全局速率限制器实例
llm_rate_limiter = LLMRateLimiter(max_calls=20, window_seconds=60)

# ═══════════════════════════════════════════════════════════
# LLM降级策略
# ═══════════════════════════════════════════════════════════
# LLM不可用时的模块级降级方案：
LLM_DEGRADE_POLICY = {
    "B7": {
        "description": "伏笔回收检测降级为关键词匹配",
        "fallback": "keyword_matching",  # 使用关键词匹配代替LLM语义判断
        # 关键词降级逻辑：Step 1已确认实体出现在本章，直接标记为PROGRESSED
    },
    "B8": {
        "description": "节奏建议降级为确定性文本建议",
        "fallback": "deterministic_suggestion",  # 展示default_suggestion（确定性文本）
        # RhythmAdvisor的default_suggestion为预定义的结构化文本，零LLM成本
    },
}

# ═══════════════════════════════════════════════════════════
# LLM返回值校验：JSON Schema
# ═══════════════════════════════════════════════════════════
# 所有LLM返回值必须通过JSON Schema校验，不合格时重试或降级。
async def call_llm_with_validation(
    prompt: str,
    response_schema: dict,  # JSON Schema定义
    max_retries: int = 2,
    degrade_func=None,  # 降级函数，重试耗尽时调用
) -> dict:
    """
    带返回值校验的LLM调用。
    流程：调用LLM → JSON Schema校验 → 校验失败则重试 → 重试耗尽则降级。
    """
    import json
    for attempt in range(max_retries + 1):
        result = await llm_retry_wrapper(llm_analyze, prompt=prompt)
        # JSON Schema校验
        try:
            validated = validate_json_schema(result, response_schema)
            return validated
        except SchemaValidationError as e:
            logger.warning(f"LLM返回值校验失败，第{attempt+1}次: {e}")
            if attempt == max_retries and degrade_func:
                logger.warning(f"LLM返回值校验重试耗尽，执行降级")
                return degrade_func()
    # 不应到达此处，但作为安全兜底
    if degrade_func:
        return degrade_func()
    raise LLMValidationError("LLM返回值校验失败且无降级方案")
```

| 策略维度 | 数据库 | LLM |
|------|--------|------|
| 超时 | 连接池 30 秒 | 单次调用 30 秒 |
| 重试 | 指数退避 1s/2s/4s，最多 3 次 | 指数退避 1s/2s，最多 2 次 |
| 降级范围 | B6/B7/B8 检测暂停，写作不受影响 | B7 关键词匹配，B8 确定性文本 |
| 返回值校验 | SAVEPOINT 嵌套事务 | JSON Schema 校验 |
| 速率限制 | 连接池上限 20 | 每分钟最多 20 次调用 |

### 19.5 数据生命周期管理

本节定义系统全局的数据保留、归档与清理策略，确保长期运行中数据不会无限膨胀。

#### 19.5.1 数据保留策略

| 作品状态 | 数据类型 | 保留策略 |
|------|---------|------|
| 活跃作品 | 所有数据 | 永久保留 |
| 完结作品 | 检测结果/事件日志 | 归档保留 90 天，之后彻底删除 |
| 完结作品 | 其他数据（章节、角色、设定等） | 永久保留 |
| 已删除作品 | 所有关联数据 | 30 天后彻底删除（含检测记录、事件日志、运行时状态） |
| 孤儿数据 | 无所属作品的数据 | 90 天自动清理 |

#### 19.5.2 定期清理任务

系统应配置定时任务（建议每日凌晨 3:00 执行），执行以下清理操作：

```python
# 每日数据清理任务（Cron: 0 3 * * *）
async def daily_data_cleanup():
    """
    定期数据清理任务，由调度器每日凌晨执行。
    
    清理范围：
    1. 已删除作品（deleted_at距今>30天）：彻底删除所有关联数据
    2. 孤儿数据（无关联works记录）：彻底删除
    3. 完结作品的归档数据（archived_at距今>90天）：彻底删除
    """
    pass
```

#### 19.5.3 数据分层归档机制

针对章节数据量大的作品，采用热/温/冷三层归档策略：

| 层级 | 范围 | 访问频率 | 存储策略 |
|------|------|------|---------|
| 热数据 | 最近 50 章 | 高频（每次编辑） | 常规存储，保持完整索引 |
| 温数据 | 50-200 章 | 中频（上下文装配、回溯） | 常规存储，精简索引 |
| 冷数据 | 200 章以上 | 低频（全局分析、审计） | 压缩存储，仅保留主键索引 |

> **注**：归档策略为 P1 优化项，MVP 阶段所有数据均按热数据存储。P1 阶段实现温/冷数据分离后，上下文装配器（第 5 章）应优先从热数据加载，按需从温/冷数据补充。

### 19.6 可配置参数清单

# [注] R8-C4 新增：集中列出系统中所有关键可配置参数，消除 magic number 分散硬编码问题

本节汇总系统中所有关键的可配置参数，统一说明其默认值、用途及配置方式。
所有参数均建议通过 PluginConfigLayer 的 `ModuleConfigRegistry` 进行管理（见 15.6 节），
避免在各模块中分散硬编码。

#### 19.6.1 记忆系统参数（B3）

| 参数路径 | 默认值 | 说明 | 配置方式 |
|------|--------|------|---------|
| `memory.decay_weights` | `[0.6, 0.2, 0.2]` | B3 遗忘公式权重（重要性/时间衰减/频率衰减） | PluginConfigLayer |
| `memory.retention_factors` | `[0.95, 0.98, 0.99]` | B3 记忆衰减因子（短期/中期/长期记忆保留率） | PluginConfigLayer |

#### 19.6.2 伏笔管理参数（B7）

| 参数路径 | 默认值 | 说明 | 配置方式 |
|------|--------|------|---------|
| `foreshadow.recovery_quality_weights` | `[0.30, 0.25, 0.25, 0.20]` | B7 回收质量评估权重（时机/方式/完整度/影响力） | PluginConfigLayer |
| `foreshadow.type_config.*.decay_rate` | 各类型不同 | 各伏笔类型的衰减率（如伏笔线 0.05、道具 0.03 等） | PluginConfigLayer |
| `foreshadow.type_config.*.warning_threshold` | 各类型不同 | 各伏笔类型的预警阈值（章数） | PluginConfigLayer |

#### 19.6.3 节奏控制参数（B8）

| 参数路径 | 默认值 | 说明 | 配置方式 |
|------|--------|------|---------|
| `rhythm.fallback_features` | `[0.5, 0.3, 0.3, 0.3]` | B8 降级默认特征值（速度/张力/场景长度/对话比例） | PluginConfigLayer |
| `rhythm.severity_weights` | `[0.8, 0.5, 0.3, 0.1]` | B8 检测严重度权重（critical/high/medium/low） | PluginConfigLayer |
| `rhythm.genre_config.*` | 见 GENRE_DEFAULTS | B8 各题材节奏配置（慢容忍/快容忍/标准差范围等） | PluginConfigLayer |
| `rhythm.detector_thresholds` | 见模板 content | D1-D4 检测器阈值（存储在 UnifiedTemplate 中） | PluginConfigLayer / 模板系统 |

#### 19.6.4 约束系统参数

| 参数路径 | 默认值 | 说明 | 配置方式 |
|------|--------|------|---------|
| `constraint.elasticity.max_deviation` | `0.3` | 约束弹性参数：最大偏离度 | PluginConfigLayer |
| `constraint.elasticity.recovery_chapters` | `5` | 约束弹性参数：偏离后恢复章数 | PluginConfigLayer |
| `constraint.deviation_weights` | `[0.6, 0.4]` | 偏离度计算权重（情节偏离/角色偏离） | PluginConfigLayer |

#### 19.6.5 因果链与风格参数

| 参数路径 | 默认值 | 说明 | 配置方式 |
|------|--------|------|---------|
| `causal.comparison_thresholds.matched` | `> 0.7` | 因果链对比：匹配度阈值 | PluginConfigLayer |
| `causal.comparison_thresholds.deviated` | `> 0.3` | 因果链对比：偏离度阈值 | PluginConfigLayer |
| `style.drift_thresholds.warning` | `0.85` | 风格漂移检测：预警阈值 | PluginConfigLayer |
| `style.drift_thresholds.critical` | `0.70` | 风格漂移检测：严重阈值 | PluginConfigLayer |

> **配置方式说明**：
> - **PluginConfigLayer**：通过 `ModuleConfigRegistry` 注册和覆盖，支持按题材定制，推荐方式
> - **数据库**：存储在数据库配置表中，通过管理界面修改
> - **硬编码**：代码中的默认值，仅作为最终兜底，不应直接修改

---

<a id="ch20"></a>
## 第 20 章 实施路线图

### Phase 1: MVP（3-4 周）

| 功能 | 说明 |
|------|------|
| 基础写作编辑器 | TipTap 集成 |
| WriterAgent | 续写、改写、扩写 |
| StyleAgent | 基础润色、去 AI 味 |
| 基础设定管理 | 角色卡、世界观卡片 |
| 算法层 | ConsistencyChecker + TimelineValidator + ForeshadowingTracker |
| B4 MVP | M1 选择版+M3(5 维)+M4 手动+M5(4 模式)+M13 Prompt+M15 评分 |
| 单模型接入 | DeepSeek/GPT-4o |

### Phase 2: 增强版（2-3 月）

<!-- 表格说明：Phase 2增强版功能清单 -->
| 功能 | 说明 |
|------|------|
| Orchestrator 编排器 | 上下文路由+任务调度 |
| OutlineAgent + 大纲系统 | 三级大纲+铺垫检查+预演 |
| ReviewerAgent + ContinuityAgent | 多维度审校 |
| B2 完整版 | 17 条检查+渐进式四层+作者回答流程 |
| B3 完整版 | 三态管理+心跳+读者记忆衰减 |
| B4 Phase2 | M1 锚点+M2+M3 全维+M5 LLM+M6+M7+M11+M14 基础 |
| B6 角色状态桥梁层 | M1 持久化+M2 大纲衔接+M3 CharacterAgentV2 增强 |
| 角色模拟 Agent | 核心角色常驻 |
| 角色记忆系统 | 五层结构+遗忘机制 |
| 多模型智能路由 | 不同任务用最适合的模型 |

### Phase 2.5: 数据迁移策略（B6/B7/B8 升级）

当已有作品从 B1-B5 架构升级到 B1-B8 架构时，需要执行以下数据迁移方案。迁移应在 Phase 2 完成后、Phase 3 功能上线前执行。

#### B6 角色状态桥梁层迁移

已有作品的角色数据（存储在`unified_entities`中）需要初始化`CharacterRuntimeState`：

```python
async def migrate_to_b6(work_id: str):
    """
    B6迁移：为已有角色初始化运行时状态

    迁移策略：
    1. CharacterRuntimeState从大纲定义初始化
    2. arc_position设为0（起始点）
    3. emotional_history从已有章节回溯（可选，计算成本较高）
    """
    # 获取作品中所有角色实体
    characters = db.query(
        "SELECT * FROM unified_entities WHERE work_id = %s AND domain = 'character'",
        work_id
    )

    for char in characters:
        # 从大纲定义初始化运行时状态
        runtime = CharacterRuntimeState(
            entity_id=char["id"],
            arc_position=0.0,              # 弧线进度从0开始
            arc_phase="introduction",       # 默认为引入阶段
            emotional_state="neutral",      # 情感状态默认中性
            behavioral_boundaries={},       # 从角色卡提取
        )

        # 可选：从已有章节回溯emotional_history
        # 注意：此步骤需要LLM分析已有文本，成本较高，建议作为后台任务异步执行
        # if config.enable_emotional_backtrack:
        #     runtime.emotional_history = await backtrack_emotions(
        #         work_id, char["id"], max_chapters=50  # 限制回溯章数控制成本
        #     )

        await save_runtime_state(char["id"], runtime)
```

#### B7 伏笔协调层迁移

从 B3 的`ForeshadowingTracker`数据迁移到 B7 的`UnifiedForeshadowing`：

```python
# --- 摘要：migrate_to_b7() —— B7迁移脚本，将B3伏笔数据转换为B7统一伏笔视图（含状态映射规则） ---
async def migrate_to_b7(work_id: str):
    """
    B7迁移：将B3伏笔数据转换为B7统一伏笔视图

    状态映射规则（见 #15.2 状态映射规则）：
    - ForeshadowingTracker.planted → B7 PLANNED
    - ForeshadowingTracker.progressing + B3 active → B7 ACTIVE
    - B3 dormant → B7 DORMANT
    - ForeshadowingTracker.resolved + B3 dead → B7 RESOLVED
    - ForeshadowingTracker.abandoned → B7 ABANDONED
    """
    # 获取B3的ForeshadowingTracker数据
    old_foreshadowings = db.query(
        "SELECT * FROM foreshadowing WHERE work_id = %s",
        work_id
    )

    for fs in old_foreshadowings:
        # 状态映射（按 #15.2 的映射规则）
        status_map = {
            "planted": "PLANNED",
            "progressing": "ACTIVE",
            "resolved": "RESOLVED",
            "abandoned": "ABANDONED",
        }
        mapped_status = status_map.get(fs["status"], "PLANNED")

        # reader_memory按衰减公式回算
        # 衰减公式：memory = base_importance * decay_factor^(current_chapter - last_mentioned_chapter)
        # 回算时使用当前最新章节作为current_chapter
        current_chapter = db.query(
            "SELECT MAX(chapter_num) as max_ch FROM chapters WHERE work_id = %s",
            work_id
        )[0]["max_ch"]
        last_mentioned = fs.get("last_mentioned_chapter", fs["planted_chapter"])
        chapters_gap = max(0, current_chapter - last_mentioned)
        # 使用B3的默认衰减因子0.95（20章半衰期）
        reader_memory = max(0.1, 0.95 ** chapters_gap)

        # 构建B7统一伏笔对象
        unified = UnifiedForeshadowing(
            id=f"fp_{fs['id']}",
            description=fs["content"],
            foreshadow_type="plot",        # 默认为"plot"类型，后续可由AI分类器修正
            importance=fs.get("importance", "normal"),
            planted_chapter=fs["planted_chapter"],
            expected_chapter=fs.get("expected_chapter"),
            status=mapped_status,
            reader_memory=reader_memory,
            last_mentioned_chapter=last_mentioned,
            cross_line=fs.get("is_cross_line", False),
            target_lines=[],  # 从cross_line_tags提取
        )

        # 从B5 M10的cross_line_tags提取跨线信息
        cross_tags = fs.get("cross_line_tags", [])
        for tag in cross_tags:
            if tag.get("target_line_id") not in unified.target_lines:
                unified.target_lines.append(tag["target_line_id"])

        await save_unified_foreshadowing(work_id, unified)

    # 迁移B5 M10的cross_line_foreshadowing_reminders
    # → 由ForeshadowCoordinator.get_dashboard()的alerts替代
    # → reminder_chapter映射为expected_chapter
    # → reminder_message映射为expected_event
    old_reminders = db.query(
        """SELECT r.*, f.content, f.planted_chapter
           FROM cross_line_foreshadowing_reminders r
           JOIN foreshadowing f ON r.foreshadowing_id = f.id
           WHERE f.work_id = %s AND r.is_resolved = false""",
        work_id
    )
    for reminder in old_reminders:
        # 将未处理的提醒转换为B7的伏笔预警
        await foreshadow_coordinator.add_alert(
            work_id=work_id,
            foreshadowing_id=f"fp_{reminder['foreshadowing_id']}",
            alert_type="cross_line_harvest_reminder",
            message=reminder["reminder_message"],
            expected_chapter=reminder["reminder_chapter"],
        )
```

#### B8 节奏控制迁移

节奏画像从升级点开始计算，历史数据需要特殊处理：

```python
# --- 摘要：migrate_to_b8() —— B8迁移脚本，为已有作品初始化节奏控制系统（节奏画像/模板/预算） ---
async def migrate_to_b8(work_id: str):
    """
    B8迁移：为已有作品初始化节奏控制系统

    迁移策略：
    1. 节奏画像从升级点开始计算（不回溯历史）
    2. 前8章内趋势检测降级（数据不足）
    3. 历史存档点的pacing按score_to_pacing()重新映射
    """
    # 获取当前最新章节号
    current_chapter = db.query(
        "SELECT MAX(chapter_num) as max_ch FROM chapters WHERE work_id = %s",
        work_id
    )[0]["max_ch"]

    # 标记升级点：从当前章节开始计算节奏画像
    await db.execute(
        """INSERT INTO system_migration_log (work_id, module, migrated_at, from_chapter)
           VALUES (%s, 'B8', NOW(), %s)""",
        work_id, current_chapter + 1
    )

    # 前8章内趋势检测降级处理
    # B8的节奏趋势检测需要至少8章数据，升级后前8章内：
    # - D3a连续单调检测：降低敏感度（连续章数阈值从5提高到8）
    # - D3b跨卷断裂检测：暂停（需要跨卷数据积累）
    # - D4节奏异常检测：仅使用绝对阈值，不使用趋势基线
    await db.execute(
        """INSERT INTO b8_config (work_id, config_key, config_value)
           VALUES (%s, 'trend_detection_degraded', 'true')""",
        work_id
    )

    # 历史存档点的pacing重新映射
    # B5的存档点使用旧的pacing枚举，需要按B8的score_to_pacing()重新映射
    old_checkpoints = db.query(
        "SELECT * FROM narrative_checkpoints WHERE work_id = %s",
        work_id
    )
    for cp in old_checkpoints:
        # 将旧的pacing标签映射为B8的节奏评分
        # score_to_pacing()的反向映射：pacing标签 → 估算评分
        pacing_to_score = {
            "slow": 0.3,       # 慢节奏
            "medium": 0.5,     # 中等节奏（标准5值枚举）
            "buildup": 0.6,    # 铺垫蓄力（标准5值枚举）
            "fast": 0.7,       # 快节奏
            "climax": 0.9,     # 高潮
        }
        estimated_score = pacing_to_score.get(cp.get("pacing", "medium"), 0.5)
        await db.execute(
            """UPDATE narrative_checkpoints
               SET rhythm_score = %s, rhythm_pacing = %s
               WHERE id = %s""",
            estimated_score,
            score_to_pacing(estimated_score),  # 使用B8的标准化映射函数
            cp["id"]
        )

    # 8章后自动恢复正常检测
    # 由PostSavePipeline在步骤2中检查b8_config.trend_detection_degraded
    # 当已计算章数 >= 8时，自动设为false
```

#### 迁移执行顺序

```
B6迁移（角色状态初始化）
    │
    ▼
B7迁移（伏笔数据转换）── 依赖B6的角色实体数据
    │
    ▼
B8迁移（节奏系统初始化）── 独立迁移，可并行执行
    │
    ▼
验证阶段 ── 运行统一检测管线，确认迁移数据一致性
```

> **注**：迁移过程应支持回滚。每个模块的迁移完成后生成迁移快照，如遇问题可从快照恢复。

### Phase 3: 智能版（6-12 月）

| 功能 | 说明 |
|------|------|
| B4 Phase3 | M8+M9+M10+M12+M16+M17+M18+M19+M20 |
| B7 伏笔协调层 | 统一视图+AI 伏笔识别+回收检测+分类体系+密度监控+依赖链 |
| B8 节奏控制 | 节奏画像+规划系统+8 项 MVP 检测+建议引擎+曲线面板+跨模块集成 |
| M20 公开趋势分析 | 基于公开数据的风格趋势分析（无读者数据依赖） |
| InspirationAgent | 灵感库+碰撞 |
| Agent 个性化学习 | 反馈循环+风格微调 |
| 关系图谱可视化 | 角色/势力/地理 |
| 多端支持 | Web + 桌面端 |

### Phase 4: 平台化（12 月+）

| 功能 | 说明 |
|------|------|
| Agent 市场 | 第三方 Agent |
| 作者社区 | 作品分享、经验交流 |
| 平台对接 | 起点、番茄等一键发布 |
| 企业版 | 工作室协作 |
| API 开放平台 ||

---

<a id="appendix-a"></a>

## 附录 A 问题清单

### A 类：已解决（算法层）

| 编号 | 问题 | 解决方案 |
|------|------|------|
| A1 | 死角色出场 | ConsistencyChecker |
| A2 | 修为等级倒退 | ConsistencyChecker |
| A3 | 位置不合理 | ConsistencyChecker |
| A4 | 称谓不一致 | AppellationChecker |
| A5 | 伏笔超期 | ForeshadowingTracker |
| A6 | 时间线混乱 | TimelineValidator |
| A7 | 专有名词拼写 | EntityIndex |
| ... | ... | ... |

### B 类：部分解决（需创造性方案）

<!-- 表格说明：B类部分解决问题清单及当前状态 -->
| 编号 | 问题 | 状态 |
|------|------|------|
| B1 | 语义矛盾 | ✅ 重构为大纲系统 |
| B2 | 隐含信息不一致 | ✅ 17 条检查+渐进式四层 |
| B3 | 因果链断裂 | ✅ 三态管理+心跳+衰减模型 |
| B4 | 长程风格一致性 | ✅ 20 机制+五层架构 |
| B5 | 多线叙事同步 | ✅ 12 核心机制+4 辅助机制+6 层架构 |
| B6 | 角色状态桥梁层 | ✅ 3 机制（持久化+大纲衔接+记忆同步） |
| B7 | 伏笔系统 | ✅ 薄协调层（统一视图+AI 识别+回收检测+分类体系+密度监控+依赖链） |
| B8 | 节奏控制 | ✅ 薄协调层（节奏画像+规划系统+检测器+建议引擎+曲线面板+跨模块集成） |
| ~~B9~~ | ~~世界观一致性~~ | ❌ 已删除（已被 B2 世界观规则引擎+B4 M10 文化/世界观一致性完整覆盖） |
| ~~B10~~ | ~~多角色对话区分~~ | ❌ 已删除（已被 B4 M7 角色对话指纹完整覆盖） |
| ~~B11~~ | ~~情感曲线设计~~ | ❌ 已删除（已被 B1 大纲系统完整覆盖：情感曲线数据结构+计算函数+大纲预演+章纲情感目标） |
| ~~B12~~ | ~~跨卷连贯性~~ | ❌ 已删除（已被 B1/B3/B5/B7 分散覆盖，剩余归入 B8 节奏控制） |

### C 类：当前技术难以解决

| 编号 | 问题 | 间接解决方向 |
|------|------|------|
| C1 | 情感深度保持 | 角色模拟 Agent+情感履历 |
| C2 | 创意枯竭/套路化 | 灵感库+反套路桥段库 |
| C3 | 共鸣感预判 | 类型模板+叙事结构分析 |
| ... | ... | ... |

---

<a id="appendix-b"></a>

## 附录 B 关键设计决策记录

<!-- 表格说明：关键设计决策记录，列出重要决策的触发原因和影响 -->
| 决策 | 触发原因 | 影响 |
|------|---------|------|
| B1 从矛盾检测→大纲系统 | 用户："性格是会变的""问题是剧情没设计好" | B1 从检测问题重构为系统设计问题 |
| 算法优先于 LLM | 用户："能不能写程序靠算法解决" | 三层协同架构（算法 80%+LLM20%+人工） |
| 方案面板含自由输入 | 用户："加作者回复一栏，不能只做选择" | 确保作者最终解释权 |
| M20 删除读者数据依赖 | 用户："网站无法获取读者任何信息" | M20 从 3 子功能精简为 1 个 |
| B4 目标重定义 | 深度优化中认识到"一致性"是错误目标 | 从"保持一致"→"确保变化有意" |
| 分层治理（千万字级） | 用户："超 1000 万字就不行" | 四优先级分层，放弃完全追踪 |
| 结果叫"差异"不叫"矛盾" | B2 优化中认识到预设对错的危险 | 尊重作者意图，降低误报伤害 |
| 主动推荐优于被动预警 | B3 优化中认识到预警体验差 | 共振推荐帮作者自然维护元素 |
| B5 多线叙事同步独立设计 | B1-B4 无法覆盖多线叙事场景 | 新增 B5 模块，12 核心+4 辅助机制+6 层架构 |
| B1-B5 重叠设计统一合并 | 各模块独立设计导致 10 个重叠领域 | 合并为 4 大统一底层（#附录 G） |
| B9 世界观一致性删除 | B2 世界观规则引擎+B4 M10 文化/世界观一致性已完整覆盖 | 无独立设计价值，从问题清单删除 |
| B10 多角色对话区分删除 | B4 M7 角色对话指纹已完整覆盖 | 无独立设计价值，从问题清单删除 |
| B11 情感曲线设计删除 | B1 大纲系统已完整覆盖（EmotionalCurve+计算函数+大纲预演+章纲情感目标） | 无独立设计价值，从问题清单删除 |
| B12 跨卷连贯性删除 | 已被 B1/B3/B5/B7 分散覆盖，剩余归入 B8 节奏控制（D3b 跨卷断裂检测） | 无独立设计价值，从问题清单删除 |

### B.1 统一架构迁移说明汇总

> 以下汇总了全文中所有已被 #附录 G（统一底层架构）替代的旧设计。实现时应以附录 G 为准。

<!-- 表格说明：统一架构迁移说明汇总，按章节列出所有已被替代的旧设计 -->
| # | 所在章节 | 旧设计 | 替代方案（附录 G） | 替代类型 |
|------|---------|------|-------------------|------|
| 1 | 9.4.2 | `CharacterArc`/`CharacterState` 数据类 | G.1 `UnifiedEntityEngine` | 数据类替代 |
| 2 | 9.4.4 | `SetupChecker` | G.2 `BaseDetector` 子类 | 检测器迁移 |
| 3 | 9.4.5 | `_detect_pacing_issues()` 方法 | B8 D2a 节奏检测器 | 功能替代 |
| 4 | 9.4.6 | `outline_versions` 表 | G.3 `UnifiedTemplate` | 表替代 |
| 5 | 9.4.8 | `sync_outline_to_narrative_lines()` | 13.4.1 `auto_create_narrative_lines_from_outline()` | 函数替代 |
| 6 | 9.5.2 | `OutlineConflictDetector` | G.2 `BaseDetector` 子类 | 检测器迁移 |
| 7 | 9.5.3 | `OUTLINE_TEMPLATES` + `apply_outline_template()` | G.3 `UnifiedTemplate` | 模板替代 |
| 8 | 10.4 | P0-P3 严重性分级 | G.2 `DetectionSeverity` | 枚举替代 |
| 9 | 10.6 | 方案面板 UI 布局 | G.4 `VisualizationConfig` | 可视化替代 |
| 10 | 10.9.1 | `character_attributes` + `attribute_change_log` 表 | G.1 `unified_entities` | 表替代 |
| 11 | 10.9.2 | `IronFactManager` 类 | G.1 `UnifiedEntityEngine.update_attribute()` | 类替代 |
| 12 | 10.9.4 | `IncrementalScanner` 直接查询旧表 | G.1 `UnifiedEntityEngine.get_effective_state()` | 查询替代 |
| 13 | 10.9.6 | `IssueStateMachine` | G.2 `unified_detection_results.status` | 状态机替代 |
| 14 | 10.10.1 | `AttributeExtractionPipeline` | G.2 `UnifiedDetectionPipeline` 预处理步骤 | 管线替代 |
| 15 | 10.10.3 | `check_results` 表 + `query_check_results()` | G.2 `unified_detection_results` 表 | 表替代 |
| 16 | 11.7.1 | `story_elements` + `element_mentions` 表 | G.1 `unified_entities` + `entity_attribute_history` | 表替代 |
| 17 | 11.7.2 | `HeartbeatDetector` | G.2 `BaseDetector` 子类 | 检测器迁移 |
| 18 | 11.7.3 | 查询 `story_elements.importance` | G.1 `unified_entities.importance` | 字段替代 |
| 19 | 11.7.5 | 因果链可视化数据格式 | G.4 `VisualizationConfig` | 可视化替代 |
| 20 | 11.8.1 | `ElementIntroductionDetector` | G.2 `BaseDetector` + G.1 `UnifiedEntityEngine.activate()` | 检测器迁移 |
| 21 | 11.8.3 | `retire_element()` 直接操作旧表 | G.1 `UnifiedEntityEngine.retire()` | 方法替代 |
| 22 | 13.4.2 | `UnifiedKnowledgeSystem` | G.1 + G.2 完全替代 | 系统替代 |
| 23 | 13.5.2 | `NARRATIVE_LINE_TEMPLATES` | G.3 `UnifiedTemplate` | 模板替代 |
| 24 | 15.1 | 整个统一检测管线节 | G.2 `UnifiedDetectionPipeline` | 整节替代 |
| 25 | 18.2 | MVP 核心数据库 Schema | 附录 G 各小节统一表 | Schema 替代 |

---

> **文档版本**：v3.3（问题清单定格版本，主文档已迭代至 v5.0）
> **创建日期**：2026-04-16
> **最后更新**：2026-04-17
> **已完成问题**：B1/B2/B3/B4/B5/B6/B7/B8
> **已删除问题**：B9（被 B2+B4 覆盖）、B10（被 B4 覆盖）、B11（被 B1 覆盖）、B12（被 B1/B3/B5/B7 覆盖）
> **待讨论问题**：无（B1-B8 全部设计完成）
> **数据来源**：历史对话记录（17077 行）+ 已有设计文档

---

<a id="appendix-c"></a>
## 附录 C B4 长程风格一致性 —— 完整设计方案

> 📍 附录 C：B4 长程风格一致性完整设计（C.1-C.32，含盲区补充索引→附录 E），主文档摘要见第 12 章

> **版本**：v1.4 | **日期**：2026-04-17 | **状态**：深度优化第 12 轮完成
> **编号说明**：本附录为独立设计文档，内部章节编号（C.1~C.32）为附录自有编号，与主文档章节编号无关。

> ⚠️ **迁移说明**：主文档 #附录 G 定义了四大统一底层架构（UnifiedEntityEngine、UnifiedDetectionPipeline、UnifiedTemplateVersionSystem、UnifiedVisualizationFramework）。本附录中的部分设计与统一架构存在重叠，实现时应以 #附录 G 为准：
> - **实体状态**：涉及角色属性、世界观术语等实体数据的操作，应通过 `UnifiedEntityEngine`（#G.1）统一管理，而非直接操作独立表
> - **检测结果**：`style_annotations` 等检测结果表应迁移到 `unified_detection_results`（#G.2）
> - **模板版本**：`style_templates` 等模板表应纳入 `unified_templates`（#G.3）统一管理
> - **可视化**：M15 可视化工具应通过 `UnifiedVisualizationFramework`（#G.4）注册
> - 本附录中涉及的 `characters` 表引用，应替换为 `unified_entities`（`domain='character'`）
>
> **数据库**：本附录所有 SQL Schema 基于 PostgreSQL 15+语法。

## C.1 问题定义

> 📋 **摘要**：定义 AI 长程写作中的风格漂移核心问题，将终极目标设定为"确保每一次风格变化都是作者有意为之"。

### C.1.1 核心问题

长程写作中，AI 生成内容的风格与作者自身风格不一致，且随篇幅增长漂移越来越严重。

具体表现：
- **早期阶段**（1-10 章）：AI 生成内容与作者风格偏差尚可接受，偶尔出现 AI 味表达
- **中期阶段**（10-50 章）：风格漂移逐渐累积，AI 味表达频率上升，角色对话开始"千人一面"
- **后期阶段**（50 章+）：风格严重偏离，甚至同一角色在不同章节的说话方式完全不同

### C.1.2 终极目标重新定义

不是"保持风格一致"，而是**"确保每一次风格变化都是作者有意为之"**。

这意味着：
- 风格变化本身不是问题，无意识的风格漂移才是问题
- 作者有权在任何时候改变风格（如情节转折、角色成长、氛围转换）
- 系统的核心职责是：检测漂移、区分有意变化与无意漂移、记录变化

### C.1.3 三层子问题

| 层级 | 子问题 | 描述 |
|------|--------|------|
| 定义层 | 风格定义模糊 | "风格"是什么？如何量化？如何让作者定义自己的风格？ |
| 检测层 | 风格漂移无感知 | AI 生成内容偏离作者风格时，作者和系统都无法及时感知 |
| 记录层 | 风格变化无记录 | 即使作者有意改变风格，也没有机制记录和追踪这些变化 |

---

## C.2 设计哲学

> 📋 **摘要**：确立作者主权、变化合法、算法优先、分层治理四大设计原则，指导整个风格控制系统的设计方向。

### C.2.1 作者主权

作者定义什么是"正确风格"。系统不预设任何"好风格"的标准，所有风格判断均以作者的定义为准。

### C.2.2 变化合法

风格变化是创作需要，不是错误。系统区分"有意变化"和"无意漂移"，只对后者发出警告。

### C.2.3 算法优先

80%风格特征用算法统计，零 LLM 成本。只有需要语义理解的检测才调用 LLM，最大限度控制成本。

### C.2.4 分层治理

千万字级作品需要分层策略。不同层级的机制有不同的成本和精度，按需组合使用。

---

## C.3 五层架构

> 📋 **摘要**：定义作者层、算法层、LLM 检测层、生成控制层、系统支撑层的分层架构及层间反馈循环关系。

```
作者层：M1风格宪法 + M2意图注册表 → 定义"什么是正确风格"
算法层：M3统计+M4词汇+M5 AI味+M9感官+M11漂移 → 确定性统计，零LLM成本
LLM检测层：M6+M7+M8+M12 → 需要语义理解，定期/按需
生成控制层：M13+M17 → 从源头预防
系统支撑层：M14+M15+M16+M18+M19+M20 → 支撑以上所有层
```

### C.3.1 各层职责

| 层级 | 包含机制 | 核心职责 | LLM 依赖 |
|------|----------|------|---------|
| 作者层 | M1, M2 | 定义风格标准、记录有意变化 | 无 |
| 算法层 | M3, M4, M5, M9, M11 | 确定性统计与检测 | 无 |
| LLM 检测层 | M6, M7, M8, M12 | 语义级风格分析 | 按需 |
| 生成控制层 | M13, M17 | 从源头预防风格漂移 | 生成时 |
| 系统支撑层 | M14, M15, M16, M18, M19, M20 | 支撑以上所有层 | 按需 |

### C.3.2 层间协作关系

```text
作者层（定义）→ 算法层（检测）→ LLM检测层（深度分析）→ 生成控制层（预防）→ 系统支撑层（反馈）
     ↑                                                                              ↓
     └────────────────────── 反馈循环：检测结果反馈给作者层，优化风格定义 ←──────────────┘
```

---

## C.4 M1 风格宪法系统

> 📋 **摘要**：定义全书风格的最高准则，支持自由文本、结构化选项和参考文本三种定义方式，含版本管理和 12 问初始化问卷。

### C.4.1 定位

全书风格的最高准则。所有风格检测、生成控制、质量评估均以此为基准。

### C.4.2 三种定义方式

| 方式 | 描述 | 适用场景 |
|------|------|------|
| 自由文本描述 | 作者用自然语言描述自己的风格 | 精确度要求不高时 |
| 结构化选项 | 通过预设维度选择风格参数 | 快速初始化 |
| 参考文本上传 | 上传自己的写作样本，系统自动分析 | 精确度要求高时 |

### C.4.3 结构化选项维度

| 维度 | 选项范围 | 说明 |
|------|----------|------|
| 正式度 | 1-10 | 口语化 ↔ 书面化 |
| 情感浓度 | 1-10 | 冷静克制 ↔ 情感浓烈 |
| 叙事距离 | 1-10 | 贴近角色 ↔ 俯瞰全局 |
| 描写密度 | 1-10 | 简洁白描 ↔ 细腻铺陈 |
| 节奏偏好 | 慢/中等/铺垫/快/高潮 | 慢热铺垫/均衡叙事/蓄力推进/动作密集/高潮爆发 |

### C.4.4 版本管理

- 每次修订生成新版本，保留历史版本
- 版本号格式：`v{major}.{minor}`（major 为大幅调整，minor 为微调）
- 支持回滚到任意历史版本
- 版本变更时记录变更原因

### C.4.5 初始化问卷（12 个问题）

<!-- 表格说明：风格宪法初始化问卷，12个问题及选项说明 -->
| # | 问题 | 类型 | 选项/说明 |
|------|------|------|-----------|
| 1 | 作品类型/子类型 | 选择 | 玄幻/都市/科幻/历史/言情/悬疑/武侠/仙侠/其他 |
| 2 | 目标读者年龄 | 选择 | 少儿/青少年/成人 |
| 3 | 叙事人称 | 选择 | 第一人称/第三人称限制/第三人称全知 |
| 4 | 情感基调 | 选择 | 热血/温馨/沉重/轻松/暗黑/幽默 |
| 5 | 语言风格（文白程度） | 滑块 | 1(纯口语) - 10(文言文) |
| 6 | 描写偏好 | 多选 | 环境描写/心理描写/动作描写/对话描写/细节描写 |
| 7 | 对话比例 | 滑块 | 10% - 80% |
| 8 | 节奏偏好 | 选择 | 慢节奏/中等/铺垫蓄力/快节奏/高潮爆发 |
| 9 | 禁忌内容 | 多选 | 脏话/血腥/色情/政治敏感/自定义 |
| 10 | 参考作品 | 文本 | 列出 1-3 部风格相近的作品 |
| 11 | 独特风格标签 | 文本 | 自由描述自己的独特风格特点 |
| 12 | 风格宪法文本 | 文本 | 用一段话总结"我的写作风格" |

---

## C.5 M2 风格意图注册表

> 📋 **摘要**：记录作者每一次有意的风格变化，通过完整状态机管理意图的注册、激活、验证和完成全生命周期。

### C.5.1 定位

记录作者每一次有意的风格变化。当风格发生预期内的变化时，通过注册意图来"合法化"这些变化，避免系统误报。

### C.5.2 意图字段

| 字段 | 类型 | 说明 |
|------|------|------|
| change_type | enum | evolution(渐进演变)/contrast(强烈对比)/return(回归旧风格)/experiment(风格实验) |
| chapter_range | [start, end] | 风格变化的目标章节范围 |
| description | text | 变化描述 |
| from_style_vector | vector | 变化前的风格向量快照 |
| to_style_vector | vector | 期望变化后的风格向量 |

### C.5.3 完整状态机

意图从注册到完成经历以下状态：

```
registered → active → verifying → completed
                                    → incomplete → verifying（最多3次）
                                    → abandoned
```

**状态转换规则：**

| 转换 | 触发条件 | 说明 |
|------|----------|------|
| registered → active | 章节进入 range_start | 自动激活 |
| active → verifying | 章节到达 range_end | 自动触发验证 |
| verifying → completed | 验证分数 > 0.7 | 意图成功实现 |
| verifying → incomplete | 验证分数 0.4-0.7 | 部分实现，可申请延长 |
| verifying → abandoned | 验证分数 < 0.4 或作者手动放弃 | 意图未实现 |
| incomplete → verifying | 延长后重新验证 | 最多 3 次 |

### C.5.4 重叠处理

当两个意图的章节范围重叠时：
1. 创建 `overlap_group`，将重叠的意图归入同一组
2. 后注册的意图自动 `pause`（暂停），等待前一个完成
3. 前一个完成后，后一个自动恢复 `active`

### C.5.5 SQL Schema

```sql
CREATE TABLE style_intents (
    -- === 主键与标识 ===
    id UUID PRIMARY KEY,
    work_id UUID REFERENCES works(id),
    chapter_range_start INT NOT NULL,
    chapter_range_end INT NOT NULL,
    change_type VARCHAR(20) NOT NULL,  -- evolution/contrast/return/experiment
    from_style_vector FLOAT[],
    to_style_vector FLOAT[],
    description TEXT,  -- 意图描述
    status VARCHAR(20) DEFAULT 'registered',  -- registered/active/paused/verifying/completed/incomplete/abandoned
    extension_count INT DEFAULT 0,
    paused_by_intent_id UUID,
    overlap_group_id UUID,
    verification_score FLOAT,
    verified_at TIMESTAMP,
    -- === 审计字段 ===
    created_at TIMESTAMP DEFAULT NOW()
);
-- ER关系：本表通过 work_id 关联到 works(id)
```

---

## C.6 M3 算法统计引擎

> 📋 **摘要**：通过确定性算法提取文本的 50 维风格特征（句法、词汇、N-gram、感官、情感/节奏五大类），零 LLM 成本。

### C.6.1 定位

风格检测的核心引擎。通过确定性算法提取文本的 50 维风格特征，零 LLM 成本，支持千万字级作品的增量计算。

### C.6.2 50 维原始特征（5 大类）

#### C.6.2.1 句法特征（15 维）

<!-- 表格说明：50维风格特征的句法特征部分（15维），含计算方式 -->
| # | 特征名 | 计算方式 | 说明 |
|------|--------|------|------|
| 1 | 平均句长 | 总字数 / 句数 | 基础句式特征。同时被 B8 节奏画像引擎复用（见#16.2 节），作为"叙事速度"维度的倒数归一化输入 |
| 2 | 句长标准差 | 句长的统计标准差 | 句式变化幅度 |
| 3 | 长句比例(>40 字) | >40 字句子数 / 总句数 | 复杂句式倾向 |
| 4 | 短句比例(<10 字) | <10 字句子数 / 总句数 | 简洁风格倾向 |
| 5 | "的"字密度 | "的"字数 / 总字数 | AI 生成中文最强信号 |
| 6 | 逗号密度 | 逗号数 / 总字数 | 句内停顿频率 |
| 7 | 句号密度 | 句号数 / 总字数 | 断句频率 |
| 8 | 问号密度 | 问号数 / 总字数 | 疑问句频率 |
| 9 | 感叹号密度 | 感叹号数 / 总字数 | 感叹句频率 |
| 10 | 冒号密度 | 冒号数 / 总字数 | 引述/解释频率 |
| 11 | 分号密度 | 分号数 / 总字数 | 并列结构频率 |
| 12 | 破折号密度 | 破折号数 / 总字数 | 补充说明频率 |
| 13 | 省略号密度 | 省略号数 / 总字数 | 悬念/省略频率 |
| 14 | 引号密度 | 引号数 / 总字数 | 对话/引用频率 |
| 15 | 括号密度 | 括号数 / 总字数 | 注释/补充频率 |

#### C.6.2.2 词汇特征（12 维）

<!-- 表格说明：50维风格特征的词汇特征部分（12维），含计算方式 -->
| # | 特征名 | 计算方式 | 说明 |
|------|--------|------|------|
| 1 | 词汇丰富度(TTR) | 独立词数 / 总词数 | Type-Token Ratio |
| 2 | 平均词长 | 总字数 / 总词数 | 用词复杂度 |
| 3 | 文言词密度 | 文言词数 / 总词数 | 古典风格倾向 |
| 4 | 口语词密度 | 口语词数 / 总词数 | 口语化程度 |
| 5 | 四字成语密度 | 四字成语数 / 总词数 | 成语使用频率 |
| 6 | 叠词密度 | 叠词数 / 总词数 | 叠词使用频率 |
| 7 | 量词密度 | 量词数 / 总词数 | 量词使用频率 |
| 8 | 代词密度 | 代词数 / 总词数 | 人称指代频率 |
| 9 | 动词密度 | 动词数 / 总词数 | 动作描写倾向 |
| 10 | 形容词密度 | 形容词数 / 总词数 | 修饰描写倾向 |
| 11 | 副词密度 | 副词数 / 总词数 | 程度/方式修饰倾向 |
| 12 | 外来词密度 | 外来词数 / 总词数 | 外来语使用频率 |

#### C.6.2.3 N-gram 特征（8 维）

| # | 特征名 | 计算方式 | 说明 |
|------|--------|------|------|
| 1 | 二字词频率 TOP10 方差 | TOP10 二字词频率的统计方差 | 高频二字词集中度 |
| 2 | 三字词频率 TOP10 方差 | TOP10 三字词频率的统计方差 | 高频三字词集中度 |
| 3 | 四字词频率 TOP10 方差 | TOP10 四字词频率的统计方差 | 高频四字词集中度 |
| 4 | 常用搭配数 | 出现>5 次的词搭配数 | 习惯性表达数量 |
| 5 | 独特搭配数 | 仅出现 1 次的词搭配数 | 创新表达数量 |
| 6 | 搭配多样性 | 独特搭配数 / 总搭配数 | 表达创新程度 |
| 7 | 句式模板 TOP5 占比 | 最常见 5 种句式的占比之和 | 句式单一程度 |
| 8 | 段首词多样性 | 段首词独立数 / 总段落数 | 段落开头变化程度 |

#### C.6.2.4 感官特征（8 维）

| # | 特征名 | 计算方式 | 说明 |
|------|--------|------|------|
| 1 | 视觉词密度 | 视觉词数 / 总词数 | 视觉描写倾向 |
| 2 | 听觉词密度 | 听觉词数 / 总词数 | 听觉描写倾向 |
| 3 | 触觉词密度 | 触觉词数 / 总词数 | 触觉描写倾向 |
| 4 | 嗅觉词密度 | 嗅觉词数 / 总词数 | 嗅觉描写倾向 |
| 5 | 味觉词密度 | 味觉词数 / 总词数 | 味觉描写倾向 |
| 6 | 通感词密度 | 通感词数 / 总词数 | 跨感官描写倾向 |
| 7 | 感官总密度 | 感官词总数 / 总词数 | 感官描写总体倾向 |
| 8 | 感官多样性 | 感官维度熵 | 感官维度分布均匀度 |

#### C.6.2.5 情感/节奏特征（7 维）

| # | 特征名 | 计算方式 | 说明 |
|------|--------|------|------|
| 1 | 积极情感词密度 | 积极情感词数 / 总词数 | 正面情感倾向。同时被 B8 节奏画像引擎复用（见#16.2 节），与消极情感词密度合并为"情感强度"维度 |
| 2 | 消极情感词密度 | 消极情感词数 / 总词数 | 负面情感倾向。同时被 B8 节奏画像引擎复用（见#16.2 节），与积极情感词密度合并为"情感强度"维度 |
| 3 | 情感波动率 | 情感值的标准差 | 情感起伏程度 |
| 4 | 对话占比 | 对话字数 / 总字数 | 对话在文本中的比例。同时被 B8 节奏画像引擎复用（见#16.2 节），作为"对话比"维度直接使用 |
| 5 | 独白占比 | 独白字数 / 总字数 | 内心独白比例 |
| 6 | 描写占比 | 描写字数 / 总字数 | 环境描写比例 |
| 7 | 动作占比 | 动作描写字数 / 总字数 | 动作描写比例 |

> **与 M4/M9 的协调**：M3 的词汇特征(12 维)和感官特征(8 维)分别与 M4 词汇控制、M9 感官/意象系统存在重叠。M3 负责统计和检测（被动），M4/M9 负责控制和干预（主动）。两者共享底层数据但职责不同：M3 回答"当前风格是什么"，M4/M9 回答"风格应该怎么调"。

### C.6.3 PCA 降维

50 维原始特征通过 PCA 降维至 20 维风格向量（使用前 20 个主成分，保留 95%以上方差），用于：
- 风格相似度计算（cosine similarity）
- 风格漂移检测
- 风格聚类分析

### C.6.4 Welford 增量算法实现

针对千万字级作品，使用 Welford 在线算法实现增量计算，无需存储全部历史数据。

```python
# --- 摘要：WelfordStyleStats扩展方法 —— Welford在线算法的扩展：标准差/全局均值向量/余弦相似度/重置等 ---
class WelfordStyleStats:
    """Welford在线算法：增量计算风格统计量，支持千万字级作品"""

    def __init__(self):
        # 每个维度的在线统计量
        self.stats: dict[str, dict] = {}

    def update(self, new_values: dict[str, float]) -> None:
        """处理新章节的特征值，增量更新统计"""
        for dim, new_val in new_values.items():
            if dim not in self.stats:
                # 首次遇到该维度，初始化
                self.stats[dim] = {
                    "count": 0, "mean": 0.0, "M2": 0.0
                }
            s = self.stats[dim]
            s["count"] += 1
            delta = new_val - s["mean"]
            s["mean"] += delta / s["count"]
            delta2 = new_val - s["mean"]
            s["M2"] += delta * delta2

    def get_variance(self, dim: str) -> float:
        """获取某维度的方差"""
        if dim not in self.stats or self.stats[dim]["count"] < 2:
            return 0.0
        return self.stats[dim]["M2"] / (self.stats[dim]["count"] - 1)

    def get_global_mean_vector(self) -> dict[str, float]:
        """获取全局均值向量（作为风格基准线）"""
        return {dim: s["mean"] for dim, s in self.stats.items()}
```

### C.6.5 风格周期检测

基于变点检测（change-point detection）算法，识别风格稳定区间：
- 使用 PELT（Pruned Exact Linear Time）算法检测变点
- 将全书划分为若干风格稳定区间
- 每个稳定区间计算一个代表风格向量
- 用于风格漂移追踪的基准线

---

## C.7 M4 词汇控制系统

> 📋 **摘要**：管理作者的个人禁用词和偏好词表，直接影响生成控制层的 Prompt 组装，含使用频率追踪。

### C.7.1 定位

管理作者的个人词汇偏好，包括禁用词和偏好词，直接影响生成控制层的 Prompt 组装。

### C.7.2 禁用词表

| 来源 | 说明 | 示例 |
|------|------|------|
| 手动添加 | 作者主动添加 | "仿佛"、"宛如" |
| AI 味自动检测 | M5 检测到的高频 AI 味词 | 系统自动建议 |
| 反馈学习 | 作者多次修改的词 | 系统学习得到 |

### C.7.3 偏好词表

| 来源 | 说明 | 示例 |
|------|------|------|
| 手动添加 | 作者主动添加 | "兀自"、"端的是" |
| 频率分析 | 作者常用独特表达 | 系统自动提取 |
| 参考文本 | 从上传样本中提取 | 系统自动分析 |

### C.7.4 词汇使用频率追踪

- 记录每个词的使用频率随章节的变化趋势
- 当某个词的使用频率突然上升/下降超过 2 个标准差时发出提醒
- 支持按词性、场景类型筛选

---

## C.8 M5 AI 味检测器

> 📋 **摘要**：定义 10 类 AI 生成文本常见模式（滥用比喻词、过度修饰等）的检测词表、评分算法和阈值等级。

### C.8.1 定位

检测 AI 生成文本中常见的"AI 味"表达模式，是风格质量控制的重要一环。

### C.8.2 10 类检测模式（完整词表）

<!-- 表格说明：AI味检测的10类模式及对应关键词列表和权重 -->
| # | 模式名称 | 关键词列表 | 权重 |
|------|----------|------|------|
| 1 | 滥用比喻词 | 宛如/仿佛/犹如/恰似/好似/如同/恍若/宛若/像是 | 0.8 |
| 2 | 过度修饰 | 缓缓地/轻轻地/默默地/静静地/淡淡地/微微地/悄然/徐徐 | 0.7 |
| 3 | 情感直述 | 心中涌起/眼中闪过/嘴角微微/内心深处/灵魂深处/心底 | 0.9 |
| 4 | 万能连接词 | 然而/不过/与此同时/转瞬之间/刹那间 | 0.6 |
| 5 | 总结式收尾 | 这一刻/从此以后/命运的齿轮/一切都将 | 0.8 |
| 6 | 环境烘托套路 | 月光如水/微风拂过/夕阳西下/晨曦微露 | 0.7 |
| 7 | 过度排比 | 三个以上相同句式连续 | 0.6 |
| 8 | 情感标签化 | 愤怒/悲伤/喜悦/恐惧+地 | 0.8 |
| 9 | 虚假深度 | 也许/或许/终究/不过如此/不过尔尔 | 0.5 |
| 10 | AI 特有句式 | 不禁/忍不住/情不自禁/下意识地 | 0.7 |

### C.8.3 评分算法

```
score = (Σ(pattern_count × weight) / total_sentences) × 100
```

### C.8.4 阈值

| 分数范围 | 等级 | 建议操作 |
|------|------|------|
| < 15 | 优秀 | 无需处理 |
| 15-30 | 良好 | 可选择性修改 |
| 30-50 | 需注意 | 建议修改 |
| > 50 | 严重 | 必须修改 |

### C.8.5 误报保护

- 作者手动标记为"我的风格"的词组，永久排除检测
- 排除记录存储在 `style_learning_rules` 表中，`rule_type = 'banned_word'`，`source = 'manual'`

---

## C.9 M6 场景-风格匹配

> 📋 **摘要**：定义 8 种场景类型（战斗、情感、描写等）的关键词字典和对应的风格标准，实现场景感知的风格检测。

### C.9.1 定位

不同场景类型对风格有不同的合理要求。战斗场景允许短句密集，情感场景允许修饰丰富，系统需要理解这种场景差异。

### C.9.2 8 种场景类型及关键词字典

| # | 场景类型 | 关键词 |
|------|----------|------|
| 1 | 战斗场景 | 打/击/斩/刺/劈/挡/闪/跃/飞/轰/爆/碎/裂/破/震/怒吼/咆哮/嘶吼 |
| 2 | 情感场景 | 泪/哭/笑/叹/拥抱/颤抖/哽咽/抽泣/微笑/苦笑/沉默/凝视 |
| 3 | 描写场景 | 山/水/云/风/月/花/树/光/影/色/声/味/触/景/貌 |
| 4 | 对话场景 | 说/道/问/答/喊/叫/骂/劝/求/谢/道歉/解释/争论/商量 |
| 5 | 回忆场景 | 记得/想起/回忆/曾经/那时/从前/过去/往事/旧日/当年 |
| 6 | 修炼场景 | 气/灵/力/丹/阵/法/功/境界/突破/修炼/感悟/天地 |
| 7 | 悬疑场景 | 疑/暗/影/密/藏/踪/迹/线索/真相/谜/诡/异 |
| 8 | 日常场景 | 吃/喝/睡/走/坐/看/听/想/说/笑/玩/买/卖 |

> **分类算法**：取关键词命中密度最高的场景类型作为分类结果。若最高密度低于 0.1（即每 10 词中命中不足 1 个关键词），则标记为"未分类"。支持多标签：密度超过 0.3 的场景类型均作为候选。

### C.9.3 场景风格标准

| 场景类型 | 允许的风格特征 | 不建议的风格特征 |
|------|----------------|------|
| 战斗场景 | 短句密集、动词密度高、感叹号多 | 长修饰句、排比 |
| 情感场景 | 修饰丰富、叠词多、独白占比高 | 过于简洁 |
| 描写场景 | 感官词丰富、形容词密度高 | 口语化 |
| 对话场景 | 口语化、短句、感叹/问号多 | 长句描写 |
| 回忆场景 | 文言词多、节奏慢、省略号多 | 快节奏短句 |
| 修炼场景 | 四字词语多、文白混用 | 口语化 |
| 悬疑场景 | 短句、省略号多、感官词少 | 过度修饰 |
| 日常场景 | 口语化、对话占比高 | 文言词多 |

---

## C.10 M7 对话/角色风格

> 📋 **摘要**：为每个角色提取对话指纹（常用词汇、句式偏好、口头禅等），确保角色对话风格独特不千人一面。

### C.10.1 定位

确保每个角色有独特的对话风格，避免"千人一面"。

### C.10.2 角色对话指纹提取

对每个角色的对话提取以下特征：
- **常用词汇**：该角色独有的高频词（TOP 20）
- **句式偏好**：平均句长、句长分布
- **口头禅**：标志性表达（如"嘿嘿"、"本座"、"老子"）
- **语气词**：常用的语气助词（如"嘛"、"呢"、"啊"、"罢了"）
- **称呼习惯**：对他人常用的称呼方式

### C.10.3 对话标签一致性检查

- 检查对话标签（说/道/问/答等）的使用一致性
- 检查对话提示语（动作描写+对话）的风格一致性
- 当角色的对话指纹偏离其历史平均值超过阈值时发出警告

---

## C.11 M8 叙事技术一致性

> 📋 **摘要**：通过规则引擎检测视角一致性、时态一致性和叙事距离控制，确保叙事技术全篇统一。

### C.11.1 定位

确保叙事技术的使用在整个作品中保持一致。

### C.11.2 视角一致性

| 视角类型 | 检测要点 |
|------|----------|
| 第一人称 | 检测是否意外出现第三人称叙述 |
| 第三人称限制 | 检测是否泄露了视角角色不知道的信息 |
| 第三人称全知 | 检测视角切换是否过于频繁或突兀 |

### C.11.3 时态一致性

- 中文虽然没有严格的时态变化，但有时间表达的一致性
- 检测时间线是否出现矛盾（如"昨天"发生的事与已建立的时间线冲突）

### C.11.4 叙事距离控制

| 叙事距离 | 特征 | 检测方式 |
|------|------|------|
| 近距离（贴近角色） | 大量内心独白、感官描写 | 统计独白占比、感官词密度 |
| 远距离（俯瞰全局） | 概括性叙述、上帝视角 | 统计概括性表达频率 |

> **实现说明**：M8 的三项检测均通过规则引擎实现。视角一致性检查第一人称/第三人称代词混用；时态一致性检查中文时态标记词（了/过/着/将）；叙事距离通过段落长度和内心独白比例判断。具体实现纳入 UnifiedDetectionPipeline 的 BaseDetector 插件体系。

---

## C.12 M9 感官/意象系统

> 📋 **摘要**：维护五感词典和 6 大意象类别，追踪意象使用频率、重复检测及关联网络，确保感官描写丰富性。

### C.12.1 定位

追踪作品中的感官描写和意象使用，确保感官体验的丰富性和意象使用的合理性。

### C.12.2 五感词典

为视觉、听觉、触觉、嗅觉、味觉分别维护词典，用于计算感官特征（M3 的 8 维感官特征）。

### C.12.3 意象分类与追踪系统

#### C.12.3.1 6 大意象类别

| 类别 | 代表意象 | 说明 |
|------|----------|------|
| 自然意象 | 月/风/雨/雪/花/树/山/水/云/星 | 自然景物 |
| 器物意象 | 剑/刀/琴/棋/书/画/灯/镜/扇/玉 | 人造器物 |
| 身体意象 | 眼/手/发/唇/肩/背/指/眉/腰/足 | 人体部位 |
| 空间意象 | 天/地/门/窗/路/桥/塔/城/殿/阁 | 空间场所 |
| 时间意象 | 晨/暮/春/秋/夜/昼/四季/年华/岁月/时光 | 时间概念 |
| 抽象意象 | 命/缘/道/心/梦/魂/血/火/冰/光 | 抽象概念 |

#### C.12.3.2 意象追踪

- 记录每个意象的首次出现章节
- 追踪使用频率趋势（按章节窗口统计）
- 记录最近使用章节，避免长时间不使用后突然出现

#### C.12.3.3 重复检测

- 同一意象在 3 章内重复使用超过阈值时提醒
- 阈值根据意象类别不同而不同（自然意象阈值较高，抽象意象阈值较低）

#### C.12.3.4 意象关联网络

- 自动发现经常一起出现的意象组合
- 构建意象共现矩阵
- 用于检测意象使用的创新性（是否过度依赖某些固定组合）

---

## C.13 M10 文化/世界观一致性

> 📋 **摘要**：维护世界观术语表和文化氛围词典，检测术语表达混用和文化元素冲突，确保世界观统一。

### C.13.1 定位

确保作品中的文化氛围和世界观术语表达保持一致。

### C.13.2 术语表达一致性

- 维护世界观术语表（如修炼体系的等级名称、地名、组织名等）
- 检测同一概念是否使用了不同的表达方式（如"灵气"和"灵力"混用）
- 支持术语别名映射（如"老夫"和"本座"都指向同一角色）

### C.13.3 文化氛围维护

- 检测文化元素的混用（如古代背景中出现现代用语）
- 维护文化氛围词典（古代/现代/科幻等不同背景的词汇集）

### C.13.4 世界观术语表

```sql
CREATE TABLE worldview_terms (
    id UUID PRIMARY KEY,
    work_id UUID REFERENCES works(id),
    term TEXT NOT NULL,           -- 标准术语
    aliases TEXT[],               -- 别名列表
    category VARCHAR(50),         -- 分类（修炼等级/地名/组织/物品等）
    description TEXT,             -- 术语说明
    first_appearance_chapter INT, -- 首次出现章节
    created_at TIMESTAMP DEFAULT NOW()
);
-- ER关系：本表通过 work_id 关联到 works(id)
```

> **与 M4 的协调规则**：M10 世界观术语表的优先级高于 M4 禁用词表。若某词在 M10 中定义为标准术语，则即使 M4 中标记为禁用词，也不予拦截。建议在 M4 的禁用词检查中增加 M10 术语表例外判断。

---

## C.14 M11 风格漂移追踪

> 📋 **摘要**：以 10 章为滑动窗口持续监控风格向量变化，通过余弦相似度阈值及时发现无意识的风格漂移。

### C.14.1 定位

持续监控风格向量的变化，及时发现无意识的风格漂移。

### C.14.2 滑动窗口

- 每 10 章为一个窗口
- 计算窗口内所有章节的风格向量均值
- 与前一个窗口的风格向量计算余弦相似度

### C.14.3 漂移阈值

| 相似度范围 | 状态 | 操作 |
|------|------|------|
| >= 0.95 | 稳定 | 无需处理 |
| 0.85-0.95 | 轻微漂移 | 记录，不警告 |
| 0.70-0.85 | 明显漂移 | 发出警告 |
| < 0.70 | 严重漂移 | 强烈警告，建议检查 |

> **阈值优先级**：当多个条件叠加时（如同时处于过渡期+冷启动），取最宽松的阈值。优先级：过渡期(0.70) > 冷启动(0.75) > 模型切换(0.80) > 正常(0.85)。

### C.14.4 可视化

- 漂移曲线图：X 轴为章节号，Y 轴为与前一章的余弦相似度
- 当有活跃的风格意图（M2）时，漂移曲线上标注意图范围
- 支持按维度查看漂移情况（如仅查看"的"字密度的变化）

---

## C.15 M12 风格质量评估

> 📋 **摘要**：综合宪法符合度、漂移稳定性、AI 味控制、场景适配度和意图完成度五个维度进行加权评分。

### C.15.1 定位

综合多个维度对章节的风格质量进行评分，给出 0-100 的总分和各维度分项得分。

### C.15.2 多维度评分算法

```python
def assess_style_quality(chapter_stats, constitution, prev_stats):
    """风格质量评估：返回0-100分"""
    scores = {}

    # 1. 宪法符合度（权重0.3）
    scores["constitution"] = cosine_sim(
        chapter_stats["style_vector"],
        constitution["target_vector"]
    ) * 100

    # 2. 漂移稳定性（权重0.25）
    if prev_stats:
        drift = 1 - cosine_sim(
            chapter_stats["style_vector"],
            prev_stats["style_vector"]
        )
        scores["stability"] = max(0, (1 - drift * 5)) * 100
    else:
        scores["stability"] = 100

    # 3. AI味控制（权重0.2）
    scores["ai_flavor"] = max(0, 100 - chapter_stats["ai_flavor_score"])

    # 4. 场景适配度（权重0.15）
    scene_type = classify_scene(chapter_stats)
    scene_score = calculate_scene_match(chapter_stats, scene_type)
    scores["scene_match"] = scene_score * 100

    # 5. 意图完成度（权重0.1）
    active_intents = get_active_intents(chapter_stats["chapter_num"])
    if active_intents:
        scores["intent_progress"] = avg_intent_progress(active_intents) * 100
    else:
        scores["intent_progress"] = 100

    # 加权总分
    total = sum(scores[k] * w for k, w in [
        ("constitution", 0.3), ("stability", 0.25),
        ("ai_flavor", 0.2), ("scene_match", 0.15), ("intent_progress", 0.1)
    ])

    return {"total": round(total, 1), "breakdown": scores}
```

### C.15.3 评分等级

| 总分范围 | 等级 | 建议 |
|------|------|------|
| 90-100 | 优秀 | 无需调整 |
| 75-89 | 良好 | 可选择性优化 |
| 60-74 | 一般 | 建议优化薄弱维度 |
| < 60 | 较差 | 需要重点修改 |

---

## C.16 M13 生成控制

> 📋 **摘要**：设计 4 层 Prompt 架构（System/Style/Content/Context），从源头预防风格漂移，总 Token 预算约 5200。

### C.16.1 定位

从源头预防风格漂移，通过精心设计的 Prompt 架构确保 AI 生成内容符合风格要求。

### C.16.2 4 层 Prompt 架构

#### Layer 1 - System Prompt（约 200 tokens，固定）

```
你是一位网文写作助手。你的核心原则：
1. 严格遵循作者的风格宪法
2. 保持与当前章节的风格一致
3. 避免AI味表达
4. 尊重场景类型的风格差异
```

#### Layer 2 - Style Prompt（约 800 tokens，动态）

# [注] 完整版变量列表见 C.16.2 节，此处为概览版。完整版额外包含{dialogue_ratio}和{sensory_density}。

```
【风格宪法】{constitution_summary}
【当前风格基准】句长均值:{avg_len} 词汇丰富度:{ttr} "的"字密度:{de_density}
【场景风格要求】{scene_type}: {scene_style_guide}
【禁用表达】{banned_patterns}
【偏好表达】{preferred_patterns}
【活跃风格意图】{active_intents_description}
```

#### Layer 3 - Content Prompt（约 1800 tokens，动态）

```
【当前情节】{plot_summary}
【在场角色】{characters_with_styles}
【角色运行时状态】{character_runtime_context}
# [注] character_runtime_context变量说明：
     值来源：B6 ContextRouter character_runtime通道（#16.6），
     包含每个在场角色的arc_phase（角色弧阶段）、current_emotion（当前情感）、current_goals（当前目标）。
     用于确保生成内容与角色当前状态一致。 -->
【情感基调】{emotion_tone}
【节奏要求】{pacing_guide}
# [注] pacing_guide变量说明：
     值来源：由get_writing_context_from_outline()中的rhythm_context.rhythm_guide字段提供，
     该字段由B8 RhythmIntegration（#16.7）基于前章节奏画像和章纲expected_pacing生成。
     pacing枚举已与B8统一为5值：slow/medium/buildup/fast/climax（见#16.2节奏画像引擎）。
     注意：pacing_guide是rhythm_context_summary（B8）的子集字段。 -->
【节奏上下文】{rhythm_context_summary}
# [注] rhythm_context_summary变量说明：
     值来源：B8 RhythmProfiler.get_rhythm_context()（#16.2），
     包含prev_chapter_rhythm（前章节奏画像）、expected_pacing（期望节奏）、
     rhythm_direction（节奏变化方向）、active_rhythm_issues（活跃节奏问题）。
     pacing_guide为rhythm_context_summary中rhythm_guide子字段的简化版。 -->
【本章目标】{chapter_objectives}
```

#### Layer 4 - Context Prompt（约 1800 tokens，动态）

```
【前文摘要】{previous_chapter_summary}
【关键对话】{recent_dialogues}
【增强伏笔视图】{foreshadowing_enhanced}
# [注] foreshadowing_enhanced变量说明：
     值来源：B7 ForeshadowCoordinator.inject_writing_context()（#16.5），
     包含增强的伏笔上下文（含关联角色、预期回收章节、紧迫度等结构化信息）。
     启用B7后，此变量替代下方的{active_foreshadowing}。 -->
【活跃伏笔】{active_foreshadowing}
# [注] active_foreshadowing变量说明：
     值来源：B1 memory.get_active_foreshadowing()，
     当B7 ForeshadowCoordinator未启用时作为降级方案使用。
     启用B7后，建议优先使用{foreshadowing_enhanced}。 -->
【风格漂移警告】{drift_warnings_if_any}
```

#### C.16.2.5 Prompt 变量数据源映射表

<!-- 表格说明：4层Prompt模板中所有变量的数据提供方映射 -->
| Prompt 变量 | 所属层 | 数据提供方 | 说明 |
|------|--------|------|------|
| `{constitution_summary}` | Layer 2 | B4 StyleConstitution | 风格宪法摘要 |
| `{avg_len}` / `{ttr}` / `{de_density}` | Layer 2 | B2 StyleProfiler | 风格统计指标 |
| `{dialogue_ratio}` / `{sensory_density}` | Layer 2 | B2 StyleProfiler | 完整版额外指标（见 C.16.2） |
| `{scene_type}` / `{scene_style_guide}` | Layer 2 | 章纲元数据 | 场景类型与风格指导 |
| `{banned_patterns}` / `{preferred_patterns}` | Layer 2 | B4 StyleConstitution | 禁用/偏好表达 |
| `{active_intents_description}` | Layer 2 | B4 StyleConstitution | 活跃风格意图 |
| `{plot_summary}` | Layer 3 | 章纲 | 当前情节摘要 |
| `{characters_with_styles}` | Layer 3 | B1 + B6 | 在场角色及风格描述 |
| **`{character_runtime_context}`** | **Layer 3** | **B6 ContextRouter character_runtime 通道** | **角色运行时状态（arc_phase、current_emotion、current_goals）** |
| `{emotion_tone}` | Layer 3 | 章纲 | 情感基调 |
| `{pacing_guide}` | Layer 3 | rhythm_context.rhythm_guide（B8 子字段） | 节奏指导（rhythm_context_summary 的子集） |
| **`{rhythm_context_summary}`** | **Layer 3** | **B8 RhythmProfiler.get_rhythm_context()** | **节奏上下文摘要（prev_chapter_rhythm、expected_pacing、rhythm_direction、active_rhythm_issues）** |
| `{chapter_objectives}` | Layer 3 | 章纲 | 本章目标 |
| `{previous_chapter_summary}` | Layer 4 | B1 memory | 前文摘要 |
| `{recent_dialogues}` | Layer 4 | B1 memory | 关键对话 |
| **`{foreshadowing_enhanced}`** | **Layer 4** | **B7 ForeshadowCoordinator.inject_writing_context()** | **增强伏笔视图（启用 B7 后替代{active_foreshadowing}）** |
| `{active_foreshadowing}` | Layer 4 | B1 memory.get_active_foreshadowing() | 活跃伏笔（B7 未启用时的降级方案） |
| `{drift_warnings_if_any}` | Layer 4 | B3 DriftDetector | 风格漂移警告 |

### C.16.3 总 Token 预算

# [注] B6/B7/B8新增变量额外贡献约1200 tokens：character_runtime_context(~300) + rhythm_context_summary(~300) + foreshadowing_enhanced(~300) + pacing_guide子集调整(~300)

| 层级 | Token 数 | 动态程度 |
|------|---------|------|
| Layer 1 - System | ~200 | 固定 |
| Layer 2 - Style | ~800 | 每章更新 |
| Layer 3 - Content | ~1800 | 每章更新（含 B6 角色运行时+B8 节奏上下文，各约 300 tokens） |
| Layer 4 - Context | ~1800 | 每章更新（含 B7 增强伏笔，约 300 tokens） |
| **总计** | **~5200** | - |

---

## C.17 M14 反馈学习

> 📋 **摘要**：从作者的修改行为中自动学习 5 类风格规则（禁用词、偏好词、风格调整、场景规则、角色规则），含审查面板。

### C.17.1 定位

从作者的修改行为中学习风格规则，持续优化风格控制。

### C.17.2 5 种规则类型

| 类型 | 说明 | 示例 |
|------|------|------|
| 禁用词 | 作者删除的词 | "仿佛" → 加入禁用词表 |
| 偏好词 | 作者添加的词 | "兀自" → 加入偏好词表 |
| 风格调整 | 作者对风格参数的修改 | 句长均值从 15 调整为 20 |
| 场景规则 | 作者对特定场景的风格要求 | 战斗场景禁用长修饰句 |
| 角色规则 | 作者对特定角色的风格要求 | 角色 A 说话必须用文言 |

### C.17.3 学习规则存储 Schema

```sql
CREATE TABLE style_learning_rules (
    id UUID PRIMARY KEY,
    work_id UUID REFERENCES works(id),
    rule_type VARCHAR(20) NOT NULL,  -- banned_word/preferred_word/style_adj/scene_rule/character_rule
    trigger_pattern TEXT NOT NULL,
    action TEXT NOT NULL,
    confidence FLOAT DEFAULT 0.5,
    source VARCHAR(20) DEFAULT 'manual',  -- manual/ai_suggested/verified/preset
    usage_count INT DEFAULT 0,
    last_used_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);
-- ER关系：本表通过 work_id 关联到 works(id)
```

### C.17.4 审查面板

- AI 建议的规则（`source = 'ai_suggested'`）需要作者审核
- 审核选项：接受（`verified`）、拒绝（删除）、修改后接受
- 置信度随使用次数增长：每次成功应用后 `confidence += 0.1`，上限为 1.0

---

## C.18 M15 可视化工具集

> 📋 **摘要**：提供雷达图、漂移曲线、AI 味仪表盘等 5 种可视化类型及对应的数据查询 API 端点设计。

### C.18.1 定位

将风格数据以直观的可视化方式呈现，帮助作者理解和控制风格。

### C.18.2 可视化类型

| 类型 | 说明 | 数据来源 |
|------|------|------|
| 雷达图 | 多维度风格画像 | M3 50 维特征 |
| 漂移曲线 | 风格向量随章节变化 | M11 漂移追踪 |
| AI 味仪表盘 | 各模式检测趋势 | M5 AI 味检测 |
| 风格对比 | 两章节风格差异 | M3 特征对比 |
| 意象分布 | 意象使用频率和分布 | M9 意象追踪 |

### C.18.3 可视化数据查询 API

```python
# API端点设计

# 雷达图数据：50维特征归一化后的雷达图数据
GET /api/works/{work_id}/style/radar?chapter={num}

# 漂移曲线数据：章节间cosine similarity曲线数据
GET /api/works/{work_id}/style/drift?start={ch}&end={ch}

# AI味数据：每章AI味评分 + 各模式命中详情
GET /api/works/{work_id}/style/ai-flavor?start={ch}&end={ch}

# 风格对比数据：两章节50维特征差异对比
GET /api/works/{work_id}/style/diff?ch_a={num}&ch_b={num}

# 意象数据：意象使用频率和分布数据
GET /api/works/{work_id}/style/imagery?start={ch}&end={ch}
```

---

## C.19 M16 风格守护 Agent

> 📋 **摘要**：独立审核 Agent 不参与生成，仅对已生成内容执行算法层快速检查和 LLM 深度审核，必要时发出改写请求。

### C.19.1 定位

独立的审核 Agent，不参与内容生成，仅负责审核已生成内容的风格质量。

### C.19.2 审核流程

```
生成内容 → 算法层快速检查（M3/M4/M5/M9/M11）
         → 通过 → 输出
         → 未通过 → LLM深度审核（M6/M7/M8/M12）
                   → 通过 → 输出
                   → 未通过 → 发出改写请求
```

### C.19.3 改写通信协议

```python
@dataclass
class StyleRewriteRequest:
    """风格守护Agent发出的改写请求"""
    request_id: str          # 唯一请求ID
    target_text: str         # 需要改写的原文
    reason: str              # 改写原因（如"AI味评分52，触发模式：滥用比喻词"）
    severity: str            # must_fix/should_fix/suggest
    constraints: dict        # 改写约束（保持情节不变、保持角色对话不变等）
    max_rewrites: int = 3    # 最大改写轮次


@dataclass
class StyleRewriteResponse:
    """WriterAgent返回的改写响应"""
    request_id: str
    rewritten_text: str      # 改写后的文本
    changes_made: list[str]  # 改动说明列表
    confidence: float        # 改写信心度0-1
    accepted: bool           # 是否接受改写建议
```

### C.19.4 审核严格度

| 条件 | 严格度 | 说明 |
|------|--------|------|
| 章节有活跃风格意图 | 降低 | 允许风格变化 |
| AI 生成比例高 | 提高 | 更严格检测 |
| 连续 3 章质量评分下降 | 提高 | 可能存在系统性问题 |
| 作者近期频繁修改 | 提高 | 说明当前风格不满意 |

---

## C.20 M17 风格过渡控制

> 📋 **摘要**：提供渐变、突变、振荡三种过渡曲线算法，在作者有意改变风格时控制平滑过渡过程。

### C.20.1 定位

当作者有意改变风格时（通过 M2 注册意图），控制风格变化的过渡过程，避免突兀的风格跳变。

### C.20.2 3 种过渡曲线

```python
def calculate_transition_progress(raw_progress: float, curve_type: str) -> float:
    """
    计算风格过渡进度（0.0-1.0）
    raw_progress: 原始进度（0.0-1.0），基于章节位置
    curve_type: 过渡曲线类型
    """
    import math

    if curve_type == "gradual":
        # Sigmoid渐变：中段变化最快，首尾缓慢
        progress = 1 / (1 + math.exp(-10 * (raw_progress - 0.5)))
    elif curve_type == "abrupt":
        # 阶梯突变：前80%保持旧风格，最后20%快速切换
        progress = 0.0 if raw_progress < 0.8 else (raw_progress - 0.8) / 0.2
    elif curve_type == "oscillating":
        # 正弦振荡：在两种风格间来回摆动，幅度逐渐收敛
        progress = raw_progress + 0.15 * math.sin(raw_progress * math.pi * 4)
        progress = max(0.0, min(1.0, progress))  # 钳位到[0,1]
    else:
        progress = raw_progress  # 默认线性

    return progress
```

| 曲线类型 | 适用场景 | 特点 |
|------|----------|------|
| gradual（渐变） | 渐进演变(evolution) | Sigmoid 曲线，中段变化最快 |
| abrupt（突变） | 强烈对比(contrast) | 前 80%保持旧风格，最后 20%快速切换 |
| oscillating（振荡） | 风格实验(experiment) | 在两种风格间来回摆动，幅度逐渐收敛 |

### C.20.3 过渡期间阈值调整

- 漂移检测阈值临时放宽：cosine_similarity 从 0.85 降至 0.70
- AI 味检测阈值临时放宽：从 30 提升至 45
- 过渡结束后自动恢复原始阈值
- 过渡期间的检测结果标记为"过渡期"，不计入长期趋势

---

## C.21 M18 人机边界管理

> 📋 **摘要**：通过段落级、句子级、词级三级标记粒度清晰区分 AI 生成与人工创作内容，含修改比例计算。

### C.21.1 定位

清晰标记 AI 生成内容的边界，让作者始终知道哪些内容是 AI 生成的，哪些是自己写的。

### C.21.2 三级标记粒度

| 粒度 | 说明 | 适用场景 |
|------|------|------|
| 段落级 | 标记整个段落的来源 | 段落来源单一时 |
| 句子级 | 段落内混合来源时，标记每个句子 | 人机协作写作 |
| 词级 | 关键改写位置精确标记 | 精细审核 |

来源类型：
- `human`：作者原创
- `ai`：AI 生成
- `ai_rewritten_human`：AI 改写了作者原文

### C.21.3 修改比例计算

基于编辑距离（Levenshtein）计算 AI 修改比例：

```python
def calculate_modification_ratio(original: str, modified: str) -> float:
    """计算AI修改比例（基于Levenshtein编辑距离）"""
    import Levenshtein
    distance = Levenshtein.distance(original, modified)
    max_len = max(len(original), len(modified))
    if max_len == 0:
        return 0.0
    return distance / max_len
```

### C.21.4 AI 比例影响检测严格度

- AI 生成比例高的段落，风格检测更严格
- 检测严格度系数：`strictness = 1.0 + ai_ratio * 0.5`（AI 比例 100%时，严格度提升 50%）

### C.21.5 SQL Schema

```sql
CREATE TABLE content_authorship_marks (
    id UUID PRIMARY KEY,
    chapter_id UUID REFERENCES chapters(id),
    paragraph_index INT NOT NULL,       -- 段落序号（从0开始）
    sentence_index INT,                 -- 句子序号（NULL表示整个段落）
    source VARCHAR(20) NOT NULL,        -- human/ai/ai_rewritten_human
    modification_ratio FLOAT,           -- AI修改比例（0.0-1.0）
    original_text_hash VARCHAR(64),     -- 原文哈希（用于溯源）
    marked_at TIMESTAMP DEFAULT NOW()
);
-- ER关系：本表通过 work_id 关联到 works(id)
```

---

## C.22 M19 跨作品风格管理

> 📋 **摘要**：实现多作品风格数据隔离与选择性维度导入机制，含适配度评分和导入后风险控制策略。

### C.22.1 定位

当作者有多部作品时，确保各作品的风格独立管理，同时支持跨作品的风格复用。

### C.22.2 多作品风格隔离

- 每部作品拥有独立的风格宪法（M1）、意图注册表（M2）、统计基线（M3）
- 作品间的风格数据默认隔离，不互相影响

### C.22.3 跨作品风格导入机制

#### C.22.3.1 选择性维度导入

作者可以选择导入哪些风格维度：

| 维度类别 | 包含内容 | 说明 |
|------|----------|------|
| 句法维度 | 句长分布、标点密度等 | 基础句式风格 |
| 词汇维度 | 禁用词、偏好词、TTR 等 | 用词风格 |
| 感官维度 | 五感词密度、意象偏好 | 描写风格 |
| 情感维度 | 情感词密度、情感波动率 | 情感表达风格 |

#### C.22.3.2 适配度评分

评估导入风格与目标作品的匹配程度：

> **注**：完整版实现（含类型适配、详细报告）见 E.4.3 适配度评分。

```python
def calculate_style_compatibility(
    source_style_vector: list[float],
    target_constitution_vector: list[float]
) -> float:
    """计算导入风格与目标作品的适配度（0-1）—— 简化版"""
    similarity = cosine_sim(source_style_vector, target_constitution_vector)
    return similarity
```

#### C.22.3.3 风险控制

- 导入后前 5 章加强监控
- 漂移阈值临时收紧：cosine_similarity 从 0.85 提升至 0.90
- 5 章后如果适配度评分稳定在 0.85 以上，恢复正常阈值

---

## C.23 M20 公开趋势分析

> 📋 **摘要**：基于公开排行榜数据提供通用风格建议，已删除读者反馈和作品数据对比功能，仅保留市场趋势参考。

### C.23.1 定位

基于公开信息的风格趋势分析，为作者提供市场导向的风格建议。

### C.23.2 范围说明

- M20-A（读者反馈分析）已删除：网站无法获取读者任何信息
- M20-C（作品数据对比）已删除：网站无法获取作品数据
- 仅保留 M20-B：基于公开排行榜/类型趋势的通用风格建议

### C.23.3 M20-B 通用风格建议

- 基于公开的排行榜数据（如起点中文网月票榜、畅销榜等）
- 分析当前热门类型的风格特征
- 提供通用性的风格建议（如"当前玄幻类作品中，对话占比平均为 35%，您的作品为 20%，偏低"）
- 所有数据来源均为公开信息，不涉及任何读者个人数据或作品内部数据

> **扩展方向**：M20-B 可接入公开网文平台的风格趋势数据（如起点、晋江的热门作品风格特征），为作者提供"当前市场流行风格"参考。数据来源限定为公开聚合统计，不涉及具体作品的读者数据。具体实现方案待 B7 阶段讨论。

---

## C.24 中文特有风格维度

> 📋 **摘要**：定义"的"字密度、文白混用比例、四字词语密度等 6 个中文写作独有的风格维度及对应权重。

### C.24.1 定位

中文写作有独特的风格维度，这些维度在英文写作中不存在或表现不同，需要特别关注。

### C.24.2 六大中文特有维度

| 维度 | 权重 | 说明 | 计算方式 |
|------|------|------|----------|
| "的"字密度 | 0.95 | AI 生成中文的最强信号 | "的"字数 / 总字数 |
| 文白混用比例 | 0.8 | 半文半白风格检测 | 文言词数 / 总词数 |
| 四字词语密度 | 0.7 | 成语/四字词使用频率 | 四字词语数 / 总词数 |
| 叠词密度 | 0.6 | 叠词使用频率 | 叠词数 / 总词数 |
| 口语词密度 | 0.5 | 口语化程度 | 口语词数 / 总词数 |
| 量词精确度 | 0.5 | 量词使用准确性 | 正确量词数 / 总量词数 |

### C.24.3 权重说明

- 权重反映该维度对风格判断的重要性
- "的"字密度权重最高（0.95），因为它是区分 AI 生成中文和人类写作的最强信号
- 权重用于风格质量评估（M12）中的加权计算

---

## C.25 成本控制

> 📋 **摘要**：分析各层 Token 消耗预算，通过算法优先、增量计算、按需 LLM 和 Prompt 精简四项策略将每章成本降至 4000-7000。

### C.25.1 各层 Token 消耗

| 阶段 | Token 预算/章 | 说明 |
|------|-------------|------|
| 算法层（M3/M4/M5/M9/M11） | 0 | 纯算法计算，零 LLM 成本 |
| LLM 检测层（M6/M7/M8/M12） | 2000-3000 | 按需触发，非每章必用 |
| 生成控制（M13） | 800 | Style Prompt（Layer 2） |
| **总计** | **4000-7000** | 从初始 17700 优化至此 |

### C.25.2 优化策略

| 策略 | 节省量 | 说明 |
|------|--------|------|
| 算法优先 | ~8000 tokens/章 | 80%特征用算法提取 |
| 增量计算 | 存储成本 | Welford 算法无需存储全量数据 |
| 按需 LLM | ~3000 tokens/章 | 非每章都触发 LLM 检测 |
| Prompt 精简 | ~2000 tokens/章 | 4 层架构避免冗余 |

---

## C.26 5 级降级策略

> 📋 **摘要**：定义从完整运行到全部暂停的 5 个降级等级及对应触发条件和自动恢复策略，确保系统在资源受限时仍可用。

### C.26.1 降级等级

| 级别 | 状态 | 说明 | 风格覆盖 |
|------|------|------|----------|
| Level 0 | 完整运行 | 所有机制正常 | 100% |
| Level 1 | LLM 降频 | LLM 检测频率降低（每 5 章一次） | ~80% |
| Level 2 | 仅算法 | 关闭所有 LLM 调用，仅保留算法层 | ~60% |
| Level 3 | 仅缓存 Prompt | 使用缓存的风格 Prompt，不重新计算 | ~40% |
| Level 4 | 全部暂停 | 不影响写作，所有风格机制关闭 | 0% |

### C.26.2 降级触发条件

| 条件 | 降级到 | 说明 |
|------|--------|------|
| API 限流 | Level 1 | LLM 调用频率受限 |
| API 不可用 | Level 2 | LLM 服务完全不可用 |
| 系统负载过高 | Level 1-2 | 根据负载程度选择 |
| 用户手动 | Level 3-4 | 用户主动选择降低 |
| 离线模式 | Level 2 | 无网络连接时 |

### C.26.3 恢复策略

- 降级原因消除后自动恢复到 Level 0
- 恢复时对降级期间跳过的章节进行补检
- 补检优先级：最近章节 > 较早章节

---

## C.27 Round 9 盲区补充索引

> 📋 **摘要**：汇总 Round 9 优化中发现的 8 个盲区补充的索引和交叉引用，含统一检测管线 API 的完整实现。

本章汇总 Round 9 优化中发现的 8 个盲区补充，这些补充已整合到各机制章节中，此处提供索引和交叉引用。

### C.27.1 M3 50 维特征定义表

完整的 50 维特征定义，包括 5 大类（句法 15 维、词汇 12 维、N-gram 8 维、感官 8 维、情感/节奏 7 维）。

> 见 [附录 C C.6 M3 算法统计引擎 - C.6.2 节](#c62-50 维原始特征（5 大类）)

### C.27.2 M5 AI 味模式库完整词表

10 类 AI 味检测模式的完整关键词列表和权重配置。

> 见 [附录 C C.8 M5 AI 味检测器 - C.8.2 节](#c82-10 类检测模式（完整词表）)

### C.27.3 M16 改写通信协议

风格守护 Agent 与 WriterAgent 之间的改写请求/响应数据结构。

> 见 [附录 C C.19 M16 风格守护 Agent - C.19.3 节](#c193-改写通信协议)

### C.27.4 M14 学习规则存储 Schema

反馈学习系统的规则存储 SQL 表结构。

> 见 [附录 C C.17 M14 反馈学习 - C.17.3 节](#c173-学习规则存储 schema)

### C.27.5 M1 初始化问卷（12 问题）

风格宪法初始化的 12 个引导问题。

> 见 [附录 C C.4 M1 风格宪法系统 - C.4.5 节](#c45-初始化问卷（12 个问题）)

### C.27.6 M6 场景分类器关键词字典

8 种场景类型的关键词字典和场景风格标准。

> 见 [附录 C C.9 M6 场景-风格匹配 - C.9.2 节](#c92-8 种场景类型及关键词字典)

### C.27.7 M12 质量评估算法

风格质量评估的 5 维度加权评分算法。

> 见 [附录 C C.15 M12 风格质量评估 - C.15.2 节](#c152-多维度评分算法)

### C.27.8 统一检测管线 API

所有风格检测机制的统一调用接口：

```python
def run_style_pipeline(chapter_text: str, work_id: str, chapter_num: int) -> dict:
    """
    统一风格检测管线
    按层级执行：算法层 → LLM层 → 生成控制层
    返回完整的检测结果
    """
    result = {
        "chapter_num": chapter_num,
        "algorithm_checks": {},    # 算法层结果
        "llm_checks": {},          # LLM层结果
        "quality_score": None,     # 质量评分
        "rewrite_requests": [],    # 改写请求（如有）
        "drift_warnings": [],      # 漂移警告（如有）
    }

    # 第一步：算法层检测（零LLM成本）
    result["algorithm_checks"] = {
        "stats": extract_50d_features(chapter_text),           # M3
        "banned_words": check_banned_words(chapter_text),      # M4
        "sensory": check_sensory(chapter_text),                # M9
        "drift": check_drift(work_id, chapter_num),            # M11
    }

    # 第二步：LLM层检测（按需）
    if should_run_llm_checks(work_id, chapter_num):
        result["llm_checks"] = {
            "ai_flavor": detect_ai_flavor(chapter_text),       # M5
            "scene_match": check_scene_style(chapter_text),    # M6
            "character_style": check_character_style(chapter_text),  # M7
            "narrative": check_narrative_consistency(chapter_text),  # M8
        }

    # 第三步：质量评估
    result["quality_score"] = assess_style_quality(
        result["algorithm_checks"]["stats"],
        get_constitution(work_id),
        get_prev_stats(work_id, chapter_num)
    )

    return result
```

---

## C.28 盲区补充索引（已迁移至附录 E）

> 以下三轮盲区补充设计已迁移至独立的 **附录 E：B4 盲区补充与迭代设计**，按机制编号重新组织。

| 原编号 | 新编号 | 标题 | 对应主节 |
|------|--------|------|---------|
| C.28.1 | E.1 | M2 意图生命周期状态机 | C.5 M2 风格意图注册表 |
| C.28.2 | E.2 | M17 过渡控制完整算法 | C.20 M17 风格过渡控制 |
| C.28.3 | E.3 | M18 人机边界管理粒度规则 | C.21 M18 人机边界管理 |
| C.28.4 | E.4 | M19 跨作品风格导入机制 | C.22 M19 跨作品风格管理 |
| C.28.5 | E.5 | M3 Welford 增量算法实现 | C.6 M3 算法统计引擎 |
| C.28.6 | E.6 | M13 完整 Prompt 模板 | C.16 M13 生成控制 |
| C.28.7 | E.7 | M15 可视化数据查询 API | C.18 M15 可视化工具集 |
| C.28.8 | E.8 | M9 意象分类与追踪系统 | C.12 M9 感官/意象系统 |
| C.29.1 | E.9 | M3 中文分词策略 | C.6 M3 算法统计引擎 |
| C.29.2 | E.10 | M7 角色对话指纹动态更新 | C.10 M7 对话/角色风格 |
| C.29.3 | E.11 | M11 自适应滑动窗口策略 | C.14 M11 风格漂移追踪 |
| C.29.4 | E.12 | M16 风格守护 Agent 审核时机 | C.19 M16 风格守护 Agent |
| C.29.5 | E.13 | M1 风格宪法与 M3 统计引擎对齐 | C.4 M1 风格宪法系统 |
| C.29.6 | E.14 | M14 反馈学习冷启动策略 | C.17 M14 反馈学习 |
| C.29.7 | E.15 | LLM 检测层调度与合并策略 | 跨机制（M5/M6/M7/M8/M12） |
| C.29.8 | E.16 | 风格漂移根因分析系统 | C.14 M11 风格漂移追踪 |
| C.30.1 | E.17 | 风格快照与检查点系统 | 跨机制 |
| C.30.2 | E.18 | 多 LLM 模型切换风格补偿 | C.16 M13 生成控制 |
| C.30.3 | E.19 | 风格检测精度评估体系 | 跨机制 |
| C.30.4 | E.20 | 章节内风格波动检测 | C.14 M11 风格漂移追踪 |
| C.30.5 | E.21 | 风格恢复与纠偏建议系统 | C.19 M16 风格守护 Agent |
| C.30.6 | E.22 | 数据安全与隐私合规 | 跨机制 |
| C.30.7 | E.23 | 风格模板生态与社区共享 | C.4 M1 风格宪法系统 |
| C.30.8 | E.24 | 风格检测性能优化与缓存策略 | C.25 成本控制 |

> 📄 **完整设计见附录 E：B4 盲区补充与迭代设计（E.1-E.24）**

## C.29 盲区补充：跨作品风格与作者指纹 *[已迁移至附录 E]*

> ⚠️ **迁移说明**：C.29.1-C.29.8 已迁移至附录 E（E.17-E.24），详见上方 C.28 迁移表。

## C.30 盲区补充：数据安全、性能优化与生态 *[已迁移至附录 E]*

> ⚠️ **迁移说明**：C.30.1-C.30.8 已迁移至附录 E（E.17-E.24），详见上方 C.28 迁移表。

## C.31 B4 与 B1/B5 跨模块协同接口

> 📋 **摘要**：定义风格系统与大纲系统（B1）、多线叙事（B5）之间的跨模块协同接口，包括按线定制风格和大纲预演风格检查。

#### 31.1 与 B5 按线定制风格

不同叙事线可以有不同的风格宪法：

```python
def get_line_style_constitution(work_id: str, line_id: str) -> dict:
    """
    获取叙事线的风格宪法（支持按线定制）
    
    如果该线有定制宪法则返回定制版，否则返回全局宪法
    """
    # 查找该线的定制宪法
    custom = db.query(
        "SELECT * FROM style_constitutions WHERE work_id = %s AND narrative_line_id = %s AND is_active = TRUE",
        work_id, line_id
    )
    
    if custom:
        return custom[0]
    
    # 回退到全局宪法
    global_constitution = db.query(
        "SELECT * FROM style_constitutions WHERE work_id = %s AND narrative_line_id IS NULL AND is_active = TRUE",
        work_id
    )
    
    return global_constitution[0] if global_constitution else None
```

#### 31.2 与 B1 大纲预演的风格检查

在大纲预演中增加风格一致性检查：

```python
class StyleAwareOutlinePreview(OutlinePreviewEngine):
    """风格感知的大纲预演引擎"""
    
    def preview(self, outline: dict) -> dict:
        """扩展预演：增加风格维度检查"""
        report = super().preview(outline)
        
        # 新增检查：风格宪法与内容匹配度
        report["style_consistency"] = self._check_style_consistency(outline)
        
        return report
    
    def _check_style_consistency(self, outline: dict) -> dict:
        """检查大纲中的风格设定是否与宪法一致"""
        constitution = get_active_constitution(outline["work_id"])
        if not constitution:
            return {"status": "no_constitution", "score": None}
        
        issues = []
        
        # 检查卷纲中的情感基调是否与宪法一致
        for volume in outline.get("volumes", []):
            volume_tone = volume.get("emotional_tone", "")
            constitution_tone = constitution.get("emotion_intensity", 5)
            
            # 如果宪法定义了低情感浓度，但卷纲标注了高情感场景
            if constitution_tone <= 3 and volume_tone in ["climax", "intense"]:
                issues.append({
                    "volume": volume["volume_num"],
                    "issue": "情感基调与风格宪法不匹配",
                    "detail": f"宪法情感浓度{constitution_tone}，但卷纲标注为{volume_tone}"
                })
        
        return {
            "status": "checked",
            "issues": issues,
            "score": 1.0 if not issues else 0.5,
        }
```

## C.32 编辑器集成与风格迁移工作流

> 📋 **摘要**：定义风格检测结果在编辑器中的行内标记和侧边栏集成方案，以及多作品间风格迁移的完整工作流。

#### 32.1 风格检测结果的编辑器集成方案

**行内标记**：风格问题在编辑器中以行内标记展示

| 问题类型 | 标记样式 | 悬浮提示 | 操作 |
|------|---------|------|------|
| AI 味表达 | 蓝色波浪下划线 | "AI 味：「仿佛」(权重 0.8)" | 一键替换/标记为我的风格 |
| 禁用词 | 红色波浪下划线 | "禁用词：「缓缓地」" | 一键删除/标记为允许 |
| 风格漂移 | 黄色波浪下划线 | "风格漂移：句长偏离 2.3σ" | 查看详情/忽略 |
| 场景不匹配 | 紫色波浪下划线 | "场景不匹配：战斗场景用了过多修饰" | 查看建议/忽略 |

**侧边栏面板**：

```python
# 编辑器侧边栏集成数据格式
STYLE_PANEL_DATA = {
    "overview": {
        "overall_score": 78.5,          # 综合风格评分
        "ai_flavor_score": 22,           # AI味评分
        "drift_status": "stable",        # 漂移状态
        "constitution_match": 0.92,      # 宪法匹配度
    },
    "dimension_details": [
        {"name": "平均句长", "current": 24.5, "target": 22.0, "status": "warning"},
        {"name": ""的"字密度", "current": 0.032, "target": 0.030, "status": "ok"},
        {"name": "词汇丰富度", "current": 0.65, "target": 0.62, "status": "ok"},
    ],
    "suggestions": [
        {"type": "ai_flavor", "text": "第3段「仿佛」建议替换为「像」", "action": "replace"},
        {"type": "drift", "text": "近5章句长逐渐增加，建议注意控制", "action": "info"},
    ],
}
```

#### 32.2 多作品间的风格迁移工作流

> 📋 本节为 [C.22 M19 跨作品风格管理](#c22-m19 跨作品风格管理) 的工程实现补充，建议实现时与对应章节一并阅读。

```python
# --- 摘要：StyleMigrationWorkflow —— 多作品间风格迁移工作流，支持完整/选择性/差量三种迁移模式 ---
class StyleMigrationWorkflow:
    """风格迁移工作流：将作品A的风格配置迁移到作品B"""
    
    def migrate(
        self, source_work_id: str, target_work_id: str,
        options: dict | None = None
    ) -> dict:
        """
        执行风格迁移
        
        参数:
            source_work_id: 源作品ID
            target_work_id: 目标作品ID
            options: 迁移选项
                {
                    "dimensions": ["syntax", "vocabulary"],  # 迁移哪些维度
                    "adapt": True,  # 是否适配目标作品
                    "dry_run": False,  # 试运行（不实际写入）
                }
                
        返回:
            dict: 迁移报告
        """
        opts = options or {}
        
        # 步骤1：提取源作品风格配置
        source_style = self._extract_style_config(source_work_id)
        
        # 步骤2：获取目标作品当前风格
        target_style = self._extract_style_config(target_work_id)
        
        # 步骤3：计算适配度
        if opts.get("adapt", True):
            adaptation = self._calculate_adaptation(source_style, target_style)
        else:
            adaptation = None
        
        # 步骤4：生成迁移计划
        migration_plan = self._generate_migration_plan(
            source_style, target_style, adaptation, opts.get("dimensions", "all")
        )
        
        # 步骤5：执行迁移（非试运行）
        if not opts.get("dry_run", False):
            self._execute_migration(target_work_id, migration_plan)
        
        return {
            "source_work": source_work_id,
            "target_work": target_work_id,
            "adaptation": adaptation,
            "plan": migration_plan,
            "dry_run": opts.get("dry_run", False),
        }
    
    def _calculate_adaptation(self, source: dict, target: dict) -> dict:
        """计算源风格到目标作品的适配度"""
        # 比较两作品的类型、读者群、篇幅等
        # 生成适配建议（如"源作品偏文言，目标作品偏口语，建议降低文白度"）
        return {
            "overall_fit": 0.75,
            "adjustments": [
                {"dimension": "formality", "source": 7, "target": 4, "suggestion": "降低正式度"},
            ],
        }
```

---

<a id="appendix-d"></a>
## 附录 D B5 多线叙事同步 —— 完整设计方案

> 📍 附录 D：B5 多线叙事系统完整设计（D.1-D.23），主文档摘要见第 13 章

> **版本**：v1.0 | **日期**：2026-04-17 | **状态**：初版完成
> **编号说明**：本附录为独立设计文档，内部章节编号（D.1~D.23）为附录自有编号，与主文档章节编号无关。

> ⚠️ **迁移说明**：主文档 #附录 G 定义了四大统一底层架构。本附录中的部分表和设计与统一架构存在重叠，实现时应以 #附录 G 为准：
> - **`character_global_states`** → 已由 `unified_entities.global_state`（JSONB 字段）替代（#G.1），**不再作为独立表使用**
> - **`character_line_states`** → 已由 `entity_line_states` 替代（#G.1）
> - **`characters` 表引用** → 应替换为 `unified_entities`（`domain='character'`）
> - **检测结果**（如跨线审核结果）→ 应纳入 `unified_detection_results`（#G.2）
> - **叙事线模板** → 应纳入 `unified_templates`（`type='narrative_line'`，#G.3）
> - 本附录中涉及的实体状态操作，应通过 `UnifiedEntityEngine`（#G.1）统一管理
>
> **数据库**：本附录所有 SQL Schema 基于 PostgreSQL 15+语法。

## D.1 问题定义

> 📋 **摘要**：定义多线叙事的三大核心问题（上下文切换成本、跨线一致性、读者体验断裂），归纳为 8 个设计问题 Q1-Q8。

### D.1.1 核心问题

多线叙事是网文中常见且强大的叙事技巧，广泛应用于玄幻、都市、悬疑、科幻等类型。然而，当叙事线数量从 2 条增加到 5 条甚至更多时，作者面临三大类核心问题：

1. **上下文切换成本高**：作者在不同叙事线之间切换时，需要重新回忆每条线的当前进展、角色状态、伏笔线索等信息，认知负荷急剧上升。
2. **跨线一致性维护困难**：多条线共享同一个世界观，时间、信息、角色状态需要保持一致，但人工维护极易出现矛盾。
3. **读者体验断裂**：叙事线切换不当会导致读者记忆负担过重、节奏断裂、视角混乱，严重影响阅读体验。

### D.1.2 三层子问题结构（10 个子问题）

我们将上述三大类问题进一步分解为 10 个具体子问题，形成三层结构：

#### 第一层：上下文管理（P1-P3）

| 编号 | 子问题 | 描述 | 典型场景 |
|------|--------|------|----------|
| P1 | 线索切换成本 | 从 A 线切换到 B 线时，需要重新加载 B 线的完整上下文 | 写完主角修炼线，切到配角支线时忘记配角上次做了什么 |
| P2 | 线索进度感知 | 难以快速了解每条线的写作进度和剧情推进状态 | "我这条支线写到哪了？上次写到第几章？" |
| P3 | 线索关系理解 | 难以把握多条线之间的逻辑关系和相互影响 | "这两条线什么时候交汇？有没有因果依赖？" |

#### 第二层：跨线一致性（P4-P7）

| 编号 | 子问题 | 描述 | 典型场景 |
|------|--------|------|----------|
| P4 | 时间一致性 | 多条线的时间流逝需要保持合理关系 | A 线过了 3 天，B 线却只过了 1 小时，读者感到混乱 |
| P5 | 信息一致性 | 角色在不同线中获得的信息需要正确追踪 | 角色在 A 线得知了秘密，切到 B 线时却"忘记"了 |
| P6 | 状态一致性 | 角色的物理/心理状态在不同线中需要保持一致 | 角色在 A 线受了重伤，B 线中却活蹦乱跳 |
| P7 | 伏笔跨线追踪 | 在一条线埋下的伏笔，需要在另一条线中回收 | A 线提到的重要道具，B 线中再也没有出现 |

#### 第三层：读者体验（P8-P10）

| 编号 | 子问题 | 描述 | 典型场景 |
|------|--------|------|----------|
| P8 | 节奏断裂 | 线切换时机不当导致叙事节奏被打断 | 正在高潮时突然切到另一条平淡的线 |
| P9 | 记忆负担 | 读者难以记住长时间未出现的线的内容 | 一条线停更了 30 章，读者完全忘了之前发生了什么 |
| P10 | 视角混乱 | 多线切换导致读者搞不清当前是谁的视角 | 频繁切换视角，读者迷失在角色之间 |

### D.1.3 五种多线类型分类（T1-T5）

不同的多线叙事模式带来不同的管理挑战。我们识别出 5 种基本类型：

| 编号 | 类型 | 描述 | 典型案例 | 核心挑战 |
|------|------|------|----------|------|
| T1 | 视角切换型 | 同一时间线，不同角色的视角交替 | 《冰与火之歌》POV 切换 | 角色状态一致性、信息隔离 |
| T2 | 空间并行型 | 不同地点同时发生的事件 | 多线同时进攻不同副本 | 时间同步、事件协调 |
| T3 | 时间交错型 | 不同时间线交替推进（闪回/闪前） | 过去与现在交替叙事 | 时间锚点管理、因果链 |
| T4 | 主次线型 | 一条主线+多条支线交替 | 主角修炼线+多条配角支线 | 支线遗忘、进度失衡 |
| T5 | 嵌套型 | 线中有线（如故事中的故事） | 梦境、游戏世界、书中书 | 层级管理、边界清晰度 |

**实际作品中通常是多种类型的组合**。例如，一部玄幻小说可能同时包含 T4（主线修炼+支线探险）和 T2（多条线在不同地点并行推进）。

### D.1.4 与 B1-B4 的交叉分析

在定义 B5 的独有问题之前，先分析哪些问题已被 B1-B4 覆盖：

<!-- 表格说明：B5 多线叙事与 B1-B4 的交叉分析，识别 B5 独有问题 -->
| 问题域 | B1 大纲 | B2 时间 | B3 伏笔 | B4 风格 | B5 独有？ |
|------|--------|------|--------|------|----------|
| 线索进度感知(P2) | 部分覆盖 | - | - | - | **是** ——B1 只管大纲，不管写作进度 |
| 线索关系理解(P3) | 部分覆盖 | - | - | - | **是** ——B1 只有静态关系，无动态依赖 |
| 时间一致性(P4) | - | 部分覆盖 | - | - | **是** ——B2 只管单线时间，不管跨线时间 |
| 信息一致性(P5) | - | - | - | - | **是** —— 完全空白 |
| 状态一致性(P6) | - | - | - | - | **是** —— 完全空白 |
| 伏笔跨线追踪(P7) | - | - | 部分覆盖 | - | **是** ——B3 只管单线伏笔 |
| 节奏断裂(P8) | - | - | - | - | ✅ B8 D3a 跨章断裂+D3b 跨卷断裂检测 |
| 记忆负担(P9) | - | - | - | - | **是** —— 完全空白 |
| 线索切换成本(P1) | - | - | - | - | **是** —— 完全空白 |
| 视角混乱(P10) | - | - | - | 部分覆盖 | **部分** ——B4 管视角风格，不管切换逻辑 |

**结论**：10 个子问题中，8 个是 B5 独有的，2 个（P2、P3）与 B1 有部分重叠但 B5 需要提供更细粒度的运行时支持。

### D.1.5 精简为 8 个核心问题（Q1-Q8）

将 10 个子问题进一步归纳为 8 个核心设计问题：

| 编号 | 核心问题 | 覆盖子问题 | 对应机制 |
|------|----------|------|----------|
| Q1 | 如何在切换叙事线时快速恢复上下文？ | P1 | M1 存档点 + M2 交接文档 |
| Q2 | 如何可视化多条线的进度和关系？ | P2, P3 | M11 仪表盘 + M6 依赖图 |
| Q3 | 如何保证跨线时间流逝的一致性？ | P4 | M4 全局时间轴 |
| Q4 | 如何追踪角色跨线的信息获取？ | P5 | M5 知识背包 |
| Q5 | 如何维护角色跨线的状态一致？ | P6 | M9 双层状态 |
| Q6 | 如何追踪伏笔的跨线埋设与回收？ | P7 | M10 伏笔跨线标签 |
| Q7 | 如何在合适的时机切换叙事线？ | P8, P10 | S1 节奏建议 + M3 AI 助手 |
| Q8 | 如何减轻读者对长时间未更新线的记忆负担？ | P9 | M2 读者前情提要 |

### D.1.6 终极目标

**让作者像管理单线叙事一样轻松地管理多线叙事。**

具体而言：
- 切换叙事线时，上下文恢复时间从"数分钟回忆"降低到"数秒浏览"。
- 跨线一致性错误率降低 90%以上。
- 读者在叙事线切换时的体验平滑度显著提升。
- 作者可以专注于创作本身，而非记忆管理。

---

## D.2 设计哲学

> 📋 **摘要**：确立线程隔离、按需同步、作者主权、渐进自动化四大设计原则，定义 L0-L2 三级自动化等级。

### D.2.1 线程隔离

**每条叙事线是一个独立的上下文空间。**

类比操作系统的进程隔离：每条线有自己的"内存空间"（剧情上下文）、"寄存器"（当前状态）、"程序计数器"（写作进度）。线与线之间默认不共享信息，只有在明确需要时才进行跨线同步。

这意味着：
- 写 A 线时，系统只加载 A 线的上下文，不会用 B 线的信息"污染"A 线的创作空间。
- 每条线的状态变更默认只影响本线，不会自动传播到其他线。
- 跨线信息流动是显式的、可追踪的。

### D.2.2 按需同步

**只在必要时跨线同步信息。**

不是所有跨线信息都需要实时同步。系统根据以下原则决定何时同步：

1. **作者主动触发**：作者明确要求查看或同步某条线的信息。
2. **一致性检查触发**：系统检测到潜在的不一致风险时，主动提醒。
3. **事件驱动触发**：某些关键事件（如角色死亡、重大剧情转折）自动触发跨线通知。

按需同步的核心优势是**降低认知负荷**——作者不需要同时关注所有线的信息，只需要在关键时刻获得必要的跨线信息。

### D.2.3 作者主权

**所有跨线操作由作者最终决定。**

系统可以检测问题、提供建议、自动生成内容，但**最终的决策权始终在作者手中**。具体体现为：

- 系统检测到时间不一致时，提供修复建议，但不自动修改。
- 系统建议切换叙事线时，作者可以忽略建议继续当前线。
- 系统生成的交接文档是草稿，作者可以编辑后再使用。
- 所有自动化的跨线操作都有"撤销"选项。

### D.2.4 渐进自动化

**从手动到全自动，逐步提升自动化程度。**

我们定义三个自动化等级：

| 等级 | 名称 | 描述 | 适用场景 |
|------|------|------|----------|
| L0 | 手动模式 | 所有操作由作者手动完成，系统只提供工具 | 新手作者、简单多线结构 |
| L1 | 半自动模式 | 系统自动检测问题并建议，作者确认后执行 | 有经验的作者、中等复杂度 |
| L2 | 全自动模式 | 系统自动执行常规操作，只在异常时请求作者介入 | 高级作者、复杂多线结构 |

**默认从 L0 开始，作者可以随时调整等级。** 每个机制都可以独立设置自动化等级，例如存档点可以设为 L2 全自动，而线切换建议保持 L1 半自动。

---

## D.3 六层架构

> 📋 **摘要**：定义展示层、Agent 层、AI 层、算法层、状态层、数据层、扩展层的七层架构，含层间交互原则和机制编号规则。

### D.3.1 架构总览

B5 采用六层架构设计，从下到上依次为：

```text
┌─────────────────────────────────────────────────────────────┐
│                     展示层 (Presentation)                     │
│                    M11 叙事线仪表盘                           │
├─────────────────────────────────────────────────────────────┤
│                     Agent层 (Agent)                          │
│           M3 叙事线AI助手  │  M12 跨线审核Agent               │
├─────────────────────────────────────────────────────────────┤
│                      AI层 (AI)                               │
│         M2 交接文档生成  │  S1 节奏建议引擎                    │
├─────────────────────────────────────────────────────────────┤
│                    算法层 (Algorithm)                         │
│    M4 全局时间轴  │  M6 依赖图  │  M8 线拓扑变更              │
├─────────────────────────────────────────────────────────────┤
│                     状态层 (State)                            │
│                   M7 叙事线生命周期                           │
├─────────────────────────────────────────────────────────────┤
│                     数据层 (Data)                             │
│        M1 存档点  │  M5 知识背包  │  M9 双层状态              │
├─────────────────────────────────────────────────────────────┤
│                     扩展层 (Extension)                        │
│    M10 伏笔跨线标签  │  S2 失败模式库  │  S3 预设             │
└─────────────────────────────────────────────────────────────┘
```

### D.3.2 各层职责

| 层级 | 职责 | Token 消耗 | 关键特性 |
|------|------|------|----------|
| 展示层 | 向作者展示多线状态的可视化界面 | 0 | 4 种视图模式、实时更新 |
| Agent 层 | 主动式 AI 助手，监控和干预写作流程 | 1000-2000/次 | 每条线一个 M3、全局一个 M12 |
| AI 层 | 按需调用的 AI 能力 | 500-1000/次 | 交接文档生成、节奏建议 |
| 算法层 | 确定性的计算和检查逻辑 | 0 | 时间对齐、依赖检测、拓扑变更 |
| 状态层 | 管理叙事线的生命周期状态 | 0 | 状态机、转换规则 |
| 数据层 | 存储和检索叙事线相关数据 | 0 | 存档点、知识背包、双层状态 |
| 扩展层 | 可选的增强功能 | 0-500/次 | 伏笔标签、失败模式、预设模板 |

### D.3.3 层间交互原则

1. **单向依赖**：上层可以调用下层，下层不能调用上层。
2. **跨层调用**：展示层可以直接调用数据层（读取数据），但修改操作必须经过 Agent 层或 AI 层。
3. **事件驱动**：状态层和算法层通过事件机制通知上层，避免轮询。
4. **降级友好**：任何一层失效时，下层可以独立运行（只是功能减少）。

### D.3.4 机制编号规则

- **M（Mechanism）**：核心机制，共 12 个（M1-M12）。
- **S（Supplementary）**：辅助机制，共 4 个（S1-S4）。
- 编号不连续是因为设计过程中进行了合并和精简（从最初的 56 个思路精简而来）。

---

## D.4 M1 叙事线存档点系统

> 📋 **摘要**：定义叙事线状态快照的数据结构和触发策略（线切换、章节完成、重大事件），支持快速上下文恢复。

### D.4.1 设计目标

解决**Q1（如何在切换叙事线时快速恢复上下文）**的核心数据基础设施。

存档点是叙事线在某个时刻的"快照"，记录了该线当时的所有关键信息。当作者从其他线切换回来时，系统自动加载最新的存档点，帮助作者快速恢复上下文。

### D.4.2 数据结构

```python
from dataclasses import dataclass, field
from typing import Optional
from datetime import datetime
import uuid


@dataclass
class CharacterSnapshot:
    """角色在某条线某个时刻的快照"""
    name: str                          # 角色名称
    location: str                      # 当前位置
    status: str                        # 生理状态（健康/受伤/中毒等）
    emotion: str                       # 情绪状态（愤怒/悲伤/平静等）


@dataclass
class NarrativeLineSavepoint:
    """
    叙事线存档点
    记录一条叙事线在某个时刻的完整状态快照
    """
    # === 基础标识 ===
    id: str = field(default_factory=lambda: str(uuid.uuid4()))  # 存档点唯一ID
    line_id: str = ""                  # 所属叙事线ID
    chapter_num: int = 0               # 所在章节号
    timestamp: datetime = field(default_factory=datetime.now)   # 创建时间戳

    # === 剧情摘要 ===
    plot_summary: str = ""             # 剧情摘要（200-500字）
    active_conflicts: list[str] = field(default_factory=list)   # 当前活跃的冲突列表
    recent_events: list[str] = field(default_factory=list)      # 最近发生的重要事件

    # === 角色状态 ===
    characters_present: list[CharacterSnapshot] = field(default_factory=list)
    # 当前场景中出现的角色及其状态

    # === 时间信息 ===
    story_time: str = ""               # 故事内时间（如"第三天清晨"）
    time_since_line_start: str = ""    # 距离该线开始的时间跨度

    # === 氛围与节奏 ===
    emotion_tone: str = ""             # 情感基调（紧张/温馨/悲伤等）
    pacing: str = ""                   # 当前节奏（slow/medium/buildup/fast/climax，B8统一5值枚举）

    # === 待办事项 ===
    pending_foreshadowing: list[str] = field(default_factory=list)
    # 该线中尚未回收的伏笔列表
    pending_tasks: list[str] = field(default_factory=list)
    # 该线中尚未完成的剧情任务列表
```

### D.4.3 触发策略

存档点的创建不是随意的，而是遵循明确的触发策略：

| 触发时机 | 优先级 | 自动/手动 | 描述 |
|------|--------|------|------|
| 线切换时 | 高 | 自动 | 作者从 A 线切换到 B 线时，自动为 A 线创建存档点 |
| 章节完成时 | 高 | 自动 | 一章写作完成时，自动为当前线创建存档点 |
| 重大事件后 | 中 | 半自动 | AI 检测到重大剧情事件后，建议创建存档点 |
| 手动保存 | 低 | 手动 | 作者随时可以手动创建存档点 |

**自动触发规则**：
- 线切换时：如果距离上次存档不超过 500 字，则跳过（避免过于频繁）。
- 章节完成时：始终创建，作为该章的"检查点"。
- 重大事件后：由 M3 AI 助手判断，需要作者确认。

### D.4.4 恢复机制

当作者切换到一条叙事线时，系统执行以下恢复流程：

```
1. 加载该线最新的存档点
2. 生成恢复摘要（格式见下方）
3. 将恢复摘要展示给作者
4. 作者确认后，开始写作
```

**恢复摘要示例**：

```
═══════════════════════════════════════
  叙事线「暗影密林」— 恢复摘要
  上次更新：第47章 · 3天前
═══════════════════════════════════════

【剧情摘要】
林风在暗影密林深处发现了上古阵法的遗迹，
正与守护兽进行激战。苏瑶在后方治疗伤员，
但药草即将耗尽。

【当前冲突】
• 与守护兽的战斗（进行中）
• 药草短缺危机（紧急）

【在场角色】
• 林风 — 密林深处 / 轻伤 / 坚决
• 苏瑶 — 密林入口 / 疲惫 / 焦虑

【故事时间】第三天黄昏
【情感基调】紧张
【叙事节奏】快

【待回收伏笔】
• 第42章提到的"密林深处的光球"尚未解释

【待完成任务】
• 击败守护兽
• 找到阵法核心
═══════════════════════════════════════
```

### D.4.5 SQL Schema

```sql
-- 叙事线存档点表
CREATE TABLE line_savepoints (
    -- === 主键与标识 ===
    id UUID PRIMARY KEY,                          -- 存档点唯一ID
    line_id UUID REFERENCES narrative_lines(id),   -- 所属叙事线ID
    -- === 存档数据 ===
    chapter_num INT NOT NULL,                      -- 所在章节号（整数编号，与chapters表的序列号对应；不使用UUID，便于按章节顺序排序和范围查询）
    plot_summary TEXT,                             -- 剧情摘要
    active_conflicts JSONB,                        -- 当前活跃冲突（JSON数组）
    recent_events JSONB,                           -- 最近重要事件（JSON数组）
    characters_present JSONB,                      -- 在场角色快照（JSON数组）
    story_time VARCHAR(50),                        -- 故事内时间
    time_since_line_start VARCHAR(50),             -- 距线开始的时间跨度
    emotion_tone VARCHAR(20),                      -- 情感基调
    pacing VARCHAR(10) NOT NULL CHECK (pacing IN ('slow','medium','buildup','fast','climax')), -- 叙事节奏（5级枚举）
    pending_foreshadowing JSONB,                   -- 待回收伏笔（JSON数组）
    pending_tasks JSONB,                           -- 待完成任务（JSON数组）
    -- === 审计字段 ===
    created_at TIMESTAMP DEFAULT NOW()             -- 创建时间
);
-- ER关系：本表通过 narrative_line_id 关联到 narrative_lines(id)

-- 索引：按线和章节快速查询最新存档点
CREATE INDEX idx_savepoints_line_chapter
    ON line_savepoints(line_id, chapter_num DESC);

-- 索引：按线查询最新存档点
CREATE INDEX idx_savepoints_line_latest
    ON line_savepoints(line_id, created_at DESC);
```

---

## D.5 M2 交接文档自动生成

> 📋 **摘要**：面向作者和读者两种受众自动生成交接文档，长度根据间隔章节数和复杂度动态调整。

### D.5.1 设计目标

解决**Q1（上下文恢复）**和**Q8（读者记忆负担）**。

交接文档是存档点（M1）的自然语言版本，面向不同受众有两种模式：

### D.5.2 两种模式

| 模式 | 受众 | 长度 | 用途 |
|------|------|------|------|
| 作者交接文档 | 作者本人 | 300-500 字 | 切换线时快速恢复上下文 |
| 读者前情提要 | 读者 | 50-300 字 | 插入正文，帮助读者回忆之前的内容 |

### D.5.3 动态长度调整

交接文档的长度不是固定的，而是根据"间隔"动态调整：

```python
def calculate_recap_length(
    chapters_since_last_update: int,   # 距上次更新间隔的章节数
    total_chapters_in_line: int,       # 该线总章节数
    complexity_score: float,           # 该线的复杂度评分（0-1）
    mode: str = "author"               # "author" 或 "reader"
) -> int:
    """
    动态计算交接文档的目标长度

    核心逻辑：
    - 间隔越长，文档越长（读者遗忘更多）
    - 线越复杂，文档越长（需要更多上下文）
    - 作者模式比读者模式更长（作者需要更多细节）
    """
    # 基础长度
    if mode == "author":
        base_length = 300
        max_length = 500
    else:  # reader模式
        base_length = 50
        max_length = 300

    # 间隔因子：每间隔5章增加10%长度
    interval_factor = 1.0 + (chapters_since_last_update / 5) * 0.1

    # 复杂度因子：复杂度每增加0.1，长度增加5%
    complexity_factor = 1.0 + complexity_score * 0.5

    # 计算最终长度，不超过上限
    target_length = int(base_length * interval_factor * complexity_factor)
    return min(target_length, max_length)
```

**长度调整示例**：

| 间隔章数 | 复杂度 | 作者模式 | 读者模式 |
|------|--------|------|----------|
| 1-2 章 | 0.3 | 300 字 | 50 字 |
| 5 章 | 0.5 | 375 字 | 75 字 |
| 10 章 | 0.7 | 472 字 | 150 字 |
| 20 章 | 0.9 | 500 字（上限） | 270 字 |
| 30 章+ | 0.9 | 500 字（上限） | 300 字（上限） |

### D.5.4 读者前情提要的插入规则

读者前情提要需要插入到正文中的合适位置，遵循以下规则：

1. **插入位置**：在该线的最新章节开头，作为"前情提要"段落。
2. **触发条件**：当该线距离上次更新超过 N 章时自动生成（N 可配置，默认 5 章）。
3. **格式规范**：
   - 使用特殊的标记格式，与正文区分。
   - 可以被读者折叠/展开（在阅读器中）。
   - 不计入正文字数统计。
4. **内容选择**：
   - 优先包含与当前章节直接相关的信息。
   - 省略读者已经熟悉的基础设定。
   - 突出关键悬念和待解决的冲突。

**读者前情提要示例**：

```
【前情提要·暗影密林线】
林风在密林深处发现了上古阵法遗迹，正与守护兽激战。
苏瑶负责后方治疗，但药草即将耗尽。
密林深处还有一个神秘的光球尚未探索……
```

---

## D.6 M3 叙事线 AI 助手

> 📋 **摘要**：为每条叙事线配备专属 AI 助手，承担状态守护、切换汇报、离开记录、遗忘预警和推进建议五大职责。

### D.6.1 设计目标

M3 是每条叙事线配备的"专属 AI 助手"，负责该线的日常管理和维护。它是 B5 中与作者交互最频繁的组件。

### D.6.2 五大职责

| 职责 | 描述 | 触发条件 | 自动化等级 |
|------|------|------|------------|
| 状态守护 | 监控该线的状态变化，确保关键信息被正确记录 | 持续运行 | L1 |
| 切换汇报 | 作者切换到该线时，汇报当前状态 | 线切换时 | L2 |
| 离开记录 | 作者离开该线时，记录离开时的状态 | 线切换时 | L2 |
| 遗忘预警 | 当该线长时间未更新时，提醒作者 | 定时检查 | L1 |
| 推进建议 | 根据该线的当前状态，建议下一步剧情方向 | 作者请求或定时 | L0 |

### D.6.3 与 M12 的关系

M3 和 M12 是 B5 的两个 Agent，但职责不同：

| 维度 | M3 叙事线 AI 助手 | M12 跨线审核 Agent |
|------|-----------------|------|
| 数量 | 每条线一个 | 全局一个 |
| 类型 | 主动型（主动守护和提醒） | 审核型（被动检查和报告） |
| 范围 | 只关注单条线 | 关注所有线的交叉点 |
| 类比 | 线的"贴身管家" | 全局的"质检员" |

**交互模式**：
- M3 检测到潜在问题时，先尝试在单线范围内解决。
- 如果问题涉及跨线（如时间不一致），M3 将问题上报给 M12。
- M12 审核完成后，将结果反馈给相关线的 M3。

### D.6.4 M3 工作流示例

```
作者从A线切换到B线：

1. M3(A线) 触发"离开记录"
   → 记录A线当前状态
   → 创建存档点（M1）
   → 生成交接文档（M2）

2. M3(B线) 触发"切换汇报"
   → 加载B线最新存档点
   → 生成恢复摘要
   → 检查B线是否有长时间未处理的任务
   → 向作者汇报

3. M12 触发"跨线检查"（异步）
   → 检查A线离开时的状态是否与B线有冲突
   → 如有冲突，通知M3(B线)
```

---

## D.7 M4 全局时间轴引擎

> 📋 **摘要**：建立所有叙事线共享的绝对时间参考系，通过时间锚点和时间对齐检查保证跨线时间流逝一致。

### D.7.1 设计目标

解决**Q3（如何保证跨线时间流逝的一致性）**。

全局时间轴是所有叙事线共享的"绝对时间参考系"。每条线有自己的"叙事时间流速"，但所有线的时间都可以映射到同一个绝对时间轴上。

### D.7.2 数据结构

```python
# --- 摘要：TimeCursor + GlobalTimeline —— 全局时间轴数据结构，支持叙事时间流速和绝对时间锚点 ---
from dataclasses import dataclass, field
from typing import Optional
import uuid


@dataclass
class TimeCursor:
    """
    时间游标：表示一条线在全局时间轴上的当前位置
    """
    line_id: str = ""                          # 所属叙事线ID
    narrative_time: str = ""                   # 叙事时间描述（如"第三天黄昏"）
    absolute_time: str = ""                    # 绝对时间（如"纪元3024年3月15日 18:00"）
    time_flow_rate: float = 1.0                # 时间流速（1.0=正常，0.5=慢放，2.0=快进）
    last_updated_chapter: int = 0              # 最后更新的章节号


@dataclass
class TimelineEvent:
    """
    时间轴事件：标记一个在时间轴上有意义的事件
    """
    id: str = field(default_factory=lambda: str(uuid.uuid4()))  # 事件唯一ID
    line_id: str = ""                          # 所属叙事线ID
    chapter_num: int = 0                       # 所在章节号
    event_description: str = ""                # 事件描述
    narrative_time: str = ""                   # 叙事时间
    absolute_time: str = ""                    # 绝对时间
    duration: str = ""                         # 持续时间（如"2小时"）
    is_time_anchor: bool = False               # 是否为时间锚点
    characters_involved: list[str] = field(default_factory=list)
    # 涉及的角色列表


@dataclass
class GlobalTimeline:
    """
    全局时间轴：管理所有叙事线的时间关系
    """
    events: list[TimelineEvent] = field(default_factory=list)
    cursors: dict[str, TimeCursor] = field(default_factory=dict)
    # line_id -> TimeCursor 的映射

    def add_event(self, event: TimelineEvent) -> None:
        """添加一个时间事件"""
        self.events.append(event)
        # 按绝对时间排序
        self.events.sort(key=lambda e: e.absolute_time)

    def get_line_cursor(self, line_id: str) -> Optional[TimeCursor]:
        """获取某条线的时间游标"""
        return self.cursors.get(line_id)

    def get_events_in_range(
        self,
        start_absolute_time: str,
        end_absolute_time: str
    ) -> list[TimelineEvent]:
        """获取指定时间范围内的事件"""
        return [
            e for e in self.events
            if start_absolute_time <= e.absolute_time <= end_absolute_time
        ]
```

### D.7.3 时间锚点

**时间锚点（Time Anchor）** 是全局时间轴上的关键标记点，用于同步多条线的时间。

- 时间锚点通常是"不可更改的客观事件"，如"日食发生"、"战争爆发"。
- 所有线的时间都可以相对于最近的时间锚点来校准。
- 当两条线在同一个时间锚点附近交汇时，系统会自动检查时间一致性。

### D.7.4 时间对齐检查

```python
# --- 摘要：check_time_consistency() —— 检查两条叙事线之间的时间一致性（锚点校准/流速验证/顺序检查） ---
def check_time_consistency(
    timeline: GlobalTimeline,
    line_a_id: str,
    line_b_id: str
) -> list[dict]:
    """
    检查两条线之间的时间一致性

    返回不一致问题列表，每个问题包含：
    - type: 问题类型
    - description: 问题描述
    - severity: 严重程度（warning/error）
    """
    issues = []
    cursor_a = timeline.get_line_cursor(line_a_id)
    cursor_b = timeline.get_line_cursor(line_b_id)

    if not cursor_a or not cursor_b:
        return issues

    # 检查项1：绝对时间是否合理
    # 如果两条线有共同的绝对时间参考，检查时间差是否合理
    if cursor_a.absolute_time and cursor_b.absolute_time:
        # 这里简化处理，实际需要解析时间字符串
        # 检查两条线的时间流速差异是否过大
        rate_diff = abs(cursor_a.time_flow_rate - cursor_b.time_flow_rate)
        if rate_diff > 5.0:
            issues.append({
                "type": "time_flow_mismatch",
                "description": (
                    f"线{line_a_id}和线{line_b_id}的时间流速差异过大："
                    f"{cursor_a.time_flow_rate} vs {cursor_b.time_flow_rate}"
                ),
                "severity": "warning"
            })

    # 检查项2：时间锚点是否对齐
    # 查找两条线共同经过的时间锚点
    anchors_a = [
        e for e in timeline.events
        if e.line_id == line_a_id and e.is_time_anchor
    ]
    anchors_b = [
        e for e in timeline.events
        if e.line_id == line_b_id and e.is_time_anchor
    ]
    # 如果两条线都经过了同一个锚点事件，检查描述是否一致
    common_anchors = set(a.event_description for a in anchors_a) & \
                     set(b.event_description for b in anchors_b)
    for anchor_desc in common_anchors:
        anchor_a = next(a for a in anchors_a if a.event_description == anchor_desc)
        anchor_b = next(b for b in anchors_b if b.event_description == anchor_desc)
        if anchor_a.absolute_time != anchor_b.absolute_time:
            issues.append({
                "type": "anchor_mismatch",
                "description": (
                    f"时间锚点'{anchor_desc}'在两条线中的绝对时间不一致："
                    f"线{line_a_id}={anchor_a.absolute_time}, "
                    f"线{line_b_id}={anchor_b.absolute_time}"
                ),
                "severity": "error"
            })

    # 检查项3：角色是否可能同时出现在两个位置
    # 查找两条线中共同出现的角色
    events_a_chars = set()
    for e in timeline.events:
        if e.line_id == line_a_id:
            events_a_chars.update(e.characters_involved)
    events_b_chars = set()
    for e in timeline.events:
        if e.line_id == line_b_id:
            events_b_chars.update(e.characters_involved)
    common_chars = events_a_chars & events_b_chars
    if common_chars:
        # 检查这些角色在两条线中的时间是否重叠
        # 如果重叠，说明角色同时出现在两条线中（可能是合理的，也可能不是）
        issues.append({
            "type": "character_time_overlap",
            "description": (
                f"角色{common_chars}同时出现在线{line_a_id}和线{line_b_id}中，"
                f"请确认时间是否合理"
            ),
            "severity": "warning"
        })

    return issues
```

### D.7.5 SQL Schema

```sql
-- 时间轴事件表
CREATE TABLE timeline_events (
    id UUID PRIMARY KEY,                          -- 事件唯一ID
    line_id UUID REFERENCES narrative_lines(id),   -- 所属叙事线ID
    chapter_num INT NOT NULL,                      -- 所在章节号
    event_description TEXT,                        -- 事件描述
    narrative_time VARCHAR(50),                    -- 叙事时间
    absolute_time VARCHAR(50),                     -- 绝对时间
    -- 注意：实际实现应增加 sort_order INT 字段用于范围查询，VARCHAR排序不可靠
    duration VARCHAR(50),                          -- 持续时间
    is_time_anchor BOOLEAN DEFAULT FALSE,          -- 是否为时间锚点
    characters_involved JSONB,                     -- 涉及角色（JSON数组）
    created_at TIMESTAMP DEFAULT NOW()             -- 创建时间
);
-- ER关系：本表通过 narrative_line_id 关联到 narrative_lines(id)

-- 索引：按线查询事件
CREATE INDEX idx_timeline_events_line
    ON timeline_events(line_id, chapter_num);

-- 索引：按绝对时间查询
CREATE INDEX idx_timeline_events_absolute_time
    ON timeline_events(absolute_time);

-- 索引：快速查找时间锚点
CREATE INDEX idx_timeline_events_anchors
    ON timeline_events(is_time_anchor) WHERE is_time_anchor = TRUE;
```

---

## D.8 M5 角色知识背包

> 📋 **摘要**：为每个角色在每条线中维护信息清单，追踪知识获取来源，检测跨线信息泄漏风险。

### D.8.1 设计目标

解决**Q4（如何追踪角色跨线的信息获取）**。

知识背包是每个角色在每条线中携带的"信息清单"。它记录了角色在何时、通过什么方式、从谁那里获得了什么信息。当角色跨线出现时，系统可以检查角色是否"知道"某个信息，避免信息泄漏。

### D.8.2 数据结构

```python
# --- 摘要：KnowledgeItem + KnowledgePack —— 知识背包数据结构，追踪角色跨线的信息获取和来源 ---
from dataclasses import dataclass, field
from typing import Optional
import uuid


@dataclass
class KnowledgeItem:
    """
    知识条目：角色知道的一条信息
    """
    content: str = ""                     # 知识内容描述
    category: str = "general"             # 分类：general/secret/combat/social/lore
    acquired_via: str = "witnessed"       # 获取方式：witnessed/told/inferred/found/other
    confidence: float = 1.0               # 确信度（0-1，1=完全确定）
    is_shared: bool = False               # 是否已告知其他角色


@dataclass
class KnowledgeAcquisition:
    """
    知识获取记录：记录角色获取知识的具体过程
    """
    knowledge_content: str = ""           # 知识内容
    acquired_chapter: int = 0             # 获取时的章节号
    source_character: str = ""            # 信息来源角色（空=环境/物品）
    acquired_via: str = "witnessed"       # 获取方式
    line_id: str = ""                     # 获取时所在的叙事线
    confidence: float = 1.0               # 确信度


@dataclass
class KnowledgePack:
    """
    角色知识背包：一个角色在一条线中的所有知识
    """
    character_id: str = ""                # 角色ID
    line_id: str = ""                     # 叙事线ID
    items: list[KnowledgeItem] = field(default_factory=list)
    acquisition_history: list[KnowledgeAcquisition] = field(default_factory=list)

    def add_knowledge(self, acquisition: KnowledgeAcquisition) -> None:
        """添加一条新知识"""
        # 检查是否已经知道这条信息
        existing = [
            item for item in self.items
            if item.content == acquisition.knowledge_content
        ]
        if existing:
            # 已知信息，更新确信度
            existing[0].confidence = max(
                existing[0].confidence, acquisition.confidence
            )
        else:
            # 新信息，添加到背包
            self.items.append(KnowledgeItem(
                content=acquisition.knowledge_content,
                category=self._infer_category(acquisition.knowledge_content),
                acquired_via=acquisition.acquired_via,
                confidence=acquisition.confidence,
                is_shared=False
            ))
        self.acquisition_history.append(acquisition)

    def knows(self, content: str, min_confidence: float = 0.5) -> bool:
        """检查角色是否知道某条信息"""
        for item in self.items:
            if item.content == content and item.confidence >= min_confidence:
                return True
        return False

    def _infer_category(self, content: str) -> str:
        """根据内容推断知识分类"""
        # 简化处理，实际可以使用AI分类
        keywords_map = {
            "secret": ["秘密", "阴谋", "隐藏", "暗中"],
            "combat": ["战斗", "功法", "武技", "修炼"],
            "social": ["关系", "身份", "背景", "势力"],
            "lore": ["历史", "传说", "遗迹", "上古"]
        }
        for category, keywords in keywords_map.items():
            for keyword in keywords:
                if keyword in content:
                    return category
        return "general"
```

### D.8.3 信息泄漏检测

```python
# --- 摘要：check_knowledge_leak() —— 信息泄漏检测，检查角色在目标线中是否不应该知道某条信息 ---
def check_knowledge_leak(
    character_id: str,
    target_line_id: str,
    knowledge_content: str,
    all_knowledge_packs: dict[str, KnowledgePack]
) -> dict:
    """
    检查角色在目标线中是否"不应该知道"某条信息

    参数：
    - character_id: 角色ID
    - target_line_id: 目标叙事线ID
    - knowledge_content: 要检查的知识内容
    - all_knowledge_packs: 所有角色的知识背包字典

    返回：
    - is_leak: 是否为信息泄漏
    - detail: 泄漏详情
    """
    # 构建该角色的跨线知识合集
    character_total_knowledge = set()
    for pack_key, pack in all_knowledge_packs.items():
        if pack.character_id == character_id:
            for item in pack.items:
                if item.confidence >= 0.5:
                    character_total_knowledge.add(item.content)

    # 检查角色是否知道这条信息
    knows_it = knowledge_content in character_total_knowledge

    # 检查角色在目标线中是否有这条知识的记录
    target_pack_key = f"{character_id}_{target_line_id}"
    target_pack = all_knowledge_packs.get(target_pack_key)
    knows_in_target_line = False
    if target_pack:
        knows_in_target_line = target_pack.knows(knowledge_content)

    if knows_it and not knows_in_target_line:
        return {
            "is_leak": True,
            "detail": (
                f"角色{character_id}在其他线中已经知道'{knowledge_content}'，"
                f"但在目标线{target_line_id}中没有获取记录。"
                f"如果角色在目标线中使用了这条信息，可能构成信息泄漏。"
            )
        }

    return {
        "is_leak": False,
        "detail": "未检测到信息泄漏风险"
    }
```

### D.8.4 SQL Schema

```sql
-- 角色知识背包表
CREATE TABLE character_knowledge_packs (
    -- === 主键与标识 ===
    id UUID PRIMARY KEY,                          -- 记录唯一ID
    character_id UUID REFERENCES unified_entities(id),  -- characters已迁移；角色ID
    line_id UUID REFERENCES narrative_lines(id),   -- 叙事线ID
    knowledge_content TEXT NOT NULL,               -- 知识内容
    category VARCHAR(20) NOT NULL,                 -- 分类
    acquired_via VARCHAR(20) NOT NULL,             -- 获取方式
    acquired_chapter INT NOT NULL,                 -- 获取时的章节号
    source_character UUID REFERENCES unified_entities(id),  -- characters已迁移；信息来源角色
    confidence FLOAT DEFAULT 1.0,                  -- 确信度
    is_shared BOOLEAN DEFAULT FALSE,               -- 是否已告知他人
    -- === 审计字段 ===
    created_at TIMESTAMP DEFAULT NOW()             -- 创建时间
);
-- ER关系：本表通过 character_id 关联到 unified_entities(id)；通过 narrative_line_id 关联到 narrative_lines(id)

-- 索引：按角色和线查询知识
CREATE INDEX idx_knowledge_pack_character_line
    ON character_knowledge_packs(character_id, line_id);

-- 索引：按知识内容搜索
CREATE INDEX idx_knowledge_pack_content
    ON character_knowledge_packs USING gin(
        to_tsvector('simple', knowledge_content)
    );

-- 唯一约束：同一角色在同一线上不重复记录相同知识
CREATE UNIQUE INDEX idx_knowledge_pack_unique
    ON character_knowledge_packs(character_id, line_id, knowledge_content);
```

---

## D.9 M6 叙事线依赖图

> 📋 **摘要**：描述多条叙事线之间的时间、因果、信息、互斥四类依赖关系，含循环依赖 DFS 检测算法。

### D.9.1 设计目标

解决**Q2（如何可视化多条线的进度和关系）**中的"关系理解"部分。

依赖图描述了多条叙事线之间的逻辑依赖关系。当一条线的变化可能影响另一条线时，依赖图会记录这种关系，并在适当的时候发出提醒。

### D.9.2 数据结构

```python
from dataclasses import dataclass, field
from typing import Optional
import uuid


@dataclass
class LineDependency:
    """
    叙事线依赖关系
    表示 from_line 对 to_line 存在某种依赖
    """
    id: str = field(default_factory=lambda: str(uuid.uuid4()))  # 依赖关系唯一ID
    from_line: str = ""                    # 源线ID（依赖方）
    to_line: str = ""                      # 目标线ID（被依赖方）
    dependency_type: str = "temporal"      # 依赖类型
    description: str = ""                  # 依赖描述
    condition: str = ""                    # 满足条件描述
    is_satisfied: bool = False             # 是否已满足
    created_at_chapter: int = 0            # 创建时的章节号
    satisfied_at_chapter: Optional[int] = None  # 满足时的章节号
```

### D.9.3 四种依赖类型

| 类型 | 代码 | 描述 | 示例 |
|------|------|------|------|
| 时间依赖 | `temporal` | A 线的时间必须在 B 线之后 | B 线先发生，A 线是 B 线的结果 |
| 因果依赖 | `causal` | A 线的事件是 B 线事件的原因 | A 线中角色做了某事，导致 B 线中发生了某事 |
| 信息依赖 | `information` | A 线需要 B 线中的信息才能推进 | A 线中的角色需要 B 线中发现的线索 |
| 互斥依赖 | `exclusive` | A 线和 B 线不能同时处于活跃状态 | 两条线描述的是同一事件的不同版本 |

### D.9.4 循环依赖检测

```python
def detect_circular_dependencies(
    dependencies: list[LineDependency]
) -> list[list[str]]:
    """
    使用DFS检测依赖图中的循环依赖

    返回所有循环路径，每个路径是一个线ID列表
    """
    # 构建邻接表
    graph: dict[str, list[str]] = {}
    for dep in dependencies:
        if dep.from_line not in graph:
            graph[dep.from_line] = []
        graph[dep.from_line].append(dep.to_line)

    cycles: list[list[str]] = []
    visited: set[str] = set()
    rec_stack: set[str] = set()
    path: list[str] = []

    def dfs(node: str) -> None:
        """深度优先搜索遍历"""
        visited.add(node)
        rec_stack.add(node)
        path.append(node)

        # 遍历所有邻居
        for neighbor in graph.get(node, []):
            if neighbor not in visited:
                dfs(neighbor)
            elif neighbor in rec_stack:
                # 发现循环！提取循环路径
                cycle_start = path.index(neighbor)
                cycle = path[cycle_start:] + [neighbor]
                cycles.append(cycle)

        path.pop()
        rec_stack.remove(node)

    # 对所有节点执行DFS
    for node in graph:
        if node not in visited:
            dfs(node)

    return cycles
```

### D.9.5 SQL Schema

```sql
-- 叙事线依赖关系表
CREATE TABLE line_dependencies (
    id UUID PRIMARY KEY,                          -- 依赖关系唯一ID
    from_line UUID REFERENCES narrative_lines(id), -- 源线ID（依赖方）
    to_line UUID REFERENCES narrative_lines(id),   -- 目标线ID（被依赖方）
    dependency_type VARCHAR(20) NOT NULL,          -- 依赖类型
    description TEXT,                              -- 依赖描述
    condition TEXT,                                -- 满足条件
    is_satisfied BOOLEAN DEFAULT FALSE,            -- 是否已满足
    created_at_chapter INT,                        -- 创建时的章节号
    satisfied_at_chapter INT,                      -- 满足时的章节号
    created_at TIMESTAMP DEFAULT NOW()             -- 创建时间
);
-- ER关系：本表通过 source_line_id/target_line_id 关联到 narrative_lines(id)

-- 索引：按源线查询依赖
CREATE INDEX idx_dependencies_from
    ON line_dependencies(from_line);

-- 索引：按目标线查询被依赖
CREATE INDEX idx_dependencies_to
    ON line_dependencies(to_line);

-- 索引：查询未满足的依赖
CREATE INDEX idx_dependencies_unsatisfied
    ON line_dependencies(is_satisfied) WHERE is_satisfied = FALSE;
```

---

## D.10 M7 叙事线生命周期

> 📋 **摘要**：定义叙事线从创建到结束的 6 种状态（created/active/paused/converging/ended/interrupted）及转换规则。

### D.10.1 设计目标

为每条叙事线定义清晰的生命周期状态，使系统可以根据线的状态自动调整行为。

### D.10.2 状态机

```text
                    ┌──────────┐
                    │ created  │
                    │ (已创建)  │
                    └────┬─────┘
                         │ 开始写作
                         ▼
                    ┌──────────┐
              ┌────▶│  active  │◀────┐
              │     │ (活跃中)  │     │
              │     └────┬─────┘     │
              │          │           │
              │    暂停写作     恢复写作
              │          │           │
              │          ▼           │
              │     ┌──────────┐     │
              │     │  paused  │─────┘
              │     │ (已暂停)  │
              │     └────┬─────┘
              │          │
              │     放弃/删除
              │          ▼
              │     ┌─────────────┐
              │     │ interrupted │
              │     │ (已中断)     │
              │     └─────────────┘
              │
              │    准备收束
              │          │
              │          ▼
              │     ┌───────────┐
              │     │converging │
              │     │ (收束中)   │
              │     └─────┬─────┘
              │           │ 收束完成
              │           ▼
              │     ┌──────────┐
              └─────│  ended   │
                    │ (已结束)  │
                    └──────────┘
```

### D.10.3 状态定义

| 状态 | 代码 | 描述 | 允许的操作 |
|------|------|------|------------|
| 已创建 | `created` | 线已创建但尚未开始写作 | 编辑线设定、删除、开始写作 |
| 活跃中 | `active` | 线正在写作中 | 写作、暂停、准备收束 |
| 已暂停 | `paused` | 线暂时停止写作 | 恢复写作、放弃 |
| 收束中 | `converging` | 线正在准备与其他线交汇 | 写作收束内容、完成收束 |
| 已结束 | `ended` | 线已完成，不再更新 | 查看历史、引用 |
| 已中断 | `interrupted` | 线被放弃，不再继续 | 查看历史、重新激活（需作者确认） |

### D.10.4 状态转换规则

| 当前状态 | 目标状态 | 触发条件 | 自动/手动 | 系统动作 |
|------|----------|------|-----------|------|
| created | active | 作者开始写该线的第一章 | 手动 | 初始化存档点、时间游标 |
| active | paused | 作者切换到其他线且超过 N 章未回来 | 自动(L1) | 创建存档点、启动遗忘计时器 |
| active | converging | 作者标记该线准备收束 | 手动 | 检查依赖关系、生成交汇建议 |
| active | interrupted | 作者主动放弃该线 | 手动 | 标记未完成的伏笔和任务 |
| paused | active | 作者切换回该线 | 手动 | 加载存档点、生成恢复摘要 |
| paused | interrupted | 暂停超过 M 章（M 可配置，默认 50） | 自动(L1) | 通知作者、标记为可能废弃 |
| converging | ended | 收束内容写作完成 | 手动 | 标记所有依赖为已满足 |
| interrupted | active | 作者决定重新激活 | 手动 | 重新初始化状态、检查一致性 |

### D.10.5 SQL Schema

```sql
-- 叙事线主表
CREATE TABLE narrative_lines (
    -- === 主键与标识 ===
    id UUID PRIMARY KEY,                          -- 叙事线唯一ID
    work_id UUID REFERENCES works(id),            -- 所属作品ID
    name VARCHAR(100) NOT NULL,                   -- 线名称
    -- === 线定义 ===
    description TEXT,                             -- 线描述
    line_type VARCHAR(20) NOT NULL,               -- 线类型（T1-T5）
    status VARCHAR(20) NOT NULL DEFAULT 'created', -- 生命周期状态
    main_character_id UUID REFERENCES unified_entities(id),  -- characters已迁移；主角ID（可选）
    color VARCHAR(7) DEFAULT '#3B82F6',           -- 显示颜色（十六进制）
    weight FLOAT DEFAULT 0,                        -- 叙事线权重（用于节奏计算）
    sort_order INT DEFAULT 0,                     -- 排序顺序
    created_at TIMESTAMP DEFAULT NOW(),           -- 创建时间
    updated_at TIMESTAMP DEFAULT NOW(),           -- 更新时间
    ended_at TIMESTAMP                            -- 结束时间
);
-- ER关系：本表通过 work_id 关联到 works(id)；被 entity_line_states(narrative_line_id)、line_savepoints(narrative_line_id) 等关联

-- 索引：按作品查询叙事线
CREATE INDEX idx_narrative_lines_work
    ON narrative_lines(work_id, sort_order);

-- 索引：按状态查询
CREATE INDEX idx_narrative_lines_status
    ON narrative_lines(status);
```

---

## D.11 M8 线拓扑变更

> 📋 **摘要**：管理叙事线的交汇、分叉、合并、冲突解决四种拓扑操作，含完整的状态检查和依赖转移逻辑。

### D.11.1 设计目标

管理叙事线之间拓扑关系的变化——交汇、分叉、合并、冲突解决。

### D.11.2 四种拓扑操作

| 操作 | 描述 | 触发条件 | 复杂度 |
|------|------|------|--------|
| 交汇(converge) | 两条或多条线在某个节点汇合 | 剧情需要 | 高 |
| 分叉(diverge) | 一条线分裂为多条线 | 剧情分支 | 中 |
| 合并(merge) | 一条线被并入另一条线 | 线不再需要独立存在 | 中 |
| 冲突解决(resolve) | 解决两条线之间的矛盾 | 检测到不一致 | 高 |

### D.11.3 交汇操作

```python
# --- 摘要：converge_lines() —— 叙事线交汇操作，将多条线汇聚到同一章节并更新存档点 ---
def converge_lines(
    line_ids: list[str],
    convergence_chapter: int,
    convergence_description: str
) -> dict:
    """
    将多条叙事线交汇到一起

    参数：
    - line_ids: 要交汇的线ID列表
    - convergence_chapter: 交汇发生的章节号
    - convergence_description: 交汇描述

    返回：
    - new_line_id: 交汇后生成的新线ID（可选）
    - merged_savepoint: 合并后的存档点
    - warnings: 警告信息列表
    """
    warnings = []

    # 1. 检查所有线的状态是否允许交汇
    for line_id in line_ids:
        # 只有active和converging状态的线可以交汇
        line_status = get_line_status(line_id)  # 假设的数据库查询函数
        if line_status not in ("active", "converging"):
            warnings.append(
                f"线{line_id}当前状态为{line_status}，不建议交汇"
            )

    # 2. 检查时间一致性
    for i in range(len(line_ids)):
        for j in range(i + 1, len(line_ids)):
            issues = check_time_consistency(
                get_global_timeline(),  # 假设的全局时间轴
                line_ids[i],
                line_ids[j]
            )
            warnings.extend([
                f"线{line_ids[i]}与线{line_ids[j]}：{issue['description']}"
                for issue in issues
            ])

    # 3. 合并各线的存档点
    merged_savepoint = merge_savepoints(
        [get_latest_savepoint(lid) for lid in line_ids]
    )

    # 4. 更新各线状态为converging
    for line_id in line_ids:
        update_line_status(line_id, "converging")

    # 5. 记录交汇事件
    record_convergence_event(
        line_ids=line_ids,
        chapter=convergence_chapter,
        description=convergence_description
    )

    return {
        "new_line_id": None,  # 交汇不一定要创建新线
        "merged_savepoint": merged_savepoint,
        "warnings": warnings
    }
```

### D.11.4 分叉操作

```python
def diverge_line(
    source_line_id: str,
    new_line_name: str,
    divergence_chapter: int,
    divergence_description: str
) -> dict:
    """
    从一条线分叉出新的叙事线

    参数：
    - source_line_id: 源线ID
    - new_line_name: 新线名称
    - divergence_chapter: 分叉发生的章节号
    - divergence_description: 分叉描述

    返回：
    - new_line_id: 新线的ID
    - inherited_savepoint: 从源线继承的存档点
    """
    # 1. 获取源线在分叉点的存档点
    source_savepoint = get_savepoint_at_chapter(
        source_line_id, divergence_chapter
    )

    # 2. 创建新线
    new_line_id = create_narrative_line(
        name=new_line_name,
        description=divergence_description,
        parent_line_id=source_line_id
    )

    # 3. 将源线的存档点复制到新线（作为起点）
    inherited_savepoint = copy_savepoint(
        source_savepoint,
        new_line_id=new_line_id
    )

    # 4. 创建依赖关系：新线时间依赖于源线
    create_dependency(
        from_line=new_line_id,
        to_line=source_line_id,
        dependency_type="temporal",
        description=f"从线{source_line_id}在第{divergence_chapter}章分叉",
        condition="源线到达分叉点"
    )

    return {
        "new_line_id": new_line_id,
        "inherited_savepoint": inherited_savepoint
    }
```

### D.11.5 合并操作

```python
def merge_lines(
    source_line_id: str,
    target_line_id: str,
    merge_chapter: int
) -> dict:
    """
    将源线合并到目标线中

    合并后，源线状态变为ended，其内容成为目标线的一部分
    """
    warnings = []

    # 1. 检查目标线是否可以接收合并
    target_status = get_line_status(target_line_id)
    if target_status not in ("active", "converging"):
        warnings.append(
            f"目标线{target_line_id}当前状态为{target_status}，无法接收合并"
        )

    # 2. 检查是否有未解决的冲突
    conflicts = check_merge_conflicts(source_line_id, target_line_id)
    if conflicts:
        warnings.append(
            f"检测到{len(conflicts)}个合并冲突，需要先解决"
        )

    # 3. 将源线的待办事项转移到目标线
    transfer_pending_items(source_line_id, target_line_id)

    # 4. 将源线的伏笔转移到目标线
    transfer_foreshadowing(source_line_id, target_line_id)

    # 5. 更新源线状态为ended
    update_line_status(source_line_id, "ended")

    # 6. 记录合并事件
    record_merge_event(
        source_line=source_line_id,
        target_line=target_line_id,
        chapter=merge_chapter
    )

    return {
        "success": len(warnings) == 0,
        "warnings": warnings,
        "conflicts": conflicts
    }
```

### D.11.6 合并冲突数据结构

```python
@dataclass
class MergeConflict:
    """
    合并冲突：两条线合并时检测到的矛盾
    """
    conflict_type: str                  # 冲突类型
    field_name: str                     # 冲突字段名
    source_value: str                   # 源线的值
    target_value: str                   # 目标线的值
    description: str                    # 冲突描述
    suggested_resolution: str = ""      # 建议的解决方案
    auto_resolvable: bool = False       # 是否可以自动解决
```

---

## D.12 M9 双层状态模型

> 📋 **摘要**：将角色状态分为全局共享状态（存活、境界等）和线内临时状态（位置、情绪等），确保跨线状态一致。

### D.12.1 设计目标

解决**Q5（如何维护角色跨线的状态一致）**。

双层状态模型将角色的状态分为两层：
- **全局状态（Global State）**：跨所有线共享的永久性状态。
- **线内状态（Line State）**：仅在特定线内有效的临时性状态。

### D.12.2 数据结构

```python
# --- 摘要：GlobalState + LineState —— 角色双层状态模型数据结构（全局共享状态 + 线内临时状态） ---
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class GlobalState:
    """
    角色全局状态：跨所有线共享的永久性状态
    """
    is_alive: bool = True                           # 是否存活
    current_realm: str = ""                         # 当前境界/等级
    permanent_injuries: list[str] = field(default_factory=list)
    # 永久性伤势（如断臂、失明）
    possessions: list[str] = field(default_factory=list)
    # 永久持有物品（如空间戒指、本命法宝）
    relationships: dict[str, str] = field(default_factory=dict)
    # 关系字典：{角色ID: 关系描述}


@dataclass
class LineState:
    """
    角色线内状态：仅在特定线内有效的临时性状态
    """
    line_id: str = ""                               # 所属叙事线ID
    location: str = ""                              # 当前位置
    temporary_injuries: list[str] = field(default_factory=list)
    # 临时伤势（如擦伤、疲劳）
    emotional_state: str = ""                       # 情绪状态
    equipment: list[str] = field(default_factory=list)
    # 当前装备的物品（可能在不同线中不同）
    knowledge_snapshot: list[str] = field(default_factory=list)
    # 知识快照：该角色在该线中知道的关键信息


@dataclass
class CharacterState:
    """
    角色完整状态：全局状态 + 各线状态
    """
    character_id: str = ""                          # 角色ID
    global_state: GlobalState = field(default_factory=GlobalState)
    line_states: dict[str, LineState] = field(default_factory=dict)
    # line_id -> LineState 的映射

    def get_line_state(self, line_id: str) -> Optional[LineState]:
        """获取角色在指定线中的状态"""
        return self.line_states.get(line_id)

    def update_global_state(self, **kwargs) -> None:
        """更新全局状态"""
        for key, value in kwargs.items():
            if hasattr(self.global_state, key):
                setattr(self.global_state, key, value)

    def update_line_state(self, line_id: str, **kwargs) -> None:
        """更新线内状态"""
        if line_id not in self.line_states:
            self.line_states[line_id] = LineState(line_id=line_id)
        for key, value in kwargs.items():
            if hasattr(self.line_states[line_id], key):
                setattr(self.line_states[line_id], key, value)
```

### D.12.3 状态变更判定规则

当角色的状态发生变化时，系统需要判断这个变更属于全局状态还是线内状态：

<!-- 表格说明：角色状态变更判定规则，区分全局状态与线内状态 -->
| 变更类型 | 归属 | 判定规则 | 示例 |
|------|------|------|------|
| 死亡 | 全局 | 不可逆，影响所有线 | 角色死亡后不能在其他线中复活 |
| 境界提升 | 全局 | 永久性能力提升 | 突破到新的修炼境界 |
| 永久性伤势 | 全局 | 不可逆的身体损伤 | 断臂、失明 |
| 永久物品获取 | 全局 | 获得重要物品 | 获得空间戒指、本命法宝 |
| 关系变化 | 全局 | 与其他角色的关系改变 | 结拜、结仇、结婚 |
| 位置移动 | 线内 | 临时性位置 | 进入某个副本、到达某个城市 |
| 临时伤势 | 线内 | 可恢复的身体损伤 | 擦伤、疲劳、轻伤 |
| 情绪变化 | 线内 | 临时性心理状态 | 愤怒、悲伤、兴奋 |
| 临时装备 | 线内 | 可更换的装备 | 穿上某件衣服、拿起某把剑 |
| 知识获取 | 线内 | 在特定线中获得的信息 | 在密林中发现了某个秘密 |

### D.12.4 SQL Schema

> ⚠️ **迁移说明**：以下 `character_global_states` 和 `character_line_states` 表已由主文档 #G.1 统一架构替代：
> - `character_global_states` → `unified_entities.global_state`（JSONB 字段）
> - `character_line_states` → `entity_line_states`
> 保留以下 Schema 作为**设计参考**，实现时应使用统一架构的表。

```sql
-- 角色全局状态表（已由 unified_entities.global_state 替代）
CREATE TABLE character_global_states (
    id UUID PRIMARY KEY,                          -- 记录唯一ID
    entity_id UUID REFERENCES unified_entities(id),  -- characters已迁移；原character_id
    work_id UUID REFERENCES works(id),             -- 所属作品ID
    is_alive BOOLEAN DEFAULT TRUE,                 -- 是否存活
    current_realm VARCHAR(50),                     -- 当前境界/等级
    permanent_injuries JSONB,                      -- 永久性伤势（JSON数组）
    possessions JSONB,                             -- 永久持有物品（JSON数组）
    relationships JSONB,                           -- 关系字典（JSON对象）
    updated_at TIMESTAMP DEFAULT NOW(),            -- 更新时间
    UNIQUE(character_id, work_id)                  -- 每个作品每个角色只有一条全局状态
);
-- ER关系：本表通过 character_id 关联到 unified_entities(id)

-- 角色线内状态表
CREATE TABLE character_line_states (
    id UUID PRIMARY KEY,                          -- 记录唯一ID
    entity_id UUID REFERENCES unified_entities(id),  -- characters已迁移；原character_id
    line_id UUID REFERENCES narrative_lines(id),   -- 叙事线ID
    location VARCHAR(100),                         -- 当前位置
    temporary_injuries JSONB,                      -- 临时伤势（JSON数组）
    emotional_state VARCHAR(20),                   -- 情绪状态
    equipment JSONB,                               -- 当前装备（JSON数组）
    updated_at TIMESTAMP DEFAULT NOW(),            -- 更新时间
    UNIQUE(entity_id, line_id)                  -- 每个角色每条线只有一条线内状态
);
-- ER关系：本表通过 character_id 关联到 unified_entities(id)；通过 narrative_line_id 关联到 narrative_lines(id)

-- 索引：按角色查询全局状态
CREATE INDEX idx_global_states_character
    ON character_global_states(entity_id);

-- 索引：按角色和线查询线内状态
CREATE INDEX idx_line_states_character_line
    ON character_line_states(entity_id, line_id);
```

---

## D.13 M10 伏笔跨线标签

> 📋 **摘要**：在 B3 伏笔系统基础上扩展跨线标签和回收提醒功能，追踪伏笔的跨线埋设与回收。

### D.13.1 设计目标

解决**Q6（如何追踪伏笔的跨线埋设与回收）**。

M10 是 B3 伏笔系统的跨线扩展。它在 B3 原有的伏笔管理基础上，增加了跨线标签和跨线回收提醒功能。

### D.13.2 B3 伏笔表扩展

在 B3 原有的伏笔表基础上，增加跨线相关字段：

> **交叉引用**：foreshadowing 表定义见主文档 #11.2（B3 因果链断裂检测·铺垫追踪）及统一架构 #G.1 unified_entities（domain='foreshadowing'）

```sql
-- 在B3原有的foreshadowing表上增加跨线字段
ALTER TABLE foreshadowing ADD COLUMN IF NOT EXISTS
    cross_line_tags JSONB DEFAULT '[]';
    -- 跨线标签列表，每个标签包含：
    -- {"target_line_id": "xxx", "relation": "plant/harvest/related", "note": "说明"}

    -- 【与B7 UnifiedForeshadowing的映射关系】
    -- B5 M10的cross_line_tags与B7统一伏笔视图（#15.2 UnifiedForeshadowing）存在以下映射：
    --   1. cross_line_tags[].target_line_id → B7的 UnifiedForeshadowing.target_lines（叙事线ID列表）
    --   2. cross_line_tags[].relation（plant/harvest/related）→ B7的额外relation元数据
    --      - "plant"：本线埋设，目标线回收 → B7中cross_line=True，target_lines含目标线
    --      - "harvest"：本线回收，目标线埋设 → B7中cross_line=True，target_lines含埋设线
    --      - "related"：关联但不涉及埋设/回收 → B7中cross_line=True，target_lines含关联线
    --   3. is_cross_line → B7的 UnifiedForeshadowing.cross_line（布尔值）
    --   4. original_line_id → B7中可通过target_lines + relation推导得出原始埋设线
    --
    -- 【数据迁移说明】
    -- B5 M10的cross_line_foreshadowing_reminders表在B7架构下由以下机制替代：
    --   - 伏笔回收提醒 → ForeshadowCoordinator.get_dashboard()的alerts字段
    --   - 跨线回收检测 → B7的ForeshadowRecoveryDetector（统一检测管线插件）
    --   - 提醒消息生成 → B7的ForeshadowCoordinator基于reader_memory衰减和expected_chapter自动计算
    -- 迁移时，已有的cross_line_foreshadowing_reminders记录应转换为B7的UnifiedForeshadowing条目，
    -- 其中reminder_chapter映射为expected_chapter，reminder_message映射为expected_event。

ALTER TABLE foreshadowing ADD COLUMN IF NOT EXISTS
    is_cross_line BOOLEAN DEFAULT FALSE;
    -- 是否为跨线伏笔

ALTER TABLE foreshadowing ADD COLUMN IF NOT EXISTS
    original_line_id UUID REFERENCES narrative_lines(id);
    -- 伏笔原始埋设的叙事线ID

-- 跨线伏笔回收提醒表
CREATE TABLE cross_line_foreshadowing_reminders (
    id UUID PRIMARY KEY,                          -- 提醒唯一ID
    foreshadowing_id UUID REFERENCES foreshadowing(id),  -- 关联的伏笔ID
    plant_line_id UUID REFERENCES narrative_lines(id),   -- 埋设线ID
    harvest_line_id UUID REFERENCES narrative_lines(id),  -- 预期回收线ID
    reminder_chapter INT,                         -- 提醒章节号
    reminder_message TEXT,                        -- 提醒消息
    is_resolved BOOLEAN DEFAULT FALSE,            -- 是否已处理
    created_at TIMESTAMP DEFAULT NOW()             -- 创建时间
);
-- ER关系：本表通过 source_line_id/target_line_id 关联到 narrative_lines(id)；通过 entity_id 关联到 unified_entities(id)
```

### D.13.3 跨线伏笔回收提醒

```python
def check_cross_line_foreshadowing(
    current_line_id: str,
    current_chapter: int,
    all_foreshadowing: list[dict]
) -> list[dict]:
    """
    检查当前线中是否有需要回收的跨线伏笔

    参数：
    - current_line_id: 当前叙事线ID
    - current_chapter: 当前章节号
    - all_foreshadowing: 所有伏笔列表

    返回：
    - 需要提醒的伏笔列表
    """
    reminders = []

    for fs in all_foreshadowing:
        # 跳过非跨线伏笔
        if not fs.get("is_cross_line"):
            continue

        # 跳过已回收的伏笔
        if fs.get("status") == "harvested":
            continue

        # 检查该伏笔是否应该在当前线中回收
        cross_tags = fs.get("cross_line_tags", [])
        for tag in cross_tags:
            if (tag.get("target_line_id") == current_line_id
                    and tag.get("relation") == "harvest"):
                # 检查埋设线是否已经推进到足够远
                plant_chapter = fs.get("plant_chapter", 0)
                # 建议在埋设后至少5章再回收
                if current_chapter >= plant_chapter + 5:
                    reminders.append({
                        "foreshadowing_id": fs["id"],
                        "content": fs["content"],
                        "plant_line": fs.get("original_line_id"),
                        "plant_chapter": plant_chapter,
                        "suggestion": (
                            f"伏笔「{fs['content']}」在第{plant_chapter}章的"
                            f"线{fs.get('original_line_id')}中埋设，"
                            f"建议在当前线中回收"
                        )
                    })

    return reminders
```

---

## D.14 M11 叙事线仪表盘

> 📋 **摘要**：提供概览、甘特图、依赖图、热力图四种视图模式及对应的数据 API，统一展示多线叙事管理界面。

### D.14.1 设计目标

为作者提供一个统一的多线叙事管理界面，解决**Q2（如何可视化多条线的进度和关系）**。

### D.14.2 四种视图模式

| 视图 | 描述 | 适用场景 | 核心元素 |
|------|------|------|----------|
| 概览视图 | 所有线的基本状态一览 | 日常写作 | 线卡片列表、状态标签、进度条 |
| 甘特图视图 | 线的时间跨度和章节分布 | 规划阶段 | 时间轴、线条、里程碑 |
| 依赖图视图 | 线之间的依赖关系 | 检查一致性 | 节点、有向边、依赖类型标签 |
| 热力图视图 | 线的活跃度和更新频率 | 发现僵尸线 | 热力色块、时间维度 |

### D.14.3 仪表盘数据 API

```python
# --- 摘要：叙事线仪表盘数据API —— 概览/详情/甘特图/依赖图/热力图5个端点的完整实现 ---
# API端点1：获取概览数据
# GET /api/narrative-lines/dashboard/overview
# 返回所有线的基本状态
def get_dashboard_overview(work_id: str) -> dict:
    """
    获取叙事线概览数据

    返回：
    {
        "total_lines": 5,
        "active_lines": 3,
        "paused_lines": 1,
        "ended_lines": 1,
        "lines": [
            {
                "id": "uuid",
                "name": "暗影密林",
                "status": "active",
                "current_chapter": 47,
                "total_chapters": 47,
                "last_updated": "2026-04-15",
                "emotion_tone": "紧张",
                "pacing": "fast",
                "pending_tasks_count": 3,
                "pending_foreshadowing_count": 2
            },
            ...
        ]
    }
    """
    pass


# API端点2：获取甘特图数据
# GET /api/narrative-lines/dashboard/gantt
# 返回各线的时间跨度和章节分布
def get_dashboard_gantt(work_id: str) -> dict:
    """
    获取甘特图数据

    返回：
    {
        "timeline_start": "第1章",
        "timeline_end": "第100章",
        "lines": [
            {
                "id": "uuid",
                "name": "暗影密林",
                "start_chapter": 10,
                "end_chapter": 47,
                "current_chapter": 47,
                "milestones": [
                    {"chapter": 15, "event": "发现遗迹"},
                    {"chapter": 30, "event": "击败守护兽"}
                ]
            },
            ...
        ]
    }
    """
    pass


# API端点3：获取依赖图数据
# GET /api/narrative-lines/dashboard/dependency-graph
# 返回线之间的依赖关系
def get_dependency_graph(work_id: str) -> dict:
    """
    获取依赖图数据

    返回：
    {
        "nodes": [
            {"id": "uuid", "name": "暗影密林", "status": "active"},
            ...
        ],
        "edges": [
            {
                "from": "uuid1",
                "to": "uuid2",
                "type": "temporal",
                "is_satisfied": true,
                "label": "时间依赖"
            },
            ...
        ],
        "cycles": []  # 循环依赖列表
    }
    """
    pass


# API端点4：获取热力图数据
# GET /api/narrative-lines/dashboard/heatmap
# 返回各线的活跃度和更新频率
def get_dashboard_heatmap(work_id: str) -> dict:
    """
    获取热力图数据

    返回：
    {
        "period": "last_30_chapters",
        "lines": [
            {
                "id": "uuid",
                "name": "暗影密林",
                "activity_scores": [
                    {"chapter": 20, "score": 0.8},
                    {"chapter": 21, "score": 0.0},
                    ...
                ]
            },
            ...
        ]
    }
    """
    pass
```

---

## D.15 M12 跨线一致性审核 Agent

> 📋 **摘要**：全局唯一的审核型 Agent，在关键节点执行时间、信息、状态、伏笔、因果、角色唯一性六项一致性检查。

### D.15.1 设计目标

M12 是全局唯一的审核型 Agent，负责在关键节点检查所有线之间的一致性。与 M3（每条线一个主动型助手）不同，M12 是"质检员"角色。

### D.15.2 六项检查内容

| 编号 | 检查项 | 描述 | 严重程度 |
|------|--------|------|----------|
| C1 | 时间一致性 | 检查跨线时间流逝是否合理 | 高 |
| C2 | 信息一致性 | 检查角色是否使用了不该知道的信息 | 高 |
| C3 | 状态一致性 | 检查角色的全局状态是否在各线中一致 | 高 |
| C4 | 伏笔一致性 | 检查跨线伏笔是否被正确追踪 | 中 |
| C5 | 因果一致性 | 检查跨线因果链是否完整 | 中 |
| C6 | 角色唯一性 | 检查同一角色是否同时出现在不可能的位置 | 中 |

> **调用依赖**：M12 的 6 项检查中，C1 时间一致性调用 M4 全局时间轴引擎，C2 信息一致性调用 M5 知识背包，C3 状态一致性调用 M9 双层状态模型，C4 伏笔一致性调用 M10 伏笔跨线标签，C5 因果一致性调用 B3 因果链检测器，C6 角色唯一性为 M12 独立实现。M12 作为编排层，聚合各机制的检查结果并生成统一审核报告。

### D.15.3 三级审核时机

| 等级 | 时机 | 触发方式 | 检查范围 | Token 消耗 |
|------|------|------|----------|------|
| 1 级 | 每章完成时 | 自动 | C1, C6 | 500-800 |
| 2 级 | 线切换时 | 自动 | C1-C4 | 1000-1500 |
| 3 级 | 作者请求 / 卷完成时 | 手动/自动 | C1-C6（全量） | 1500-2000 |

### D.15.4 审核结果格式

```json
{
    "audit_id": "uuid",
    "audit_level": 2,
    "trigger": "line_switch",
    "timestamp": "2026-04-17T10:30:00Z",
    "total_issues": 3,
    "issues": [
        {
            "check_item": "C1",
            "severity": "error",
            "description": "线A在第47章的时间为'第三天黄昏'，但线B在第46章的时间已经是'第四天清晨'，时间顺序矛盾",
            "affected_lines": ["line_a_id", "line_b_id"],
            "suggestion": "建议将线B的时间调整为'第三天'或更早"
        },
        {
            "check_item": "C3",
            "severity": "warning",
            "description": "角色'林风'在全局状态中左臂已断，但在线C的第45章中使用了左手持剑",
            "affected_lines": ["line_c_id"],
            "suggestion": "检查线C中是否有遗漏的伤势描述"
        }
    ]
}
```

---

## D.16 S1 节奏建议引擎

> 📋 **摘要**：通过叙事张力计算和线推荐函数，基于冲突强度、情感基调和更新间隔建议最佳的叙事线切换时机。

### D.16.1 设计目标

辅助解决**Q7（如何在合适的时机切换叙事线）**。

节奏建议引擎通过分析各线的叙事张力，建议作者在合适的时机切换叙事线，避免节奏断裂。

### D.16.2 叙事张力计算

```python
# --- 摘要：calculate_narrative_tension() —— 叙事张力计算，综合冲突强度/悬念/情感/节奏/未解决伏笔等因素 ---
def calculate_narrative_tension(
    savepoint: dict,
    recent_chapters_tension: list[float]
) -> float:
    """
    计算一条叙事线当前的叙事张力（0-1）

    张力由以下因素决定：
    1. 当前冲突数量和强度
    2. 情感基调（紧张/悬疑 > 平静/温馨）
    3. 叙事节奏（快 > 慢）
    4. 最近几章的张力趋势

    参数：
    - savepoint: 最新的存档点数据
    - recent_chapters_tension: 最近N章的张力值列表

    返回：
    - 张力值（0-1）
    """
    # 因子1：冲突数量（0-0.3）
    conflict_count = len(savepoint.get("active_conflicts", []))
    conflict_factor = min(conflict_count * 0.1, 0.3)

    # 因子2：情感基调（0-0.25）
    emotion_tone = savepoint.get("emotion_tone", "")
    emotion_scores = {
        "紧张": 0.25, "悬疑": 0.22, "愤怒": 0.20,
        "悲伤": 0.15, "兴奋": 0.18, "平静": 0.05,
        "温馨": 0.03, "幽默": 0.02
    }
    emotion_factor = emotion_scores.get(emotion_tone, 0.1)

    # 因子3：叙事节奏（0-0.2）
    # B8统一为5值英文枚举（slow/medium/buildup/fast/climax），此处需兼容
    # 【H1修复确认】pacing_scores已更新为5值枚举，与B8 #16.2节奏画像引擎对齐。
    # 旧版中文3值（快/中/慢）保留为兼容项，迁移期结束后可移除。
    pacing = savepoint.get("pacing", "")
    pacing_scores = {
        "slow": 0.05, "medium": 0.12, "buildup": 0.14,
        "fast": 0.20, "climax": 0.22,
        # 兼容旧版中文3值（迁移期，v4.0后移除）
        "快": 0.20, "中": 0.12, "慢": 0.05
    }
    pacing_factor = pacing_scores.get(pacing, 0.10)

    # 因子4：趋势（0-0.25）
    if recent_chapters_tension:
        # 如果最近几章张力在上升，当前张力更高
        if len(recent_chapters_tension) >= 2:
            trend = recent_chapters_tension[-1] - recent_chapters_tension[-2]
            trend_factor = max(0, min(0.25, 0.125 + trend * 0.5))
        else:
            trend_factor = 0.125
    else:
        trend_factor = 0.125

    # 综合计算
    total_tension = (
        conflict_factor + emotion_factor +
        pacing_factor + trend_factor
    )
    return max(0.0, min(1.0, total_tension))
```

### D.16.3 线推荐函数

```python
# --- 摘要：suggest_next_line() —— 叙事线推荐函数，基于张力/更新时间/交替模式建议下一条应写的线 ---
def suggest_next_line(
    current_line_id: str,
    all_lines_tension: dict[str, float],
    all_lines_last_updated: dict[str, int],
    current_chapter: int
) -> dict:
    """
    建议下一条应该写作的叙事线

    推荐逻辑：
    1. 如果当前线张力很高（>0.8），建议继续当前线（不要在高潮中断）
    2. 如果当前线张力中等（0.4-0.8），建议切换到张力最低的线（平衡节奏）
    3. 如果当前线张力很低（<0.4），建议切换到张力较高的线（提升节奏）
    4. 如果某条线超过N章未更新，提高该线的推荐优先级

    参数：
    - current_line_id: 当前正在写的线ID
    - all_lines_tension: 各线当前张力 {line_id: tension}
    - all_lines_last_updated: 各线最后更新章节 {line_id: chapter}
    - current_chapter: 当前章节号

    返回：
    - recommended_line_id: 推荐的线ID
    - reason: 推荐理由
    """
    current_tension = all_lines_tension.get(current_line_id, 0.5)

    # 规则1：高潮不断
    if current_tension > 0.8:
        return {
            "recommended_line_id": current_line_id,
            "reason": (
                f"当前线张力较高（{current_tension:.2f}），"
                f"建议继续推进，避免在高潮处中断"
            )
        }

    # 计算各线的推荐分数
    scores = {}
    for line_id, tension in all_lines_tension.items():
        if line_id == current_line_id:
            continue

        score = 0.0

        # 规则2：平衡节奏 — 优先推荐张力较低的线
        if current_tension >= 0.4:
            score += (1.0 - tension) * 0.4

        # 规则3：提升节奏 — 如果当前线张力低，优先推荐张力较高的线
        if current_tension < 0.4:
            score += tension * 0.4

        # 规则4：遗忘惩罚 — 越久没更新的线，推荐分数越高
        last_updated = all_lines_last_updated.get(line_id, 0)
        chapters_gap = current_chapter - last_updated
        if chapters_gap > 5:
            score += min(chapters_gap * 0.05, 0.3)

        # 线必须处于活跃状态
        line_status = get_line_status(line_id)
        if line_status != "active":
            score = -1  # 不推荐非活跃线

        scores[line_id] = score

    # 选择分数最高的线
    if scores:
        best_line = max(scores, key=scores.get)
        best_score = scores[best_line]
        best_tension = all_lines_tension.get(best_line, 0)

        reason_parts = []
        if current_tension >= 0.4:
            reason_parts.append(
                f"当前线张力中等（{current_tension:.2f}），"
                f"建议切换以平衡节奏"
            )
        else:
            reason_parts.append(
                f"当前线张力较低（{current_tension:.2f}），"
                f"建议切换以提升节奏"
            )

        last_updated = all_lines_last_updated.get(best_line, 0)
        gap = current_chapter - last_updated
        if gap > 5:
            reason_parts.append(
                f"推荐线已{gap}章未更新，需要推进"
            )

        return {
            "recommended_line_id": best_line,
            "reason": "；".join(reason_parts)
        }

    # 没有其他可选线，继续当前线
    return {
        "recommended_line_id": current_line_id,
        "reason": "没有其他活跃的叙事线可切换"
    }
```

---

## D.17 S2 失败模式库

> 📋 **摘要**：总结多线叙事中遗忘线、僵尸线、信息污染等 7 种常见失败模式及其预防机制和检测方式。

### D.17.1 设计目标

收集和总结多线叙事写作中常见的失败模式，帮助作者提前识别和避免这些问题。

### D.17.2 七种失败模式

<!-- 表格说明：多线叙事的七种失败模式及预防/检测方式 -->
| 编号 | 失败模式 | 描述 | 典型症状 | 预防机制 | 检测方式 |
|------|----------|------|----------|------|----------|
| F1 | 遗忘线 | 某条线长时间未更新，被作者遗忘 | 一条线停更 20+章，剧情完全停滞 | M7 遗忘预警（paused 超过阈值） | M11 热力图 + M7 状态监控 |
| F2 | 僵尸线 | 线虽然还在更新，但已经失去叙事价值 | 线的内容与主线无关，读者跳读 | M3 推进建议 + S1 节奏建议 | M12 审核（因果一致性检查） |
| F3 | 信息污染 | 角色在不同线中获得了不该知道的信息 | 角色突然"知道"了只在另一条线中揭示的秘密 | M5 知识背包 + 信息泄漏检测 | M12 审核（信息一致性检查） |
| F4 | 时间崩塌 | 多条线的时间关系完全混乱 | 读者无法判断事件的先后顺序 | M4 全局时间轴 + 时间锚点 | M12 审核（时间一致性检查） |
| F5 | 节奏车祸 | 线切换时机不当，严重破坏阅读体验 | 在高潮时突然切到无聊的线 | S1 节奏建议引擎 | 张力监控 + 叙事结构分析 |
| F6 | 角色分裂 | 同一角色在不同线中的性格/行为不一致 | 角色在 A 线冷酷无情，在 B 线温柔体贴（无合理原因） | M9 双层状态 + M3 状态守护 | M12 审核（状态一致性检查） |
| F7 | 汇聚灾难 | 多条线汇聚时产生大量矛盾 | 线交汇时发现时间、信息、状态全部对不上 | M8 交汇检查 + M12 全量审核 | M8 交汇操作的预检查 |

### D.17.3 失败模式与机制的对应关系

```
F1 遗忘线     → M7生命周期 + M11热力图
F2 僵尸线     → M3 AI助手 + S1节奏建议
F3 信息污染   → M5知识背包 + M12审核
F4 时间崩塌   → M4全局时间轴 + M12审核
F5 节奏车祸   → S1节奏建议引擎
F6 角色分裂   → M9双层状态 + M12审核
F7 汇聚灾难   → M8线拓扑变更 + M12审核
```

---

## D.18 S3 网文三线模型预设

> 📋 **摘要**：为经典三线模型等常见网文多线叙事模式提供预设模板，降低作者的初始配置成本。

### D.18.1 设计目标

为常见的网文多线叙事模式提供预设模板，降低作者的配置成本。

### D.18.2 预设数据结构

```python
# --- 摘要：NarrativeLinePreset —— 叙事线预设模板数据结构，支持主线/感情线/支线/暗线等常见模式 ---
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class NarrativeLinePreset:
    """
    叙事线预设模板
    """
    name: str = ""                           # 预设名称
    description: str = ""                    # 预设描述
    line_count: int = 0                      # 线数量
    lines: list[dict] = field(default_factory=list)
    # 每条线的预设配置
    default_dependencies: list[dict] = field(default_factory=list)
    # 默认的依赖关系
    suggested_pacing: dict[str, str] = field(default_factory=dict)
    # 建议的节奏策略 {线名: 节奏描述}
    applicable_genres: list[str] = field(default_factory=list)
    # 适用类型


# 网文三线模型预设
NARRATIVE_LINE_PRESETS: dict[str, NarrativeLinePreset] = {
    "classic_three_line": NarrativeLinePreset(
        name="经典三线模型",
        description=(
            "一条主线 + 一条支线 + 一条暗线。"
            "主线推进核心剧情，支线丰富世界观，暗线埋设悬念。"
            "适用于大多数网文类型。"
        ),
        line_count=3,
        lines=[
            {
                "name": "主线",
                "type": "T4",
                "description": "主角的核心成长线，推进主要剧情",
                "pacing": "medium",  # 5值枚举：slow/medium/buildup/fast/climax；主线整体取中值，交替节奏由suggested_pacing描述
                "priority": "高",
                "suggested_ratio": "60%"  # 建议占总篇幅的比例
            },
            {
                "name": "支线",
                "type": "T4",
                "description": "配角或次要剧情线，丰富世界观和角色关系",
                "pacing": "slow",  # 5值枚举：slow/medium/buildup/fast/climax；支线整体偏慢，交替节奏由suggested_pacing描述
                "priority": "中",
                "suggested_ratio": "25%"
            },
            {
                "name": "暗线",
                "type": "T3",
                "description": "隐藏的剧情线，通过碎片化信息逐步揭示",
                "pacing": "slow",  # 5值枚举：slow/medium/buildup/fast/climax
                "priority": "低",
                "suggested_ratio": "15%"
            }
        ],
        default_dependencies=[
            {
                "from": "支线", "to": "主线",
                "type": "information",
                "description": "支线中获得的线索推动主线"
            },
            {
                "from": "暗线", "to": "主线",
                "type": "causal",
                "description": "暗线揭示的真相改变主线走向"
            }
        ],
        suggested_pacing={
            "主线": "高潮-过渡-高潮，每3-5章一个节奏周期",
            "支线": "与主线错开，主线高潮时支线过渡",
            "暗线": "每10-15章透露一点信息，保持悬念"
        },
        applicable_genres=["玄幻", "都市", "悬疑", "科幻", "历史"]
    ),

    "dual_perspective": NarrativeLinePreset(
        name="双视角模型",
        description=(
            "两个角色的视角交替推进，最终交汇。"
            "适用于爱情、推理、对抗等类型。"
        ),
        line_count=2,
        lines=[
            {
                "name": "视角A",
                "type": "T1",
                "description": "角色A的视角线",
                "pacing": "medium",  # 5值枚举：slow/medium/buildup/fast/climax
                "priority": "高",
                "suggested_ratio": "50%"
            },
            {
                "name": "视角B",
                "type": "T1",
                "description": "角色B的视角线",
                "pacing": "medium",  # 5值枚举：slow/medium/buildup/fast/climax
                "priority": "高",
                "suggested_ratio": "50%"
            }
        ],
        default_dependencies=[
            {
                "from": "视角A", "to": "视角B",
                "type": "information",
                "description": "A知道的信息B不知道（或反之）"
            }
        ],
        suggested_pacing={
            "视角A": "与视角B交替推进，每次2-4章",
            "视角B": "与视角A交替推进，每次2-4章"
        },
        applicable_genres=["都市", "悬疑", "爱情", "推理"]
    ),

    "multi_front": NarrativeLinePreset(
        name="多线并进模型",
        description=(
            "3-5条线同时推进，各自独立发展，最终汇聚。"
            "适用于大场面、多阵营对抗。"
        ),
        line_count=5,
        lines=[
            {
                "name": "主力线",
                "type": "T2",
                "description": "主角所在的主力部队",
                "pacing": "fast",
                "priority": "高",
                "suggested_ratio": "35%"
            },
            {
                "name": "侧翼线A",
                "type": "T2",
                "description": "侧翼部队A的行动",
                "pacing": "medium",  # 5值枚举：slow/medium/buildup/fast/climax
                "priority": "中",
                "suggested_ratio": "20%"
            },
            {
                "name": "侧翼线B",
                "type": "T2",
                "description": "侧翼部队B的行动",
                "pacing": "medium",  # 5值枚举：slow/medium/buildup/fast/climax
                "priority": "中",
                "suggested_ratio": "20%"
            },
            {
                "name": "敌方线",
                "type": "T2",
                "description": "敌方视角的行动",
                "pacing": "fast",  # 5值枚举：slow/medium/buildup/fast/climax；敌方线整体偏快，交替节奏由suggested_pacing描述
                "priority": "中",
                "suggested_ratio": "15%"
            },
            {
                "name": "后方线",
                "type": "T2",
                "description": "后方基地/指挥部的动态",
                "pacing": "slow",  # 5值枚举：slow/medium/buildup/fast/climax
                "priority": "低",
                "suggested_ratio": "10%"
            }
        ],
        default_dependencies=[
            {
                "from": "侧翼线A", "to": "主力线",
                "type": "temporal",
                "description": "侧翼行动与主力行动时间同步"
            },
            {
                "from": "敌方线", "to": "主力线",
                "type": "causal",
                "description": "敌方的行动影响主力的决策"
            }
        ],
        suggested_pacing={
            "主力线": "核心推进，节奏最快",
            "侧翼线A": "与主力线交替，提供不同视角",
            "侧翼线B": "与侧翼线A交替",
            "敌方线": "穿插在友方线之间，增加悬念",
            "后方线": "在战斗间隙出现，调节节奏"
        },
        applicable_genres=["玄幻", "科幻", "军事", "历史"]
    )
}
```

---

## D.19 S4 三级自动化策略

> 📋 **摘要**：将 B5 所有机制按 L0 手动、L1 半自动、L2 全自动三个等级配置，支持全局和单机制独立设置。

### D.19.1 设计目标

将 B5 的所有机制按照自动化程度分为三个等级，作者可以根据自己的偏好和经验选择合适的等级。

### D.19.2 三级策略总览

> 以下表格列数较多，建议横向滚动查看。各自动化等级的详细说明见 19.3-19.5 节。

<!-- 表格说明：B5三级自动化策略总览，各机制在不同自动化等级下的行为 -->
| 等级 | 名称 | 存档点(M1) | 交接文档(M2) | AI 助手(M3) | 时间轴(M4) | 知识背包(M5) | 依赖图(M6) | 生命周期(M7) | 拓扑变更(M8) | 双层状态(M9) | 伏笔标签(M10) | 仪表盘(M11) | 审核 Agent(M12) | 节奏建议(S1) |
|------|------|------|-------------|------|-----------|------|-----------|------|-------------|------|-------------|------|---------------|------|
| L0 | 手动 | 手动创建 | 不生成 | 不启用 | 手动记录 | 手动记录 | 手动管理 | 手动管理 | 手动操作 | 手动管理 | 手动标记 | 只读展示 | 不启用 | 不启用 |
| L1 | 半自动 | 线切换/章节完成时自动 | 线切换时生成草稿 | 启用（提醒模式） | 自动记录时间事件 | 自动追踪 | 自动检测循环 | 自动状态转换提醒 | 操作前预检查 | 自动检测全局状态变更 | 自动标记跨线伏笔 | 实时更新 | 1-2 级审核 | 切换时建议 |
| L2 | 全自动 | 所有触发时机自动 | 自动生成并插入 | 启用（主动模式） | 全自动+异常提醒 | 全自动+泄漏检测 | 全自动+异常提醒 | 全自动 | 全自动+冲突自动解决 | 全自动+跨线同步 | 全自动+回收提醒 | 实时更新+预警 | 全量审核 | 持续建议 |

### D.19.3 各等级详细说明

#### L0 手动模式

**适用对象**：新手作者、简单的双线叙事。

**特点**：
- 系统只提供工具和界面，所有操作由作者手动完成。
- 不消耗 AI Token。
- 适合作者熟悉多线叙事的基本概念。

**降级场景**：AI 服务不可用时自动降级到 L0。

#### L1 半自动模式（推荐默认）

**适用对象**：有经验的多线叙事作者、3-5 条线的复杂度。

**特点**：
- 系统自动执行常规操作（存档、状态追踪），但需要作者确认关键操作。
- AI 助手以"提醒"模式运行，不会主动修改内容。
- 审核 Agent 在关键节点（线切换、章节完成）自动运行。
- Token 消耗适中（2000-4000/章）。

#### L2 全自动模式

**适用对象**：高级作者、5 条线以上的高复杂度叙事。

**特点**：
- 系统全自动运行，只在检测到无法自动解决的问题时才请求作者介入。
- AI 助手以"主动"模式运行，可以主动建议和执行操作。
- 审核 Agent 持续运行，覆盖所有检查项。
- Token 消耗较高（3000-5000/章）。

### D.19.4 等级切换规则

- 作者可以随时调整全局自动化等级。
- 每个机制可以独立设置自动化等级（覆盖全局设置）。
- 从高等级降到低等级时，已有的自动生成内容不会被删除。
- 从低等级升到高等级时，系统会补全之前未执行的自动操作。

---

## D.20 盲区补充

> 📋 **摘要**：补充章节与叙事线的多对多映射规则、叙事线创建时机策略和跨线角色"分身"问题解决方案。

### D.20.1 盲区 A：叙事线与章节的映射关系

**问题**：一个章节可能属于多条叙事线，如何处理这种多对多关系？

**场景**：
- 过渡章节：从 A 线切换到 B 线的过渡段落，同时属于两条线。
- 交汇章节：多条线汇聚的章节，同时推进多条线。
- 嵌套章节：主线中穿插的支线片段。

**解决方案**：

```sql
-- 章节-叙事线关联表（多对多）
CREATE TABLE chapter_line_mapping (
    id UUID PRIMARY KEY,
    chapter_id UUID REFERENCES chapters(id),       -- 章节ID
    line_id UUID REFERENCES narrative_lines(id),    -- 叙事线ID
    role VARCHAR(20) NOT NULL DEFAULT 'primary',    -- 角色：primary/secondary/transition
    word_count INT DEFAULT 0,                       -- 该线在该章中的字数
    start_position INT DEFAULT 0,                   -- 在章节中的起始位置（字符偏移）
    end_position INT DEFAULT 0,                     -- 在章节中的结束位置
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(chapter_id, line_id)                     -- 同一章节同一线只有一条记录
);
-- ER关系：本表通过 chapter_id 关联到 chapters(id)；通过 narrative_line_id 关联到 narrative_lines(id)

-- 索引：按章节查询关联的线
CREATE INDEX idx_chapter_line_mapping_chapter
    ON chapter_line_mapping(chapter_id);

-- 索引：按线查询关联的章节
CREATE INDEX idx_chapter_line_mapping_line
    ON chapter_line_mapping(line_id);
```

**过渡章节归属规则**：
1. 如果章节中 A 线内容占比 > 60%，归属 A 线（B 线为 secondary）。
2. 如果 A 线和 B 线内容占比都在 30%-70%之间，标记为 transition（过渡章节）。
3. 交汇章节中所有涉及的线都标记为 primary。

### D.20.2 盲区 B：叙事线的创建时机

**问题**：叙事线应该在大纲阶段预创建，还是在写作时临时创建？

**两种策略对比**：

| 策略 | 优点 | 缺点 | 适用场景 |
|------|------|------|----------|
| 大纲阶段预创建 | 结构清晰、依赖关系明确 | 可能需要后续调整 | 有完整大纲的作品 |
| 写作时临时创建 | 灵活、适应创作中的灵感 | 可能缺少规划、依赖关系不明确 | 灵感驱动型写作 |

**推荐方案**：**混合策略**。

1. 在大纲阶段（B1）预创建已知的主要叙事线。
2. 在写作过程中允许临时创建新的叙事线。
3. 临时创建的线需要补全依赖关系信息（由 M3 AI 助手辅助）。
4. 定期（每卷结束时）审查叙事线结构，合并或删除不必要的线。

### D.20.3 盲区 C：跨线角色的"分身"问题

**问题**：同一角色同时出现在多条线中，如何管理？

**场景**：
- 角色在 A 线位于城市 X，同时在 B 线位于城市 Y（时间不同）。
- 角色在 A 线的情绪是愤怒，在 B 线是平静（时间不同导致）。
- 角色在 A 线已经知道了某个秘密，但在 B 线还不知道。

**解决方案**：

利用 M9 双层状态模型 + M4 全局时间轴 + M5 知识背包的组合：

1. **M9 双层状态**：全局状态（如存活、境界）跨线共享，线内状态（如位置、情绪）按线独立。
2. **M4 全局时间轴**：通过时间游标确保角色在不同线中的时间不矛盾。
3. **M5 知识背包**：按线追踪角色知道的信息，避免信息泄漏。

**"分身"检测规则**：
- 如果同一角色在两条线中的时间有重叠（即同一时刻出现在两个地方），系统发出警告。
- 例外情况：角色确实可以分身（如修炼分身、影分身等），作者可以标记为"合理分身"。

```python
def check_character_clone(
    character_id: str,
    line_a_id: str,
    line_b_id: str,
    timeline: GlobalTimeline
) -> dict:
    """
    检查角色是否在两条线中"分身"（同一时刻出现在两个地方）

    返回：
    - is_clone: 是否为分身
    - detail: 详情
    """
    cursor_a = timeline.get_line_cursor(line_a_id)
    cursor_b = timeline.get_line_cursor(line_b_id)

    if not cursor_a or not cursor_b:
        return {"is_clone": False, "detail": "时间数据不足"}

    # 获取角色在两条线中的位置
    state_a = get_character_line_state(character_id, line_a_id)
    state_b = get_character_line_state(character_id, line_b_id)

    if not state_a or not state_b:
        return {"is_clone": False, "detail": "角色不在其中一条线中"}

    # 如果两条线的时间有重叠，且角色位置不同，则为分身
    time_overlap = check_time_overlap(cursor_a, cursor_b)
    location_diff = state_a.location != state_b.location

    if time_overlap and location_diff:
        return {
            "is_clone": True,
            "detail": (
                f"角色{character_id}在时间重叠期间同时出现在"
                f"线{line_a_id}的{state_a.location}和"
                f"线{line_b_id}的{state_b.location}"
            )
        }

    return {"is_clone": False, "detail": "未检测到分身问题"}
```

### D.20.4 盲区 D：与 B1 大纲系统的集成方案

**问题**：B5 的叙事线管理与 B1 的大纲管理如何协同？

**集成方案**：

1. **卷纲包含线出场计划**：
   - B1 的卷纲中增加"叙事线出场计划"字段。
   - 每卷开始前，作者规划该卷中各线的出场顺序和篇幅分配。
   - B5 根据出场计划自动调整 M7 生命周期状态。
2. **大纲节点关联叙事线**：
   - B1 的大纲节点（卷/章/场景）可以关联一条或多条叙事线。
   - 写作时，系统根据大纲节点的关联线自动切换上下文。
3. **大纲变更同步**：
   - 当 B1 的大纲发生变更时（如删除一个章节），B5 自动更新相关的存档点和依赖关系。
   - 当 B5 的线状态发生变更时（如线被放弃），B1 的大纲中标记相关的节点。

```sql
-- 大纲节点-叙事线关联表
CREATE TABLE outline_node_line_mapping (
    id UUID PRIMARY KEY,
    outline_node_id UUID REFERENCES outline_nodes(id),  -- 大纲节点ID
    line_id UUID REFERENCES narrative_lines(id),         -- 叙事线ID
    planned_chapters INT,                                -- 计划章节数
    actual_chapters INT DEFAULT 0,                       -- 实际章节数
    created_at TIMESTAMP DEFAULT NOW()
);
-- ER关系：本表通过 outline_node_id 关联到 master_outlines/volume_outlines/chapter_outlines(id)；通过 narrative_line_id 关联到 narrative_lines(id)
```

---

## D.21 与 B1-B4 的协同设计

> 📋 **摘要**：定义 B5 多线叙事与大纲（B1）、时间（B2）、伏笔（B3）、风格（B4）系统的双向集成接口和协同方式。

### D.21.1 B5 + B1（大纲系统）

| 协同点 | B1 提供 | B5 提供 | 协同方式 |
|------|--------|------|----------|
| 卷纲线规划 | 卷纲编辑器 | 线出场计划模板 | 卷纲中嵌入线出场计划 |
| 章节大纲 | 章节大纲编辑器 | 章节所属线标记 | 大纲节点关联叙事线 |
| 大纲变更 | 大纲版本管理 | 存档点/依赖更新 | 大纲变更触发 B5 数据同步 |
| 写作进度 | 大纲完成度 | 线进度追踪 | 双向同步 |

**集成接口**：
```
B1 → B5：
- outline_node_created(node_id, line_ids)  # 大纲节点创建时通知B5
- outline_node_updated(node_id, changes)    # 大纲节点更新时通知B5
- outline_node_deleted(node_id)             # 大纲节点删除时通知B5

B5 → B1：
- line_status_changed(line_id, new_status)  # 线状态变更时通知B1
- line_progress_updated(line_id, chapter)   # 线进度更新时通知B1
```

### D.21.2 B5 + B2（时间系统）

| 协同点 | B2 提供 | B5 提供 | 协同方式 |
|------|--------|------|----------|
| 单线时间管理 | 章节内时间流逝追踪 | 跨线时间对齐 | B4 的时间数据作为 B5 时间锚点的来源 |
| 时间异常检测 | 单线内时间跳跃检测 | 跨线时间一致性检查 | B5 调用 B2 的检查函数 |
| 时间线展示 | 单线时间轴可视化 | 全局时间轴可视化 | B5 的甘特图视图集成 B2 的时间轴 |

**集成接口**：
```
B2 → B5：
- chapter_time_updated(chapter_id, narrative_time, absolute_time)
- time_anomaly_detected(chapter_id, anomaly_type, description)

B5 → B2：
- request_time_check(line_id, chapter_range)  # 请求B2检查某线的时间
```

### D.21.3 B5 + B3（伏笔系统）

| 协同点 | B3 提供 | B5 提供 | 协同方式 |
|------|--------|------|----------|
| 单线伏笔管理 | 伏笔的创建、追踪、回收 | 跨线伏笔标签 | B3 的伏笔表扩展跨线字段 |
| 因果链 | 单线内的因果链追踪 | 跨线因果链 | B5 的依赖图包含因果依赖 |
| 伏笔提醒 | 单线内伏笔回收提醒 | 跨线伏笔回收提醒 | B5 在合适的线上提醒回收 |

**集成接口**：
```
B3 → B5：
- foreshadowing_created(fs_id, line_id, content)
- foreshadowing_harvested(fs_id, line_id, chapter)

B5 → B3：
- request_cross_line_check(fs_id)  # 请求检查伏笔的跨线状态
- add_cross_line_tag(fs_id, target_line_id, relation)
```

### D.21.4 B5 + B4（风格系统）

| 协同点 | B4 提供 | B5 提供 | 协同方式 |
|------|--------|------|----------|
| 视角风格 | 视角规则和约束 | 线切换时的视角提醒 | B4 的视角规则附加到每条线 |
| 语言风格 | 风格宪法和规则 | 按线定制风格 | 每条线可以有自己的风格覆盖 |
| 一致性检查 | 文风一致性检查 | 跨线文风一致性 | B5 检查不同线之间的文风差异 |

**集成接口**：
```
B4 → B5：
- style_rules_updated(line_id, rules)  # 风格规则更新时通知B5

B5 → B4：
- get_line_style_rules(line_id)         # 获取某条线的风格规则
- check_cross_line_style(line_a_id, line_b_id)  # 检查跨线文风一致性
```

---

## D.22 成本控制与降级策略

> 📋 **摘要**：分析 B5 各层 Token 消耗，定义三级降级策略（算法层永不降级），提供缓存、批量检查等成本优化建议。

### D.22.1 Token 消耗分析

B5 的各层 Token 消耗如下：

<!-- 表格说明：B5各层Token消耗分析，含单次消耗、触发频率和每章消耗 -->
| 层级 | 机制 | 单次 Token 消耗 | 触发频率 | 每章消耗 |
|------|------|------|----------|------|
| 算法层 | M4 全局时间轴 | 0 | 每章 1-2 次 | 0 |
| 算法层 | M6 依赖图 | 0 | 每章 1 次 | 0 |
| 算法层 | M8 线拓扑变更 | 0 | 按需 | 0 |
| 算法层 | M9 双层状态 | 0 | 每章多次 | 0 |
| 状态层 | M7 生命周期 | 0 | 每章 1 次 | 0 |
| 数据层 | M1 存档点 | 0 | 每章 1-2 次 | 0 |
| 数据层 | M5 知识背包 | 0 | 每章多次 | 0 |
| AI 层 | M2 交接文档 | 500-1000 | 每次线切换 | 500-1000 |
| AI 层 | S1 节奏建议 | 500-1000 | 每次线切换 | 500-1000 |
| Agent 层 | M3 AI 助手 | 1000-2000 | 每章 1-2 次 | 1000-2000 |
| Agent 层 | M12 审核 Agent | 1000-2000 | 每章 1 次 | 1000-2000 |
| 扩展层 | M10 伏笔标签 | 0 | 按需 | 0 |
| 扩展层 | S2 失败模式库 | 0 | 按需 | 0 |
| 扩展层 | S3 预设 | 0 | 一次性 | 0 |

**每章总 Token 消耗**（L1 半自动模式）：
- 假设每章切换 1 次线：M2(750) + S1(750) + M3(1500) + M12(1200) = **约 4200 token**
- 不切换线时：M3(1500) + M12(1200) = **约 2700 token**

### D.22.2 三级降级策略

当系统资源不足或 AI 服务不可用时，按以下策略降级：

| 等级 | 触发条件 | 降级措施 | 功能保留 | 功能损失 |
|------|----------|------|----------|------|
| 1 级 | Token 预算不足 | 关闭 M12 全量审核，只保留 1 级审核 | M1-M11 全部保留 | M12 只做基础检查 |
| 2 级 | AI 服务响应慢 | 关闭 M3 主动模式，改为被动响应 | M1-M2, M4-M11 保留 | M3 不再主动提醒 |
| 3 级 | AI 服务不可用 | 关闭所有 AI 功能 | M1, M4-M11（算法层+数据层）保留 | M2, M3, M12, S1 不可用 |

**降级原则**：
1. **算法层和数据层永不降级**：这些是确定性计算，不依赖 AI，始终可用。
2. **展示层永不降级**：仪表盘是纯前端功能，不依赖 AI。
3. **AI 层优先降级**：交接文档和节奏建议是"锦上添花"，可以牺牲。
4. **Agent 层最后降级**：AI 助手和审核 Agent 是最有价值的 AI 功能，尽量保留。

### D.22.3 成本优化建议

1. **缓存机制**：交接文档生成后缓存，同一存档点不重复生成。
2. **批量检查**：M12 审核可以将多个检查项合并为一次 AI 调用。
3. **增量更新**：存档点只更新变化的部分，而不是每次全量生成。
4. **本地模型**：简单的分类和提取任务可以使用本地小模型，减少 API 调用。

---

## D.23 MVP 规格

> 📋 **摘要**：定义最小可行产品范围，包含 M1 存档点、M4 时间轴、M5 知识背包、M7 生命周期、M11 仪表盘 5 个核心机制，预估 15 个工作日。

### D.23.1 MVP 范围

MVP（最小可行产品）包含以下机制：

<!-- 表格说明：B5 MVP范围，列出各机制是否包含及功能范围 -->
| 机制 | 包含？ | MVP 中的功能范围 |
|------|--------|------|
| M1 存档点 | **包含** | 完整功能：自动创建、恢复摘要、SQL 存储 |
| M2 交接文档 | 不包含 | — |
| M3 AI 助手 | 不包含 | — |
| M4 时间轴 | **包含** | 基础功能：时间事件记录、时间对齐检查 |
| M5 知识背包 | **包含** | 基础功能：知识记录、泄漏检测 |
| M6 依赖图 | 不包含 | — |
| M7 生命周期 | **包含** | 完整功能：状态机、状态转换 |
| M8 线拓扑变更 | 不包含 | — |
| M9 双层状态 | 不包含 | — |
| M10 伏笔标签 | 不包含 | — |
| M11 仪表盘 | **包含** | 基础功能：概览视图、甘特图视图 |
| M12 审核 Agent | 不包含 | — |
| S1 节奏建议 | 不包含 | — |
| S2 失败模式库 | 不包含 | — |
| S3 预设 | 不包含 | — |
| S4 自动化策略 | **包含** | 仅 L0 手动模式 |

### D.23.2 MVP 功能清单

**M1 存档点系统**：
- [x] NarrativeLineSavepoint 数据结构
- [x] 线切换时自动创建存档点
- [x] 章节完成时自动创建存档点
- [x] 恢复摘要展示
- [x] SQL 存储和查询

**M4 全局时间轴**：
- [x] GlobalTimeline 数据结构
- [x] TimeCursor 数据结构
- [x] TimelineEvent 数据结构
- [x] 时间事件记录
- [x] 基础时间对齐检查
- [x] SQL 存储

**M5 角色知识背包**：
- [x] KnowledgePack 数据结构
- [x] KnowledgeItem 数据结构
- [x] 知识记录和查询
- [x] 基础信息泄漏检测
- [x] SQL 存储

**M7 叙事线生命周期**：
- [x] 状态机（created/active/paused/converging/ended/interrupted）
- [x] 状态转换规则
- [x] narrative_lines SQL 表

**M11 叙事线仪表盘**：
- [x] 概览视图（线卡片列表）
- [x] 甘特图视图（时间轴展示）
- [x] 仪表盘数据 API（概览+甘特图）

### D.23.3 开发量估算

| 模块 | 工作内容 | 预估工时 |
|------|----------|------|
| 数据层 | SQL 表设计、数据模型、基础 CRUD | 2 天 |
| M1 存档点 | 存档点创建/恢复/展示 | 3 天 |
| M4 时间轴 | 时间事件记录/对齐检查 | 2 天 |
| M5 知识背包 | 知识记录/泄漏检测 | 2 天 |
| M7 生命周期 | 状态机/转换规则 | 1 天 |
| M11 仪表盘 | 前端界面+API | 3 天 |
| 集成测试 | 端到端测试 | 2 天 |
| **总计** | | **约 15 个工作日** |

### D.23.4 MVP 覆盖率分析

| 问题 | MVP 覆盖 | 覆盖方式 |
|------|---------|------|
| Q1 上下文恢复 | **部分覆盖** | M1 存档点提供基础恢复，缺少 M2 交接文档的自然语言摘要 |
| Q2 进度和关系可视化 | **部分覆盖** | M11 仪表盘提供概览和甘特图，缺少 M6 依赖图 |
| Q3 时间一致性 | **覆盖** | M4 时间轴提供基础时间对齐检查 |
| Q4 信息追踪 | **覆盖** | M5 知识背包提供知识记录和泄漏检测 |
| Q5 状态一致 | **未覆盖** | 需要 M9 双层状态 |
| Q6 伏笔追踪 | **未覆盖** | 需要 M10 伏笔跨线标签 |
| Q7 切换时机 | **未覆盖** | 需要 S1 节奏建议 |
| Q8 读者记忆 | **未覆盖** | 需要 M2 读者前情提要 |

**MVP 总体覆盖率：50-60%**，覆盖了最核心的数据基础设施和基础可视化功能。

### D.23.5 后续迭代计划

| 迭代 | 新增机制 | 目标覆盖率 |
|------|----------|------|
| MVP | M1+M4+M5+M7+M11 | 50-60% |
| v1.1 | +M2+M9+M6 | 75-80% |
| v1.2 | +M3+M12+S1 | 90-95% |
| v1.3 | +M8+M10+S2+S3+S4 | 100% |

---

> **版本历史**
> - v1.0：初版完成（56 思路→12 核心机制+4 辅助机制+6 层架构）
> - v1.1：统一架构迁移说明添加（#附录 G 对齐）

---

<a id="appendix-e"></a>

## 附录 E B4 盲区补充与迭代设计

> 📍 附录 E：B4 长程风格一致性的三轮盲区补充设计（E.1-E.24），从附录 C 分离独立
>
> 本附录包含 B4 模块的三轮迭代补充设计，按机制编号组织：
> - **E.1-E.8**：Round 10 补充（原 C.28，8 个子节）
> - **E.9-E.16**：Round 11 补充（原 C.29，8 个子节）
> - **E.17-E.24**：Round 12 补充（原 C.30，8 个子节）
>
> 各子节已标注对应的附录 C 主节编号，实现时应与对应章节一并阅读。

> **版本**：v1.0 | **日期**：2026-04-18 | **状态**：从附录 C 分离独立

---

## E.1-E.8 盲区补充（Round 10）

> 📋 **摘要**：汇总 Round 10 深度优化中发现的 8 个盲区补充，聚焦意图状态机、过渡算法、人机边界粒度等工程实现深层问题。

本章汇总 Round 10 深度优化中发现的 8 个盲区补充。这些补充解决了前 9 轮设计中未被充分覆盖的关键问题。

### E.1 M2 意图生命周期状态机

> **设计参考**：基础实现见 C.5 5.3-5.5 节。本节为 Round 10 补充内容。
> 📋 本节为 [C.5 M2 风格意图注册表](#c5-m2 风格意图注册表) 的工程实现补充，建议实现时与对应章节一并阅读。

#### E.1.1 问题背景

Round 9 中 M2 仅定义了意图的基本字段，但缺少完整的状态管理机制。当作者注册的风格意图在执行过程中遇到各种情况（提前完成、部分完成、需要延长、与其他意图冲突）时，系统缺乏明确的处理规则。

#### E.1.2 完整状态转换图

完整状态机定义见 C.5 5.3 节。本节补充完整的 ASCII 状态转换图，便于直观理解各状态间的流转关系：

```text
                    ┌──────────────┐
                    │  registered  │ ← 作者注册意图
                    └──────┬───────┘
                           │ 章节进入 range_start
                           ▼
                    ┌──────────────┐
            ┌──────│    active    │──────┐
            │      └──────┬───────┘      │
            │             │ 章节到达 range_end
            │             ▼              │
            │      ┌──────────────┐      │
            │      │  verifying   │      │
            │      └──┬───┬───┬───┘      │
            │         │   │   │          │
            │    score>0.7  │  score<0.4 │
            │         │   │   │          │
            │         ▼   ▼   ▼          │
            │  ┌────────┐ ┌──────────┐   │
            │  │completed│ │abandoned │   │
            │  └────────┘ └──────────┘   │
            │         │                   │
            │    0.4≤score≤0.7           │
            │         │                   │
            │         ▼                   │
            │  ┌────────────┐             │
            │  │ incomplete │─────────────┘
            │  └─────┬──────┘  extension_count < 3
            │        │ 申请延长
            │        ▼
            │  ┌──────────────┐
            └──│  verifying   │ 重新验证
               └──────────────┘
```

#### E.1.3 paused 状态处理逻辑

第 5 章 5.4 节定义了重叠处理的基本规则，本节补充 `paused` 状态的完整处理流程：

1. **检测重叠**：新意图注册时，检查其 `chapter_range` 是否与任何 `active` 状态的意图重叠
2. **创建重叠组**：将重叠的意图归入同一个 `overlap_group`
3. **暂停后注册的意图**：后注册的意图状态设为 `paused`，`paused_by_intent_id` 指向前一个意图
4. **自动恢复**：前一个意图完成后，检查 `overlap_group` 中是否有被暂停的意图，自动恢复为 `active`

> **SQL Schema**：完整建表语句见 C.5 5.5 节，`style_intents` 表已包含 `paused_by_intent_id`、`overlap_group_id` 等字段。

---

### E.2 M17 过渡控制完整算法

> **设计参考**：基础实现见 C.20 20.2-20.3 节。本节为 Round 10 补充内容。
> 📋 本节为 [C.20 M17 风格过渡控制](#c20-m17 风格过渡控制) 的工程实现补充，建议实现时与对应章节一并阅读。

#### E.2.1 问题背景

Round 9 中 M17 仅提到"风格变化时的缓冲区"概念，但缺少具体的过渡曲线算法和过渡期间的阈值调整规则。作者注册风格意图后，系统如何控制风格从旧到新的平滑过渡，是保证阅读体验的关键。

#### E.2.2 过渡曲线算法

`calculate_transition_progress()` 函数的完整实现见 C.20 20.2 节，支持 gradual/abrupt/oscillating 三种曲线类型。

#### E.2.3 曲线类型选择策略

C.20 20.2 节列出了各曲线类型的适用场景。本节补充意图类型与曲线的推荐映射关系：

| 意图类型 | 推荐曲线 | 理由 |
|------|----------|------|
| evolution（渐进演变） | gradual | 风格缓慢变化，读者几乎无感知 |
| contrast（强烈对比） | abrupt | 配合情节突变，风格快速切换 |
| return（回归旧风格） | gradual | 回归过程应平滑，避免突兀 |
| experiment（风格实验） | oscillating | 新旧风格交替，最终稳定在新风格 |

#### E.2.4 过渡期间阈值调整

```python
def get_transition_thresholds(is_in_transition: bool) -> dict:
    """
    获取过渡期间的调整后阈值

    参数:
        is_in_transition: 是否处于风格过渡期

    返回:
        dict: 各检测机制的阈值配置
    """
    if not is_in_transition:
        return {
            "drift_cosine_sim": 0.85,   # 正常漂移阈值
            "ai_flavor_warning": 30,     # 正常AI味警告阈值
            "ai_flavor_severe": 50,      # 正常AI味严重阈值
        }

    # 过渡期间放宽阈值，允许风格变化
    return {
        "drift_cosine_sim": 0.70,       # 放宽漂移阈值
        "ai_flavor_warning": 45,         # 放宽AI味警告阈值
        "ai_flavor_severe": 65,          # 放宽AI味严重阈值
    }
```

#### E.2.5 过渡进度应用

```python
def blend_style_vectors(
    from_vector: list[float],
    to_vector: list[float],
    progress: float
) -> list[float]:
    """
    根据过渡进度混合两个风格向量

    参数:
        from_vector: 旧风格向量
        to_vector: 新风格向量
        progress: 过渡进度（0.0=完全旧风格, 1.0=完全新风格）

    返回:
        list[float]: 混合后的风格向量
    """
    return [
        f * (1 - progress) + t * progress
        for f, t in zip(from_vector, to_vector)
    ]
```

---

### E.3 M18 人机边界管理粒度规则

> **设计参考**：基础实现见 C.21 21.2-21.5 节。本节为 Round 10 补充内容。
> 📋 本节为 [C.21 M18 人机边界管理](#c21-m18 人机边界管理) 的工程实现补充，建议实现时与对应章节一并阅读。

#### E.3.1 问题背景

Round 9 中 M18 仅提到"AI 生成内容标记"的基本概念，但缺少具体的标记粒度规则、修改比例计算方法和存储方案。在实际使用中，人机协作写作的内容往往是混合来源的，需要精确的标记机制。

#### E.3.2 三级标记粒度

三级标记粒度的定义见 C.21 21.2 节（段落级/句子级/词级）。本节补充各粒度的详细使用规则：

**段落级标记**（最粗粒度）：
- 当整个段落的来源一致时使用
- 标记整个段落的 `source` 为 `human`、`ai` 或 `ai_rewritten_human`
- `sentence_index` 为 `NULL`

**句子级标记**（中等粒度）：
- 当段落内混合了人写和 AI 生成的内容时使用
- 对每个句子分别标记来源
- `sentence_index` 从 0 开始递增

**词级标记**（最细粒度）：
- 用于关键改写位置的精确标记
- 存储在单独的 `content_authorship_details` 表中（见附录 G 统一底层架构）
- 记录具体的词/短语级别的改写位置

#### E.3.3 修改比例计算

`calculate_modification_ratio()` 函数实现见 C.21 21.3 节。

#### E.3.4 AI 比例影响检测严格度

检测严格度系数公式见 C.21 21.4 节（`strictness = 1.0 + ai_ratio * 0.5`）。

#### E.3.5 SQL Schema

`content_authorship_marks` 主表见 C.21 21.5 节。本节补充词级标记详情子表：

```sql
-- 词级标记详情表（Round 10新增）
CREATE TABLE content_authorship_details (
    id UUID PRIMARY KEY,
    mark_id UUID REFERENCES content_authorship_marks(id),
    start_offset INT NOT NULL,          -- 改写起始位置（字符偏移）
    end_offset INT NOT NULL,            -- 改写结束位置
    original_text TEXT,                 -- 原始文本片段
    modified_text TEXT,                 -- 修改后文本片段
    change_type VARCHAR(20),            -- replace/insert/delete
    created_at TIMESTAMP DEFAULT NOW()
);
-- ER关系：本表通过 work_id 关联到 works(id)；通过 mark_id 关联到 content_authorship_marks(id)
```

---

### E.4 M19 跨作品风格导入机制

> **设计参考**：基础实现见 C.22 22.3 节。本节为 Round 10 补充内容。
> 📋 本节为 [C.22 M19 跨作品风格管理](#c22-m19 跨作品风格管理) 的工程实现补充，建议实现时与对应章节一并阅读。

#### E.4.1 问题背景

Round 9 中 M19 仅提到"多作品风格隔离"，但缺少跨作品风格复用的具体机制。作者在创作系列作品或同类型作品时，往往希望复用已验证的风格配置。

#### E.4.2 选择性维度导入

选择性维度导入的概念见 C.22 22.3.1 节。本节补充各维度的详细数据字段定义：

```python
# 可导入的风格维度
IMPORTABLE_DIMENSIONS = {
    "syntax": {
        "name": "句法维度",
        "description": "句长分布、标点密度等基础句式风格",
        "data_keys": ["avg_sentence_length", "sentence_length_std", "punctuation_densities"],
    },
    "vocabulary": {
        "name": "词汇维度",
        "description": "禁用词、偏好词、词汇丰富度等用词风格",
        "data_keys": ["banned_words", "preferred_words", "ttr", "avg_word_length"],
    },
    "sensory": {
        "name": "感官维度",
        "description": "五感词密度、意象偏好等描写风格",
        "data_keys": ["sensory_densities", "imagery_preferences"],
    },
    "emotion": {
        "name": "情感维度",
        "description": "情感词密度、情感波动率等情感表达风格",
        "data_keys": ["emotion_densities", "emotion_volatility"],
    },
}
```

#### E.4.3 适配度评分

```python
def calculate_style_compatibility(
    source_style_vector: list[float],
    target_constitution_vector: list[float],
    target_genre: str,
    source_genre: str
) -> dict:
    """
    计算导入风格与目标作品的适配度

    参数:
        source_style_vector: 源作品的风格向量
        target_constitution_vector: 目标作品的风格宪法向量
        target_genre: 目标作品类型
        source_genre: 源作品类型

    返回:
        dict: 包含总分和各维度分数的适配度报告
    """
    # 向量相似度评分
    vector_similarity = cosine_sim(source_style_vector, target_constitution_vector)

    # 类型匹配度评分
    genre_match = 1.0 if target_genre == source_genre else 0.6

    # 综合适配度
    overall = vector_similarity * 0.7 + genre_match * 0.3

    return {
        "overall": round(overall, 2),
        "vector_similarity": round(vector_similarity, 2),
        "genre_match": genre_match,
        "recommendation": "推荐导入" if overall >= 0.75 else "谨慎导入" if overall >= 0.6 else "不建议导入"
    }
```

#### E.4.4 风险控制

```python
def apply_import_risk_control(work_id: str, import_dimensions: list[str]) -> dict:
    """
    应用导入风险控制措施

    参数:
        work_id: 目标作品ID
        import_dimensions: 导入的维度列表

    返回:
        dict: 风险控制配置
    """
    return {
        # 加强监控的章节数
        "enhanced_monitoring_chapters": 5,

        # 临时收紧的漂移阈值
        "temporary_drift_threshold": 0.90,  # 从0.85提升到0.90

        # 监控结束条件
        "monitoring_end_condition": "连续3章适配度评分>=0.85",

        # 恢复正常阈值后的确认
        "recovery_requires_confirmation": True,
    }
```

---

### E.5 M3 Welford 增量算法实现

> **设计参考**：基础实现见 C.6 6.4 节。本节为 Round 10 补充内容。
> 📋 本节为 [C.6 M3 算法统计引擎](#c6-m3 算法统计引擎) 的工程实现补充，建议实现时与对应章节一并阅读。

#### E.5.1 问题背景

Round 9 中 M3 的 50 维特征提取算法假设可以一次性处理全部文本数据。但对于千万字级的长篇作品，一次性加载全部数据进行统计是不现实的。需要增量算法支持流式处理。

#### E.5.2 Welford 算法原理

Welford 在线算法是一种数值稳定的增量均值和方差计算方法：
- 每次只处理一个新数据点，无需存储历史数据
- 时间复杂度 O(1)每次更新，空间复杂度 O(d)（d 为维度数）
- 数值稳定性优于朴素的两遍扫描算法

#### E.5.3 扩展方法

`WelfordStyleStats` 类的基础方法（`__init__`、`update`、`get_variance`、`get_global_mean_vector`）见 C.6 6.4 节。本节补充以下扩展方法：

```python
# --- 摘要：WelfordStyleStats扩展方法（C.28.5.3） —— Welford在线算法的扩展：标准差/全局均值向量/余弦相似度/重置等 ---
class WelfordStyleStats:
    """Welford在线算法：增量计算风格统计量，支持千万字级作品"""
    # 基础方法（__init__, update, get_variance, get_global_mean_vector）见 C.6 6.4节

    def get_std(self, dim: str) -> float:
        """获取某维度的标准差"""
        return self.get_variance(dim) ** 0.5

    def get_global_std_vector(self) -> dict[str, float]:
        """
        获取全局标准差向量（用于异常检测）

        返回:
            dict: 各维度的标准差
        """
        return {dim: self.get_std(dim) for dim in self.stats}

    def get_chapter_count(self) -> int:
        """获取已处理的章节数"""
        if not self.stats:
            return 0
        # 所有维度的count应该相同，取第一个
        return next(iter(self.stats.values()))["count"]

    def merge(self, other: 'WelfordStyleStats') -> None:
        """
        合并另一个WelfordStyleStats实例（用于并行计算后合并）

        参数:
            other: 另一个WelfordStyleStats实例
        """
        for dim in other.stats:
            if dim not in self.stats:
                # 直接复制
                self.stats[dim] = other.stats[dim].copy()
                continue

            # 并行合并公式
            a = self.stats[dim]
            b = other.stats[dim]
            count = a["count"] + b["count"]

            if count == 0:
                continue

            delta = b["mean"] - a["mean"]
            new_mean = (a["count"] * a["mean"] + b["count"] * b["mean"]) / count
            new_M2 = a["M2"] + b["M2"] + delta * delta * a["count"] * b["count"] / count

            self.stats[dim] = {
                "count": count,
                "mean": new_mean,
                "M2": new_M2
            }
```

#### E.5.4 使用示例

```python
# 初始化统计引擎
stats = WelfordStyleStats()

# 每写完一章，增量更新
for chapter_num in range(1, 1001):
    chapter_text = load_chapter(work_id, chapter_num)
    features = extract_50d_features(chapter_text)
    stats.update(features)

# 获取全局风格基准线
baseline = stats.get_global_mean_vector()
print(f"已统计 {stats.get_chapter_count()} 章")
print(f"平均句长: {baseline['avg_sentence_length']:.1f}")
print(f"词汇丰富度: {baseline['ttr']:.3f}")
```

---

### E.6 M13 完整 Prompt 模板

> **设计参考**：基础实现见 C.16 16.2-16.3 节。本节为 Round 10 补充内容。
> 📋 本节为 [C.16 M13 生成控制](#c16-m13 生成控制) 的工程实现补充，建议实现时与对应章节一并阅读。

#### E.6.1 问题背景

Round 9 中 M13 仅提到"Prompt 分层+动态组装"的概念，但缺少具体的模板内容和 Token 预算分配。Prompt 的质量直接影响生成内容的风格一致性。

#### E.6.2 4 层 Prompt 架构（完整模板）

4 层 Prompt 架构的概览见 C.16 16.2 节。本节补充各层的完整模板内容：

**Layer 1 - System Prompt（约 200 tokens，固定）**

```
你是一位专业的网文写作助手。你的核心原则：
1. 严格遵循作者的风格宪法，这是最高优先级
2. 保持与当前章节前文的风格一致
3. 坚决避免AI味表达（如"宛如"、"缓缓地"、"心中涌起"等）
4. 尊重场景类型的风格差异（战斗场景用短句，情感场景允许修饰）
5. 保持角色对话的独特性，每个角色有自己的说话方式
```

**Layer 2 - Style Prompt（约 800 tokens，动态）**

```
【风格宪法】
{constitution_summary}

【当前风格基准】（基于最近10章统计）
- 句长均值: {avg_len}字
- 词汇丰富度(TTR): {ttr}
- "的"字密度: {de_density}
- 对话占比: {dialogue_ratio}
- 感官词密度: {sensory_density}

【场景风格要求】
当前场景: {scene_type}
风格指导: {scene_style_guide}

【禁用表达】（绝对不可使用）
{banned_patterns}

【偏好表达】（优先使用）
{preferred_patterns}

【活跃风格意图】
{active_intents_description}
```

**Layer 3 - Content Prompt（约 1800 tokens，动态）**

```
【当前情节】
{plot_summary}

【在场角色及其风格】
{characters_with_styles}
# [注] 以下为示例，实际变量由{characters_with_styles}统一提供
# [注] - 角色A: {style_description_a}
# [注] - 角色B: {style_description_b}

【角色运行时状态】
{character_runtime_context}
# [注] character_runtime_context变量说明：
     值来源：B6 ContextRouter character_runtime通道（#16.6），
     包含每个在场角色的arc_phase（角色弧阶段）、current_emotion（当前情感）、current_goals（当前目标）。
     用于确保生成内容与角色当前状态一致。 -->

【情感基调】
{emotion_tone}

【节奏要求】
{pacing_guide}
# [注] pacing_guide变量说明：同第16章Layer 3，值来自B8 RhythmIntegration（#16.7），
     pacing枚举已统一为5值（slow/medium/buildup/fast/climax）。
     注意：pacing_guide是rhythm_context_summary（B8）的子集字段。 -->

【节奏上下文】
{rhythm_context_summary}
# [注] rhythm_context_summary变量说明：
     值来源：B8 RhythmProfiler.get_rhythm_context()（#16.2），
     包含prev_chapter_rhythm（前章节奏画像）、expected_pacing（期望节奏）、
     rhythm_direction（节奏变化方向）、active_rhythm_issues（活跃节奏问题）。
     pacing_guide为rhythm_context_summary中rhythm_guide子字段的简化版。 -->

【本章目标】
{chapter_objectives}
```

**Layer 4 - Context Prompt（约 1800 tokens，动态）**

```
【前文摘要】（最近3章）
{previous_chapter_summary}

【关键对话】（最近的重要对话）
{recent_dialogues}

【增强伏笔视图】
{foreshadowing_enhanced}
# [注] foreshadowing_enhanced变量说明：
     值来源：B7 ForeshadowCoordinator.inject_writing_context()（#16.5），
     包含增强的伏笔上下文（含关联角色、预期回收章节、紧迫度等结构化信息）。
     启用B7后，此变量替代下方的{active_foreshadowing}。 -->

【活跃伏笔】
{active_foreshadowing}
# [注] active_foreshadowing变量说明：
     值来源：B1 memory.get_active_foreshadowing()，
     当B7 ForeshadowCoordinator未启用时作为降级方案使用。
     启用B7后，建议优先使用{foreshadowing_enhanced}。 -->

【风格漂移警告】（如有）
{drift_warnings_if_any}
```

#### E.6.3 Token 预算分配

Token 预算分配表见 C.16 16.3 节。

#### E.6.4 动态组装逻辑

第 18 章定义了 4 层 Prompt 的静态结构，本节补充动态组装的完整实现：

```python
# --- 摘要：assemble_style_prompt() —— 动态组装4层风格Prompt（宪法/场景/对比/纠偏），含Token预算分配 ---
def assemble_style_prompt(
    work_id: str,
    chapter_num: int,
    scene_type: str,
    plot_context: dict
) -> list[dict]:
    """
    动态组装4层风格Prompt

    参数:
        work_id: 作品ID
        chapter_num: 当前章节号
        scene_type: 场景类型
        plot_context: 情节上下文

    返回:
        list[dict]: OpenAI格式的消息列表
    """
    messages = []

    # Layer 1: 固定System Prompt
    messages.append({
        "role": "system",
        "content": SYSTEM_PROMPT_TEMPLATE
    })

    # Layer 2: 动态Style Prompt
    # assemble_style_layer 实现规格：
    #   - 从B4 StyleConstitution读取风格参数（constitution_summary、banned_patterns、preferred_patterns、active_intents_description）
    #   - 从B2 StyleProfiler获取风格统计指标（avg_len、ttr、de_density、dialogue_ratio、sensory_density）
    #   - 从章纲元数据获取scene_type和scene_style_guide
    #   - 填充Layer 2模板变量，返回格式化的Style Prompt字符串
    #   - 实现阶段详细设计，此处定义接口契约
    style_prompt = assemble_style_layer(work_id, chapter_num, scene_type)
    messages.append({
        "role": "system",
        "content": style_prompt
    })

    # Layer 3: 动态Content Prompt
    # assemble_content_layer 实现规格：
    #   - 从B1 get_writing_context_from_outline()获取基础数据（plot_summary、emotion_tone、chapter_objectives、pacing_guide）
    #   - 从B6 ContextRouter character_runtime通道获取角色运行时状态（character_runtime_context）
    #   - 从B8 RhythmProfiler.get_rhythm_context()获取节奏上下文摘要（rhythm_context_summary）
    #   - 从B1/B6获取在场角色及风格描述（characters_with_styles）
    #   - 填充Layer 3模板变量，返回格式化的Content Prompt字符串
    #   - 实现阶段详细设计，此处定义接口契约
    content_prompt = assemble_content_layer(plot_context)
    messages.append({
        "role": "user",
        "content": content_prompt
    })

    # Layer 4: 动态Context Prompt
    # assemble_context_layer 实现规格：
    #   - 从B3记忆系统获取上下文（previous_chapter_summary、recent_dialogues）
    #   - 从B1 memory.get_active_foreshadowing()获取活跃伏笔（active_foreshadowing，B7未启用时的降级方案）
    #   - 从B7 ForeshadowCoordinator.inject_writing_context()获取增强伏笔视图（foreshadowing_enhanced，启用B7时优先使用）
    #   - 从B3 DriftDetector获取风格漂移警告（drift_warnings_if_any）
    #   - 填充Layer 4模板变量，返回格式化的Context Prompt字符串
    #   - 实现阶段详细设计，此处定义接口契约
    context_prompt = assemble_context_layer(work_id, chapter_num)
    messages.append({
        "role": "user",
        "content": context_prompt
    })

    return messages
```

---

### E.7 M15 可视化数据查询 API

> **设计参考**：基础实现见 C.18 18.2-18.3 节。本节为 Round 10 补充内容。
> 📋 本节为 [C.18 M15 可视化工具集](#c18-m15 可视化工具集) 的工程实现补充，建议实现时与对应章节一并阅读。

#### E.7.1 问题背景

Round 9 中 M15 列出了可视化类型（雷达图、漂移曲线等），但缺少前后端对接的 API 设计。前端需要标准化的数据接口来渲染各种可视化图表。

#### E.7.2 API 端点设计

API 端点列表见 C.18 18.3 节。本节补充各端点的完整 JSON 响应格式：

**雷达图数据**

```text
GET /api/works/{work_id}/style/radar?chapter={num}
```

返回：50 维特征归一化后的雷达图数据

```json
{
    "chapter_num": 42,
    "categories": [
        {"name": "句法特征", "dimensions": [
            {"name": "平均句长", "value": 0.65, "max": 1.0},
            {"name": "句长标准差", "value": 0.45, "max": 1.0}
        ]},
        {"name": "词汇特征", "dimensions": [
            {"name": "词汇丰富度", "value": 0.72, "max": 1.0},
            {"name": "四字成语密度", "value": 0.38, "max": 1.0}
        ]}
    ],
    "baseline": {
        "categories": [...]
    }
}
```

**漂移曲线数据**

```text
GET /api/works/{work_id}/style/drift?start={ch}&end={ch}
```

返回：章节间 cosine similarity 曲线数据

```json
{
    "start_chapter": 30,
    "end_chapter": 50,
    "data_points": [
        {"chapter": 30, "similarity": 0.92},
        {"chapter": 31, "similarity": 0.89},
        {"chapter": 32, "similarity": 0.78, "alert": "warning"}
    ],
    "thresholds": {
        "stable": 0.95,
        "warning": 0.85,
        "critical": 0.70
    },
    "active_intents": [
        {"id": "uuid", "range": [35, 40], "type": "evolution"}
    ]
}
```

**AI 味数据**

```text
GET /api/works/{work_id}/style/ai-flavor?start={ch}&end={ch}
```

返回：每章 AI 味评分 + 各模式命中详情

```json
{
    "start_chapter": 30,
    "end_chapter": 40,
    "chapters": [
        {
            "chapter": 30,
            "total_score": 22,
            "level": "good",
            "patterns": [
                {"name": "滥用比喻词", "count": 3, "weight": 0.8},
                {"name": "过度修饰", "count": 1, "weight": 0.7}
            ]
        }
    ],
    "trend": "stable"
}
```

**风格对比数据**

```text
GET /api/works/{work_id}/style/diff?ch_a={num}&ch_b={num}
```

返回：两章节 50 维特征差异对比

```json
{
    "chapter_a": 10,
    "chapter_b": 30,
    "overall_similarity": 0.82,
    "dimension_diffs": [
        {"name": "平均句长", "value_a": 18.5, "value_b": 22.3, "diff": 3.8, "direction": "increased"},
        {"name": ""的"字密度", "value_a": 0.032, "value_b": 0.045, "diff": 0.013, "direction": "increased", "alert": true}
    ],
    "top_changes": [
        {"dimension": ""的"字密度", "change_percent": 40.6, "severity": "high"}
    ]
}
```

**意象数据**

```text
GET /api/works/{work_id}/style/imagery?start={ch}&end={ch}
```

返回：意象使用频率和分布数据

```json
{
    "start_chapter": 20,
    "end_chapter": 40,
    "imagery_stats": [
        {
            "category": "自然意象",
            "items": [
                {"word": "月", "count": 15, "first_chapter": 3, "last_chapter": 38, "trend": "stable"},
                {"word": "风", "count": 28, "first_chapter": 1, "last_chapter": 40, "trend": "increasing"}
            ]
        }
    ],
    "repetition_alerts": [
        {"word": "月", "chapters": [35, 36, 37], "count": 8, "threshold": 5}
    ],
    "association_network": {
        "edges": [
            {"source": "月", "target": "风", "co_occurrence": 12},
            {"source": "剑", "target": "血", "co_occurrence": 8}
        ]
    }
}
```

---

### E.8 M9 意象分类与追踪系统

> **设计参考**：基础实现见 C.12 12.3 节。本节为 Round 10 补充内容。
> 📋 本节为 [C.12 M9 感官/意象系统](#c12-m9 感官意象系统) 的工程实现补充，建议实现时与对应章节一并阅读。

#### E.8.1 问题背景

Round 9 中 M9 仅提到"五感词典"，但缺少意象层面的追踪系统。意象是文学作品中反复出现的象征性元素，其使用频率和组合方式对风格有重要影响。缺少意象追踪会导致同一意象过度使用或意象组合缺乏变化。

#### E.8.2 6 大意象类别

6 大意象类别的定义见 C.12 12.3.1 节。

#### E.8.3 意象追踪实现

第 12 章 12.3.2-12.3.4 节定义了意象追踪、重复检测和关联网络的概念。本节补充完整的 Python 实现：

```python
# --- 摘要：ImageryTracker —— 意象追踪器，记录和分析6大类别意象的使用频率、分布和关联网络 ---
class ImageryTracker:
    """意象追踪器：记录和分析作品中意象的使用情况"""

    def __init__(self):
        # 6大意象类别的词典
        self.imagery_dict: dict[str, list[str]] = {
            "natural": ["月", "风", "雨", "雪", "花", "树", "山", "水", "云", "星"],
            "artifact": ["剑", "刀", "琴", "棋", "书", "画", "灯", "镜", "扇", "玉"],
            "body": ["眼", "手", "发", "唇", "肩", "背", "指", "眉", "腰", "足"],
            "space": ["天", "地", "门", "窗", "路", "桥", "塔", "城", "殿", "阁"],
            "time": ["晨", "暮", "春", "秋", "夜", "昼", "四季", "年华", "岁月", "时光"],
            "abstract": ["命", "缘", "道", "心", "梦", "魂", "血", "火", "冰", "光"],
        }

        # 意象使用记录
        # key: 意象词, value: {"first_chapter": int, "last_chapter": int, "counts": {chapter_num: count}}
        self.usage_records: dict[str, dict] = {}

    def track_chapter(self, chapter_num: int, chapter_text: str) -> dict:
        """
        追踪单章的意象使用

        参数:
            chapter_num: 章节号
            chapter_text: 章节文本

        返回:
            dict: 本章意象统计
        """
        chapter_imagery = {}

        for category, words in self.imagery_dict.items():
            for word in words:
                count = chapter_text.count(word)
                if count == 0:
                    continue

                # 更新使用记录
                if word not in self.usage_records:
                    self.usage_records[word] = {
                        "category": category,
                        "first_chapter": chapter_num,
                        "last_chapter": chapter_num,
                        "total_count": 0,
                        "chapter_counts": {},
                    }

                record = self.usage_records[word]
                record["last_chapter"] = max(record["last_chapter"], chapter_num)
                record["total_count"] += count
                record["chapter_counts"][chapter_num] = count

                chapter_imagery[word] = count

        return chapter_imagery

    def check_repetition(self, word: str, current_chapter: int,
                         window: int = 3, threshold: int = 5) -> dict | None:
        """
        检查意象是否在窗口期内过度重复

        参数:
            word: 意象词
            current_chapter: 当前章节号
            window: 检查窗口（章节数）
            threshold: 重复阈值

        返回:
            dict | None: 重复警告信息，无重复时返回None
        """
        if word not in self.usage_records:
            return None

        record = self.usage_records[word]
        window_start = current_chapter - window

        # 计算窗口内的使用次数
        window_count = sum(
            count for ch, count in record["chapter_counts"].items()
            if window_start <= ch <= current_chapter
        )

        if window_count > threshold:
            return {
                "word": word,
                "category": record["category"],
                "window_count": window_count,
                "threshold": threshold,
                "window_range": [window_start, current_chapter],
                "severity": "high" if window_count > threshold * 1.5 else "medium"
            }

        return None

    def build_association_network(self, chapter_text: str) -> dict[str, int]:
        """
        构建意象关联网络（基于共现关系）

        参数:
            chapter_text: 章节文本

        返回:
            dict: 意象共现计数 {"月-风": 3, "剑-血": 2, ...}
        """
        # 找出本章出现的所有意象
        found_words = set()
        for words in self.imagery_dict.values():
            for word in words:
                if word in chapter_text:
                    found_words.add(word)

        # 计算共现关系（同一句子中出现的意象对）
        import re
        sentences = re.split(r'[。！？]', chapter_text)
        co_occurrences: dict[str, int] = {}

        for sentence in sentences:
            sentence_words = set()
            for words in self.imagery_dict.values():
                for word in words:
                    if word in sentence:
                        sentence_words.add(word)

            # 生成所有意象对
            word_list = sorted(sentence_words)
            for i in range(len(word_list)):
                for j in range(i + 1, len(word_list)):
                    pair = f"{word_list[i]}-{word_list[j]}"
                    co_occurrences[pair] = co_occurrences.get(pair, 0) + 1

        return co_occurrences
```

#### E.8.4 重复检测规则

第 12 章 12.3.3 节定义了重复检测的基本概念。本节补充各类别的具体阈值配置：

| 意象类别 | 窗口期 | 默认阈值 | 说明 |
|------|--------|------|------|
| 自然意象 | 3 章 | 8 次 | 自然意象使用频率较高，阈值适当放宽 |
| 器物意象 | 3 章 | 6 次 | 器物意象与情节关联，阈值适中 |
| 身体意象 | 3 章 | 10 次 | 身体意象在人物描写中高频使用 |
| 空间意象 | 3 章 | 5 次 | 空间意象重复会显得单调 |
| 时间意象 | 3 章 | 6 次 | 时间意象用于节奏控制 |
| 抽象意象 | 3 章 | 4 次 | 抽象意象重复会削弱表现力 |

#### E.8.5 意象关联网络

意象关联网络的概念和构建方式见 C.12.3.4 节。完整的 `build_association_network()` 实现见 E.8.3 节 `ImageryTracker` 类。

---

> **版本历史**
> - v1.0：初始版本（20 机制+五层架构）
> - v1.1：Round 9 优化（8 个盲区补充，新增第 27 章）
> - v1.2：Round 10 优化（8 个盲区补充，新增第 28 章）
> - v1.3：Round 11 优化（8 个盲区补充，新增第 29 章）
> - v1.4：Round 12 优化（8 个盲区补充，新增第 30 章）

---

## E.9-E.16 盲区补充（Round 11）

> 📋 **摘要**：汇总 Round 11 的 8 个盲区补充，聚焦分词策略、动态指纹、自适应窗口、审核时机等工程实现层面问题。

本章汇总 Round 11 深度优化中发现的 8 个盲区补充。本轮聚焦于**工程实现层面**的深层问题，包括分词依赖、动态指纹、自适应窗口、审核时机、宪法对齐、冷启动、调度策略和根因分析。

### E.9 M3 中文分词策略与风格特征准确性保障

> 📋 本节为 [C.6 M3 算法统计引擎](#c6-m3 算法统计引擎) 的工程实现补充，建议实现时与对应章节一并阅读。

#### E.9.1 问题背景

M3 的 50 维特征中，词汇特征（12 维）和 N-gram 特征（8 维）都依赖分词结果。但中文分词存在严重的歧义性（如"南京市长江大桥"），分词错误会直接导致 TTR、词频统计、搭配提取等特征失真。当前设计完全未提及分词策略。

#### E.9.2 分词器选型

| 分词器 | 优点 | 缺点 | 适用度 |
|------|------|------|--------|
| jieba | 速度快、社区活跃、支持自定义词典 | 精度一般、未针对文学文本优化 | ⭐⭐⭐ |
| pkuseg | 领域细分（新闻/网络/医学等） | 领域不含文学、速度较慢 | ⭐⭐ |
| LAC（百度） | 词性标注精度高 | 依赖 PaddlePaddle、部署复杂 | ⭐⭐ |
| HanLP | 精度高、支持自定义 | 商用需授权 | ⭐⭐⭐ |

**推荐方案**：jieba + 自定义领域词典。理由：速度快（满足实时检测需求）、自定义词典可覆盖网文特有词汇、社区活跃易于维护。

#### E.9.3 风格领域专用词典

```python
# 网文风格领域专用词典（按类型分类）
STYLE_DOMAIN_DICT = {
    # 通用网文高频词（所有类型共用）
    "common": [
        "修炼", "境界", "突破", "灵气", "丹药", "法宝", "阵法",
        "宗门", "弟子", "长老", "掌门", "师兄", "师姐", "师弟", "师妹",
        "秘境", "历练", "机缘", "天劫", "渡劫", "飞升",
    ],
    # 玄幻/仙侠特有
    "xianxia": [
        "灵根", "筑基", "金丹", "元婴", "化神", "合体", "大乘",
        "剑意", "剑气", "剑阵", "飞剑", "法剑",
        "道心", "悟道", "天道", "因果", "劫难",
    ],
    # 都市特有
    "urban": [
        "总裁", "助理", "秘书", "合同", "股份", "集团",
        "咖啡", "红酒", "别墅", "跑车", "私人飞机",
    ],
    # 科幻特有
    "scifi": [
        "星际", "光年", "跃迁", "虫洞", "量子", "纳米",
        "人工智能", "基因", "克隆", "意识上传",
    ],
    # 历史特有
    "historical": [
        "殿下", "陛下", "臣", "朕", "孤", "本王",
        "奏折", "圣旨", "钦差", "府邸", "朝堂",
    ],
}

def load_custom_dictionary(work_genre: str) -> list[str]:
    """
    根据作品类型加载自定义词典

    参数:
        work_genre: 作品类型（xianxia/urban/scifi/historical等）

    返回:
        list[str]: 自定义词典词列表
    """
    # 通用词 + 类型专属词
    custom_words = STYLE_DOMAIN_DICT["common"]
    if work_genre in STYLE_DOMAIN_DICT:
        custom_words.extend(STYLE_DOMAIN_DICT[work_genre])

    return custom_words
```

#### E.9.4 分词结果缓存

```python
import hashlib
import json

class SegmentationCache:
    """分词结果缓存：同一章节不重复分词"""

    def __init__(self, cache_dir: str = None):  # 默认使用系统临时目录
        self.cache_dir = cache_dir

    def _get_cache_key(self, text: str) -> str:
        """基于文本内容生成缓存键"""
        return hashlib.md5(text.encode('utf-8')).hexdigest()

    def get(self, text: str) -> list[str] | None:
        """获取缓存的分词结果"""
        key = self._get_cache_key(text)
        cache_file = f"{self.cache_dir}/{key}.json"
        try:
            with open(cache_file, 'r') as f:
                data = json.load(f)
                # 验证文本未变化
                if data["text_hash"] == key:
                    return data["tokens"]
        except (FileNotFoundError, json.JSONDecodeError):
            pass
        return None

    def set(self, text: str, tokens: list[str]) -> None:
        """缓存分词结果"""
        key = self._get_cache_key(text)
        cache_file = f"{self.cache_dir}/{key}.json"
        data = {"text_hash": key, "tokens": tokens}
        try:
            with open(cache_file, 'w') as f:
                json.dump(data, f)
        except Exception as e:
            # 缓存写入失败不应中断主流程，仅记录调试日志
            logger.debug(f"分词缓存写入失败: {e}")
```

#### E.9.5 分词不确定性处理

对于存在歧义的文本片段，使用概率加权：

```python
def extract_features_with_uncertainty(
    text: str,
    seg_candidates: list[list[str]]  # 多种分词候选结果
) -> dict[str, tuple[float, float]]:
    """
    考虑分词不确定性的特征提取

    参数:
        text: 原始文本
        seg_candidates: 多种分词候选结果（由分词器返回的N-best结果）

    返回:
        dict: 每个特征的特征值及其不确定性（均值, 标准差）
    """
    # 对每种分词结果分别计算特征
    all_features = []
    for tokens in seg_candidates:
        features = extract_50d_features_from_tokens(tokens)
        all_features.append(features)

    # 计算各维度的均值和标准差
    result = {}
    for dim in all_features[0].keys():
        values = [f[dim] for f in all_features]
        mean_val = sum(values) / len(values)
        std_val = (sum((v - mean_val) ** 2 for v in values) / len(values)) ** 0.5
        result[dim] = (mean_val, std_val)

    return result
```

---

### E.10 M7 角色对话指纹的动态更新机制

> 📋 本节为 [C.10 M7 角色对话指纹](#c10-m7 角色对话指纹) 的工程实现补充，建议实现时与对应章节一并阅读。

#### E.10.1 问题背景

M7 提取了角色的对话指纹，但当前设计将指纹视为静态的。长篇网文中角色会经历性格成长，对话风格应随之变化。如果系统用"初始指纹"检测"成长后的对话"，会产生大量误报。

#### E.10.2 指纹版本管理

```sql
CREATE TABLE character_dialogue_fingerprints (
    id UUID PRIMARY KEY,
    work_id UUID REFERENCES works(id),
    character_id UUID REFERENCES unified_entities(id),  -- characters已迁移
    version INT NOT NULL DEFAULT 1,          -- 指纹版本号
    trigger_event TEXT,                       -- 触发更新的重大事件描述
    trigger_chapter INT NOT NULL,            -- 触发更新的章节号
    fingerprint JSONB NOT NULL,              -- 指纹数据
    is_active BOOLEAN DEFAULT TRUE,          -- 是否为当前活跃版本
    created_at TIMESTAMP DEFAULT NOW(),

    -- 指纹数据结构
    -- fingerprint: {
    --   "top_words": [{"word": "嘿嘿", "freq": 0.05}, ...],
    --   "avg_sentence_length": 12.5,
    --   "catchphrases": ["本座", "哼"],
    --   "particles": ["嘛", "呢", "罢了"],
    --   "addressing": {"self": "本座", "others": "尔等"},
    --   "tone_markers": ["冷笑", "淡淡地"],
    --   "style_vector": [0.12, 0.45, ...]  -- 20维对话风格向量
    -- }
);
-- ER关系：本表通过 character_id 关联到 unified_entities(id)
```

#### E.10.3 指纹更新触发条件

| 触发类型 | 条件 | 说明 |
|------|------|------|
| 重大事件 | 角色经历生死/背叛/觉醒等 | 大纲系统标记的重大角色事件 |
| 渐进漂移 | 连续 10 章对话指纹偏离>2σ | 自然成长导致的缓慢变化 |
| 作者手动 | 作者主动标记"角色性格变化" | 通过 M2 意图注册表关联 |
| 跨阶段 | 角色进入新的成长阶段 | 大纲系统中的角色弧线节点 |

#### E.10.4 指纹渐变过渡

```python
# --- 摘要：get_character_dialogue_style() —— 获取角色对话风格（考虑指纹版本过渡），支持渐变混合 ---
def get_character_dialogue_style(
    character_id: str,
    chapter_num: int,
    transition_range: int = 5  # 过渡章节数
) -> dict:
    """
    获取角色在指定章节的对话风格（考虑指纹版本过渡）

    参数:
        character_id: 角色ID
        chapter_num: 当前章节号
        transition_range: 指纹过渡的章节数

    返回:
        dict: 当前生效的对话风格指纹
    """
    # 获取该角色的所有指纹版本（按时间排序）
    fingerprints = db.query(
        "SELECT * FROM character_dialogue_fingerprints "
        "WHERE character_id = %s ORDER BY trigger_chapter",
        character_id
    )

    # 找到当前章节对应的指纹版本
    current_fp = None
    prev_fp = None
    for fp in fingerprints:
        if fp["trigger_chapter"] <= chapter_num:
            prev_fp = current_fp
            current_fp = fp
        else:
            break

    if prev_fp is None or current_fp is None:
        return current_fp["fingerprint"] if current_fp else {}

    # 计算过渡进度
    transition_start = current_fp["trigger_chapter"]
    raw_progress = (chapter_num - transition_start) / transition_range
    progress = min(1.0, max(0.0, raw_progress))

    # 使用Sigmoid平滑过渡
    import math
    smooth_progress = 1 / (1 + math.exp(-8 * (progress - 0.5)))

    # 混合新旧指纹的风格向量
    old_vector = prev_fp["fingerprint"]["style_vector"]
    new_vector = current_fp["fingerprint"]["style_vector"]
    blended = [
        o * (1 - smooth_progress) + n * smooth_progress
        for o, n in zip(old_vector, new_vector)
    ]

    # 返回混合后的指纹
    result = current_fp["fingerprint"].copy()
    result["style_vector"] = blended
    result["transition_progress"] = smooth_progress
    result["from_version"] = prev_fp["version"]
    result["to_version"] = current_fp["version"]

    return result
```

#### E.10.5 与 M2 意图注册表的关联

角色性格变化通过 M2 注册为风格意图：

```python
# 角色成长自动注册为风格意图
def register_character_growth_intent(
    work_id: str,
    character_id: str,
    character_name: str,
    growth_description: str,
    trigger_chapter: int,
    estimated_end_chapter: int
) -> str:
    """
    将角色性格变化注册为风格意图

    参数:
        work_id: 作品ID
        character_id: 角色ID
        character_name: 角色名称
        growth_description: 成长描述（如"经历背叛后变得冷硬"）
        trigger_chapter: 触发章节
        estimated_end_chapter: 预计完成章节

    返回:
        str: 意图ID
    """
    intent_id = str(uuid.uuid4())

    db.execute("""
        INSERT INTO style_intents (
            id, work_id, chapter_range_start, chapter_range_end,
            change_type, description, status
        ) VALUES (%s, %s, %s, %s, %s, %s, 'registered')
    """, (
        intent_id, work_id, trigger_chapter, estimated_end_chapter,
        "evolution",
        f"角色{character_name}性格变化：{growth_description}"
    ))

    return intent_id
```

---

### E.11 M11 自适应滑动窗口策略

> 📋 本节为 [C.14 M11 风格漂移检测](#c14-m11 风格漂移检测) 的工程实现补充，建议实现时与对应章节一并阅读。

#### E.11.1 问题背景

M11 固定使用 10 章为一个滑动窗口，但不同规模的作品中 10 章的含义完全不同。100 章作品中 10 章占 10%篇幅，而 1000 章作品中仅占 1%。

#### E.11.2 自适应窗口大小计算

```python
def calculate_window_size(
    total_chapters: int,
    avg_chapter_words: int,
    target_window_words: int = 50000  # 目标窗口字数：5万字
) -> dict:
    """
    计算自适应的滑动窗口大小

    参数:
        total_chapters: 作品总章数（或已完成章数）
        avg_chapter_words: 平均每章字数
        target_window_words: 目标窗口字数（默认5万字）

    返回:
        dict: 窗口配置
    """
    # 基于字数的窗口大小
    word_based_window = max(3, round(target_window_words / avg_chapter_words))

    # 基于总章数的自适应调整
    if total_chapters <= 30:
        # 短篇：窗口 = 总章数的30%
        adaptive_window = max(3, round(total_chapters * 0.3))
    elif total_chapters <= 100:
        # 中篇：窗口 = 总章数的15%
        adaptive_window = max(5, round(total_chapters * 0.15))
    elif total_chapters <= 500:
        # 长篇：窗口 = 总章数的8%
        adaptive_window = max(8, round(total_chapters * 0.08))
    else:
        # 超长篇：窗口 = 总章数的5%，上限30章
        adaptive_window = min(30, max(10, round(total_chapters * 0.05)))

    # 取两种策略的较小值（更敏感）
    final_window = min(word_based_window, adaptive_window)

    return {
        "window_size": final_window,
        "word_based_window": word_based_window,
        "adaptive_window": adaptive_window,
        "window_word_estimate": final_window * avg_chapter_words,
        "rationale": f"基于{total_chapters}章作品（均{avg_chapter_words}字/章），"
                     f"自适应窗口为{final_window}章（约{final_window * avg_chapter_words}字）"
    }
```

#### E.11.3 多尺度窗口策略

```python
# --- 摘要：MultiScaleDriftDetector —— 多尺度漂移检测器，同时使用小/中/大窗口检测突变和长期趋势 ---
class MultiScaleDriftDetector:
    """多尺度漂移检测器：同时使用小窗口检测突变和大窗口检测长期趋势"""

    def __init__(self, total_chapters: int, avg_chapter_words: int):
        config = calculate_window_size(total_chapters, avg_chapter_words)
        self.small_window = max(3, config["window_size"] // 3)   # 小窗口：检测突变
        self.medium_window = config["window_size"]                 # 中窗口：标准检测
        self.large_window = config["window_size"] * 2             # 大窗口：长期趋势

    def detect_drift(self, chapter_vectors: dict[int, list[float]]) -> dict:
        """
        多尺度漂移检测

        参数:
            chapter_vectors: {章节号: 风格向量}

        返回:
            dict: 多尺度检测结果
        """
        results = {}

        for scale_name, window_size in [
            ("small", self.small_window),
            ("medium", self.medium_window),
            ("large", self.large_window)
        ]:
            drifts = self._calculate_window_drifts(
                chapter_vectors, window_size
            )
            results[scale_name] = {
                "window_size": window_size,
                "drifts": drifts,
                "max_drift": min(drifts.values()) if drifts else 1.0,
                "detection_type": "突变检测" if scale_name == "small" else
                                  "标准检测" if scale_name == "medium" else
                                  "长期趋势"
            }

        # 综合判断
        results["overall"] = self._merge_multi_scale_results(results)

        return results

    def _calculate_window_drifts(
        self,
        chapter_vectors: dict[int, list[float]],
        window_size: int
    ) -> dict[int, float]:
        """计算每个窗口的漂移值"""
        drifts = {}
        chapters = sorted(chapter_vectors.keys())

        for i in range(window_size, len(chapters)):
            # 当前窗口的向量均值
            window_chapters = chapters[i - window_size:i]
            prev_chapters = chapters[max(0, i - 2 * window_size):i - window_size]

            if not prev_chapters:
                continue

            # 计算两个窗口的均值向量
            current_mean = self._mean_vector(
                [chapter_vectors[c] for c in window_chapters]
            )
            prev_mean = self._mean_vector(
                [chapter_vectors[c] for c in prev_chapters]
            )

            # 余弦相似度
            similarity = self._cosine_sim(current_mean, prev_mean)
            drifts[chapters[i]] = similarity

        return drifts

    def _merge_multi_scale_results(self, results: dict) -> dict:
        """合并多尺度检测结果"""
        small = results["small"]["max_drift"]
        medium = results["medium"]["max_drift"]
        large = results["large"]["max_drift"]

        # 判断漂移类型
        if small < 0.70 and medium > 0.85:
            drift_type = "突变型漂移"  # 小窗口检测到但大窗口没有 → 短期突变
        elif medium < 0.85 and large > 0.85:
            drift_type = "渐进型漂移"  # 中窗口检测到但大窗口没有 → 逐渐偏离
        elif large < 0.85:
            drift_type = "全局型漂移"  # 所有尺度都检测到 → 严重全局漂移
        else:
            drift_type = "稳定"

        return {
            "drift_type": drift_type,
            "severity": "critical" if large < 0.70 else
                        "warning" if medium < 0.85 else
                        "minor" if small < 0.85 else "stable"
        }

    @staticmethod
    def _mean_vector(vectors: list[list[float]]) -> list[float]:
        """计算向量均值"""
        if not vectors:
            return []
        dim = len(vectors[0])
        return [
            sum(v[i] for v in vectors) / len(vectors)
            for i in range(dim)
        ]

    @staticmethod
    def _cosine_sim(a: list[float], b: list[float]) -> float:
        """计算余弦相似度"""
        import math
        dot = sum(x * y for x, y in zip(a, b))
        norm_a = math.sqrt(sum(x ** 2 for x in a))
        norm_b = math.sqrt(sum(x ** 2 for x in b))
        if norm_a == 0 or norm_b == 0:
            return 0.0
        return dot / (norm_a * norm_b)
```

---

### E.12 M16 风格守护 Agent 的审核时机与粒度

> 📋 本节为 [C.19 M16 风格守护 Agent](#c19-m16 风格守护 agent) 的工程实现补充，建议实现时与对应章节一并阅读。

#### E.12.1 问题背景

M16 定义了审核流程和改写协议，但缺少关键的时机和粒度定义。审核是在每个段落后立即进行？还是整章完成后批量审核？不同时机的延迟要求和用户体验完全不同。

#### E.12.2 三级审核时机

<!-- 表格说明：三级审核时机定义，含粒度、延迟要求和触发条件 -->
| 级别 | 名称 | 粒度 | 延迟要求 | 触发条件 | 适用场景 |
|------|------|------|----------|------|----------|
| L1 | 实时审核 | 段落级 | < 100ms | 每个段落生成后 | AI 续写/改写时 |
| L2 | 准实时审核 | 场景级 | < 2s | 场景切换时 | 写完一个完整场景 |
| L3 | 批量审核 | 章节级 | < 10s | 章节保存/完成时 | 作者手动保存章节 |

> **B7/B8 检测的触发时机说明**：
>
> B7（伏笔回收检测）和 B8（节奏检测）**不纳入 L3 审核队列**，而是通过
> PostSavePipeline（#F.4 节）在章节保存后独立异步触发：
> - B7 伏笔回收检测：由 PostSavePipeline 步骤 4（`_check_foreshadowing_status`）触发，
>   检测当前章节是否满足伏笔回收条件，结果写入`rhythm_issues`和伏笔状态表。
> - B8 节奏检测：由 PostSavePipeline 步骤 2（节奏画像计算）完成后自动触发 RhythmDetector，
>   执行 D1-D4 共 8 项检测，结果写入`rhythm_issues`表。
>
> **设计原因**：B7/B8 的检测依赖章节级数据（节奏画像、伏笔状态），且计算成本较高，
> 不适合纳入 L3 的同步审核流程。独立触发可避免阻塞 L3 的 10s 延迟要求，同时确保
> B7/B8 的检测结果在作品健康度仪表盘（#17.5）中正常展示。

#### E.12.3 各级别执行内容

```python
# --- 摘要：run_style_audit() —— 执行风格审核（L1行内/L2段落/L3全章），按级别返回不同详细度的结果 ---
def run_style_audit(
    text: str,
    audit_level: str,
    work_id: str,
    chapter_num: int
) -> dict:
    """
    执行风格审核

    参数:
        text: 待审核文本
        audit_level: 审核级别（L1/L2/L3）
        work_id: 作品ID
        chapter_num: 章节号

    返回:
        dict: 审核结果
    """
    result = {"level": audit_level, "checks": {}}

    if audit_level == "L1":
        # 实时审核：仅执行算法层快速检查（零LLM成本）
        result["checks"] = {
            "banned_words": check_banned_words(text),       # M4 禁用词
            "ai_flavor_quick": quick_ai_flavor_check(text), # M5 快速模式匹配
        }
        result["latency_target"] = "100ms"

    elif audit_level == "L2":
        # 准实时审核：算法层 + 轻量LLM检查
        result["checks"] = {
            "banned_words": check_banned_words(text),       # M4
            "ai_flavor": detect_ai_flavor(text),            # M5 完整检测
            "scene_match": check_scene_style(text),         # M6
            "character_style": quick_character_check(text), # M7 快速检查
        }
        result["latency_target"] = "2s"

    elif audit_level == "L3":
        # 批量审核：完整检测管线
        result["checks"] = {
            "full_stats": extract_50d_features(text),       # M3
            "banned_words": check_banned_words(text),       # M4
            "ai_flavor": detect_ai_flavor(text),            # M5
            "scene_match": check_scene_style(text),         # M6
            "character_style": check_character_style(text), # M7 完整检查
            "narrative": check_narrative_consistency(text), # M8
            "quality_score": assess_style_quality(text),    # M12
        }
        result["latency_target"] = "10s"

    return result
```

#### E.12.4 审核结果与编辑器 UI 集成

| 审核级别 | UI 展示方式 | 交互方式 |
|------|-----------|------|
| L1 | 行内波浪下划线 + 悬浮提示 | 点击查看建议，一键接受修改 |
| L2 | 侧边栏黄色卡片 | 展开查看详情，逐条处理 |
| L3 | 独立审核报告面板 | 完整报告，支持批量操作 |

#### E.12.5 审核队列管理

```python
# --- 摘要：AuditPriority + AuditQueueManager —— 审核队列管理，支持优先级排序/预算控制/批量处理 ---
from dataclasses import dataclass, field
from enum import Enum
import time

class AuditPriority(Enum):
    P0_CRITICAL = 0   # 硬约束违反，必须立即处理
    P1_HIGH = 1       # 高概率问题，优先处理
    P2_MEDIUM = 2     # 可能问题，正常处理
    P3_LOW = 3        # 参考信息，空闲时处理

@dataclass
class AuditTask:
    """审核任务"""
    task_id: str
    text: str
    audit_level: str          # L1/L2/L3
    priority: AuditPriority
    work_id: str
    chapter_num: int
    created_at: float = field(default_factory=time.time)

class AuditQueue:
    """审核队列管理器"""

    def __init__(self, max_concurrent: int = 3):
        self.queue: list[AuditTask] = []
        self.max_concurrent = max_concurrent
        self.running = 0

    def enqueue(self, task: AuditTask) -> None:
        """入队（按优先级插入）"""
        self.queue.append(task)
        # 按优先级排序（P0最高）
        self.queue.sort(key=lambda t: t.priority.value)

    def dequeue(self) -> AuditTask | None:
        """出队（考虑并发限制）"""
        if self.running >= self.max_concurrent or not self.queue:
            return None
        task = self.queue.pop(0)
        self.running += 1
        return task

    def complete(self) -> None:
        """标记一个任务完成"""
        self.running = max(0, self.running - 1)

    def get_queue_status(self) -> dict:
        """获取队列状态"""
        return {
            "queue_length": len(self.queue),
            "running": self.running,
            "by_priority": {
                p.name: sum(1 for t in self.queue if t.priority == p)
                for p in AuditPriority
            }
        }
```

---

### E.13 M1 风格宪法与 M3 统计引擎的对齐机制

#### E.13.1 问题背景

M1 支持三种定义方式，其中"自由文本描述"和"结构化选项"产生的风格定义与 M3 的 50 维数值特征之间存在语义鸿沟。只有"参考文本上传"可以直接通过 M3 分析得到数值化的风格向量。

#### E.13.2 结构化选项→50 维特征映射表

```python
# --- 摘要：STRUCTURED_OPTION_TO_FEATURES —— 结构化选项到50维特征的映射表（正式度/情感/描写/对话/节奏） ---
# 结构化选项维度到50维特征的映射
STRUCTURED_OPTION_TO_FEATURES = {
    "formality": {  # 正式度 1-10
        "name": "正式度",
        "mappings": {
            1: {"avg_sentence_length": (8, 12), "colloquial_density": (0.15, 0.25)},
            3: {"avg_sentence_length": (12, 16), "colloquial_density": (0.10, 0.18)},
            5: {"avg_sentence_length": (16, 22), "colloquial_density": (0.05, 0.12)},
            7: {"avg_sentence_length": (22, 30), "colloquial_density": (0.02, 0.08)},
            10: {"avg_sentence_length": (28, 40), "colloquial_density": (0.00, 0.03)},
        }
    },
    "emotion_intensity": {  # 情感浓度 1-10
        "name": "情感浓度",
        "mappings": {
            1: {"positive_emotion_density": (0.01, 0.03), "negative_emotion_density": (0.01, 0.03)},
            5: {"positive_emotion_density": (0.03, 0.07), "negative_emotion_density": (0.03, 0.07)},
            10: {"positive_emotion_density": (0.07, 0.15), "negative_emotion_density": (0.07, 0.15)},
        }
    },
    "narrative_distance": {  # 叙事距离 1-10
        "name": "叙事距离",
        "mappings": {
            1: {"monologue_ratio": (0.20, 0.35), "sensory_density": (0.08, 0.15)},
            5: {"monologue_ratio": (0.10, 0.20), "sensory_density": (0.04, 0.08)},
            10: {"monologue_ratio": (0.02, 0.08), "sensory_density": (0.01, 0.04)},
        }
    },
    "description_density": {  # 描写密度 1-10
        "name": "描写密度",
        "mappings": {
            1: {"description_ratio": (0.10, 0.20), "adjective_density": (0.03, 0.06)},
            5: {"description_ratio": (0.20, 0.35), "adjective_density": (0.06, 0.10)},
            10: {"description_ratio": (0.35, 0.50), "adjective_density": (0.10, 0.18)},
        }
    },
    "pacing": {  # 节奏偏好 slow/medium/buildup/fast/climax（5级枚举）
        "name": "节奏偏好",
        "mappings": {
            "slow": {"short_sentence_ratio": (0.05, 0.15), "dialogue_ratio": (0.10, 0.25)},
            "medium": {"short_sentence_ratio": (0.15, 0.25), "dialogue_ratio": (0.20, 0.30)},
            "buildup": {"short_sentence_ratio": (0.20, 0.35), "dialogue_ratio": (0.25, 0.40)},
            "fast": {"short_sentence_ratio": (0.30, 0.50), "dialogue_ratio": (0.30, 0.50)},
            "climax": {"short_sentence_ratio": (0.40, 0.60), "dialogue_ratio": (0.35, 0.55)},
        }
    },
}

def structured_to_constitution_vector(
    structured_options: dict[str, int | str]
) -> dict[str, tuple[float, float]]:
    """
    将结构化选项转化为50维特征的目标范围

    参数:
        structured_options: 结构化选项值
            {"formality": 7, "emotion_intensity": 5, ...}

    返回:
        dict: 各特征维度的目标范围 (min, max)
    """
    target_ranges = {}

    for option_key, option_value in structured_options.items():
        if option_key not in STRUCTURED_OPTION_TO_FEATURES:
            continue

        option_def = STRUCTURED_OPTION_TO_FEATURES[option_key]

        # 找到最接近的映射档位
        if isinstance(option_value, int):
            # 数值型：找最近的档位
            closest_level = min(
                option_def["mappings"].keys(),
                key=lambda k: abs(k - option_value)
            )
            mappings = option_def["mappings"][closest_level]
        else:
            # 枚举型：直接查找
            mappings = option_def["mappings"].get(option_value, {})

        # 合并到目标范围（取交集）
        for feature_name, (fmin, fmax) in mappings.items():
            if feature_name in target_ranges:
                # 已有范围，取交集
                existing = target_ranges[feature_name]
                target_ranges[feature_name] = (
                    max(existing[0], fmin),
                    min(existing[1], fmax)
                )
            else:
                target_ranges[feature_name] = (fmin, fmax)

    return target_ranges
```

#### E.13.3 自由文本→风格向量的 LLM 转化

```python
CONSTITUTION_EXTRACTION_PROMPT = """你是一位文学风格分析专家。请分析以下作者对自己写作风格的描述，提取出可量化的风格特征参数。

作者风格描述：
{constitution_text}

作品类型：{genre}
目标读者：{audience}

请以JSON格式输出以下维度的估计值（每个维度给出一个数值和置信度0-1）：
{{
    "avg_sentence_length": {{"value": 数值, "confidence": 0-1}},
    "ttr": {{"value": 数值, "confidence": 0-1}},
    "de_density": {{"value": 数值, "confidence": 0-1}},
    "colloquial_density": {{"value": 数值, "confidence": 0-1}},
    "four_char_density": {{"value": 数值, "confidence": 0-1}},
    "reduplication_density": {{"value": 数值, "confidence": 0-1}},
    "dialogue_ratio": {{"value": 数值, "confidence": 0-1}},
    "description_ratio": {{"value": 数值, "confidence": 0-1}},
    "sensory_density": {{"value": 数值, "confidence": 0-1}},
    "emotion_volatility": {{"value": 数值, "confidence": 0-1}}
}}

注意：
- avg_sentence_length: 平均句长（字）
- ttr: 词汇丰富度（0-1）
- de_density: "的"字密度（0-1）
- 其余密度类维度均为（0-1）
- 如果描述中无法推断某个维度，confidence设为0.1
"""
```

#### E.13.4 宪法向量校准机制

```python
# --- 摘要：calibrate_constitution_vector() —— 用实际写作数据校准宪法向量，含置信度评估和维度补全 ---
def calibrate_constitution_vector(
    work_id: str,
    min_chapters: int = 10
) -> dict:
    """
    用实际写作数据校准宪法向量

    参数:
        work_id: 作品ID
        min_chapters: 最少需要多少章数据才进行校准

    返回:
        dict: 校准报告
    """
    # 获取已写章节数
    chapter_count = db.query(
        "SELECT COUNT(*) FROM chapters WHERE work_id = %s", work_id
    )[0][0]

    if chapter_count < min_chapters:
        return {
            "calibrated": False,
            "reason": f"章节数不足（{chapter_count}/{min_chapters}）",
            "next_check_chapter": min_chapters
        }

    # 获取宪法向量（当前值）
    constitution = db.query(
        "SELECT * FROM style_constitutions WHERE work_id = %s ORDER BY version DESC LIMIT 1",
        work_id
    )[0]

    # 获取实际统计基线
    stats = WelfordStyleStats()
    chapters = db.query(
        "SELECT content FROM chapters WHERE work_id = %s ORDER BY chapter_num",
        work_id
    )
    for ch in chapters:
        features = extract_50d_features(ch["content"])
        stats.update(features)

    actual_baseline = stats.get_global_mean_vector()

    # 计算宪法向量与实际基线的差异
    diffs = {}
    for dim in actual_baseline:
        if dim in constitution["target_vector"]:
            diff = abs(actual_baseline[dim] - constitution["target_vector"][dim])
            std = stats.get_std(dim)
            # 以标准差为单位衡量差异
            z_score = diff / std if std > 0 else 0
            diffs[dim] = {
                "constitution_value": constitution["target_vector"][dim],
                "actual_value": actual_baseline[dim],
                "z_score": round(z_score, 2),
                "needs_calibration": z_score > 2.0  # 超过2σ需要校准
            }

    # 生成校准建议
    needs_calibration = [d for d in diffs.values() if d["needs_calibration"]]

    return {
        "calibrated": len(needs_calibration) == 0,
        "chapter_count": chapter_count,
        "total_dimensions": len(diffs),
        "dimensions_needing_calibration": len(needs_calibration),
        "details": diffs,
        "recommendation": (
            "宪法向量与实际写作风格匹配良好" if not needs_calibration
            else f"建议校准以下{len(needs_calibration)}个维度"
        )
    }
```

---

### E.14 M14 反馈学习的冷启动策略

> 📋 本节为 [C.17 M14 反馈学习](#c17-m14 反馈学习) 的工程实现补充，建议实现时与对应章节一并阅读。

#### E.14.1 问题背景

M14 从作者修改行为中学习规则，但新作品初期（前 5-10 章）修改数据极少，反馈学习系统处于"冷启动"状态。

#### E.14.2 冷启动阶段定义

| 阶段 | 章节范围 | 数据量 | 策略 |
|------|----------|------|------|
| 冷启动期 | 1-5 章 | 极少 | 加强人工引导，使用预置规则 |
| 预热期 | 6-15 章 | 较少 | 逐步启用 AI 建议规则，低置信度 |
| 正常运行 | 16 章+ | 充足 | 完整反馈学习，正常置信度 |

#### E.14.3 预置规则导入

```python
# 按作品类型预置的基础风格规则
PRESET_RULES = {
    "xianxia": [
        {"rule_type": "banned_word", "trigger_pattern": "仿佛", "action": "replace", "confidence": 0.7},
        {"rule_type": "banned_word", "trigger_pattern": "宛如", "action": "replace", "confidence": 0.7},
        {"rule_type": "preferred_word", "trigger_pattern": "兀自", "action": "prefer", "confidence": 0.5},
        {"rule_type": "preferred_word", "trigger_pattern": "端的是", "action": "prefer", "confidence": 0.5},
    ],
    "urban": [
        {"rule_type": "banned_word", "trigger_pattern": "缓缓地", "action": "replace", "confidence": 0.6},
        {"rule_type": "banned_word", "trigger_pattern": "心中涌起", "action": "replace", "confidence": 0.6},
    ],
    "scifi": [
        {"rule_type": "scene_rule", "trigger_pattern": "tech_description", "action": "use_precise_terms", "confidence": 0.6},
    ],
    "historical": [
        {"rule_type": "banned_word", "trigger_pattern": "OK", "action": "replace", "confidence": 0.9},
        {"rule_type": "banned_word", "trigger_pattern": "厉害", "action": "replace", "confidence": 0.7},
        {"rule_type": "preferred_word", "trigger_pattern": "且说", "action": "prefer", "confidence": 0.5},
    ],
}

def load_preset_rules(work_id: str, genre: str) -> int:
    """
    加载预置规则到作品的反馈学习系统

    参数:
        work_id: 作品ID
        genre: 作品类型

    返回:
        int: 加载的规则数量
    """
    rules = PRESET_RULES.get(genre, [])
    loaded = 0

    for rule in rules:
        db.execute("""
            INSERT INTO style_learning_rules (
                work_id, rule_type, trigger_pattern, action,
                confidence, source
            ) VALUES (%s, %s, %s, %s, %s, 'preset')
        """, (
            work_id, rule["rule_type"], rule["trigger_pattern"],
            rule["action"], rule["confidence"]
        ))
        loaded += 1

    return loaded
```

#### E.14.4 冷启动期间的检测阈值调整

```python
def get_cold_start_config(chapter_num: int) -> dict:
    """
    获取冷启动期间的配置

    参数:
        chapter_num: 当前章节号

    返回:
        dict: 冷启动配置
    """
    if chapter_num <= 5:
        # 冷启动期：放宽阈值，减少误报
        return {
            "phase": "cold_start",
            "drift_threshold": 0.75,         # 放宽（正常0.85）
            "ai_flavor_threshold": 40,       # 放宽（正常30）
            "auto_rewrite": False,           # 禁止自动改写
            "ai_suggested_rules": False,     # 禁止AI建议规则
            "constitution_confidence": 0.5,  # 宪法向量置信度低
        }
    elif chapter_num <= 15:
        # 预热期：逐步收紧
        progress = (chapter_num - 5) / 10  # 0.0 → 1.0
        return {
            "phase": "warm_up",
            "drift_threshold": 0.75 + progress * 0.10,  # 0.75 → 0.85
            "ai_flavor_threshold": 40 - progress * 10,  # 40 → 30
            "auto_rewrite": False,
            "ai_suggested_rules": True,       # 启用AI建议
            "ai_suggested_confidence": 0.3 + progress * 0.2,  # 0.3 → 0.5
            "constitution_confidence": 0.5 + progress * 0.5,  # 0.5 → 1.0
        }
    else:
        # 正常运行
        return {
            "phase": "normal",
            "drift_threshold": 0.85,
            "ai_flavor_threshold": 30,
            "auto_rewrite": True,
            "ai_suggested_rules": True,
            "ai_suggested_confidence": 0.5,
            "constitution_confidence": 1.0,
        }
```

---

### E.15 LLM 检测层的调度与合并策略

#### E.15.1 问题背景

M6/M7/M8/M12 需要 LLM 调用，但缺少调度优先级、预算裁剪和结果合并的具体策略。

#### E.15.2 检测任务优先级

| 优先级 | 任务 | 权重 | 理由 |
|------|------|------|------|
| P0 | M5 AI 味检测 | 0.35 | 最高频问题，直接影响读者体验（快速模式为算法层零 LLM 成本，完整检测为 LLM 层） |
| P1 | M7 角色对话风格 | 0.25 | "千人一面"是严重质量缺陷 |
| P2 | M6 场景-风格匹配 | 0.20 | 场景适配影响沉浸感 |
| P3 | M8 叙事技术一致性 | 0.12 | 视角/时态错误较严重但频率低 |
| P4 | M12 风格质量评估 | 0.08 | 综合评估，可降频 |

#### E.15.3 预算受限时的裁剪策略

```python
def plan_llm_detection(
    budget_tokens: int,
    estimated_costs: dict[str, int],
    priorities: dict[str, float]
) -> list[str]:
    """
    在Token预算受限时选择要执行的检测任务

    参数:
        budget_tokens: 可用的Token预算
        estimated_costs: 各任务的预估Token消耗
            {"M5": 800, "M6": 600, "M7": 500, "M8": 400, "M12": 700}
        priorities: 各任务的优先级权重
            {"M5": 0.35, "M7": 0.25, "M6": 0.20, "M8": 0.12, "M12": 0.08}

    返回:
        list[str]: 选中的任务列表
    """
    # 按优先级排序
    sorted_tasks = sorted(priorities.items(), key=lambda x: -x[1])

    selected = []
    remaining_budget = budget_tokens

    for task_name, priority in sorted_tasks:
        cost = estimated_costs.get(task_name, 0)
        if cost <= remaining_budget:
            selected.append(task_name)
            remaining_budget -= cost

    return selected

# 使用示例
# 预算充足：全部执行 → ["M5", "M7", "M6", "M8", "M12"]
# 预算2000：执行P0+P1+P2 → ["M5", "M7", "M6"]
# 预算1000：仅执行P0+P1 → ["M5", "M7"]
# 预算500：仅执行P0 → ["M5"]
```

#### E.15.4 检测结果合并算法

```python
# --- 摘要：merge_detection_results() —— 检测结果合并算法，支持加权平均/投票/取最严三种合并策略 ---
def merge_detection_results(
    results: dict[str, dict],
    weights: dict[str, float]
) -> dict:
    """
    合并多个检测任务的结果

    参数:
        results: 各任务的检测结果
            {"M5": {"score": 35, "issues": [...]}, "M7": {"score": 72, "issues": [...]}, ...}
        weights: 各任务的权重

    返回:
        dict: 合并后的检测结果
    """
    merged = {
        "overall_score": 0.0,
        "issues": [],
        "confidence": 0.0,
        "source_breakdown": {}
    }

    total_weight = sum(weights.values())
    weighted_score = 0.0
    total_confidence = 0.0

    for task_name, result in results.items():
        weight = weights.get(task_name, 0)

        # 加权评分
        task_score = result.get("score", 100)
        weighted_score += task_score * weight

        # 收集所有问题
        for issue in result.get("issues", []):
            issue["source_task"] = task_name
            issue["priority_weight"] = weight
            merged["issues"].append(issue)

        # 记录分项
        merged["source_breakdown"][task_name] = {
            "score": task_score,
            "weight": weight,
            "issue_count": len(result.get("issues", []))
        }

        total_confidence += weight

    # 计算加权总分
    merged["overall_score"] = round(weighted_score / total_weight, 1)
    merged["confidence"] = round(total_confidence / total_weight, 2)

    # 按严重程度排序问题
    merged["issues"].sort(key=lambda x: (
        -x.get("severity", 0),  # 严重程度降序
        -x.get("priority_weight", 0)  # 优先级降序
    ))

    return merged
```

#### E.15.5 批量检测优化

```python
def batch_detect(chapter_text: str, work_id: str, chapter_num: int) -> dict:
    """
    批量执行LLM检测（共享预处理结果）

    优化点：所有检测任务共享分词、词性标注、断句等预处理结果
    """
    # 第一步：共享预处理（只执行一次）
    preprocessed = shared_preprocess(chapter_text)
    # preprocessed = {
    #     "tokens": [...],       # 分词结果
    #     "pos_tags": [...],     # 词性标注
    #     "sentences": [...],    # 断句结果
    #     "paragraphs": [...],   # 段落分割
    # }

    # 第二步：并行执行选中的检测任务
    config = get_cold_start_config(chapter_num)
    budget = get_llm_budget(work_id)

    selected_tasks = plan_llm_detection(
        budget_tokens=budget,
        estimated_costs={"M5": 800, "M6": 600, "M7": 500, "M8": 400, "M12": 700},
        priorities={"M5": 0.35, "M7": 0.25, "M6": 0.20, "M8": 0.12, "M12": 0.08}
    )

    results = {}
    for task in selected_tasks:
        results[task] = execute_detection(task, preprocessed, work_id, chapter_num)

    # 第三步：合并结果
    merged = merge_detection_results(
        results,
        {"M5": 0.35, "M7": 0.25, "M6": 0.20, "M8": 0.12, "M12": 0.08}
    )

    return merged
```

---

### E.16 风格漂移根因分析系统

> 📋 本节为 [C.14 M11 风格漂移检测](#c14-m11 风格漂移检测) 的工程实现补充，建议实现时与对应章节一并阅读。

#### E.16.1 问题背景

M11 能检测到风格漂移，但只能告诉作者"风格变了"。作者需要的是根因分析：哪个维度导致的？从哪章开始的？是否与特定事件相关？

#### E.16.2 漂移归因算法

```python
def analyze_drift_causes(
    current_vector: list[float],
    baseline_vector: list[float],
    feature_names: list[str],
    std_vector: list[float]
) -> list[dict]:
    """
    分析风格漂移的根因：分解各维度对漂移的贡献度

    参数:
        current_vector: 当前风格向量
        baseline_vector: 基准风格向量
        feature_names: 各维度名称
        std_vector: 各维度的标准差（用于Z-score标准化）

    返回:
        list[dict]: 按贡献度排序的漂移原因列表
    """
    causes = []

    for i, name in enumerate(feature_names):
        diff = current_vector[i] - baseline_vector[i]
        std = std_vector[i] if i < len(std_vector) else 1.0

        # Z-score：以标准差为单位衡量偏离程度
        z_score = abs(diff) / std if std > 0 else 0

        # 方向：增大还是减小
        direction = "increased" if diff > 0 else "decreased"

        # 贡献度：Z-score的平方（越大贡献越大）
        contribution = z_score ** 2

        if z_score > 1.0:  # 只报告偏离超过1σ的维度
            causes.append({
                "dimension": name,
                "baseline_value": round(baseline_vector[i], 4),
                "current_value": round(current_vector[i], 4),
                "difference": round(diff, 4),
                "z_score": round(z_score, 2),
                "direction": direction,
                "contribution": round(contribution, 2),
                "severity": "high" if z_score > 3.0 else
                            "medium" if z_score > 2.0 else "low"
            })

    # 按贡献度降序排序
    causes.sort(key=lambda c: -c["contribution"])

    return causes
```

#### E.16.3 漂移起始点定位

```python
# --- 摘要：locate_drift_origin() —— 使用二分搜索定位风格开始偏离的精确章节 ---
def locate_drift_origin(
    chapter_vectors: dict[int, list[float]],
    baseline_vector: list[float],
    threshold: float = 0.85
) -> dict:
    """
    使用二分搜索定位风格开始偏离的精确章节

    参数:
        chapter_vectors: {章节号: 风格向量}
        baseline_vector: 基准风格向量
        threshold: 漂移检测阈值（cosine similarity）

    返回:
        dict: 漂移起始点信息
    """
    chapters = sorted(chapter_vectors.keys())

    # 找到第一个低于阈值的章节
    first_drift_chapter = None
    for ch in chapters:
        similarity = cosine_sim(chapter_vectors[ch], baseline_vector)
        if similarity < threshold:
            first_drift_chapter = ch
            break

    if first_drift_chapter is None:
        return {"drift_detected": False}

    # 二分搜索精确起始点
    low = 1
    high = first_drift_chapter

    while high - low > 1:
        mid = (low + high) // 2
        mid_similarity = cosine_sim(chapter_vectors[mid], baseline_vector)

        if mid_similarity >= threshold:
            low = mid
        else:
            high = mid

    # 计算过渡区间
    return {
        "drift_detected": True,
        "first_alert_chapter": first_drift_chapter,
        "estimated_origin_chapter": high,
        "transition_range": (low, high),
        "similarity_at_origin": round(
            cosine_sim(chapter_vectors[high], baseline_vector), 4
        ),
        "similarity_before_origin": round(
            cosine_sim(chapter_vectors[low], baseline_vector), 4
        ),
    }
```

#### E.16.4 漂移模式分类

```python
# --- 摘要：DriftPattern枚举 + classify_drift_pattern() —— 漂移模式分类（全局/局部/周期/突变/渐进） ---
from enum import Enum

class DriftPattern(Enum):
    GLOBAL = "global"           # 全局漂移：所有维度都在偏离
    LOCAL = "local"             # 局部漂移：仅少数维度偏离
    PERIODIC = "periodic"       # 周期性漂移：风格在两个状态间摆动
    SUDDEN = "sudden"           # 突变漂移：某一章节突然偏离
    GRADUAL = "gradual"         # 渐进漂移：缓慢但持续地偏离

def classify_drift_pattern(
    chapter_vectors: dict[int, list[float]],
    baseline_vector: list[float]
) -> dict:
    """
    分类漂移模式

    参数:
        chapter_vectors: {章节号: 风格向量}
        baseline_vector: 基准风格向量

    返回:
        dict: 漂移模式分类结果
    """
    chapters = sorted(chapter_vectors.keys())
    similarities = [
        cosine_sim(chapter_vectors[ch], baseline_vector)
        for ch in chapters
    ]

    # 计算相似度序列的统计特征
    import statistics
    mean_sim = statistics.mean(similarities)
    std_sim = statistics.stdev(similarities) if len(similarities) > 1 else 0

    # 检测突变：相邻章节相似度差异
    max_delta = max(
        abs(similarities[i] - similarities[i-1])
        for i in range(1, len(similarities))
    ) if len(similarities) > 1 else 0

    # 检测趋势：线性回归斜率
    n = len(similarities)
    if n > 2:
        x_mean = (n - 1) / 2
        y_mean = mean_sim
        numerator = sum(
            (i - x_mean) * (similarities[i] - y_mean)
            for i in range(n)
        )
        denominator = sum((i - x_mean) ** 2 for i in range(n))
        trend_slope = numerator / denominator if denominator > 0 else 0
    else:
        trend_slope = 0

    # 分类规则
    if max_delta > 0.15:
        pattern = DriftPattern.SUDDEN
        description = "检测到突变型漂移：某一章节风格突然偏离基准"
    elif abs(trend_slope) > 0.005 and std_sim < 0.05:
        pattern = DriftPattern.GRADUAL
        description = f"检测到渐进型漂移：风格持续{'下降' if trend_slope < 0 else '上升'}"
    elif std_sim > 0.08:
        pattern = DriftPattern.PERIODIC
        description = "检测到周期性漂移：风格在波动中偏离"
    elif mean_sim < 0.85:
        pattern = DriftPattern.GLOBAL
        description = "检测到全局型漂移：整体风格已偏离基准"
    else:
        pattern = DriftPattern.LOCAL
        description = "检测到局部漂移：部分维度偏离，整体尚可"

    return {
        "pattern": pattern.value,
        "description": description,
        "statistics": {
            "mean_similarity": round(mean_sim, 4),
            "std_similarity": round(std_sim, 4),
            "max_adjacent_delta": round(max_delta, 4),
            "trend_slope": round(trend_slope, 6),
        }
    }
```

#### E.16.5 根因报告生成

```python
# --- 摘要：generate_drift_report() —— 生成人类可读的风格漂移根因分析报告（含维度偏离/模式/建议） ---
def generate_drift_report(
    work_id: str,
    chapter_num: int,
    drift_detected: bool
) -> dict:
    """
    生成人类可读的风格漂移根因分析报告

    参数:
        work_id: 作品ID
        chapter_num: 当前章节号
        drift_detected: 是否检测到漂移

    返回:
        dict: 完整的漂移分析报告
    """
    if not drift_detected:
        return {"status": "stable", "message": "风格稳定，未检测到漂移"}

    # 获取数据
    baseline = get_constitution_vector(work_id)
    current = get_chapter_style_vector(work_id, chapter_num)
    chapter_vectors = get_all_chapter_vectors(work_id)
    std_vector = get_global_std_vector(work_id)
    feature_names = get_50d_feature_names()

    # 1. 漂移归因
    causes = analyze_drift_causes(current, baseline, feature_names, std_vector)

    # 2. 起始点定位
    origin = locate_drift_origin(chapter_vectors, baseline)

    # 3. 模式分类
    pattern = classify_drift_pattern(chapter_vectors, baseline)

    # 4. 生成可读报告
    report = {
        "status": "drift_detected",
        "summary": f"检测到{pattern['description']}，"
                   f"当前相似度{cosine_sim(current, baseline):.2f}",
        "drift_pattern": pattern,
        "top_causes": causes[:5],  # 前5大原因
        "origin": origin,
        "recommendations": _generate_recommendations(causes, pattern),
    }

    return report

def _generate_recommendations(causes: list[dict], pattern: dict) -> list[str]:
    """根据漂移原因生成修复建议"""
    recommendations = []

    for cause in causes[:3]:
        dim = cause["dimension"]
        direction = "升高" if cause["direction"] == "increased" else "降低"

        # 维度到建议的映射
        if "的" in dim:
            recommendations.append(
                f"「{dim}」{direction}明显（偏离{cause['z_score']}σ），"
                f"建议检查是否有过度修饰的句子"
            )
        elif "句长" in dim:
            recommendations.append(
                f"「{dim}」{direction}明显（偏离{cause['z_score']}σ），"
                f"建议注意句子长度的控制"
            )
        elif "对话" in dim:
            recommendations.append(
                f"「{dim}」{direction}明显（偏离{cause['z_score']}σ），"
                f"建议检查角色对话的比例"
            )
        else:
            recommendations.append(
                f"「{dim}」{direction}明显（偏离{cause['z_score']}σ），"
                f"建议关注该维度的变化趋势"
            )

    # 模式特定建议
    if pattern["pattern"] == "sudden":
        recommendations.append(
            "检测到突变型漂移，建议检查漂移起始章节附近是否有特殊事件"
            "（如更换AI模型、长时间中断后恢复写作等）"
        )
    elif pattern["pattern"] == "gradual":
        recommendations.append(
            "检测到渐进型漂移，建议定期回顾早期章节的风格"
        )

    return recommendations
```

---

## E.17-E.24 盲区补充（Round 12）

> 📋 **摘要**：汇总 Round 12 的 8 个盲区补充，从运维安全、模型适配、精度评估、生态建设四个全新维度切入解决系统性问题。

本章汇总 Round 12 深度优化中发现的 8 个盲区补充。本轮从**运维安全、模型适配、精度评估、生态建设**四个全新维度切入，解决前 11 轮未覆盖的系统性问题。

### E.17 风格快照与检查点系统

#### E.17.1 问题背景

千万字级作品的风格数据（Welford 统计量、漂移历史、意图状态等）持续增长，但缺少一致性检查点机制。数据库损坏、版本升级或作者需要回退到历史风格状态时，系统无法恢复。

#### E.17.2 检查点触发策略

| 触发条件 | 说明 |
|------|------|
| 定时触发 | 每 20 章自动创建一个检查点 |
| 重大事件 | 风格宪法修订、跨作品导入后立即创建 |
| 手动触发 | 作者主动创建（"保存风格快照"） |
| 降级恢复 | 从降级状态恢复后创建恢复前检查点 |

#### E.17.3 检查点数据结构

```sql
CREATE TABLE style_checkpoints (
    -- === 主键与标识 ===
    id UUID PRIMARY KEY,
    work_id UUID REFERENCES works(id),
    chapter_num INT NOT NULL,              -- 检查点对应的章节号
    trigger_type VARCHAR(20) NOT NULL,      -- auto/event/manual/recovery
    trigger_description TEXT,               -- 触发说明

    -- Welford统计量快照
    welford_stats JSONB NOT NULL,           -- 完整的WelfordStyleStats序列化
    global_mean_vector JSONB NOT NULL,      -- 全局均值向量
    global_std_vector JSONB NOT NULL,       -- 全局标准差向量
    chapter_count INT NOT NULL,             -- 已统计章节数

    -- 活跃状态快照
    active_intents JSONB NOT NULL,          -- 所有活跃意图的完整状态
    constitution_version INT NOT NULL,      -- 当时的宪法版本号
    learning_rules_summary JSONB,           -- 学习规则摘要（规则数、置信度分布）

    -- 元数据
    data_size_kb INT,                       -- 检查点数据大小（KB）
    is_incremental BOOLEAN DEFAULT FALSE,   -- 是否为增量检查点
    parent_checkpoint_id UUID REFERENCES style_checkpoints(id),  -- 增量检查点的父节点
    -- === 审计字段 ===
    created_at TIMESTAMP DEFAULT NOW()
);
-- ER关系：本表通过 work_id 关联到 works(id)
```

#### E.17.4 增量检查点实现

```python
# --- 摘要：StyleCheckpointManager —— 风格检查点管理器，支持完整和增量检查点的创建/加载/清理 ---
import json
import zlib

class StyleCheckpointManager:
    """风格检查点管理器：支持完整和增量检查点"""

    def __init__(self, work_id: str):
        self.work_id = work_id

    def create_checkpoint(
        self,
        chapter_num: int,
        welford_stats: 'WelfordStyleStats',
        active_intents: list[dict],
        constitution_version: int,
        trigger_type: str = "auto",
        trigger_description: str = ""
    ) -> str:
        """
        创建风格检查点

        参数:
            chapter_num: 当前章节号
            welford_stats: Welford统计引擎实例
            active_intents: 活跃意图列表
            constitution_version: 宪法版本号
            trigger_type: 触发类型
            trigger_description: 触发说明

        返回:
            str: 检查点ID
        """
        # 获取上一个检查点
        last_checkpoint = self._get_last_checkpoint()

        # 序列化Welford统计量
        stats_data = json.dumps({
            "stats": welford_stats.stats,
            "chapter_count": welford_stats.get_chapter_count()
        }, ensure_ascii=False)

        # 计算与上一个检查点的差异
        is_incremental = False
        parent_id = None
        if last_checkpoint:
            diff = self._compute_diff(
                last_checkpoint["welford_stats"],
                stats_data
            )
            # 如果差异小于完整数据的30%，使用增量存储
            if len(diff) < len(stats_data) * 0.3:
                stats_data = diff
                is_incremental = True
                parent_id = last_checkpoint["id"]

        # 压缩数据
        compressed = zlib.compress(stats_data.encode('utf-8'))

        checkpoint_id = str(uuid.uuid4())
        db.execute("""
            INSERT INTO style_checkpoints (
                id, work_id, chapter_num, trigger_type, trigger_description,
                welford_stats, global_mean_vector, global_std_vector,
                chapter_count, active_intents, constitution_version,
                data_size_kb, is_incremental, parent_checkpoint_id
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """, (
            checkpoint_id, self.work_id, chapter_num,
            trigger_type, trigger_description,
            compressed,  # 存储压缩后的数据
            json.dumps(welford_stats.get_global_mean_vector()),
            json.dumps(welford_stats.get_global_std_vector()),
            welford_stats.get_chapter_count(),
            json.dumps(active_intents),
            constitution_version,
            len(compressed) // 1024,
            is_incremental, parent_id
        ))

        return checkpoint_id

    def restore_checkpoint(self, checkpoint_id: str) -> dict:
        """
        从检查点恢复风格状态

        参数:
            checkpoint_id: 检查点ID

        返回:
            dict: 恢复报告
        """
        checkpoint = db.query(
            "SELECT * FROM style_checkpoints WHERE id = %s",
            checkpoint_id
        )[0]

        # 如果是增量检查点，需要递归合并父检查点
        if checkpoint["is_incremental"] and checkpoint["parent_checkpoint_id"]:
            full_stats = self._merge_incremental_chain(checkpoint_id)
        else:
            full_stats = zlib.decompress(checkpoint["welford_stats"]).decode('utf-8')

        # 恢复Welford统计量
        stats_data = json.loads(full_stats)
        restored_stats = WelfordStyleStats()
        restored_stats.stats = stats_data["stats"]

        # 恢复活跃意图
        active_intents = json.loads(checkpoint["active_intents"])

        return {
            "checkpoint_id": checkpoint_id,
            "chapter_num": checkpoint["chapter_num"],
            "restored_chapter_count": stats_data["chapter_count"],
            "restored_intents": len(active_intents),
            "constitution_version": checkpoint["constitution_version"],
            "message": f"已恢复到第{checkpoint['chapter_num']}章的风格状态"
        }

    def _compute_diff(self, old_data: str, new_data: str) -> str:
        """计算两个序列化数据的差异（简化版：存储新增/变更的维度）"""
        old_stats = json.loads(old_data)["stats"]
        new_stats = json.loads(new_data)["stats"]

        diff = {"stats": {}, "added": [], "removed": []}

        # 找出新增和变更的维度
        for dim, new_val in new_stats.items():
            if dim not in old_stats:
                diff["added"].append({dim: new_val})
            elif old_stats[dim] != new_val:
                diff["stats"][dim] = new_val

        # 找出删除的维度（理论上不应该有）
        for dim in old_stats:
            if dim not in new_stats:
                diff["removed"].append(dim)

        return json.dumps(diff, ensure_ascii=False)

    def _merge_incremental_chain(self, checkpoint_id: str) -> str:
        """递归合并增量检查点链，得到完整数据"""
        checkpoint = db.query(
            "SELECT * FROM style_checkpoints WHERE id = %s",
            checkpoint_id
        )[0]

        if not checkpoint["is_incremental"] or not checkpoint["parent_checkpoint_id"]:
            return zlib.decompress(checkpoint["welford_stats"]).decode('utf-8')

        # 先获取父检查点的完整数据
        parent_full = self._merge_incremental_chain(checkpoint["parent_checkpoint_id"])
        parent_stats = json.loads(parent_full)["stats"]

        # 应用增量差异
        diff = json.loads(
            zlib.decompress(checkpoint["welford_stats"]).decode('utf-8')
        )

        # 合并
        merged = {"stats": parent_stats.copy()}
        merged["stats"].update(diff.get("stats", {}))
        for item in diff.get("added", []):
            merged["stats"].update(item)

        return json.dumps(merged, ensure_ascii=False)

    def _get_last_checkpoint(self) -> dict | None:
        """获取最近的检查点"""
        result = db.query(
            "SELECT * FROM style_checkpoints "
            "WHERE work_id = %s ORDER BY chapter_num DESC LIMIT 1",
            self.work_id
        )
        return result[0] if result else None
```

---

### E.18 多 LLM 模型切换时的风格基准偏移补偿

> 📋 本节为 [C.16 M13 生成控制](#c16-m13 生成控制) 的工程实现补充，建议实现时与对应章节一并阅读。

#### E.18.1 问题背景

PRD 提到"多模型接入（GPT-4o/Claude/DeepSeek）"，但 B4 未考虑模型切换对风格的影响。不同 LLM 有不同的"默认写作风格"，切换模型后即使使用相同 Prompt，生成内容的风格也会偏移。

#### E.18.2 模型风格指纹

```python
# 各LLM模型的默认风格特征基线（通过标准化测试文本提取）
MODEL_STYLE_FINGERPRINTS = {
    "gpt-4o": {
        "name": "GPT-4o",
        "default_vector": {
            "avg_sentence_length": 22.5,     # 中等偏长
            "de_density": 0.035,             # "的"字密度中等
            "ttr": 0.62,                     # 词汇丰富度中等
            "colloquial_density": 0.06,      # 低口语化
            "four_char_density": 0.04,       # 四字词密度低
            "ai_flavor_baseline": 28,        # AI味基线分数
        },
        "characteristics": "平衡中性，偶有过度修饰",
    },
    "claude-3.5-sonnet": {
        "name": "Claude 3.5 Sonnet",
        "default_vector": {
            "avg_sentence_length": 25.0,     # 偏长
            "de_density": 0.038,             # "的"字密度略高
            "ttr": 0.65,                     # 词汇丰富度较高
            "colloquial_density": 0.04,      # 低口语化
            "four_char_density": 0.05,       # 四字词密度中等
            "ai_flavor_baseline": 22,        # AI味基线较低
        },
        "characteristics": "文学化倾向，修饰较多",
    },
    "deepseek-v3": {
        "name": "DeepSeek V3",
        "default_vector": {
            "avg_sentence_length": 18.0,     # 偏短
            "de_density": 0.030,             # "的"字密度较低
            "ttr": 0.58,                     # 词汇丰富度较低
            "colloquial_density": 0.08,      # 口语化略高
            "four_char_density": 0.03,       # 四字词密度低
            "ai_flavor_baseline": 32,        # AI味基线较高
        },
        "characteristics": "简洁直接，偶有AI套路",
    },
}
```

#### E.18.3 模型切换补偿算法

```python
# --- 摘要：calculate_model_compensation() —— 模型切换补偿算法，计算LLM模型变更时的风格偏差补偿参数 ---
def calculate_model_compensation(
    current_model: str,
    target_model: str,
    author_baseline: dict[str, float]
) -> dict[str, float]:
    """
    计算模型切换时的风格补偿参数

    当作者从模型A切换到模型B时，需要调整Prompt中的风格参数，
    以补偿两个模型默认风格的差异。

    参数:
        current_model: 当前使用的模型标识
        target_model: 目标模型标识
        author_baseline: 作者的风格基线（50维特征均值）

    返回:
        dict: 需要补偿的维度及其补偿值
    """
    if current_model == target_model:
        return {}

    current_fp = MODEL_STYLE_FINGERPRINTS.get(current_model, {})
    target_fp = MODEL_STYLE_FINGERPRINTS.get(target_model, {})

    if not current_fp or not target_fp:
        return {}

    compensations = {}
    for dim in author_baseline:
        if dim not in current_fp["default_vector"] or dim not in target_fp["default_vector"]:
            continue

        current_default = current_fp["default_vector"][dim]
        target_default = target_fp["default_vector"][dim]
        author_value = author_baseline[dim]

        # 计算模型差异
        model_diff = target_default - current_default

        # 补偿值 = 模型差异（反向补偿）
        # 如果目标模型比当前模型的默认值高，需要在Prompt中强调更低的值
        compensations[dim] = {
            "model_diff": round(model_diff, 4),
            "compensation": round(-model_diff, 4),
            "author_target": author_value,
            "prompt_adjustment": (
                f"目标模型的{dim}默认偏高{abs(model_diff):.3f}，"
                f"Prompt中需强调目标值为{author_value:.3f}"
            ) if model_diff > 0 else (
                f"目标模型的{dim}默认偏低{abs(model_diff):.3f}，"
                f"Prompt中需强调目标值为{author_value:.3f}"
            )
        }

    return compensations


def generate_model_aware_prompt(
    base_prompt: str,
    current_model: str,
    target_model: str,
    author_baseline: dict[str, float]
) -> str:
    """
    生成模型感知的风格Prompt

    在基础Prompt中添加模型特定的风格补偿指令
    """
    if current_model == target_model:
        return base_prompt

    compensations = calculate_model_compensation(
        current_model, target_model, author_baseline
    )

    if not compensations:
        return base_prompt

    # 生成补偿指令
    compensation_section = "\n【模型风格补偿】\n"
    for dim, comp in compensations.items():
        if abs(comp["model_diff"]) > 0.005:  # 只补偿差异显著的维度
            dim_name_map = {
                "avg_sentence_length": "平均句长",
                "de_density": ""的"字密度",
                "ttr": "词汇丰富度",
            }
            name = dim_name_map.get(dim, dim)
            compensation_section += f"- {name}：目标{comp['author_target']:.3f}，注意控制\n"

    return base_prompt + compensation_section
```

#### E.18.4 模型切换时的基线重校准

```python
def on_model_switch(work_id: str, old_model: str, new_model: str) -> dict:
    """
    模型切换时的处理流程

    参数:
        work_id: 作品ID
        old_model: 旧模型标识
        new_model: 新模型标识

    返回:
        dict: 切换处理报告
    """
    # 1. 创建切换前检查点
    checkpoint_mgr = StyleCheckpointManager(work_id)
    chapter_num = db.query(
        "SELECT MAX(chapter_num) FROM chapters WHERE work_id = %s", work_id
    )[0][0]
    checkpoint_id = checkpoint_mgr.create_checkpoint(
        chapter_num=chapter_num,
        welford_stats=get_welford_stats(work_id),
        active_intents=get_active_intents(work_id),
        constitution_version=get_constitution_version(work_id),
        trigger_type="event",
        trigger_description=f"模型切换: {old_model} → {new_model}"
    )

    # 2. 计算补偿参数
    author_baseline = get_author_baseline(work_id)
    compensations = calculate_model_compensation(
        old_model, new_model, author_baseline
    )

    # 3. 临时调整检测阈值（切换后前5章放宽）
    # 模型切换本身会引入风格偏移，不应误报
    drift_adjustment = {
        "drift_threshold": 0.75,  # 临时放宽（正常0.85）
        "adjustment_chapters": 5,  # 5章后恢复
        "reason": f"模型从{old_model}切换到{new_model}，需要适应期"
    }

    return {
        "checkpoint_id": checkpoint_id,
        "compensations": compensations,
        "drift_adjustment": drift_adjustment,
        "message": f"已创建切换前检查点，计算了{len(compensations)}个维度的补偿参数"
    }
```

---

### E.19 风格检测精度评估体系

#### E.19.1 问题背景

M5-M12 定义了各种检测算法和阈值，但缺少元评估机制。阈值（如 cosine_similarity < 0.85）只能靠经验设定，无法科学优化。

#### E.19.2 人工标注数据集构建

```python
# 标注任务定义
ANNOTATION_TASK_TYPES = {
    "ai_flavor": {
        "description": "标注文本中的AI味表达",
        "labels": ["is_ai_flavor", "not_ai_flavor"],
        "granularity": "sentence",  # 句子级标注
        "min_annotations_per_item": 3,  # 每个样本至少3人标注
    },
    "drift": {
        "description": "判断两个章节之间是否存在风格漂移",
        "labels": ["drift", "no_drift", "intentional_change"],
        "granularity": "chapter_pair",
        "min_annotations_per_item": 2,
    },
    "character_voice": {
        "description": "判断对话是否符合角色特征",
        "labels": ["in_character", "out_of_character"],
        "granularity": "dialogue",
        "min_annotations_per_item": 2,
    },
}

# 标注数据存储
CREATE TABLE style_annotations (
    id UUID PRIMARY KEY,
    work_id UUID REFERENCES works(id),
    task_type VARCHAR(20) NOT NULL,       -- ai_flavor/drift/character_voice
    target_id VARCHAR(100) NOT NULL,      -- 标注目标ID（句子ID/章节对ID等）
    label VARCHAR(30) NOT NULL,           -- 标注标签
    annotator_id VARCHAR(50) NOT NULL,    -- 标注者ID
    confidence FLOAT DEFAULT 1.0,         -- 标注置信度
    notes TEXT,                           -- 标注备注
    created_at TIMESTAMP DEFAULT NOW()
);
-- ER关系：本表通过 work_id 关联到 works(id)
```

#### E.19.3 精度评估指标

```python
# --- 摘要：evaluate_detection_precision() —— 检测精度评估，计算精确率/召回率/F1分数等指标 ---
def evaluate_detection_precision(
    task_type: str,
    detection_results: list[dict],
    annotations: list[dict]
) -> dict:
    """
    评估检测算法的精度

    参数:
        task_type: 检测任务类型
        detection_results: 算法检测结果 [{"target_id": ..., "predicted": True/False}]
        annotations: 人工标注 [{"target_id": ..., "label": ...}]

    返回:
        dict: 精度评估报告
    """
    # 构建标注真值（多数投票）
    from collections import Counter
    ground_truth = {}
    for ann in annotations:
        if ann["target_id"] not in ground_truth:
            ground_truth[ann["target_id"]] = []
        ground_truth[ann["target_id"]].append(ann["label"])

    # 多数投票确定真值
    for tid in ground_truth:
        counter = Counter(ground_truth[tid])
        ground_truth[tid] = counter.most_common(1)[0][0]

    # 计算混淆矩阵
    tp = fp = tn = fn = 0
    for result in detection_results:
        tid = result["target_id"]
        predicted = result["predicted"]
        actual = ground_truth.get(tid)

        if actual is None:
            continue  # 无标注，跳过

        # 将标签映射为布尔值
        actual_bool = actual in ("is_ai_flavor", "drift", "out_of_character")

        if predicted and actual_bool:
            tp += 1
        elif predicted and not actual_bool:
            fp += 1
        elif not predicted and not actual_bool:
            tn += 1
        elif not predicted and actual_bool:
            fn += 1

    # 计算指标
    precision = tp / (tp + fp) if (tp + fp) > 0 else 0
    recall = tp / (tp + fn) if (tp + fn) > 0 else 0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0
    accuracy = (tp + tn) / (tp + tn + fp + fn) if (tp + tn + fp + fn) > 0 else 0

    return {
        "task_type": task_type,
        "sample_count": len(detection_results),
        "confusion_matrix": {"tp": tp, "fp": fp, "tn": tn, "fn": fn},
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1_score": round(f1, 4),
        "accuracy": round(accuracy, 4),
        "false_positive_rate": round(fp / (fp + tn), 4) if (fp + tn) > 0 else 0,
    }
```

#### E.19.4 阈值自动优化

```python
# --- 摘要：optimize_threshold() —— 基于标注数据的阈值自动优化，支持网格搜索和F1/精确率/召回率优化目标 ---
def optimize_threshold(
    task_type: str,
    scores_and_labels: list[dict],
    metric_to_optimize: str = "f1_score"
) -> dict:
    """
    基于标注数据自动优化检测阈值

    参数:
        task_type: 检测任务类型
        scores_and_labels: [{"score": float, "label": bool}, ...]
        metric_to_optimize: 要优化的指标（precision/recall/f1_score）

    返回:
        dict: 最优阈值和对应的指标
    """
    best_threshold = 0.5
    best_metric = 0.0
    results = []

    # 网格搜索：从0.1到0.95，步长0.05
    for threshold in [i / 100 for i in range(10, 96, 5)]:
        tp = fp = tn = fn = 0

        for item in scores_and_labels:
            predicted = item["score"] >= threshold
            actual = item["label"]

            if predicted and actual:
                tp += 1
            elif predicted and not actual:
                fp += 1
            elif not predicted and not actual:
                tn += 1
            else:
                fn += 1

        precision = tp / (tp + fp) if (tp + fp) > 0 else 0
        recall = tp / (tp + fn) if (tp + fn) > 0 else 0
        f1 = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0

        metric_value = {
            "precision": precision,
            "recall": recall,
            "f1_score": f1,
        }[metric_to_optimize]

        results.append({
            "threshold": threshold,
            "precision": round(precision, 4),
            "recall": round(recall, 4),
            "f1_score": round(f1, 4),
        })

        if metric_value > best_metric:
            best_metric = metric_value
            best_threshold = threshold

    return {
        "task_type": task_type,
        "optimal_threshold": best_threshold,
        f"best_{metric_to_optimize}": round(best_metric, 4),
        "all_results": results,
    }
```

---

### E.20 章节内风格波动检测

> 📋 本节为 [C.14 M11 风格漂移检测](#c14-m11 风格漂移检测) 的工程实现补充，建议实现时与对应章节一并阅读。

#### E.20.1 问题背景

M11 的漂移检测是章节级的，但同一章节内也可能存在严重的风格波动（如前半段作者写、后半段 AI 续写）。

#### E.20.2 章节内分段检测

```python
# --- 摘要：detect_intra_chapter_drift() —— 章节内分段风格波动检测，将章节按800字分段计算风格指纹方差 ---
def detect_intra_chapter_drift(
    chapter_text: str,
    segment_size: int = 800  # 每段800字
) -> dict:
    """
    检测章节内的风格波动

    参数:
        chapter_text: 章节全文
        segment_size: 分段大小（字数）

    返回:
        dict: 章节内风格波动分析
    """
    # 将章节按字数分段
    segments = []
    for i in range(0, len(chapter_text), segment_size):
        segment = chapter_text[i:i + segment_size]
        if len(segment) < 200:  # 忽略过短的段
            continue
        segments.append({
            "index": len(segments),
            "start": i,
            "end": i + len(segment),
            "text": segment,
            "features": extract_50d_features(segment)
        })

    if len(segments) < 2:
        return {"status": "insufficient_segments", "segment_count": len(segments)}

    # 计算相邻段落的风格相似度
    adjacencies = []
    for i in range(1, len(segments)):
        sim = cosine_sim(
            segments[i - 1]["features"]["style_vector"],
            segments[i]["features"]["style_vector"]
        )
        adjacencies.append({
            "segment_a": segments[i - 1]["index"],
            "segment_b": segments[i]["index"],
            "similarity": round(sim, 4),
            "is_abrupt": sim < 0.80  # 段落间突变阈值（比章间更严格）
        })

    # 计算章节内风格波动指数
    similarities = [a["similarity"] for a in adjacencies]
    import statistics
    volatility_index = statistics.stdev(similarities) if len(similarities) > 1 else 0

    # 找出突变点
    abrupt_points = [a for a in adjacencies if a["is_abrupt"]]

    return {
        "status": "analyzed",
        "segment_count": len(segments),
        "segment_size": segment_size,
        "volatility_index": round(volatility_index, 4),
        "volatility_level": (
            "high" if volatility_index > 0.10 else
            "medium" if volatility_index > 0.05 else
            "low"
        ),
        "adjacent_similarities": adjacencies,
        "abrupt_points": abrupt_points,
        "intra_chapter_consistency": round(
            statistics.mean(similarities), 4
        ) if similarities else 1.0,
    }
```

#### E.20.3 章节内一致性评分

```python
def score_intra_chapter_consistency(
    chapter_text: str,
    work_id: str,
    chapter_num: int
) -> dict:
    """
    评分章节内的风格一致性

    参数:
        chapter_text: 章节全文
        work_id: 作品ID
        chapter_num: 章节号

    返回:
        dict: 一致性评分报告
    """
    drift_result = detect_intra_chapter_drift(chapter_text)

    if drift_result["status"] != "analyzed":
        return {"score": None, "reason": drift_result["status"]}

    # 基于波动指数和一致性计算评分
    consistency = drift_result["intra_chapter_consistency"]
    volatility = drift_result["volatility_index"]
    abrupt_count = len(drift_result["abrupt_points"])

    # 评分公式：一致性×(1-波动惩罚)×(1-突变惩罚)
    volatility_penalty = min(0.3, volatility * 2)  # 波动惩罚上限30%
    abrupt_penalty = min(0.2, abrupt_count * 0.05)  # 每个突变点扣5%，上限20%
    score = consistency * (1 - volatility_penalty) * (1 - abrupt_penalty) * 100

    return {
        "score": round(score, 1),
        "consistency": consistency,
        "volatility_index": volatility,
        "abrupt_point_count": abrupt_count,
        "grade": (
            "excellent" if score >= 90 else
            "good" if score >= 75 else
            "fair" if score >= 60 else
            "poor"
        ),
        "details": drift_result
    }
```

---

### E.21 风格恢复与纠偏建议系统

> 📋 本节为 [C.19 M16 风格守护 Agent](#c19-m16 风格守护 agent) 的工程实现补充，建议实现时与对应章节一并阅读。

#### E.21.1 问题背景

29.8 节设计了漂移根因分析，告诉作者"哪里漂了"，但缺少具体的修复指导。作者知道"的"字密度升高了，但不知道怎么改回来。

#### E.21.2 纠偏建议生成

```python
# --- 摘要：generate_correction_suggestions() —— 基于漂移根因分析生成具体纠偏建议（含示例文本和优先级） ---
def generate_correction_suggestions(
    drift_report: dict,
    work_id: str,
    chapter_num: int
) -> list[dict]:
    """
    基于漂移根因分析生成具体的纠偏建议

    参数:
        drift_report: 漂移根因分析报告（来自29.8的generate_drift_report）
        work_id: 作品ID
        chapter_num: 当前章节号

    返回:
        list[dict]: 纠偏建议列表（按优先级排序）
    """
    suggestions = []
    causes = drift_report.get("top_causes", [])

    for cause in causes[:5]:
        dim = cause["dimension"]
        z_score = cause["z_score"]
        direction = cause["direction"]
        baseline = cause["baseline_value"]
        current = cause["current_value"]

        suggestion = {
            "dimension": dim,
            "severity": cause["severity"],
            "z_score": z_score,
            "suggestions": []
        }

        # 根据不同维度生成具体建议
        if "de_density" in dim or "的" in dim:
            if direction == "increased":
                suggestion["suggestions"].extend([
                    {
                        "type": "manual",
                        "action": "检查并删除不必要的\"的\"字",
                        "example": "\"美丽的风景\" → \"美景\""
                    },
                    {
                        "type": "ai_assist",
                        "action": "使用去AI味工具批量检查",
                        "tool": "StyleAgent.deAI_flavor"
                    },
                ])
            else:
                suggestion["suggestions"].append({
                    "type": "info",
                    "action": "\"的\"字密度偏低，可适当增加修饰",
                })

        elif "sentence_length" in dim or "句长" in dim:
            if direction == "increased":
                suggestion["suggestions"].extend([
                    {
                        "type": "manual",
                        "action": "将长句拆分为短句",
                        "example": "将超过40字的句子拆分为两个20字左右的句子"
                    },
                    {
                        "type": "prompt_adj",
                        "action": "在生成Prompt中强调短句风格",
                        "prompt_addition": "请使用短句，平均句长控制在{baseline:.0f}字以内"
                    },
                ])
            else:
                suggestion["suggestions"].append({
                    "type": "manual",
                    "action": "适当增加句长变化，避免全部短句",
                })

        elif "dialogue" in dim or "对话" in dim:
            suggestion["suggestions"].append({
                "type": "manual",
                "action": f"调整对话比例至目标值{baseline:.1%}",
                "details": "增加角色对话或减少叙述描写"
            })

        elif "ai_flavor" in dim:
            suggestion["suggestions"].extend([
                {
                    "type": "ai_assist",
                    "action": "运行AI味检测，定位具体问题表达",
                    "tool": "M5.detect_ai_flavor"
                },
                {
                    "type": "prompt_adj",
                    "action": "在生成Prompt中强化AI味禁令",
                    "prompt_addition": "严禁使用以下表达：宛如、仿佛、缓缓地、心中涌起"
                },
            ])

        else:
            suggestion["suggestions"].append({
                "type": "general",
                "action": f"维度\"{dim}\"偏离基准{z_score}σ，建议关注并调整"
            })

        suggestions.append(suggestion)

    return suggestions
```

#### E.21.3 风格恢复 Prompt

```python
STYLE_RECOVERY_PROMPT = """请按照以下目标风格重写给定文本。

【目标风格参数】
- 平均句长: {avg_sentence_length}字
- 词汇丰富度(TTR): {ttr}
- "的"字密度: {de_density}
- 对话比例: {dialogue_ratio}
- 感官词密度: {sensory_density}

【当前问题】
{drift_description}

【修复要求】
1. 保持原文的情节内容和角色对话不变
2. 仅调整写作风格，使其符合目标参数
3. 消除AI味表达
4. 保持场景类型的风格适配

【待修复文本】
{text_to_fix}
"""
```

#### E.21.4 渐进式修复策略

```python
def plan_correction_strategy(
    drift_report: dict,
    max_corrections_per_session: int = 3
) -> dict:
    """
    制定渐进式修复策略

    参数:
        drift_report: 漂移根因报告
        max_corrections_per_session: 每次最多修复的维度数

    返回:
        dict: 修复计划
    """
    causes = drift_report.get("top_causes", [])

    # 按严重程度排序，优先修复最严重的
    sorted_causes = sorted(causes, key=lambda c: -c["z_score"])

    # 每次修复不超过max_corrections_per_session个维度
    session_plan = sorted_causes[:max_corrections_per_session]

    return {
        "total_issues": len(causes),
        "this_session": len(session_plan),
        "remaining": len(causes) - len(session_plan),
        "priority_order": [
            {
                "dimension": c["dimension"],
                "z_score": c["z_score"],
                "severity": c["severity"],
                "action": f"修复\"{c['dimension']}\"（偏离{c['z_score']}σ）"
            }
            for c in session_plan
        ],
        "verification_step": "修复后请重新运行风格检测，确认偏差降至1σ以内"
    }
```

---

### E.22 数据安全与隐私合规

#### E.22.1 问题背景

B4 收集了大量作者的风格数据，但缺少数据导出/导入和隐私保护机制。

#### E.22.2 风格数据导出格式

```python
# --- 摘要：STYLE_EXPORT_SCHEMA —— 风格数据导出格式定义（JSON），含作品信息/宪法/统计/检查点/标注 ---
STYLE_EXPORT_SCHEMA = {
    "version": "1.0",
    "exported_at": "ISO8601时间戳",
    "work_info": {
        "work_id": "UUID",
        "name": "作品名称",
        "genre": "类型",
        "total_chapters": "总章数",
        "total_words": "总字数",
    },
    "style_constitution": {
        "version": "宪法版本号",
        "philosophy_text": "风格哲学文本",
        "structured_preferences": "结构化选项",
        "target_vector": "目标风格向量",
    },
    "style_statistics": {
        "global_mean_vector": "全局均值向量",
        "global_std_vector": "全局标准差向量",
        "chapter_count": "统计章节数",
    },
    "style_intents": [
        {
            "change_type": "类型",
            "chapter_range": [start, end],
            "description": "描述",
            "status": "状态",
        }
    ],
    "learning_rules": {
        "banned_words": ["禁用词列表"],
        "preferred_words": ["偏好词列表"],
        "custom_rules": ["自定义规则列表"],
    },
    "character_fingerprints": {
        "character_name": {
            "version": "指纹版本",
            "catchphrases": ["口头禅"],
            "style_vector": "对话风格向量",
        }
    },
}

def export_style_data(work_id: str, export_format: str = "json") -> dict:
    """
    导出作品的完整风格数据

    参数:
        work_id: 作品ID
        export_format: 导出格式（json/yaml）

    返回:
        dict: 导出的风格数据
    """
    # 收集所有风格数据
    work = db.query("SELECT * FROM works WHERE id = %s", work_id)[0]
    constitution = db.query(
        "SELECT * FROM style_constitutions WHERE work_id = %s ORDER BY version DESC LIMIT 1",
        work_id
    )[0]

    export_data = {
        "version": "1.0",
        "exported_at": datetime.now().isoformat(),
        "work_info": {
            "work_id": work_id,
            "name": work["name"],
            "genre": work["genre"],
            "total_chapters": db.query(
                "SELECT COUNT(*) FROM chapters WHERE work_id = %s", work_id
            )[0][0],
        },
        "style_constitution": {
            "version": constitution["version"],
            "philosophy_text": constitution["philosophy_text"],
            "structured_preferences": constitution["structured_preferences"],
        },
        "style_statistics": {
            "global_mean_vector": get_global_mean_vector(work_id),
            "global_std_vector": get_global_std_vector(work_id),
        },
        "style_intents": get_all_intents(work_id),
        "learning_rules": get_all_learning_rules(work_id),
        "character_fingerprints": get_all_character_fingerprints(work_id),
    }

    return export_data
```

#### E.22.3 数据安全策略

```python
# --- 摘要：STYLE_DATA_SECURITY —— 风格数据安全策略，AES-256加密/匿名化/访问控制/备份策略 ---
# 风格数据安全配置
STYLE_DATA_SECURITY = {
    "encryption": {
        "algorithm": "AES-256-GCM",
        "key_management": "每用户独立密钥，由用户密码派生",
        "fields_to_encrypt": [
            "philosophy_text",          # 风格哲学文本
            "structured_preferences",   # 结构化选项
            "welford_stats",            # Welford统计量
        ],
    },
    "access_control": {
        "owner_full_access": True,           # 作品所有者完全访问
        "collaborator_read_only": True,      # 协作者只读
        "system_anonymized_access": True,    # 系统匿名访问（用于模板市场）
    },
    "data_retention": {
        "active_work": "永久保留（直到作者删除）",
        "deleted_work": "30天后彻底删除",
        "orphaned_data": "90天清理",
    },
    "gdpr_compliance": {
        "right_to_export": True,             # 导出权
        "right_to_delete": True,             # 删除权
        "right_to_portability": True,        # 可携带权
        "deletion_confirmation": True,       # 删除确认
    },
}

def delete_style_data(work_id: str, confirm: bool = False) -> dict:
    """
    彻底删除作品的风格数据（GDPR合规）

    参数:
        work_id: 作品ID
        confirm: 是否确认删除

    返回:
        dict: 删除报告
    """
    if not confirm:
        return {"status": "confirmation_required", "message": "请确认删除操作"}

    # 记录待删除的数据范围
    tables_to_clean = [
        ("style_constitutions", "work_id"),
        ("style_intents", "work_id"),
        ("style_learning_rules", "work_id"),
        ("chapter_style_stats", "work_id"),
        ("ai_flavor_results", "work_id"),
        ("content_authorship_marks", "work_id"),
        ("style_checkpoints", "work_id"),
        ("character_dialogue_fingerprints", "work_id"),
    ]

    deleted_counts = {}
    for table, column in tables_to_clean:
        count = db.query(
            f"SELECT COUNT(*) FROM {table} WHERE {column} = %s", work_id
        )[0][0]
        db.execute(
            f"DELETE FROM {table} WHERE {column} = %s", work_id
        )
        deleted_counts[table] = count

    return {
        "status": "deleted",
        "work_id": work_id,
        "deleted_records": deleted_counts,
        "total_deleted": sum(deleted_counts.values()),
        "message": f"已彻底删除{sum(deleted_counts.values())}条风格数据记录"
    }
```

---

### E.23 风格模板生态与社区共享

#### E.23.1 问题背景

M1 的初始化问卷是"从零开始"定义风格，但大多数新手作者不知道如何描述自己的风格。缺少风格模板库来降低入门门槛。

#### E.23.2 风格模板数据结构

```sql
CREATE TABLE style_templates (
    -- === 主键与标识 ===
    id UUID PRIMARY KEY,
    name VARCHAR(100) NOT NULL,             -- 模板名称（如"古龙风"）
    -- === 模板内容 ===
    description TEXT NOT NULL,               -- 模板描述
    category VARCHAR(20) NOT NULL,           -- 分类（official/community/custom）
    genre VARCHAR(20),                       -- 适用类型（all/xianxia/urban等）
    author_id VARCHAR(50),                   -- 创建者ID（官方模板为NULL）

    -- 风格配置
    constitution_text TEXT,                  -- 风格哲学文本
    structured_preferences JSONB,            -- 结构化选项
    target_vector JSONB,                     -- 目标风格向量
    banned_words TEXT[],                     -- 推荐禁用词
    preferred_words TEXT[],                  -- 推荐偏好词

    -- 社区数据
    download_count INT DEFAULT 0,            -- 下载次数
    rating_avg FLOAT DEFAULT 0.0,            -- 平均评分
    rating_count INT DEFAULT 0,              -- 评分人数
    tags TEXT[],                             -- 标签

    -- 审核
    is_verified BOOLEAN DEFAULT FALSE,       -- 是否经过官方审核
    verified_at TIMESTAMP,

    -- === 审计字段 ===
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
-- ER关系：本表为系统级配置表，通过 template_type 区分类型
```

#### E.23.3 官方预设模板

```python
# --- 摘要：OFFICIAL_TEMPLATES —— 官方预设风格模板（古龙风/金庸风/网文爽文/文艺清新/暗黑悬疑） ---
OFFICIAL_TEMPLATES = [
    {
        "name": "古龙风",
        "description": "短句密集，意境深远，留白多，对话精炼",
        "genre": "all",
        "structured_preferences": {
            "formality": 6,
            "emotion_intensity": 7,
            "narrative_distance": 3,
            "description_density": 3,
            "pacing": "fast",
        },
        "target_vector": {
            "avg_sentence_length": 12,
            "de_density": 0.020,
            "ttr": 0.55,
            "short_sentence_ratio": 0.45,
            "dialogue_ratio": 0.45,
        },
        "banned_words": ["仿佛", "宛如", "缓缓地", "心中涌起"],
        "preferred_words": ["冷", "风", "月", "刀", "酒"],
        "tags": ["武侠", "短句", "意境", "经典"],
    },
    {
        "name": "金庸风",
        "description": "文白混用，描写细腻，文化底蕴深厚，叙事宏大",
        "genre": "all",
        "structured_preferences": {
            "formality": 7,
            "emotion_intensity": 6,
            "narrative_distance": 5,
            "description_density": 7,
            "pacing": "medium",
        },
        "target_vector": {
            "avg_sentence_length": 25,
            "de_density": 0.030,
            "ttr": 0.68,
            "four_char_density": 0.06,
            "description_ratio": 0.35,
        },
        "banned_words": [],
        "preferred_words": ["端的是", "兀自", "却说", "且说", "只见"],
        "tags": ["武侠", "古典", "细腻", "经典"],
    },
    {
        "name": "猫腻风",
        "description": "第一人称，口语化，幽默感强，内心独白丰富",
        "genre": "all",
        "structured_preferences": {
            "formality": 3,
            "emotion_intensity": 5,
            "narrative_distance": 2,
            "description_density": 4,
            "pacing": "medium",
        },
        "target_vector": {
            "avg_sentence_length": 18,
            "de_density": 0.025,
            "ttr": 0.60,
            "colloquial_density": 0.10,
            "monologue_ratio": 0.25,
        },
        "banned_words": ["仿佛", "宛如"],
        "preferred_words": ["其实", "说实话", "问题是", "有意思"],
        "tags": ["网文", "口语", "幽默", "第一人称"],
    },
    {
        "name": "烽火戏诸侯风",
        "description": "文辞华丽，意象丰富，情感浓烈，节奏张弛有度",
        "genre": "xianxia",
        "structured_preferences": {
            "formality": 8,
            "emotion_intensity": 9,
            "narrative_distance": 4,
            "description_density": 8,
            "pacing": "slow",
        },
        "target_vector": {
            "avg_sentence_length": 28,
            "de_density": 0.035,
            "ttr": 0.72,
            "sensory_density": 0.10,
            "four_char_density": 0.07,
        },
        "banned_words": [],
        "preferred_words": ["天地", "苍穹", "岁月", "山河", "春秋"],
        "tags": ["仙侠", "华丽", "意象", "情感"],
    },
]
```

#### E.23.4 模板应用流程

```python
# --- 摘要：apply_style_template() —— 风格模板应用流程，支持部分覆盖和自定义微调 ---
def apply_style_template(
    work_id: str,
    template_id: str,
    customization: dict | None = None
) -> dict:
    """
    将风格模板应用到作品

    参数:
        work_id: 作品ID
        template_id: 模板ID
        customization: 作者的自定义调整（覆盖模板默认值）

    返回:
        dict: 应用报告
    """
    template = db.query(
        "SELECT * FROM style_templates WHERE id = %s", template_id
    )[0]

    # 解析模板配置
    constitution_text = template["constitution_text"]
    structured = template["structured_preferences"]
    target_vector = template["target_vector"]

    # 应用作者自定义调整
    if customization:
        if "structured_preferences" in customization:
            structured.update(customization["structured_preferences"])
        if "additional_banned_words" in customization:
            existing_banned = set(template["banned_words"] or [])
            existing_banned.update(customization["additional_banned_words"])
            template["banned_words"] = list(existing_banned)

    # 创建风格宪法
    constitution_version = create_constitution(
        work_id=work_id,
        philosophy_text=constitution_text,
        structured_preferences=structured,
        target_vector=target_vector,
    )

    # 导入禁用词和偏好词
    for word in (template["banned_words"] or []):
        add_banned_word(work_id, word, source="template")
    for word in (template["preferred_words"] or []):
        add_preferred_word(work_id, word, source="template")

    # 更新模板下载计数
    db.execute(
        "UPDATE style_templates SET download_count = download_count + 1 WHERE id = %s",
        template_id
    )

    return {
        "template_name": template["name"],
        "constitution_version": constitution_version,
        "banned_words_imported": len(template["banned_words"] or []),
        "preferred_words_imported": len(template["preferred_words"] or []),
        "customization_applied": customization is not None,
        "message": f"已应用「{template['name']}」风格模板"
    }
```

---

### E.24 风格检测性能优化与缓存策略

> 📋 本节为 [C.25 成本控制](#c25-成本控制) 的工程实现补充，建议实现时与对应章节一并阅读。

#### E.24.1 问题背景

16.3 节定义了性能 SLA，但缺少达到这些 SLA 的具体优化策略和缓存设计。

#### E.24.2 多级缓存架构

```text
L1 内存缓存（进程级）
  ├── 章节分词结果（TTL: 永久，章节修改时失效）
  ├── 章节特征向量（TTL: 永久，章节修改时失效）
  └── 禁用词/偏好词表（TTL: 5分钟）

L2 Redis缓存（服务级）
  ├── 窗口均值向量（TTL: 1小时）
  ├── 漂移检测结果（TTL: 30分钟）
  └── AI味检测结果（TTL: 30分钟）

L3 数据库（持久化）
  └── 所有历史数据
```

#### E.24.3 缓存键设计与失效策略

```python
# --- 摘要：StyleCacheManager —— 风格检测多级缓存管理器（L1内存/L2 Redis/L3数据库），含缓存键设计 ---
import hashlib
import json

class StyleCacheManager:
    """风格检测多级缓存管理器"""

    def __init__(self, redis_client):
        self.redis = redis_client
        self.memory_cache: dict[str, tuple[float, any]] = {}  # {key: (expire_time, value)}

    def _make_key(self, prefix: str, work_id: str, **kwargs) -> str:
        """生成缓存键"""
        parts = [prefix, work_id] + [f"{k}={v}" for k, v in sorted(kwargs.items())]
        raw = ":".join(parts)
        return f"style:{hashlib.md5(raw.encode()).hexdigest()[:16]}"

    def get_features(self, work_id: str, chapter_num: int, chapter_hash: str) -> dict | None:
        """
        获取章节特征（L1内存缓存）

        参数:
            work_id: 作品ID
            chapter_num: 章节号
            chapter_hash: 章节内容哈希（用于失效判断）

        返回:
            dict | None: 缓存的特征向量，未命中返回None
        """
        key = self._make_key("features", work_id, ch=chapter_num)
        if key in self.memory_cache:
            expire_time, value = self.memory_cache[key]
            if expire_time > time.time() and value.get("hash") == chapter_hash:
                return value["features"]
            else:
                del self.memory_cache[key]
        return None

    def set_features(
        self, work_id: str, chapter_num: int,
        chapter_hash: str, features: dict
    ) -> None:
        """缓存章节特征"""
        key = self._make_key("features", work_id, ch=chapter_num)
        self.memory_cache[key] = (
            time.time() + 3600 * 24,  # 24小时过期
            {"hash": chapter_hash, "features": features}
        )

    def get_window_vector(
        self, work_id: str, window_size: int, end_chapter: int
    ) -> list[float] | None:
        """
        获取窗口均值向量（L2 Redis缓存）

        参数:
            work_id: 作品ID
            window_size: 窗口大小
            end_chapter: 窗口结束章节

        返回:
            list[float] | None: 缓存的窗口向量
        """
        key = self._make_key("window", work_id, ws=window_size, end=end_chapter)
        cached = self.redis.get(key)
        if cached:
            return json.loads(cached)
        return None

    def set_window_vector(
        self, work_id: str, window_size: int,
        end_chapter: int, vector: list[float], ttl: int = 3600
    ) -> None:
        """缓存窗口均值向量"""
        key = self._make_key("window", work_id, ws=window_size, end=end_chapter)
        self.redis.setex(key, ttl, json.dumps(vector))

    def invalidate_chapter(self, work_id: str, chapter_num: int) -> int:
        """
        章节修改时失效相关缓存

        参数:
            work_id: 作品ID
            chapter_num: 修改的章节号

        返回:
            int: 失效的缓存条目数
        """
        invalidated = 0

        # 失效L1内存缓存中该章节的特征
        key = self._make_key("features", work_id, ch=chapter_num)
        if key in self.memory_cache:
            del self.memory_cache[key]
            invalidated += 1

        # 失效L2 Redis中包含该章节的所有窗口缓存
        # 通过模式匹配删除
        pattern = f"style:*:ws=*:end={chapter_num}"
        for key in self.redis.scan_iter(match=pattern):
            self.redis.delete(key)
            invalidated += 1

        # 失效该章节之后的所有窗口缓存（因为窗口包含了该章节）
        pattern = f"style:*:ws=*"
        for key in self.redis.scan_iter(match=pattern):
            data = self.redis.get(key)
            if data:
                parsed = json.loads(data)
                # 简化处理：清除所有窗口缓存，让它们自然重建
                # TODO(P3): 优化为精确失效——仅删除包含该章节的滑动窗口缓存，避免全量失效
                self.redis.delete(key)
                invalidated += 1

        return invalidated
```

#### E.24.4 特征提取性能优化

```python
import numpy as np
from functools import lru_cache

# 预编译正则表达式（避免重复编译）
import re
SENTENCE_SPLIT_RE = re.compile(r'[。！？；]')
DE_CHARACTER_RE = re.compile(r'的')
COMMA_RE = re.compile(r'，')
PERIOD_RE = re.compile(r'。')

# 感官词典预加载（避免每次从数据库读取）
SENSORY_WORD_SETS = None

def get_sensory_word_sets():
    """懒加载感官词典"""
    global SENSORY_WORD_SETS
    if SENSORY_WORD_SETS is None:
        SENSORY_WORD_SETS = {
            "visual": set(load_sensory_words("visual")),
            "auditory": set(load_sensory_words("auditory")),
            "tactile": set(load_sensory_words("tactile")),
            "olfactory": set(load_sensory_words("olfactory")),
            "gustatory": set(load_sensory_words("gustatory")),
        }
    return SENSORY_WORD_SETS

def fast_extract_syntax_features(text: str) -> dict:
    """
    高性能句法特征提取（向量化优化版）

    相比逐个正则匹配，使用预编译正则和批量计数
    """
    # 批量标点统计
    sentences = SENTENCE_SPLIT_RE.split(text)
    sentence_lengths = [len(s) for s in sentences if s.strip()]

    if not sentence_lengths:
        return {"avg_sentence_length": 0, "sentence_length_std": 0}

    arr = np.array(sentence_lengths, dtype=np.float64)

    return {
        "avg_sentence_length": float(np.mean(arr)),
        "sentence_length_std": float(np.std(arr)),
        "long_sentence_ratio": float(np.sum(arr > 40) / len(arr)),
        "short_sentence_ratio": float(np.sum(arr < 10) / len(arr)),
        "de_density": len(DE_CHARACTER_RE.findall(text)) / len(text),
        "comma_density": len(COMMA_RE.findall(text)) / len(text),
        "period_density": len(PERIOD_RE.findall(text)) / len(text),
    }
```

#### E.24.5 性能监控指标

```python
# 性能监控配置
PERFORMANCE_MONITORING = {
    "metrics": {
        "feature_extraction_time_ms": {
            "description": "50维特征提取耗时",
            "sla_target": 50,     # SLA目标: 50ms
            "warning_threshold": 80,   # 警告阈值: 80ms
            "critical_threshold": 150, # 严重阈值: 150ms
        },
        "llm_detection_time_ms": {
            "description": "LLM检测耗时",
            "sla_target": 5000,
            "warning_threshold": 8000,
            "critical_threshold": 15000,
        },
        "cache_hit_rate": {
            "description": "缓存命中率",
            "sla_target": 0.80,    # 目标80%命中率
            "warning_threshold": 0.60,
            "critical_threshold": 0.40,
        },
        "drift_detection_latency_ms": {
            "description": "漂移检测端到端延迟",
            "sla_target": 100,
            "warning_threshold": 200,
            "critical_threshold": 500,
        },
    },
    "reporting": {
        "interval_seconds": 60,     # 每60秒汇总一次
        "retention_days": 7,        # 保留7天数据
        "alert_channels": ["log", "dashboard"],  # 告警通道
    },
}
```

---

<a id="appendix-f"></a>

## 附录 F 跨模块事件总线 —— 完整设计方案

> 📍 附录 F：跨模块事件总线完整设计（F.1-F.9），从第 17 章 15.4 节拆分

> **版本**：v1.0 | **日期**：2026-04-18 | **状态**：从第 17 章拆分独立

> **解决盲点**：B1 大纲变更传播、B1 软/硬约束弹性、B2 规则优先级冲突、B3 合理断裂标记、B4 风格-节奏耦合、B5 叙事线合并冲突

### F.1 设计哲学
B1-B5 不是孤立的模块，而是**有机协作的系统**。任何模块的输出变更都可能影响其他模块。事件总线是模块间的"神经系统"——不是简单的消息队列，而是带**语义理解**的协调引擎。

### F.2 事件类型定义
```python
# --- 摘要：EventType枚举 + EventData数据类 —— 跨模块事件类型定义（B1-B8共8模块约40种事件） ---
from enum import Enum
from dataclasses import dataclass, field
from typing import Optional, List
from datetime import datetime

class EventType(Enum):
    """跨模块事件类型"""
    # === B1 大纲事件 ===
    OUTLINE_CREATED = "outline.created"           # 新建大纲
    OUTLINE_UPDATED = "outline.updated"           # 大纲内容变更
    OUTLINE_DELETED = "outline.deleted"           # 大纲删除
    OUTLINE_DEVIATION = "outline.deviation"       # 写作偏离大纲
    OUTLINE_BRANCH_CREATED = "outline.branch"     # 大纲分支探索
    
    # === B2 检查事件 ===
    RULE_CREATED = "rule.created"                 # 新增检查规则
    RULE_CONFLICT = "rule.conflict"               # 规则间冲突
    CHECK_RESULT = "check.result"                 # 检查结果产出
    CHECK_DISMISS = "check.dismiss"               # 作者忽略检查
    
    # === B3 因果链事件 ===
    ELEMENT_INTRODUCED = "element.introduced"     # 新元素引入
    ELEMENT_STATE_CHANGE = "element.state"        # 元素状态变更
    CAUSAL_BREAK = "causal.break"                 # 因果链断裂（待确认）
    CAUSAL_BREAK_CONFIRMED = "causal.confirmed"   # 断裂确认为问题
    CAUSAL_BREAK_INTENTIONAL = "causal.intentional"  # 断裂标记为"故意的"
    FORESHADOW_PLANTED = "foreshadow.planted"     # 伏笔埋设
    FORESHADOW_RESOLVED = "foreshadow.resolved"   # 伏笔回收
    
    # === B4 风格事件 ===
    STYLE_CONSTITUTION_CHANGE = "style.constitution"  # 风格宪法变更
    STYLE_INTENT_REGISTERED = "style.intent"      # 风格意图注册
    STYLE_DRIFT_DETECTED = "style.drift"          # 风格漂移检测
    STYLE_SCENE_REQUEST = "style.scene"           # 场景风格请求
    
    # === B5 叙事线事件 ===
    LINE_CREATED = "line.created"                 # 叙事线创建
    LINE_MERGED = "line.merged"                   # 叙事线合并
    LINE_CONVERGED = "line.converged"             # 叙事线交汇
    LINE_SAVEPOINT = "line.savepoint"             # 存档点创建
    LINE_HANDOFF = "line.handoff"                 # 线切换交接

    # === B6 角色状态事件 ===
    CHARACTER_STATE_ANOMALY = "character.state.anomaly"  # 角色状态异常检测完成

    # === B7 伏笔管理事件 ===
    FORESHADOWING_RECOVERY_DETECTED = "foreshadowing.recovery.detected"      # 伏笔回收检测完成
    FORESHADOWING_DENSITY_WARNING = "foreshadowing.density.warning"          # 伏笔密度预警
    FORESHADOWING_DEPENDENCY_VIOLATION = "foreshadowing.dependency.violation" # 伏笔依赖违规

    # === B8 节奏分析事件 ===
    RHYTHM_ANOMALY_DETECTED = "rhythm.anomaly.detected"  # 节奏异常检测完成


@dataclass
class CrossModuleEvent:
    """跨模块事件"""
    event_id: str                    # 事件唯一ID
    event_type: EventType            # 事件类型
    source_module: str               # 来源模块 (B1/B2/B3/B4/B5/B6/B7/B8)
    work_id: str                     # 作品ID
    chapter_num: Optional[int]       # 关联章节号
    payload: dict                    # 事件数据
    priority: int = 5                # 优先级 1-10，10最高
    propagation: str = "auto"        # 传播策略：auto/confirm/block
    created_at: datetime = field(default_factory=datetime.now)
    metadata: dict = field(default_factory=dict)  # 元信息（置信度、来源等）
```

### F.3 事件传播矩阵
定义每种事件对其他模块的影响：

```python
# --- 摘要：PROPAGATION_MATRIX —— 事件传播矩阵，定义各模块事件到目标模块的传播规则和响应动作 ---
# 事件传播矩阵：source_event → {target_module: reaction}
PROPAGATION_MATRIX = {
    # ── B1 大纲变更 ──
    EventType.OUTLINE_UPDATED: {
        "B2": "recheck_affected_rules",      # 重新检查受影响的规则
        "B3": "update_causal_plan",           # 更新计划因果链
        "B4": "update_style_constraints",     # 更新风格约束
        "B5": "sync_narrative_lines",         # 同步叙事线
        # B6: refresh_character_states —— 重新加载受影响角色的运行时状态，
        #     如果弧线阶段定义变更（phases中的name/expected_state发生变化），
        #     则重置该角色的arc_phase和arc_position，使其在下次写作时重新匹配
        "B6": "refresh_character_states",     # 刷新角色状态快照
        # B7: check_foreshadowing_impact —— 检查章节重排（增删/移动章节）
        #     是否影响已有伏笔的planted_chapter和expected_chapter，
        #     若受影响则更新伏笔的章节引用并标记需要人工确认
        "B7": "check_foreshadowing_impact",   # 检查伏笔影响范围
        # B8: recalculate_rhythm_baseline —— 如果章纲的pacing字段发生变更，
        #     重新计算受影响章节的节奏画像（rhythm fingerprint），
        #     使节奏基线与最新大纲意图保持一致
        "B8": "recalculate_rhythm_baseline",  # 重算节奏基线
    },
    EventType.OUTLINE_DEVIATION: {
        "B1": "evaluate_deviation",           # 评估偏离严重度
        "B2": "relax_temporary_rules",        # 临时放宽相关规则
    },
    EventType.OUTLINE_BRANCH_CREATED: {
        "B1": "snapshot_current_state",       # 快照当前状态
        "B2": "branch_check_rules",           # 分支检查规则
        "B3": "branch_element_states",        # 分支元素状态
    },
    
    # ── B2 规则冲突 ──
    EventType.RULE_CONFLICT: {
        "B2": "arbitrate_priority",           # 仲裁规则优先级
    },
    EventType.CHECK_DISMISS: {
        "B2": "update_false_positive_model",  # 更新误报模型
        "B3": "lower_element_confidence",     # 降低相关元素置信度
    },
    
    # ── B3 因果链 ──
    EventType.CAUSAL_BREAK_INTENTIONAL: {
        "B2": "suppress_related_checks",      # 抑制相关检查（不报误报）
        "B3": "mark_intentional_gap",         # 标记为故意断裂
    },
    EventType.FORESHADOW_PLANTED: {
        "B3": "register_foreshadow",          # 注册伏笔
        "B5": "tag_cross_line_if_needed",     # 跨线标记
    },
    
    # ── B4 风格 ──
    EventType.STYLE_SCENE_REQUEST: {
        "B4": "match_scene_style",            # 匹配场景风格
        "B5": "adjust_narrative_tension",     # 调整叙事张力
    },
    EventType.STYLE_DRIFT_DETECTED: {
        "B4": "trigger_recovery",             # 触发风格恢复
    },
    
    # ── B5 叙事线 ──
    EventType.LINE_MERGED: {
        "B2": "resolve_state_conflicts",      # 解决状态冲突
        "B3": "merge_element_states",         # 合并元素状态
        "B4": "blend_line_styles",            # 融合线风格
        "B5": "arbitrate_merge_conflicts",    # 仲裁合并冲突
    },
    EventType.LINE_HANDOFF: {
        "B2": "switch_knowledge_context",     # 切换知识上下文
        "B3": "pause_resume_elements",        # 暂停/恢复元素心跳
        "B4": "switch_style_profile",         # 切换风格配置
    },

    # ── B7 伏笔管理 ──
    EventType.FORESHADOWING_RESOLVED: {
        "B6": "update_arc_milestones",        # 更新角色弧里程碑状态
        "B7": "mark_foreshadow_completed",    # 标记伏笔为已完成
    },

    # ── B8 节奏分析 ──
    EventType.RHYTHM_ANOMALY_DETECTED: {
        "B4": "trigger_style_drift_check",    # 触发风格漂移检测（节奏异常可能导致风格偏移）
        "B8": "log_rhythm_anomaly",           # 记录节奏异常日志
    },
}
```

### F.4 章节保存后处理管线（PostSavePipeline）

章节保存后需要执行一系列后处理步骤，确保各模块数据一致性。PostSavePipeline 定义了统一的执行顺序和失败策略。

```python
# --- 摘要：PostSavePipeline —— 章节保存后处理管线，定义同步阶段（步骤1-2）和异步阶段（步骤3-6）的执行顺序 ---
class PostSavePipeline:
    """
    章节保存后处理管线 —— 定义保存后的统一处理步骤和执行顺序
    
    执行分为两个阶段：
    - 同步阶段（步骤1-2）：保存操作必须等待完成，失败则回滚保存
    - 异步阶段（步骤3-6）：后台执行，失败仅记录错误，不影响保存结果
    """

    async def execute(self, chapter_id: str, chapter_num: int,
                      content: str, outline_context: dict):
        """
        执行完整的后处理管线
        
        Args:
            chapter_id: 章节唯一标识
            chapter_num: 章节编号
            content: 章节文本内容
            outline_context: 大纲上下文（含pacing、角色列表等）
        """
        # 管线开始日志：记录管线启动，便于追踪后处理流程
        import time
        pipeline_start = time.monotonic()
        logger.info(f"PostSavePipeline开始执行，work_id={outline_context.get('work_id', 'unknown')}, chapter={chapter_num}")

        # ══════════════════════════════════════════
        # 同步阶段：保存操作需等待，失败则回滚
        # ⚠️ 总超时约束：同步阶段（步骤1+2）总超时 3秒
        #   - 步骤1（B4风格统计）：超时 1.5秒
        #   - 步骤2（B8节奏画像）：超时 1.5秒
        #   - 超时后跳过对应步骤并记录 WARNING 日志，
        #     仅当步骤1超时时步骤2才可执行（因步骤2依赖步骤1结果）
        # ══════════════════════════════════════════

        # 步骤1：B4 风格统计更新（必须最先执行，B8依赖其结果）
        #   - extract_50d_features：从章节文本提取50维风格特征向量
        #   - Welford增量更新：用Welford在线算法增量更新全局风格均值/方差
        try:
            style_features = await self.b4_service.extract_50d_features(content)
            self.b4_service.update_statistics_welford(
                chapter_num=chapter_num,
                features=style_features
            )
        except Exception as e:
            # 同步步骤失败 → 回滚保存，向用户报告错误
            logger.error(f"PostSavePipeline 步骤1失败（风格统计更新）: {e}")
            raise SaveRollbackError(f"风格统计更新失败，已回滚保存: {e}")

        # 步骤2：B8 节奏画像计算（依赖步骤1的4维特征）
        #   - compute_fingerprint：基于B4的4维节奏特征计算节奏指纹
        #   - 产出该章节的节奏画像，供后续异常检测使用
        try:
            rhythm_fingerprint = await self.b8_service.compute_fingerprint(
                style_features=style_features,  # 依赖步骤1的结果
                chapter_num=chapter_num,
                pacing_hint=outline_context.get("pacing")  # 大纲中的节奏提示
            )
        except Exception as e:
            # 同步步骤失败 → 回滚保存
            logger.error(f"PostSavePipeline 步骤2失败（节奏画像计算）: {e}")
            raise SaveRollbackError(f"节奏画像计算失败，已回滚保存: {e}")

        # 同步阶段完成日志：记录同步阶段耗时，便于性能监控
        sync_elapsed = (time.monotonic() - pipeline_start) * 1000  # 转换为毫秒
        logger.debug(f"同步阶段完成，耗时{sync_elapsed:.0f}ms")

        # ══════════════════════════════════════════
        # 异步阶段：后台执行，失败仅记录错误
        # ⚠️ 各步骤单次超时约束：
        #   - 步骤3（B6角色同步）：单次超时 5秒
        #   - 步骤4（B7伏笔检测）：单次超时 30秒（含LLM调用）
        #   - 步骤5（统一检测管线）：单次超时 10秒
        #   - 步骤6（B5存档点更新）：单次超时 3秒
        #   - 超时后跳过该步骤并记录 WARNING 日志
        # ══════════════════════════════════════════

        # 提前初始化检测结果变量，避免后续步骤依赖 dir() 检查
        detection_results = {}

        # 创建异步任务，不阻塞保存返回
        # 保存task引用并添加done_callback，防止异步任务异常被静默丢失
        task = asyncio.create_task(self._execute_async_phase(
            chapter_id=chapter_id,
            chapter_num=chapter_num,
            content=content,
            outline_context=outline_context,
            rhythm_fingerprint=rhythm_fingerprint,
        ))
        # 异常回调：任务完成时检查是否有未捕获的异常，防止静默丢失
        task.add_done_callback(lambda t: t.exception() if not t.cancelled() else None)

    async def _execute_async_phase(self, chapter_id: str, chapter_num: int,
                                    content: str, outline_context: dict,
                                    rhythm_fingerprint: dict):
        """异步阶段：步骤3-6，后台执行"""

        # 异步阶段计时起点
        import time
        async_start = time.monotonic()

        # 步骤3：B6 角色状态同步（依赖写作内容）
        #   - sync_agent_to_memory：将章节中的角色反应同步到记忆系统
        #   - 乐观锁重试策略：最多重试3次，每次间隔100ms
        #     角色状态同步涉及并发写入（多个章节可能同时更新同一角色），
        #     使用乐观锁避免数据冲突，冲突时自动重试
        import asyncio
        max_retries = 3  # 最大重试次数
        retry_interval = 0.1  # 重试间隔（秒）
        for attempt in range(1, max_retries + 1):
            try:
                await self.b6_service.sync_agent_to_memory(
                    chapter_id=chapter_id,
                    chapter_num=chapter_num,
                    content=content,
                )
                break  # 成功则跳出重试循环
            except OptimisticLockError as e:
                if attempt < max_retries:
                    logger.warning(
                        f"PostSavePipeline 步骤3乐观锁冲突，"
                        f"第{attempt}次重试（共{max_retries}次）: {e}"
                    )
                    await asyncio.sleep(retry_interval)
                else:
                    logger.error(
                        f"PostSavePipeline 步骤3乐观锁冲突，"
                        f"已重试{max_retries}次仍失败: {e}"
                    )
            except Exception as e:
                logger.error(f"PostSavePipeline 步骤3失败（角色状态同步）: {e}")
                break  # 非乐观锁错误不重试，直接跳出
        # 异步步骤失败 → 仅记录，不影响保存

        # 步骤4：B7 伏笔回收检测（含LLM调用，可异步）
        #   - detect_foreshadowing_recovery：检测本章是否回收了已埋伏笔
        try:
            await self.b7_service.detect_foreshadowing_recovery(
                chapter_id=chapter_id,
                chapter_num=chapter_num,
                content=content,
            )
        except Exception as e:
            logger.error(f"PostSavePipeline 步骤4失败（伏笔回收检测）: {e}")

        # 步骤5：统一检测管线执行（汇总所有检测）
        #   - UnifiedDetectionPipeline.run：汇总B2/B3/B4/B7等检测结果
        try:
            detection_results = await self.unified_pipeline.run(
                chapter_id=chapter_id,
                chapter_num=chapter_num,
            )
        except Exception as e:
            logger.error(f"PostSavePipeline 步骤5失败（统一检测管线）: {e}")

        # 步骤6：B5 存档点更新（依赖检测结果）
        #   - 基于步骤5的检测结果更新叙事线存档点
        try:
            await self.b5_service.update_checkpoint(
                chapter_id=chapter_id,
                chapter_num=chapter_num,
                detection_results=detection_results,  # 已在异步阶段开始前初始化为{}
            )
        except Exception as e:
            logger.error(f"PostSavePipeline 步骤6失败（存档点更新）: {e}")

        # 异步阶段完成日志：记录异步阶段耗时
        async_elapsed = (time.monotonic() - async_start) * 1000  # 转换为毫秒
        logger.debug(f"异步阶段完成，耗时{async_elapsed:.0f}ms")

        # 管线完成日志：记录总耗时，便于端到端性能监控
        total_elapsed = (time.monotonic() - pipeline_start) * 1000  # 转换为毫秒
        logger.info(f"PostSavePipeline执行完成，总耗时{total_elapsed:.0f}ms")
```

**执行顺序与依赖关系图：**

```
章节保存成功
    │
    ├── [同步阻塞] 步骤1: B4 风格统计更新 ──── 失败 → 回滚保存
    │       │
    │       ▼
    ├── [同步阻塞] 步骤2: B8 节奏画像计算 ──── 失败 → 回滚保存
    │       │
    │       ▼ (同步阶段完成，保存操作返回成功)
    │
    └── [异步后台] ── 步骤3: B6 角色状态同步 ── 失败 → 记录错误
                        │
                        ▼
                    步骤4: B7 伏笔回收检测 ── 失败 → 记录错误
                        │
                        ▼
                    步骤5: 统一检测管线 ── 失败 → 记录错误
                        │
                        ▼
                    步骤6: B5 存档点更新 ── 失败 → 记录错误
```

**失败策略总结：**

| 阶段 | 步骤 | 失败处理 | 对保存的影响 |
|------|------|------|-------------|
| 同步阻塞 | 步骤 1 B4 风格统计 | 抛出 SaveRollbackError | 回滚保存，用户收到错误提示 |
| 同步阻塞 | 步骤 2 B8 节奏画像 | 抛出 SaveRollbackError | 回滚保存，用户收到错误提示 |
| 异步后台 | 步骤 3 B6 角色同步 | 记录错误日志 | 不影响保存，下次保存时重试 |
| 异步后台 | 步骤 4 B7 伏笔检测 | 记录错误日志 | 不影响保存，下次保存时重试 |
| 异步后台 | 步骤 5 统一检测 | 记录错误日志 | 不影响保存，下次保存时重试 |
| 异步后台 | 步骤 6 B5 存档点 | 记录错误日志 | 不影响保存，下次保存时重试 |

**并发写入冲突处理机制：**

PostSavePipeline 涉及多个模块的并发写入，需要确保数据一致性。以下是各模块的并发控制策略：

```python
# --- 摘要：ConcurrencyControl —— 并发写入冲突处理策略，定义各模块的锁机制/排队策略和幂等保护 ---
class ConcurrencyControl:
    """
    并发写入冲突处理策略

    核心原则：
    - 单用户场景为主（一个作者同时编辑一个作品）
    - 多标签页/多设备场景通过乐观锁处理
    - 跨模块数据一致性通过事件总线的序列化保证
    """

    # ══════════════════════════════════════════
    # B6 角色运行时状态：乐观锁（H26修复）
    # ══════════════════════════════════════════
    # B6的save_runtime_state()已实现乐观锁机制（见H26修复）：
    # - 每条CharacterRuntimeState记录包含version字段
    # - 更新时检查version是否匹配，不匹配则抛出OptimisticLockError
    # - PostSavePipeline步骤3捕获该异常后自动重试（最多3次）
    #
    # 示例：
    #   UPDATE character_runtime_states
    #   SET ..., version = version + 1
    #   WHERE entity_id = %s AND version = %s
    #   -- 如果affected_rows == 0，说明版本不匹配，触发重试

    # ══════════════════════════════════════════
    # B7 伏笔状态转换：事件总线序列化保证
    # ══════════════════════════════════════════
    # B7的伏笔状态转换（如PLANNED→ACTIVE→RESOLVED）通过事件总线保证顺序：
    # - 同一伏笔的状态转换事件按FIFO顺序串行处理
    # - 事件总线为每个foreshadowing_id维护独立的事件队列
    # - 状态转换函数是幂等的：相同的状态转换执行多次结果一致
    # - PostSavePipeline步骤4（伏笔回收检测）发出状态转换事件后，
    #   由事件总线异步消费，不阻塞保存流程
    #
    # 并发场景示例：
    #   用户保存第10章 → 步骤4发出 "fp_001: ACTIVE→RESOLVED" 事件
    #   用户立即保存第11章 → 步骤4发出 "fp_001: ACTIVE→DORMANT" 事件
    #   事件总线按顺序处理：先RESOLVED，再DORMANT被忽略（状态已不是ACTIVE）
    #
    # 实现要点：
    #   class ForeshadowEventQueue:
    #       """伏笔事件队列：按foreshadowing_id隔离，保证同伏笔事件串行"""
    #       _queues: dict[str, asyncio.Queue] = {}  # foreshadowing_id → 事件队列
    #
    #       async def emit(self, foreshadowing_id: str, event: StateTransitionEvent):
    #           queue = self._queues.setdefault(foreshadowing_id, asyncio.Queue())
    #           await queue.put(event)
    #
    #       async def process(self, foreshadowing_id: str):
    #           """消费者：串行处理同一伏笔的所有事件"""
    #           queue = self._queues.get(foreshadowing_id)
    #           while not queue.empty():
    #               event = await queue.get()
    #               await self._apply_transition(event)  # 幂等的状态转换

    # ══════════════════════════════════════════
    # B8 节奏画像：按章节独立计算，天然无冲突
    # ══════════════════════════════════════════
    # B8的节奏画像计算具有天然的并发安全性：
    # - 每个章节的节奏画像（chapter_style_stats）是独立记录
    # - compute_fingerprint()只写入当前章节的记录，不修改其他章节
    # - 趋势分析（如D3a连续单调检测）只读取历史数据，不写入
    # - 即使两个标签页同时保存同一章节，最后写入的结果会覆盖前一个
    #   （可接受的最终一致性，因为节奏画像是基于文本的确定性计算）
    #
    # 唯一需要注意的场景：章节删除时的级联重算（见附录 F.6 ChapterCascadeHandler —— 章节变更级联处理器，处理删除/合并/拆分时的跨模块数据一致性维护）
    # 此时通过数据库行级锁（SELECT FOR UPDATE）避免重算任务与正常保存的冲突
```

**并发控制策略总结：**

| 模块 | 并发策略 | 冲突检测 | 恢复方式 |
|------|---------|------|---------|
| B6 角色状态 | 乐观锁（version 字段） | 写入时检查 version | 自动重试（最多 3 次） |
| B7 伏笔状态 | 事件总线序列化 | 同伏笔事件 FIFO 排队 | 幂等转换，丢弃无效事件 |
| B8 节奏画像 | 无锁（章节独立） | 不需要（天然无冲突） | 最后写入胜出 |
| B4 风格统计 | Welford 增量算法 | 原子更新（单行 SQL） | 重新计算当章统计 |

### F.5 约束弹性系统（软约束 vs 硬约束）
```python
# --- 摘要：ConstraintElasticity 完整dataclass定义 —— 约束弹性系统，支持HARD/SOFT/ADVISORY三级弹性 ---
@dataclass
class ConstraintElasticity:
    """
    约束弹性系统：大纲不是死板的"宪法"，而是有弹性的"指导方针"
    
    弹性等级：
    - HARD：绝对不可违反（如角色核心人设）
    - SOFT：可以临时偏离，但需要回归路径（如角色性格细节）
    - ADVISORY：仅供参考，不强制（如建议的情节走向）
    """
    constraint_id: str
    source: str                   # 来源：outline/rule/style/element
    level: str                    # hard / soft / advisory
    
    # 软约束特有字段
    max_deviation: float = 0.3    # 最大偏离度 0-1
    recovery_chapters: int = 5    # 偏离后N章内需回归
    deviation_current: float = 0.0  # 当前偏离度
    
    # 偏离追踪
    deviation_log: list[dict] = field(default_factory=list)
    deviation_start_chapter: Optional[int] = None


def evaluate_outline_deviation(
    outline_item: dict,
    actual_writing: str,
    constraint: ConstraintElasticity
) -> dict:
    """
    评估大纲偏离度
    
    Args:
        outline_item: 大纲条目（含预期内容摘要）
        actual_writing: 实际写作文本
        constraint: 约束弹性配置
    
    Returns:
        偏离评估结果
    """
    # Step 1: 语义相似度计算（大纲预期 vs 实际写作）
    # TODO(P3): 待实现
    similarity = compute_semantic_similarity(
        outline_item["expected_summary"],
        # TODO(P3): 待实现
        extract_summary(actual_writing)
    )
    
    # Step 2: 关键要素覆盖率
    expected_elements = outline_item.get("key_elements", [])
    covered_elements = [
        elem for elem in expected_elements
        if elem.lower() in actual_writing.lower()
           # TODO(P3): 待实现
           or semantic_match(elem, actual_writing)
    ]
    coverage = len(covered_elements) / max(len(expected_elements), 1)
    
    # Step 3: 综合偏离度
    deviation = 1.0 - (similarity * 0.6 + coverage * 0.4)
    
    # Step 4: 弹性判断
    result = {
        "deviation": round(deviation, 3),
        "similarity": round(similarity, 3),
        "coverage": round(coverage, 3),
        "covered_elements": covered_elements,
        "missing_elements": [e for e in expected_elements if e not in covered_elements],
        "status": "ok",  # ok / warning / critical
        "action": None,
    }
    
    if constraint.level == "hard":
        if deviation > 0.1:
            result["status"] = "critical"
            result["action"] = "block"  # 硬约束：阻止继续偏离
    elif constraint.level == "soft":
        if deviation > constraint.max_deviation:
            result["status"] = "critical"
            result["action"] = "require_recovery_plan"
        elif deviation > constraint.max_deviation * 0.7:
            result["status"] = "warning"
            result["action"] = "suggest_recovery"
    # advisory级别：仅记录日志，不触发任何动作
    
    return result
```

### F.6 章节变更级联处理（ChapterCascadeHandler）

当作者执行章节删除、合并或拆分操作时，需要级联更新各模块中基于章节号的数据引用，确保数据一致性。

```python
# --- 摘要：ChapterCascadeHandler —— 章节变更级联处理器，处理删除/合并/拆分时的跨模块数据一致性维护 ---
class ChapterCascadeHandler:
    """
    章节变更级联处理器

    处理章节删除、合并、拆分时的跨模块数据一致性维护。
    所有级联操作在一个数据库事务中执行，任一步骤失败则全部回滚。
    """

    async def on_chapter_delete(self, work_id: str, deleted_chapter_num: int):
        """
        章节删除时的级联处理

        Args:
            work_id: 作品ID
            deleted_chapter_num: 被删除的章节号
        """
        async with db.transaction():
            # ══════════════════════════════════════════
            # 步骤1：B6 角色运行时状态更新
            # ══════════════════════════════════════════
            # 检查并更新CharacterRuntimeState中基于chapter_num的记录
            # - 删除该章节的角色状态快照（如有）
            # - 更新后续章节的引用：所有chapter_num > deleted_chapter_num的记录减1
            await db.execute(
                """DELETE FROM character_runtime_snapshots
                   WHERE work_id = %s AND chapter_num = %s""",
                work_id, deleted_chapter_num
            )
            await db.execute(
                """UPDATE character_runtime_snapshots
                   SET chapter_num = chapter_num - 1
                   WHERE work_id = %s AND chapter_num > %s""",
                work_id, deleted_chapter_num
            )

            # ══════════════════════════════════════════
            # 步骤2：B7 伏笔章节引用更新
            # ══════════════════════════════════════════
            # 更新所有伏笔的章节引用（后续章节号-1）
            # - planted_chapter：埋设章节
            # - expected_chapter：预期回收章节
            # - last_mentioned_chapter：最后提及章节
            # - actual_resolved_chapter：实际回收章节
            foreshadowing_fields = [
                "planted_chapter", "expected_chapter",
                "last_mentioned_chapter", "actual_resolved_chapter"
            ]
            for field in foreshadowing_fields:
                # 删除引用被删章节的伏笔记录（如planted_chapter被删，该伏笔需人工确认）
                # 注意：不直接删除伏笔，而是标记为需要人工审核
                await db.execute(
                    f"""UPDATE unified_foreshadowings
                        SET {field} = {field} - 1
                        WHERE work_id = %s AND {field} > %s""",
                    work_id, deleted_chapter_num
                )
                # 如果某伏笔的planted_chapter恰好是被删章节，标记为需人工审核
                if field == "planted_chapter":
                    await db.execute(
                        """UPDATE unified_foreshadowings
                           SET status = 'PLANNED', needs_review = true
                           WHERE work_id = %s AND planted_chapter = %s""",
                        work_id, deleted_chapter_num
                    )

            # ══════════════════════════════════════════
            # 步骤3：B8 节奏画像更新
            # ══════════════════════════════════════════
            # 删除对应章节的节奏画像记录
            await db.execute(
                """DELETE FROM chapter_style_stats
                   WHERE work_id = %s AND chapter_num = %s""",
                work_id, deleted_chapter_num
            )
            # 重新计算受影响章节的节奏画像（删除点之后的所有章节）
            # 因为节奏趋势检测依赖相邻章节的对比
            affected_chapters = db.query(
                """SELECT chapter_num FROM chapter_style_stats
                   WHERE work_id = %s AND chapter_num >= %s
                   ORDER BY chapter_num""",
                work_id, deleted_chapter_num
            )
            for ch in affected_chapters:
                # 异步重新计算，不阻塞当前操作
                asyncio.create_task(
                    self.b8_service.recompute_fingerprint(work_id, ch["chapter_num"])
                )

            # ══════════════════════════════════════════
            # 步骤4：B5 存档点更新
            # ══════════════════════════════════════════
            # 删除被删章节的存档点，更新后续存档点的chapter_num
            await db.execute(
                """DELETE FROM narrative_checkpoints
                   WHERE work_id = %s AND chapter_num = %s""",
                work_id, deleted_chapter_num
            )
            await db.execute(
                """UPDATE narrative_checkpoints
                   SET chapter_num = chapter_num - 1
                   WHERE work_id = %s AND chapter_num > %s""",
                work_id, deleted_chapter_num
            )

    async def on_chapter_merge(self, work_id: str, merged_chapter_nums: list[int],
                                new_chapter_num: int):
        """
        章节合并时的级联处理

        将多个章节合并为一个新章节时：
        - B6：合并角色状态快照，取最后一个合并章节的状态作为基准
        - B7：伏笔的planted_chapter/last_mentioned_chapter如在合并范围内，
              统一指向新章节号；expected_chapter按比例调整
        - B8：删除旧章节的节奏画像，为新章节重新计算
        - B5：合并存档点，保留最后一个合并章节的存档数据

        Args:
            work_id: 作品ID
            merged_chapter_nums: 被合并的章节号列表（按顺序）
            new_chapter_num: 合并后的新章节号
        """
        # 章节合并本质上是"删除多个旧章节 + 插入一个新章节"
        # 先执行类似删除的级联处理，再为新章节建立数据
        # 详细实现与on_chapter_delete类似，此处省略重复逻辑
        pass

    async def on_chapter_split(self, work_id: str, original_chapter_num: int,
                                new_chapter_nums: list[int]):
        """
        章节拆分时的级联处理

        将一个章节拆分为多个新章节时：
        - B6：保留原章节的角色状态快照，为新拆分章节创建空快照
        - B7：伏笔的planted_chapter如在拆分范围内，指向第一个新章节；
              last_mentioned_chapter指向最后一个包含提及的新章节
        - B8：删除原章节的节奏画像，为每个新章节重新计算
        - B5：原存档点保留在第一个新章节，后续新章节创建空存档点

        Args:
            work_id: 作品ID
            original_chapter_num: 被拆分的原章节号
            new_chapter_nums: 拆分后的新章节号列表（按顺序）
        """
        # 章节拆分本质上是"删除一个旧章节 + 插入多个新章节"
        # 详细实现与on_chapter_delete类似，此处省略重复逻辑
        pass
```

**级联处理执行流程图：**

```
章节变更操作（删除/合并/拆分）
    │
    ▼
ChapterCascadeHandler 接收事件
    │
    ├── [事务开始]
    │   ├── 步骤1: B6 角色运行时状态更新
    │   ├── 步骤2: B7 伏笔章节引用更新
    │   ├── 步骤3: B8 节奏画像更新（部分异步）
    │   └── 步骤4: B5 存档点更新
    │
    ├── [事务提交] 或 [全部回滚]
    │
    └── [异步] B8节奏画像重新计算
```

### F.7 规则冲突仲裁引擎
```python
# --- 摘要：RuleArbitrator —— 规则冲突仲裁引擎，按优先级（作者声明>硬约束>新规则>高置信度）仲裁矛盾结论 ---
class RuleArbitrator:
    """
    规则冲突仲裁引擎
    
    当B2的多条检查规则产生矛盾结论时，按以下优先级仲裁：
    1. 作者明确声明 > AI推断
    2. 硬约束 > 软约束 > 建议性
    3. 新规则 > 旧规则（时间优先）
    4. 高置信度 > 低置信度
    5. 具体规则 > 通用规则
    """
    
    def arbitrate(self, conflicts: list) -> list:
        """
        仲裁规则冲突
        
        Args:
            conflicts: 冲突列表，每项含 {
                "rule_a": {"id", "source", "level", "confidence", "created_at", "scope"},
                "rule_b": {"id", "source", "level", "confidence", "created_at", "scope"},
                "conflict_description": str
            }
        
        Returns:
            仲裁结果列表
        """
        results = []
        for conflict in conflicts:
            a, b = conflict["rule_a"], conflict["rule_b"]
            winner = self._compare(a, b)
            results.append({
                "conflict": conflict["conflict_description"],
                "winner": winner["id"],
                "loser": (b if winner["id"] == a["id"] else a)["id"],
                "reason": winner["reason"],
                "requires_author": winner.get("requires_author", False),
            })
        return results
    
    def _compare(self, a: dict, b: dict) -> dict:
        """比较两条规则的优先级"""
        
        # 规则1：作者明确声明 > AI推断
        if a["source"] == "author" and b["source"] == "ai":
            return {**a, "reason": "作者声明优先于AI推断"}
        if b["source"] == "author" and a["source"] == "ai":
            return {**b, "reason": "作者声明优先于AI推断"}
        
        # 规则2：硬约束 > 软约束 > 建议性
        level_rank = {"hard": 3, "soft": 2, "advisory": 1}
        if level_rank.get(a["level"], 0) != level_rank.get(b["level"], 0):
            winner = a if level_rank.get(a["level"], 0) > level_rank.get(b["level"], 0) else b
            return {**winner, "reason": f"约束等级更高（{winner['level']}）"}
        
        # 规则3：新规则 > 旧规则
        if a["created_at"] != b["created_at"]:
            winner = a if a["created_at"] > b["created_at"] else b
            return {**winner, "reason": "更新时间更近"}
        
        # 规则4：高置信度 > 低置信度
        if abs(a["confidence"] - b["confidence"]) > 0.2:
            winner = a if a["confidence"] > b["confidence"] else b
            return {**winner, "reason": f"置信度更高（{winner['confidence']:.0%}）"}
        
        # 规则5：具体 > 通用
        if a.get("scope") != b.get("scope"):
            winner = a if a.get("scope") == "specific" else b
            return {**winner, "reason": "规则更具体"}
        
        # 无法自动仲裁，需要作者介入
        return {**a, "reason": "无法自动仲裁，需作者确认", "requires_author": True}
```

### F.8 叙事线合并冲突解决
```python
# --- 摘要：MergeConflictResolver —— 叙事线合并冲突解决器，提供预设策略模板处理角色/元素/时间线冲突 ---
class MergeConflictResolver:
    """
    叙事线合并冲突解决器
    
    当B5的两条叙事线合并时，角色/元素/时间线可能冲突。
    提供预设的解决策略模板，作者可选择或自定义。
    """
    
    # 冲突类型 → 解决策略
    STRATEGIES = {
        "character_state_conflict": [
            {
                "name": "主线优先",
                "description": "以主线（weight更高）的角色状态为准",
                "auto": True,
            },
            {
                "name": "最新优先",
                "description": "以时间上更近的状态为准",
                "auto": True,
            },
            {
                "name": "融合状态",
                "description": "将两个状态融合（如：A线受伤+B线完好 → 轻伤）",
                "auto": False,  # 需要LLM辅助
            },
            {
                "name": "作者指定",
                "description": "作者手动选择保留哪个状态",
                "auto": False,
            },
        ],
        "timeline_conflict": [
            {
                "name": "时间锚点对齐",
                "description": "以全局时间轴引擎（M4）的绝对时间为准",
                "auto": True,
            },
            {
                "name": "相对时间对齐",
                "description": "以各线内部的相对时间关系为准",
                "auto": True,
            },
        ],
        "style_conflict": [
            {
                "name": "目标风格统一",
                "description": "合并后统一为目标风格（B4 M1宪法）",
                "auto": True,
            },
            {
                "name": "保留线风格",
                "description": "合并后各保留原线风格特征",
                "auto": False,
            },
        ],
    }
    
    def resolve_merge(
        self,
        line_a_id: str,
        line_b_id: str,
        strategy_selections: Optional[dict] = None
    ) -> dict:
        """
        解决叙事线合并冲突
        
        Args:
            line_a_id: 叙事线A的ID
            line_b_id: 叙事线B的ID
            strategy_selections: 作者选择的策略 {conflict_type: strategy_name}
        
        Returns:
            合并方案
        """
        # Step 1: 检测冲突
        conflicts = self._detect_conflicts(line_a_id, line_b_id)
        
        # Step 2: 对每个冲突应用策略
        resolution_plan = []
        for conflict in conflicts:
            ctype = conflict["type"]
            strategies = self.STRATEGIES.get(ctype, [])
            
            # 作者已选策略
            if strategy_selections and ctype in strategy_selections:
                chosen = next(
                    s for s in strategies 
                    if s["name"] == strategy_selections[ctype]
                )
            else:
                # 自动选择第一个可自动执行的策略
                chosen = next((s for s in strategies if s.get("auto")), strategies[0])
            
            resolution_plan.append({
                "conflict": conflict,
                "strategy": chosen["name"],
                "description": chosen["description"],
                "auto_resolved": chosen.get("auto", False),
                "requires_author": not chosen.get("auto", False),
            })
        
        return {
            "conflicts_found": len(conflicts),
            "resolution_plan": resolution_plan,
            "author_action_required": any(
                not r["auto_resolved"] for r in resolution_plan
            ),
        }
    
    def _detect_conflicts(self, line_a_id: str, line_b_id: str) -> list:
        """检测两条叙事线合并时的冲突"""
        conflicts = []
        
        # 检查角色状态冲突（使用统一实体叙事线状态表）
        char_states_a = db.query(
            "SELECT entity_id, state FROM entity_line_states WHERE line_id = %s", line_a_id
        )
        char_states_b = db.query(
            "SELECT entity_id, state FROM entity_line_states WHERE line_id = %s", line_b_id
        )
        
        for ca in char_states_a:
            for cb in char_states_b:
                if ca["entity_id"] == cb["entity_id"]:
                    if ca["state"] != cb["state"]:
                        conflicts.append({
                            "type": "character_state_conflict",
                            "entity_id": ca["entity_id"],  # 统一实体ID（角色）
                            "state_a": ca["state"],
                            "state_b": cb["state"],
                            "severity": "high",
                        })
        
        # 检查时间线冲突
        # ...（调用B5 M4全局时间轴引擎进行对齐检查）
        
        return conflicts
```

### F.9 事件总线 SQL Schema
```sql
# --- 摘要：cross_module_events + constraint_elasticity + rule_arbitrations SQL Schema —— 事件总线与约束系统存储 ---
-- 跨模块事件日志表
CREATE TABLE cross_module_events (
    -- === 主键与标识 ===
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type VARCHAR(50) NOT NULL,          -- 事件类型
    source_module VARCHAR(5) NOT NULL,        -- 来源模块 B1/B2/B3/B4/B5/B6/B7/B8
    target_module VARCHAR(5),                 -- 目标模块（NULL=广播）
    -- === 关联与载荷 ===
    work_id UUID NOT NULL REFERENCES works(id),
    chapter_num INT,
    payload JSONB NOT NULL DEFAULT '{}',      -- 事件数据
    priority INT DEFAULT 5,                   -- 优先级 1-10
    propagation VARCHAR(10) DEFAULT 'auto',   -- auto/confirm/block
    -- === 状态与审计 ===
    status VARCHAR(20) DEFAULT 'pending',     -- pending/processing/done/failed
    result JSONB,                             -- 处理结果
    created_at TIMESTAMP DEFAULT NOW(),
    processed_at TIMESTAMP
);
-- ER关系：本表通过 work_id 关联到 works(id)；source_module/target_module 为模块标识（B1-B8），非直接外键

-- 事件处理索引
CREATE INDEX idx_events_work_type ON cross_module_events(work_id, event_type);
CREATE INDEX idx_events_status ON cross_module_events(status);
CREATE INDEX idx_events_source ON cross_module_events(source_module);
-- 按来源模块+事件类型复合索引，支持跨模块事件溯源查询
CREATE INDEX idx_events_source_type ON cross_module_events(source_module, event_type);

-- 数据保留：status='done' 的事件保留30天后归档，'failed' 事件保留90天后归档。
-- 归档操作由每日清理任务执行（见 #19.5.2），归档到 cross_module_events_archive 表。

-- 约束弹性表
CREATE TABLE constraint_elasticity (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    work_id UUID NOT NULL REFERENCES works(id),
    constraint_id VARCHAR(100) NOT NULL,      -- 约束唯一标识
    source VARCHAR(20) NOT NULL,              -- outline/rule/style/element
    level VARCHAR(10) NOT NULL,               -- hard/soft/advisory
    max_deviation FLOAT DEFAULT 0.3,          -- 软约束最大偏离度
    recovery_chapters INT DEFAULT 5,          -- 回归章节数
    current_deviation FLOAT DEFAULT 0.0,      -- 当前偏离度
    deviation_start_chapter INT,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(work_id, constraint_id)
);
-- ER关系：本表通过 work_id 关联到 works(id)

-- 规则冲突仲裁记录
CREATE TABLE rule_arbitrations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    work_id UUID NOT NULL REFERENCES works(id),
    rule_a_id VARCHAR(100) NOT NULL,
    rule_b_id VARCHAR(100) NOT NULL,
    winner_id VARCHAR(100) NOT NULL,
    reason TEXT NOT NULL,
    requires_author BOOLEAN DEFAULT FALSE,
    author_resolution JSONB,                  -- 作者的最终裁决
    created_at TIMESTAMP DEFAULT NOW()
);
-- ER关系：本表通过 work_id 关联到 works(id)

-- 数据保留：仲裁记录保留最近50章，更早的归档
```

---

<a id="appendix-g"></a>

## 附录 G 统一底层架构 —— 完整设计方案

> 📍 附录 G：统一底层架构完整设计（G.1-G.5），从第 17 章 15.8 节拆分

> **版本**：v1.0 | **日期**：2026-04-18 | **状态**：从第 17 章拆分独立

> **设计动机**：B1-B5 各自独立设计导致 10 个重叠领域（实体状态、检测管线、模板版本、可视化等），存在数据冗余、接口不统一、维护成本高的问题。本节将重叠设计合并为 4 大统一底层。

### G.1 ① 统一实体状态引擎（UnifiedEntityEngine）
**合并来源**：
- B1 #9.4.2 角色弧线数据结构
- B2 #10.9.1 属性库 + #10.9.2 铁事实
- B3 #11.7.1 元素三态管理
- B5 附录 D M9 双层状态模型

**核心思想**：所有"作品中的实体"（角色、物品、地点、组织、概念）使用**同一套状态引擎**管理，各模块只是在不同维度上观察和操作同一个实体。

```python
# --- 摘要：UnifiedEntity 核心数据模型 —— EntityDomain（实体域）/EntityLifecycle（实体生命周期）枚举 + UnifiedEntity 完整 dataclass 定义 ---
from enum import Enum
from dataclasses import dataclass, field
from typing import Optional, List, Dict, Any
from datetime import datetime

class EntityDomain(Enum):
    """实体所属领域（决定哪些模块关注它）"""
    CHARACTER = "character"     # 角色 → B1弧线 + B2属性 + B3元素 + B5状态
    ITEM = "item"               # 物品 → B2属性 + B3元素
    LOCATION = "location"       # 地点 → B2属性 + B3元素
    ORGANIZATION = "org"        # 组织 → B2属性 + B3元素
    CONCEPT = "concept"         # 概念（力量体系、世界观规则）→ B2铁事实
    FORESHADOWING = "foreshadowing"  # 伏笔 → B7伏笔生命周期管理（伏笔实体使用此domain）

class EntityLifecycleState(Enum):
    """实体生命周期状态（合并B3三态 + B5叙事线状态）"""
    DORMANT = "dormant"         # 未引入/休眠 → B3心跳暂停
    ACTIVE = "active"           # 活跃中 → 所有模块正常追踪
    FROZEN = "frozen"           # 冻结（大纲分支/时间旅行）→ 快照保留
    DEAD = "dead"               # 退役/死亡 → B3停止心跳，B2标记历史


@dataclass
class UnifiedEntity:
    """
    统一实体：所有B模块共享的实体表示
    
    替代原有的：
    - B1 character_arcs 表
    - B2 character_attributes + iron_facts 表
    - B3 story_elements 表
    - B5 character_global_states + character_line_states 表
    """
    # === 基础信息 ===
    entity_id: str                              # 全局唯一ID
    work_id: str                                # 作品ID
    name: str                                   # 实体名称
    domain: EntityDomain                        # 实体领域
    lifecycle: EntityLifecycleState = EntityLifecycleState.DORMANT
    
    # === B2 属性层（合并属性库+铁事实） ===
    attributes: Dict[str, Any] = field(default_factory=dict)  # {"age": 25, "cultivation": "金丹期"}
    iron_facts: List[str] = field(default_factory=list)       # 不可变事实 ["张三是李四的师父"]
    attribute_history: List[dict] = field(default_factory=list)  # 变更日志
    
    # === B3 元素层（合并三态+心跳） ===
    importance: float = 0.5                     # 重要性 0-1（B3机制二推断）
    last_mentioned_chapter: int = 0             # 最后提及章节
    heartbeat_active: bool = False              # 心跳是否激活
    foreshadow_ids: List[str] = field(default_factory=list)  # 关联的伏笔ID
    
    # === B5 叙事线层（合并双层状态） ===
    global_state: Dict[str, Any] = field(default_factory=dict)  # 全局状态
    line_states: Dict[str, Dict] = field(default_factory=dict)  # {line_id: state}
    
    # === B1 弧线层 ===
    arc_id: Optional[str] = None                # 关联的角色弧线ID
    arc_position: float = 0.0                   # 弧线进度 0-1
    
    # === 元信息 ===
    created_at: datetime = field(default_factory=datetime.now)
    updated_at: datetime = field(default_factory=datetime.now)
    tags: List[str] = field(default_factory=list)  # 自由标签


class UnifiedEntityEngine:
    """
    统一实体状态引擎
    
    提供实体的CRUD + 状态转换 + 跨模块通知
    所有B模块通过此引擎访问实体，不再直接操作数据库
    """
    
    def __init__(self, event_bus):
        self.event_bus = event_bus
        self._cache: Dict[str, UnifiedEntity] = {}  # 实体缓存
    
    # ── 公共访问接口 ──
    
    def get_entity(self, entity_id: str) -> UnifiedEntity:
        """
        获取实体对象（公共访问接口）
        
        封装内部 _get() 方法，提供公共访问接口。
        外部模块（如B6 CharacterStateBridge）应使用此方法，
        而非直接调用 _get()（私有方法，命名约定以下划线开头）。
        
        Args:
            entity_id: 实体ID
            
        Returns:
            UnifiedEntity 实体对象
            
        Raises:
            KeyError: 实体不存在时抛出
        """
        return self._get(entity_id)
    
    # ── 生命周期管理 ──
    
    def activate(self, entity_id: str, chapter_num: int, context: str = ""):
        """激活实体（B3元素引入检测调用此方法）"""
        entity = self._get(entity_id)
        old_state = entity.lifecycle
        
        if old_state == EntityLifecycleState.DORMANT:
            entity.lifecycle = EntityLifecycleState.ACTIVE
            entity.heartbeat_active = True
            entity.last_mentioned_chapter = chapter_num
            
            # 通知各模块
            self.event_bus.emit(EventType.ELEMENT_INTRODUCED, source="ENGINE", payload={
                "entity_id": entity_id,
                "domain": entity.domain.value,
                "chapter_num": chapter_num,
            })
    
    def freeze(self, entity_id: str, reason: str = ""):
        """冻结实体（大纲分支/时间旅行时调用）"""
        entity = self._get(entity_id)
        entity.lifecycle = EntityLifecycleState.FROZEN
        entity.heartbeat_active = False
    
    def retire(self, entity_id: str, chapter_num: int, reason: str = ""):
        """退役实体（B3元素退役流程调用此方法）"""
        entity = self._get(entity_id)
        entity.lifecycle = EntityLifecycleState.DEAD
        entity.heartbeat_active = False
        
        self.event_bus.emit(EventType.ELEMENT_STATE_CHANGE, source="ENGINE", payload={
            "entity_id": entity_id,
            "new_state": "dead",
            "chapter_num": chapter_num,
            "reason": reason,
        })
    
    # ── 属性管理（B2） ──
    
    def update_attribute(self, entity_id: str, key: str, value: Any, 
                         chapter_num: int, source: str = "author"):
        """
        更新实体属性
        
        Args:
            source: "author"（作者声明）/"ai_inferred"（AI推断）/"plot"（剧情导致）
        """
        entity = self._get(entity_id)
        old_value = entity.attributes.get(key)
        
        # 铁事实不可修改
        if key in entity.iron_facts and source != "author":
            return {"status": "rejected", "reason": "铁事实只能由作者修改"}
        
        entity.attributes[key] = value
        entity.attribute_history.append({
            "key": key, "old_value": old_value, "new_value": value,
            "chapter_num": chapter_num, "source": source,
            "timestamp": datetime.now().isoformat(),
        })
        entity.updated_at = datetime.now()
        
        # 通知B2检查管线
        self.event_bus.emit(EventType.CHECK_RESULT, source="ENGINE", payload={
            "entity_id": entity_id,
            "attribute_key": key,
            "old_value": old_value,
            "new_value": value,
            "chapter_num": chapter_num,
        })
    
    # ── 叙事线状态（B5） ──
    
    def set_line_state(self, entity_id: str, line_id: str, state: dict):
        """设置实体在某条叙事线中的状态"""
        entity = self._get(entity_id)
        entity.line_states[line_id] = state
        entity.updated_at = datetime.now()
    
    def get_effective_state(self, entity_id: str, line_id: str = None) -> dict:
        """
        获取实体的有效状态
        
        优先级：line_state > global_state > attributes
        """
        entity = self._get(entity_id)
        
        if line_id and line_id in entity.line_states:
            return {**entity.global_state, **entity.attributes, **entity.line_states[line_id]}
        return {**entity.global_state, **entity.attributes}
    
    # ── 弧线进度（B1） ──
    
    def update_arc_position(self, entity_id: str, position: float, chapter_num: int):
        """更新角色弧线进度"""
        entity = self._get(entity_id)
        entity.arc_position = max(0.0, min(1.0, position))
        entity.updated_at = datetime.now()
    
    # ── 快照与回溯 ──
    
    def snapshot(self, entity_id: str, chapter_num: int) -> str:
        """创建实体状态快照（用于大纲分支/时间旅行）"""
        entity = self._get(entity_id)
        snapshot_id = f"snap_{entity_id}_ch{chapter_num}"
        # 存储快照到数据库
        db.execute("""
            INSERT INTO entity_snapshots (id, entity_id, chapter_num, data, created_at)
            VALUES (%s, %s, %s, %s, NOW())
        """, (snapshot_id, entity_id, chapter_num, json.dumps({
            "attributes": entity.attributes,
            "global_state": entity.global_state,
            "line_states": entity.line_states,
            "lifecycle": entity.lifecycle.value,
            "importance": entity.importance,
            "arc_position": entity.arc_position,
        })))
        return snapshot_id
    
    def restore(self, entity_id: str, snapshot_id: str):
        """从快照恢复实体状态"""
        snapshot = db.query(
            "SELECT data FROM entity_snapshots WHERE id = %s", snapshot_id
        )[0]["data"]
        entity = self._get(entity_id)
        
        entity.attributes = snapshot["attributes"]
        entity.global_state = snapshot["global_state"]
        entity.line_states = snapshot["line_states"]
        entity.lifecycle = EntityLifecycleState(snapshot["lifecycle"])
        entity.importance = snapshot["importance"]
        entity.arc_position = snapshot["arc_position"]
        entity.updated_at = datetime.now()
```

**统一实体 SQL Schema**（替代原有 4 套表）：

```sql
# --- 摘要：unified_entities + entity_attribute_history + entity_line_states + entity_snapshots SQL Schema ---
-- 统一实体表（替代 character_attributes + story_elements + iron_facts + character_global_states）
CREATE TABLE unified_entities (
    -- === 主键与标识 ===
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    work_id UUID NOT NULL REFERENCES works(id),
    name VARCHAR(200) NOT NULL,
    domain VARCHAR(20) NOT NULL,               -- character/item/location/org/concept
    lifecycle VARCHAR(10) NOT NULL DEFAULT 'dormant',  -- dormant/active/frozen/dead
    -- === 核心业务字段 ===
    importance FLOAT DEFAULT 0.5,
    last_mentioned_chapter INT DEFAULT 0,
    heartbeat_active BOOLEAN DEFAULT FALSE,
    attributes JSONB NOT NULL DEFAULT '{}',     -- 所有属性
    iron_facts TEXT[] NOT NULL DEFAULT '{}',    -- 不可变事实列表
    global_state JSONB NOT NULL DEFAULT '{}',   -- B5全局状态
    arc_id UUID,                                -- B1弧线关联
    arc_position FLOAT DEFAULT 0.0,             -- B1弧线进度
    foreshadow_ids JSONB DEFAULT '[]',          -- B7关联的伏笔ID列表，格式如 ["fs_001", "fs_002"]
    tags TEXT[] DEFAULT '{}',
    -- === 审计字段 ===
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
-- ER关系：本表通过 work_id 关联到 works(id)；通过 id 被 entity_line_states(entity_id)、entity_attribute_history(entity_id)、entity_snapshots(entity_id) 关联

-- 实体属性变更日志（替代 attribute_change_log）
CREATE TABLE entity_attribute_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_id UUID NOT NULL REFERENCES unified_entities(id),
    attribute_key VARCHAR(100) NOT NULL,
    old_value JSONB,
    new_value JSONB,
    chapter_num INT NOT NULL,
    source VARCHAR(20) NOT NULL,               -- author/ai_inferred/plot
    created_at TIMESTAMP DEFAULT NOW()
);
-- ER关系：本表通过 entity_id 关联到 unified_entities(id)

-- 数据保留：保留最近200章的属性变更记录，更早的记录归档到entity_attribute_history_archive表

-- 实体叙事线状态（替代 character_line_states）
CREATE TABLE entity_line_states (
    entity_id UUID NOT NULL REFERENCES unified_entities(id),
    line_id UUID NOT NULL,                     -- 叙事线ID
    state JSONB NOT NULL DEFAULT '{}',
    updated_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (entity_id, line_id)
);
-- ER关系：本表通过 entity_id 关联到 unified_entities(id)；通过 narrative_line_id 关联到 narrative_lines(id)

-- 实体状态快照（用于大纲分支/时间旅行）
CREATE TABLE entity_snapshots (
    id VARCHAR(100) PRIMARY KEY,               -- snap_{entity_id}_ch{num}
    entity_id UUID NOT NULL REFERENCES unified_entities(id),
    chapter_num INT NOT NULL,
    data JSONB NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);
-- ER关系：本表通过 entity_id 关联到 unified_entities(id)

-- 数据保留：每个实体最多保留50个快照（用于大纲分支/时间旅行），超出时按created_at降序清理最旧快照

-- 索引
CREATE INDEX idx_entities_work_domain ON unified_entities(work_id, domain);
CREATE INDEX idx_entities_lifecycle ON unified_entities(lifecycle);
CREATE INDEX idx_entities_importance ON unified_entities(importance);
CREATE INDEX idx_attr_history_entity ON entity_attribute_history(entity_id);
```

**各模块迁移映射**：

| 原有表/结构 | 迁移到 | 说明 |
|------|--------|------|
| B1 `character_arcs` | `unified_entities.arc_id` + `arc_position` | 弧线定义保留独立表，实体只存关联 |
| B2 `character_attributes` | `unified_entities.attributes` | JSON 字段统一存储 |
| B2 `iron_facts` | `unified_entities.iron_facts` | TEXT 数组 |
| B2 `attribute_change_log` | `entity_attribute_history` | 增加 source 字段 |
| B3 `story_elements` | `unified_entities` | domain 区分类型 |
| B3 `element_mentions` | `entity_attribute_history`（按 chapter_num 查询） | 合并 |
| B5 `character_global_states` | `unified_entities.global_state` | JSON 字段 |
| B5 `character_line_states` | `entity_line_states` | 保留独立表但简化 |

---

### G.2 ② 统一检测管线（UnifiedDetectionPipeline）
**合并来源**：
- B1 #9.4.4 铺垫检查算法
- B2 #10.2 17 条检查机制 + #10.3 四层渐进检查
- B3 #11.7.2 心跳检测算法
- B4 M3 算法统计 + M5 AI 味检测
- B5 M12 跨线审核 Agent

**核心思想**：所有检测共享**同一套管线架构**（触发→预处理→检测→评分→路由），各模块只注册自己的"检测器插件"。

```python
# --- 摘要：UnifiedDetectionPipeline —— 统一检测管线架构，BaseDetector抽象类+DetectionResult+DetectionTrigger ---
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import List, Optional
from enum import Enum

class DetectionTrigger(Enum):
    """检测触发时机"""
    REALTIME = "realtime"       # 实时（每段）
    PARAGRAPH = "paragraph"     # 段落间
    CHAPTER = "chapter"         # 章节完成时
    BATCH = "batch"             # 批量（作者手动触发）
    ON_EVENT = "on_event"       # 事件触发（大纲变更等）

class DetectionSeverity(Enum):
    """检测严重度"""
    CRITICAL = "critical"       # 必须立即处理
    HIGH = "high"               # 应该处理
    MEDIUM = "medium"           # 建议处理
    LOW = "low"                 # 仅供参考
    INFO = "info"               # 信息提示

# 与附录C AuditPriority(P0-P3)的映射关系：
# P0(critical) → DetectionSeverity.CRITICAL
# P1(high) → DetectionSeverity.HIGH
# P2(medium) → DetectionSeverity.MEDIUM
# P3(low) → DetectionSeverity.LOW
# 两套枚举分别用于不同场景：DetectionSeverity用于运行时检测结果，
# AuditPriority用于附录C B4风格守护Agent的审核优先级排序。


@dataclass
class DetectionResult:
    """统一检测结果（所有模块共用）"""
    detector_id: str                    # 检测器ID（如 "b2.age_check"）
    module: str                         # 来源模块 B1/B2/B3/B4/B5/B6/B7/B8
    severity: DetectionSeverity
    title: str                          # 简短标题
    description: str                    # 详细描述
    location: dict                      # 位置信息 {chapter, paragraph, start_offset, end_offset}
    entity_ids: List[str] = field(default_factory=list)  # 关联实体ID
    suggestion: str = ""                # 修复建议
    confidence: float = 1.0             # 置信度 0-1
    metadata: dict = field(default_factory=dict)  # 模块特有数据
    auto_fixable: bool = False          # 是否可自动修复


class BaseDetector(ABC):
    """检测器基类：所有B模块的检测器都继承此类"""
    
    # 子类必须覆盖以下类属性（不使用@property，便于直接在类定义中赋值）
    detector_id: str
    module: str
    trigger: 'DetectionTrigger'
    severity: 'DetectionSeverity'
    
    @abstractmethod
    def detect(self, context: dict) -> List[DetectionResult]:
        """
        执行检测（同步方法）
        
        Args:
            context: {
                "work_id": str,
                "chapter_num": int,
                "text": str,                    # 当前章节/段落文本
                "prev_text": str,               # 前文
                "entities": List[UnifiedEntity], # 相关实体
                "outline": dict,                # 当前章节大纲
                "narrative_lines": list,        # 当前活跃叙事线
                "style_profile": dict,          # 当前风格配置
            }
        """
        ...

    async def async_detect(self, context: dict) -> List[DetectionResult]:
        """
        执行异步检测（默认实现调用同步detect()，子类可覆盖以支持真正的异步操作）

        注意：B7的ForeshadowRecoveryDetector需要使用async_detect()，
        因为其伏笔回收检测包含LLM异步调用（需要等待大模型响应）。
        其他不涉及LLM调用的检测器无需覆盖此方法。

        Args:
            context: 同detect()的上下文参数
        Returns:
            检测结果列表
        """
        # 默认实现：直接委托给同步detect()方法
        return self.detect(context)


class UnifiedDetectionPipeline:
    """
    统一检测管线
    
    架构：
    ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
    │  触发器   │→│  预处理   │→│  检测器   │→│  评分器   │→│  路由器   │
    │(Trigger) │  │(Preproc) │  │(Detectors)│  │(Scorer)  │  │(Router)  │
    └──────────┘   └──────────┘   └──────────┘   └──────────┘   └──────────┘
    
    替代原有的：
    - #17.1 统一检测管线（6步）
    - 各模块独立的检测入口
    """
    
    def __init__(self, event_bus, silence_policy):
        self.detectors: Dict[str, BaseDetector] = {}
        self.event_bus = event_bus
        self.silence_policy = silence_policy  # #17.5.3 静默期策略
    
    def register(self, detector: BaseDetector):
        """注册检测器"""
        self.detectors[detector.detector_id] = detector
    
    def run(self, trigger: DetectionTrigger, context: dict) -> List[DetectionResult]:
        """
        执行检测管线

        异步检测器支持：对于包含LLM调用的检测器（如B7的ForeshadowRecoveryDetector），
        管线会优先调用async_detect()异步方法，通过asyncio.gather()并发执行异步检测器，
        再与同步检测器的结果合并。生产环境中建议使用async_run()替代本方法以获得完整异步支持。

        Args:
            trigger: 触发时机
            context: 检测上下文

        Returns:
            经过静默期过滤后的检测结果
        """
        # Step 1: 筛选匹配触发时机的检测器
        matched = [
            d for d in self.detectors.values()
            if d.trigger == trigger or d.trigger == DetectionTrigger.REALTIME
        ]
        
        # Step 2: 顺序执行检测（生产环境可改为并行）
        all_results = []
        for detector in matched:
            try:
                results = detector.detect(context)
                all_results.extend(results)
            except Exception as e:
                # 单个检测器失败不影响其他
                all_results.append(DetectionResult(
                    detector_id=detector.detector_id,
                    module=detector.module,
                    severity=DetectionSeverity.INFO,
                    title=f"检测器异常: {detector.detector_id}",
                    description=str(e),
                    location={},
                ))
        
        # Step 3: 评分（置信度 × 严重度权重）
        severity_weights = {
            DetectionSeverity.CRITICAL: 1.0,
            DetectionSeverity.HIGH: 0.8,
            DetectionSeverity.MEDIUM: 0.5,
            DetectionSeverity.LOW: 0.3,
            DetectionSeverity.INFO: 0.1,
        }
        for r in all_results:
            r.metadata["score"] = r.confidence * severity_weights.get(r.severity, 0.5)
        
        # Step 4: 去重（同一位置的相似问题合并）
        deduped = self._deduplicate(all_results)
        
        # Step 5: 静默期过滤（#17.5.3）
        filtered = self._apply_silence_policy(deduped, context)
        
        # Step 6: 路由（按模块分发）
        self._route_results(filtered)
        
        return filtered
    
    def _deduplicate(self, results: List[DetectionResult]) -> List[DetectionResult]:
        """去重：同一位置、同一实体的相似问题只保留最高分"""
        seen = {}
        for r in results:
            key = (r.location.get("chapter"), r.location.get("paragraph"), 
                   tuple(sorted(r.entity_ids)), r.detector_id.split(".")[0])
            if key not in seen or r.metadata["score"] > seen[key].metadata["score"]:
                seen[key] = r
        return list(seen.values())
    
    def _apply_silence_policy(self, results: List[DetectionResult], 
                               context: dict) -> List[DetectionResult]:
        """应用静默期策略"""
        scene_type = context.get("scene_type", "default")
        writing_speed = context.get("writing_speed", 0)
        
        filtered = []
        for r in results:
            decision = self.silence_policy.should_show_check(
                {"severity": r.severity.value, "module": r.module},
                scene_type, writing_speed
            )
            if decision.get("should_show", True):
                filtered.append(r)
            elif decision.get("batch"):
                r.metadata["delayed"] = True
                filtered.append(r)  # 批量模式仍保留，延迟显示
        
        return filtered
    
    def _route_results(self, results: List[DetectionResult]):
        """路由结果到各模块的事件"""
        for r in results:
            self.event_bus.emit(EventType.CHECK_RESULT, source=r.module, payload={
                "result_id": str(id(r)),
                "detector_id": r.detector_id,
                "severity": r.severity.value,
                "title": r.title,
            })


# ── 各模块检测器注册示例 ──

> **注**：以下检测器子类中的 `from bX_xxx import ...` 为示意性导入路径，实际实现时需根据项目模块结构调整。核心逻辑调用对应B模块的检测函数。

class ForeshadowCheckDetector(BaseDetector):
    """B1 铺垫检查检测器"""
    detector_id = "b1.foreshadow_check"
    module = "B1"
    trigger = DetectionTrigger.CHAPTER
    severity = DetectionSeverity.MEDIUM
    
    def detect(self, context) -> List[DetectionResult]:
        # 复用 #9.4.4 的铺垫检查算法
        from b1_outline import check_foreshadow_coverage
        return check_foreshadow_coverage(context)


class AgeConsistencyDetector(BaseDetector):
    """B2 年龄一致性检测器"""
    detector_id = "b2.age_consistency"
    module = "B2"
    trigger = DetectionTrigger.REALTIME
    severity = DetectionSeverity.HIGH
    
    def detect(self, context) -> List[DetectionResult]:
        # 复用 B2 增量扫描
        results = []
        for entity in context.get("entities", []):
            if entity.domain == EntityDomain.CHARACTER:
                age = entity.attributes.get("age")
                if age and context.get("chapter_num", 0) > 0:
                    # 检查年龄是否与时间线一致
                    pass  # ... 具体检查逻辑
        return results


class WorldRuleDetector(BaseDetector):
    """B2 世界观规则一致性检测器（批量检查）"""
    detector_id = "b2.world_rule"
    module = "B2"
    trigger = DetectionTrigger.CHAPTER
    severity = DetectionSeverity.HIGH
    
    def detect(self, context) -> List[DetectionResult]:
        # 复用 B2 #10.2 第3条：世界观规则一致性检查
        from b2_consistency import check_world_rules
        return check_world_rules(context)


class AppellationDetector(BaseDetector):
    """B2 称呼一致性检测器（实时检查）"""
    detector_id = "b2.appellation"
    module = "B2"
    trigger = DetectionTrigger.REALTIME
    severity = DetectionSeverity.MEDIUM
    
    def detect(self, context) -> List[DetectionResult]:
        # 复用 B2 #10.2 第5条：称呼一致性检查
        from b2_consistency import check_appellation
        return check_appellation(context)


class ElementHeartbeatDetector(BaseDetector):
    """B3 元素心跳检测器"""
    detector_id = "b3.element_heartbeat"
    module = "B3"
    trigger = DetectionTrigger.CHAPTER
    severity = DetectionSeverity.MEDIUM
    
    def detect(self, context) -> List[DetectionResult]:
        # 复用 #11.7.2 心跳检测算法
        from b3_causal import heartbeat_check
        return heartbeat_check(context)


class AITasteDetector(BaseDetector):
    """B4 AI味检测器"""
    detector_id = "b4.ai_taste"
    module = "B4"
    trigger = DetectionTrigger.PARAGRAPH
    severity = DetectionSeverity.HIGH
    
    def detect(self, context) -> List[DetectionResult]:
        # 复用 B4 M5 AI味检测
        from b4_style import detect_ai_taste
        return detect_ai_taste(context["text"])


class SceneStyleDetector(BaseDetector):
    """B4 场景风格一致性检测器"""
    detector_id = "b4.scene_style"
    module = "B4"
    trigger = DetectionTrigger.CHAPTER
    severity = DetectionSeverity.MEDIUM
    
    def detect(self, context) -> List[DetectionResult]:
        # 复用 B4 M3 场景风格指纹匹配
        from b4_style import check_scene_style_consistency
        return check_scene_style_consistency(context)


class CharacterDialogueDetector(BaseDetector):
    """B4 角色对话风格检测器"""
    detector_id = "b4.character_dialogue"
    module = "B4"
    trigger = DetectionTrigger.PARAGRAPH
    severity = DetectionSeverity.MEDIUM
    
    def detect(self, context) -> List[DetectionResult]:
        # 复用 B4 M6 角色对话风格一致性检查
        from b4_style import check_character_dialogue_style
        return check_character_dialogue_style(context)


class CrossLineAuditDetector(BaseDetector):
    """B5 跨线一致性审核检测器"""
    detector_id = "b5.cross_line_audit"
    module = "B5"
    trigger = DetectionTrigger.CHAPTER
    severity = DetectionSeverity.HIGH
    
    def detect(self, context) -> List[DetectionResult]:
        # 复用 B5 M12 跨线审核
        from b5_narrative import cross_line_audit
        return cross_line_audit(context)


class ArcConsistencyDetector(BaseDetector):
    """B6 角色弧线一致性检测器（可选注册）"""
    detector_id = "b6.arc_consistency"
    module = "B6"
    trigger = DetectionTrigger.CHAPTER
    severity = DetectionSeverity.LOW  # 弧线偏差是提示性而非强制性
    
    def detect(self, context) -> List[DetectionResult]:
        # 复用 #14.4 CharacterAgentV2._check_arc_consistency()
        from b6_bridge import check_arc_consistency_batch
        return check_arc_consistency_batch(context)


class ForeshadowRecoveryDetector(BaseDetector):
    """B7 伏笔回收检测器（检测未回收的伏笔线索）"""
    detector_id = "b7.foreshadow_recovery"
    module = "B7"
    trigger = DetectionTrigger.CHAPTER
    severity = DetectionSeverity.MEDIUM
    
    def detect(self, context) -> List[DetectionResult]:
        # 复用 B7 伏笔生命周期管理中的回收检测逻辑
        from b7_foreshadow import check_unrecovered_foreshadows
        return check_unrecovered_foreshadows(context)


class RhythmAnomalyDetector(BaseDetector):
    """B8 节奏异常检测器（含D1-D4子检测器）

    <!-- R8-C5 补充说明：D1-D4检测器阈值存储方式 -->
    注意：D1-D4检测器阈值存储在 UnifiedTemplate 的 content 字段中，
    通过模板系统间接可配置。修改阈值有两种方式：
    1. 创建自定义模板覆盖默认值（推荐，见 15.8.3 UnifiedTemplateVersionSystem）
    2. 通过 PluginConfigLayer 的 rhythm.detector_thresholds 配置项批量覆盖
    """
    detector_id = "b8.rhythm_anomaly"
    module = "B8"
    trigger = DetectionTrigger.CHAPTER
    severity = DetectionSeverity.MEDIUM
    
    def __init__(self):
        super().__init__()
        # 初始化D1-D4子检测器
        self._sub_detectors = {
            "D1": self._check_pacing,          # D1 节奏速度异常
            "D2": self._check_tension_curve,   # D2 张力曲线断裂
            "D3": self._check_scene_balance,   # D3 场景长度失衡
            "D4": self._check_dialogue_ratio,  # D4 对话/叙述比例异常
        }
    
    def detect(self, context) -> List[DetectionResult]:
        """依次运行D1-D4子检测器，汇总结果"""
        all_results = []
        for sub_id, sub_fn in self._sub_detectors.items():
            try:
                results = sub_fn(context)
                # 为子检测结果添加子检测器标识
                for r in results:
                    r.metadata["sub_detector"] = sub_id
                all_results.extend(results)
            except Exception as e:
                all_results.append(DetectionResult(
                    detector_id=f"{self.detector_id}.{sub_id}",
                    module=self.module,
                    severity=DetectionSeverity.INFO,
                    title=f"B8子检测器异常: {sub_id}",
                    description=str(e),
                    location={},
                ))
        return all_results
    
    def _check_pacing(self, context) -> List[DetectionResult]:
        """D1 节奏速度异常检测"""
        from b8_rhythm import check_pacing_anomaly
        return check_pacing_anomaly(context)
    
    def _check_tension_curve(self, context) -> List[DetectionResult]:
        """D2 张力曲线断裂检测"""
        from b8_rhythm import check_tension_break
        return check_tension_break(context)
    
    def _check_scene_balance(self, context) -> List[DetectionResult]:
        """D3 场景长度失衡检测"""
        from b8_rhythm import check_scene_length_imbalance
        return check_scene_length_imbalance(context)
    
    def _check_dialogue_ratio(self, context) -> List[DetectionResult]:
        """D4 对话/叙述比例异常检测"""
        from b8_rhythm import check_dialogue_narrative_ratio
        return check_dialogue_narrative_ratio(context)
```

**统一检测结果 SQL Schema**（替代原有 `check_results` 表）：

```sql
-- 统一检测结果表（替代 check_results）
CREATE TABLE unified_detection_results (
    -- === 主键与标识 ===
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    work_id UUID NOT NULL REFERENCES works(id),
    detector_id VARCHAR(50) NOT NULL,        -- 检测器ID（如 b2.age_consistency）
    module VARCHAR(5) NOT NULL,              -- 来源模块 B1/B2/B3/B4/B5/B6
    severity VARCHAR(10) NOT NULL,           -- critical/high/medium/low/info
    title VARCHAR(200) NOT NULL,
    description TEXT,
    -- === 检测结果 ===
    chapter_num INT,
    paragraph_num INT,
    start_offset INT,
    end_offset INT,
    entity_ids UUID[] DEFAULT '{}',          -- 关联实体
    suggestion TEXT,
    confidence FLOAT DEFAULT 1.0,
    score FLOAT,                             -- 综合评分
    -- === 状态与审计 ===
    status VARCHAR(20) DEFAULT 'open',       -- open/acknowledged/dismissed/fixed
    author_resolution TEXT,                  -- 作者处理意见
    auto_fixable BOOLEAN DEFAULT FALSE,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW(),
    resolved_at TIMESTAMP
);
-- ER关系：本表通过 entity_id 关联到 unified_entities(id)；通过 work_id 关联到 works(id)

-- 索引
CREATE INDEX idx_detection_work_status ON unified_detection_results(work_id, status);
CREATE INDEX idx_detection_module ON unified_detection_results(module);
CREATE INDEX idx_detection_severity ON unified_detection_results(severity);
CREATE INDEX idx_detection_chapter ON unified_detection_results(work_id, chapter_num);
-- 按检测器ID索引，支持按检测器维度聚合查询
CREATE INDEX idx_detection_detector ON unified_detection_results(detector_id);

-- 数据保留：status='fixed' 或 'dismissed' 且超过50章的记录归档到
-- unified_detection_results_archive 表，归档操作由每日清理任务执行（见 #19.5.2）。
```

---

### G.3 统一模板与版本系统（UnifiedTemplateVersionSystem）
**合并来源**：
- B1 #9.5.3 大纲模板系统
- B4 M1 风格宪法版本 + 风格模板市场
- B5 #13.5.2 叙事线大纲模板预设

**核心思想**：所有"可复用的创作配置"使用同一套模板系统管理，支持版本、继承、分享。

```python
# --- 摘要：UnifiedTemplate 完整dataclass定义 —— 统一模板系统，支持大纲/风格/叙事线/节奏四种模板类型 ---
@dataclass
class UnifiedTemplate:
    """
    统一模板
    
    支持四种模板类型：
    - outline：大纲模板（B1）
    - style：风格模板（B4）
    - narrative_line：叙事线模板（B5）
    - rhythm：节奏模板（B8）
    """
    template_id: str
    work_id: Optional[str]          # NULL = 系统预设模板
    template_type: str              # outline/style/narrative_line/rhythm
    name: str
    description: str
    author_id: Optional[str]        # 创建者（NULL = 系统）
    
    # 模板内容（JSON结构，不同类型有不同schema）
    content: dict
    # content字段schema说明（按template_type区分）：
    #   - outline:        {"structure": [...], "chapter_templates": [...], ...}
    #   - style:          {"tone": {...}, "vocabulary": [...], "sentence_patterns": [...], ...}
    #   - narrative_line: {"line_type": str, "arc_config": {...}, "milestones": [...], ...}
    #   - rhythm:         节奏模板的content字段存储格式为JSON对象，包含以下子字段：
    #       {"pattern": ["action", "dialogue", "reflection", ...],  # pacing标签数组，定义节奏模式
    #        "genre": "玄幻/都市/...",                               # 适用题材类型
    #        "description": "快节奏战斗模板",                        # 模板描述
    #        "tension_curve": {...},                                 # 可选：张力曲线配置
    #        "scene_balance": {...}}                                 # 可选：场景长度均衡配置
    
    # 版本管理
    version: int = 1
    parent_id: Optional[str] = None  # 继承自哪个模板
    is_builtin: bool = False         # 是否系统内置
    
    # 统计
    usage_count: int = 0
    rating_sum: float = 0.0
    rating_count: int = 0
    
    # 标签与分类
    genre: str = ""                  # 适用题材
    tags: List[str] = field(default_factory=list)


class TemplateVersionManager:
    """
    统一版本管理器
    
    替代原有的：
    - B1 #9.4.6 大纲版本管理
    - B4 M1 风格宪法版本管理
    """
    
    def create_version(self, template_id: str, changes: dict, 
                       author_id: str, description: str = "") -> str:
        """
        创建新版本
        
        Args:
            template_id: 模板ID
            changes: 变更内容（会merge到现有content上）
            author_id: 修改者
            description: 版本描述
        
        Returns:
            新版本ID
        """
        current = self._get_template(template_id)
        new_version = current.version + 1
        new_id = f"{template_id}_v{new_version}"
        
        # 合并变更
        merged_content = {**current.content, **changes}
        
        db.execute("""
            INSERT INTO unified_templates 
            (id, work_id, type, name, description, content, version, parent_id, 
             author_id, is_builtin, genre, tags)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, false, %s, %s)
        """, (new_id, current.work_id, current.template_type, current.name,
              description or current.description, json.dumps(merged_content),
              new_version, template_id, author_id, current.genre,
              json.dumps(current.tags)))
        
        return new_id
    
    def diff_versions(self, version_a_id: str, version_b_id: str) -> dict:
        """对比两个版本的差异"""
        a = self._get_template(version_a_id)
        b = self._get_template(version_b_id)
        
        diff = {}
        all_keys = set(a.content.keys()) | set(b.content.keys())
        for key in all_keys:
            if a.content.get(key) != b.content.get(key):
                diff[key] = {
                    "old": a.content.get(key),
                    "new": b.content.get(key),
                }
        
        return {
            "version_a": version_a_id,
            "version_b": version_b_id,
            "version_a_num": a.version,
            "version_b_num": b.version,
            "differences": diff,
            "total_changes": len(diff),
        }
```

```sql
-- 统一模板表（替代 outline_versions + style_templates + 叙事线模板）
CREATE TABLE unified_templates (
    id VARCHAR(100) PRIMARY KEY,             -- 模板ID或版本ID
    work_id UUID REFERENCES works(id),       -- NULL = 系统预设
    type VARCHAR(20) NOT NULL,               -- outline/style/narrative_line/rhythm，对应Python字段 template_type
    name VARCHAR(200) NOT NULL,
    description TEXT,
    content JSONB NOT NULL,                  -- 模板内容
    version INT DEFAULT 1,
    parent_id VARCHAR(100) REFERENCES unified_templates(id),  -- 父版本
    author_id UUID,                          -- 创建者
    is_builtin BOOLEAN DEFAULT FALSE,
    genre VARCHAR(50) DEFAULT '',            -- 适用题材
    tags TEXT[] DEFAULT '{}',
    usage_count INT DEFAULT 0,
    rating_sum FLOAT DEFAULT 0.0,
    rating_count INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_templates_type ON unified_templates(type);
CREATE INDEX idx_templates_genre ON unified_templates(genre);
CREATE INDEX idx_templates_builtin ON unified_templates(is_builtin) WHERE is_builtin = true;
```

**B8 节奏模板注册示例**：

```python
# --- 摘要：B8节奏模板注册示例 —— 标准/修仙/都市三种预设节奏模板的UnifiedTemplate定义 ---
# B8 节奏模板注册示例
B8_RHYTHM_TEMPLATES = [
    UnifiedTemplate(
        template_id="b8.rhythm_standard",
        work_id=None,               # 系统预设模板
        template_type="rhythm",
        name="标准网文节奏模板",
        description="适用于一般网文的节奏模板，兼顾铺垫与高潮的平衡分布",
        author_id=None,
        content={
            # 节奏参数配置
            "pacing": {
                "avg_chapter_words": 3000,      # 平均章节字数
                "max_chapter_words": 5000,      # 单章字数上限
                "min_chapter_words": 1500,      # 单章字数下限
            },
            # 张力曲线配置
            "tension_curve": {
                "arc_pattern": "rise_fall_rise", # 张力弧线模式
                "climax_interval_chapters": 15,  # 高潮间隔章数
                "breathing_chapters": 3,         # 过渡章节数
            },
            # 场景配置
            "scene_balance": {
                "max_scene_ratio": 0.4,          # 单场景占比上限
                "dialogue_ratio_range": [0.3, 0.7],  # 对话比例范围
            },
            # D1-D4子检测器阈值
            "detector_thresholds": {
                "D1_pacing": 0.6,               # D1 节奏速度异常阈值
                "D2_tension": 0.5,              # D2 张力曲线断裂阈值
                "D3_scene_balance": 0.4,        # D3 场景长度失衡阈值
                "D4_dialogue_ratio": 0.5,       # D4 对话比例异常阈值
            },
        },
        is_builtin=True,
        genre="通用",
        tags=["标准", "平衡", "通用"],
    ),
    UnifiedTemplate(
        template_id="b8.rhythm_fast",
        work_id=None,
        template_type="rhythm",
        name="快节奏爽文模板",
        description="适用于快节奏爽文，高频高潮、短章节、高对话密度",
        author_id=None,
        content={
            "pacing": {
                "avg_chapter_words": 2000,
                "max_chapter_words": 3000,
                "min_chapter_words": 1000,
            },
            "tension_curve": {
                "arc_pattern": "sustained_high",  # 持续高张力模式
                "climax_interval_chapters": 8,
                "breathing_chapters": 1,
            },
            "scene_balance": {
                "max_scene_ratio": 0.3,
                "dialogue_ratio_range": [0.4, 0.8],
            },
            "detector_thresholds": {
                "D1_pacing": 0.7,
                "D2_tension": 0.6,
                "D3_scene_balance": 0.3,
                "D4_dialogue_ratio": 0.6,
            },
        },
        is_builtin=True,
        genre="都市/玄幻",
        tags=["快节奏", "爽文", "高频高潮"],
    ),
]
```

---

### G.4 统一可视化框架（UnifiedVisualizationFramework）
**合并来源**：
- B2 #10.6 方案面板
- B3 #11.7.5 因果链可视化
- B4 M15 可视化工具集
- B5 M11 叙事线仪表盘
- #17.5 作品健康度仪表盘

**核心思想**：所有可视化共享**同一套前端组件库**和**统一数据 API**，各模块只提供数据，渲染由框架统一处理。

```python
# --- 摘要：VisualizationType + VisualizationConfig —— 统一可视化框架，支持雷达图/时间线/热力图/关系图等7种类型 ---
class VisualizationType(Enum):
    """可视化类型"""
    RADAR = "radar"              # 雷达图（B4 M15风格、#17.5健康度）
    TIMELINE = "timeline"        # 时间线（B3因果链、B5叙事线）
    HEATMAP = "heatmap"          # 热力图（B4风格漂移、B5线活跃度）
    GRAPH = "graph"              # 关系图（B3因果链、B2实体关系）
    TREND = "trend"              # 趋势图（#17.5跨章节趋势）
    TABLE = "table"              # 表格（B2检查结果、B5仪表盘数据）
    TREE = "tree"                # 树形图（B1大纲结构、B5线拓扑）
    PANEL = "panel"              # 面板（B2方案面板）


@dataclass
class VisualizationConfig:
    """可视化配置"""
    viz_type: VisualizationType
    title: str
    data_endpoint: str           # 数据API路径
    module: str                  # 来源模块
    refresh_interval: int = 0    # 自动刷新间隔（秒），0=手动
    layout: dict = field(default_factory=dict)  # 布局配置
    interactions: List[str] = field(default_factory=list)  # 交互类型：hover/click/zoom/filter


# 各模块可视化注册
VISUALIZATION_REGISTRY = {
    # B2 方案面板
    "b2.issue_panel": VisualizationConfig(
        viz_type=VisualizationType.PANEL,
        title="一致性检查面板",
        data_endpoint="/api/works/{work_id}/detections?module=B2",
        module="B2",
        refresh_interval=30,
        interactions=["filter", "sort", "acknowledge"],
    ),
    # B3 因果链图
    "b3.causal_graph": VisualizationConfig(
        viz_type=VisualizationType.GRAPH,
        title="因果链关系图",
        data_endpoint="/api/works/{work_id}/causal-graph",
        module="B3",
        interactions=["zoom", "click", "highlight_path"],
    ),
    # B4 风格雷达图
    "b4.style_radar": VisualizationConfig(
        viz_type=VisualizationType.RADAR,
        title="风格特征雷达图",
        data_endpoint="/api/works/{work_id}/style-radar",
        module="B4",
        refresh_interval=60,
    ),
    # B4 风格漂移热力图
    "b4.style_heatmap": VisualizationConfig(
        viz_type=VisualizationType.HEATMAP,
        title="风格漂移热力图",
        data_endpoint="/api/works/{work_id}/style-heatmap",
        module="B4",
        interactions=["hover", "click_chapter"],
    ),
    # B5 叙事线时间线
    "b5.narrative_timeline": VisualizationConfig(
        viz_type=VisualizationType.TIMELINE,
        title="叙事线时间轴",
        data_endpoint="/api/works/{work_id}/narrative-timeline",
        module="B5",
        interactions=["zoom", "click_line", "drag"],
    ),
    # B5 叙事线仪表盘
    "b5.line_dashboard": VisualizationConfig(
        viz_type=VisualizationType.TABLE,
        title="叙事线状态总览",
        data_endpoint="/api/works/{work_id}/narrative-dashboard",
        module="B5",
        refresh_interval=30,
        interactions=["filter", "sort"],
    ),
    # #17.5 作品健康度
    "health.radar": VisualizationConfig(
        viz_type=VisualizationType.RADAR,
        title="作品健康度",
        data_endpoint="/api/works/{work_id}/health",
        module="SYSTEM",
        refresh_interval=120,
    ),
    # #17.5 跨章节趋势
    "health.trend": VisualizationConfig(
        viz_type=VisualizationType.TREND,
        title="健康度趋势",
        data_endpoint="/api/works/{work_id}/trends",
        module="SYSTEM",
        interactions=["hover", "click_chapter"],
    ),
    # B1 大纲结构树
    "b1.outline_tree": VisualizationConfig(
        viz_type=VisualizationType.TREE,
        title="大纲结构",
        data_endpoint="/api/works/{work_id}/outline-tree",
        module="B1",
        interactions=["expand", "collapse", "drag_reorder"],
    ),
    # B7 伏笔仪表盘
    "b7.foreshadow_dashboard": VisualizationConfig(
        viz_type=VisualizationType.PANEL,
        title="伏笔生命周期仪表盘",
        data_endpoint="/api/works/{work_id}/foreshadow-dashboard",
        module="B7",
        refresh_interval=30,
        interactions=["filter", "sort", "click_foreshadow"],
    ),
    # B8 节奏曲线面板
    "b8.rhythm_curve": VisualizationConfig(
        viz_type=VisualizationType.TREND,
        title="节奏曲线面板",
        data_endpoint="/api/works/{work_id}/rhythm-curve",
        module="B8",
        interactions=["hover", "click_chapter", "zoom"],
    ),
}

# 统一可视化API
@app.get("/api/visualizations")
async def get_visualizations(work_id: str, module: Optional[str] = None):
    """获取可用可视化列表"""
    viz_list = []
    for viz_id, config in VISUALIZATION_REGISTRY.items():
        if module is None or config.module == module:
            viz_list.append({
                "id": viz_id,
                "type": config.viz_type.value,
                "title": config.title,
                "data_url": config.data_endpoint.format(work_id=work_id),
                "module": config.module,
                "refresh_interval": config.refresh_interval,
                "interactions": config.interactions,
            })
    return {"visualizations": viz_list}
```

---

### G.5 四大统一底层协作关系
```text
┌───────────────────────────────────────────────────────────────────────────┐
│                     B1-B8 各模块                                          │
│  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐       │
│  │ B1  │ │ B2  │ │ B3  │ │ B4  │ │ B5  │ │ B6  │ │ B7  │ │ B8  │       │
│  │大纲  │ │一致性│ │因果链│ │风格  │ │叙事线│ │角色弧│ │伏笔  │ │节奏  │       │
│  └──┬──┘ └──┬──┘ └──┬──┘ └──┬──┘ └──┬──┘ └──┬──┘ └──┬──┘ └──┬──┘       │
└─────┼───────┼───────┼───────┼───────┼───────┼───────┼───────┼───────────┘
      │       │       │       │       │       │       │       │
┌─────┴───────┴───────┴───────┴───────┴───────┴───────┴───────────────────┐
│                   四大统一底层                                 │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ ① 统一实体状态引擎                                     │   │
│  │    UnifiedEntity + UnifiedEntityEngine                 │   │
│  │    替代: B1角色弧线 + B2属性库 + B3元素三态 + B5双层状态      │   │
│  │    + B6弧线状态 + B7伏笔生命周期 + B8节奏状态                    │   │
│  └──────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ ② 统一检测管线                                         │   │
│  │    BaseDetector + UnifiedDetectionPipeline             │   │
│  │    替代: B1铺垫检查 + B2 17条 + B3心跳 + B4风格 + B5审核     │   │
│  │    + B6弧线一致性 + B7伏笔回收 + B8节奏异常(D1-D4)            │   │
│  └──────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ ③ 统一模板与版本系统                                   │   │
│  │    UnifiedTemplate + TemplateVersionManager           │   │
│  │    替代: B1大纲模板 + B4风格模板 + B5叙事线模板 + 版本        │   │
│  │    + B8节奏模板                                                │   │
│  └──────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ ④ 统一可视化框架                                       │   │
│  │    VisualizationConfig + VISUALIZATION_REGISTRY        │   │
│  │    替代: B2面板 + B3因果图 + B4雷达图 + B5仪表盘           │   │
│  │    + B7伏笔仪表盘 + B8节奏曲线面板                            │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ 已有基础设施（#17.4-15.6）                              │   │
│  │ 事件总线 │ 仪表盘层 │ 插件化配置层                       │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

**合并收益**：

| 维度 | 合并前 | 合并后 |
|------|--------|------|
| 数据表 | 12+张独立表 | 6 张统一表 |
| 检测入口 | 5 个独立管线 | 1 个统一管线 + 插件检测器 |
| 模板系统 | 3 套独立实现 | 1 套统一模板 + 类型区分 |
| 可视化 | 4 套独立组件 | 1 套组件库 + 配置注册 |
| 实体访问 | 各模块直接查 DB | 统一引擎 + 缓存 |
| 新模块接入 | 需要从零设计全套 | 注册检测器 + 定义实体属性即可 |


<a id="appendix-h"></a>

## 附录 H 正文代码块完整实现

> 📍 附录 H：从正文第 14 章（B6 角色状态桥梁层）和第 15 章（B7 伏笔协调层）提取的超长代码块完整实现，正文保留接口摘要

> **版本**：v1.0 | **日期**：2026-04-18 | **状态**：从第 14 章提取

### H.1 CharacterRuntimeState 完整实现（B6 角色状态桥梁层）

> 从 14.2 M1 角色运行时状态持久化提取。包含 CharacterRuntimeState dataclass、CharacterStateBridge class、ConcurrentStateError class 的完整实现。

```python
# --- 摘要：CharacterRuntimeState —— 角色运行时状态完整定义（含B6桥梁层扩展字段），约608行超长代码块 ---
from typing import Optional, Dict, Any, List
from datetime import datetime
from dataclasses import dataclass, field

@dataclass
class CharacterRuntimeState:
    """
    角色运行时状态 —— CharacterAgent.internal_state 的持久化表示
    
    存储位置：UnifiedEntity.global_state["character_runtime"]
    """
    # === 第7章 CharacterAgent 原有字段 ===
    current_emotion: str = "平静"
    emotional_triggers: Dict[str, str] = field(default_factory=dict)
    behavioral_boundaries: List[str] = field(default_factory=list)
    emotional_accumulation: Dict[str, float] = field(default_factory=dict)
    # 【M82补充说明：与B3遗忘机制的一致性】
    # emotional_accumulation 是运行时累积值，记录角色对各情感维度的累积强度。
    # 该值为运行时状态，不受第8章8.3节B3遗忘机制的直接影响。
    # 遗忘机制作用于记忆系统中的单条记忆记录（降低其可回忆度），
    # 而 emotional_accumulation 是从所有相关记忆中聚合出的标量值。
    # 【P2优化项】当对应记忆被遗忘（可回忆度降至阈值以下）后，
    # emotional_accumulation 中该记忆的贡献应在下次 sync_agent_to_memory() 时
    # 按遗忘比例衰减，确保累积值与记忆系统的实际状态保持一致。
    # 当前MVP阶段暂不实现此衰减逻辑，累积值只增不减（上限为1.0）。
    
    # === B6 新增字段 ===
    current_goals: List[str] = field(default_factory=list)
    # 角色当前目标（来自记忆系统第5层"目标/动机记忆"的快照）
    # 例：["找到师父", "变强保护苏瑶"]
    
    arc_phase: Optional[str] = None
    # 当前弧线阶段名称（来自B1大纲弧线定义）
    # 例："挣扎期"、"觉醒期"
    
    arc_phase_expected_state: Optional[Dict[str, Any]] = None
    # 当前弧线阶段对角色状态的预期（来自大纲）
    # 例：{"personality": "开始展现勇气", "emotion_tendency": "坚定中带着犹豫"}
    
    emotional_history_sync_chapter: int = 0
    # 上次与记忆系统同步的章节号（用于增量同步）

    version: int = 1
    # 乐观锁版本号，每次保存时递增，用于并发写入冲突检测

    # ── emotional_history 数据增长控制策略 ──
    # emotional_history 存储在 global_state JSONB 中（见第8章记忆系统），
    # 单角色上限 10000 条记录，防止 JSONB 字段过度膨胀影响读写性能。
    # 归档策略：当记录数超过 5000 条时，自动将最早 50% 的低重要性记忆
    # （importance < 0.3 且 recency > 100 章）归档到 character_memory_archive 表，
    # 释放主存储空间。归档操作在 PostSavePipeline 异步阶段（步骤3）中执行。
    # P2优化：将 emotional_history 拆分为独立表，支持数据库级别的行级清理
    # 和索引查询，彻底解决 JSONB 大字段性能瓶颈。

    def to_dict(self) -> dict:
        return {
            "current_emotion": self.current_emotion,
            "emotional_triggers": self.emotional_triggers,
            "behavioral_boundaries": self.behavioral_boundaries,
            "emotional_accumulation": self.emotional_accumulation,
            "current_goals": self.current_goals,
            "arc_phase": self.arc_phase,
            "arc_phase_expected_state": self.arc_phase_expected_state,
            "emotional_history_sync_chapter": self.emotional_history_sync_chapter,
            "version": self.version,
        }
    
    @classmethod
    def from_dict(cls, data: dict) -> "CharacterRuntimeState":
        return cls(
            current_emotion=data.get("current_emotion", "平静"),
            emotional_triggers=data.get("emotional_triggers", {}),
            behavioral_boundaries=data.get("behavioral_boundaries", []),
            emotional_accumulation=data.get("emotional_accumulation", {}),
            current_goals=data.get("current_goals", []),
            arc_phase=data.get("arc_phase"),
            arc_phase_expected_state=data.get("arc_phase_expected_state"),
            emotional_history_sync_chapter=data.get("emotional_history_sync_chapter", 0),
            version=data.get("version", 1),
        )


class CharacterStateBridge:
    """
    角色状态桥梁 —— 打通 CharacterAgent ↔ UnifiedEntity ↔ 记忆系统
    
    三大职责：
    1. 持久化：CharacterAgent.internal_state → UnifiedEntity.global_state
    2. 初始化：B1大纲弧线定义 → CharacterAgent.initial_state
    3. 同步：CharacterAgent.emotional_history ↔ 第8章记忆系统
    """
    
    RUNTIME_STATE_KEY = "character_runtime"
    
    def __init__(self, entity_engine, memory_system):
        self.entity_engine = entity_engine  # UnifiedEntityEngine
        self.memory_system = memory_system  # 第8章记忆系统接口
    
    # ── 职责1：持久化 ──
    
    def save_runtime_state(self, entity_id: str, 
                           agent_state: CharacterRuntimeState):
        """
        将CharacterAgent运行时状态持久化到UnifiedEntity
        
        存储路径：unified_entities.global_state["character_runtime"]
        
        安全机制：
        - 乐观锁：基于version字段检测并发写入冲突
        - 事务保护：整个保存操作应在数据库事务中执行，
          确保状态写入与版本号更新的原子性
        - 错误处理：捕获冲突异常并抛出明确错误信息
        """
        try:
            entity = self.entity_engine._get(entity_id)
            
            # 乐观锁检查：比对当前存储的版本号与传入状态的版本号
            stored_runtime = entity.global_state.get(self.RUNTIME_STATE_KEY, {})
            stored_version = stored_runtime.get("version", 1)
            if stored_version != agent_state.version:
                # 乐观锁冲突日志：记录版本不一致详情，便于排查并发写入问题
                logger.warning(
                    f"乐观锁冲突，entity_id={entity_id}, "
                    f"current_version={stored_version}, expected_version={agent_state.version}"
                )
                raise ConcurrentStateError(
                    f"角色运行时状态版本冲突（entity_id={entity_id}）："
                    f"存储版本={stored_version}，传入版本={agent_state.version}。"
                    f"可能存在并发写入，请重新加载后重试。"
                )
            
            # 递增版本号，写入状态
            agent_state.version += 1
            entity.global_state[self.RUNTIME_STATE_KEY] = agent_state.to_dict()
            entity.updated_at = datetime.now()
            # 注意：entity_engine._save(entity) 应在同一事务中提交，
            # 确保版本号递增与状态更新的原子性
            
        except ConcurrentStateError:
            # 版本冲突：直接向上抛出，由调用方决定重试策略
            raise
        except Exception as e:
            # 其他异常：包装后抛出，避免状态部分写入导致数据不一致
            raise RuntimeError(
                f"保存角色运行时状态失败（entity_id={entity_id}）：{e}"
            ) from e


class ConcurrentStateError(Exception):
    """并发状态冲突异常 —— 乐观锁检测到版本不一致时抛出"""
    pass
    
    def load_runtime_state(self, entity_id: str) -> CharacterRuntimeState:
        """
        从UnifiedEntity加载运行时状态，注入CharacterAgent
        
        如果无持久化状态（新角色），返回默认空状态
        """
        entity = self.entity_engine._get(entity_id)
        raw = entity.global_state.get(self.RUNTIME_STATE_KEY, {})
        
        if not raw:
            return CharacterRuntimeState()
        
        return CharacterRuntimeState.from_dict(raw)
    
    def get_character_agent_context(self, entity_id: str) -> dict:
        """
        为CharacterAgent.__init__()提供完整上下文
        
        合并：
        - UnifiedEntity.attributes（客观属性：年龄、修为等）
        - UnifiedEntity.iron_facts（不可变事实）
        - global_state["character_runtime"]（运行时状态）
        - 记忆系统检索结果（M3提供）
        """
        entity = self.entity_engine._get(entity_id)
        runtime = self.load_runtime_state(entity_id)
        
        return {
            "profile": {
                "name": entity.name,
                "attributes": entity.attributes,
                "iron_facts": entity.iron_facts,
            },
            "internal_state": runtime.to_dict(),
            "arc_context": {
                "arc_id": entity.arc_id,
                "arc_position": entity.arc_position,
                "arc_phase": runtime.arc_phase,
                "arc_phase_expected_state": runtime.arc_phase_expected_state,
            },
        }
    
    # ── 职责2：大纲→角色初始化 ──
    
    def initialize_from_outline(self, entity_id: str, 
                                 arc_definition: dict):
        """
        从B1大纲的弧线定义初始化角色运行时状态
        
        Args:
            arc_definition: {
                "starting_state": {
                    "personality": "懦弱、逃避冲突",
                    "emotional_baseline": "焦虑",
                    "core_goals": ["活下去", "找到师父"],
                    "behavioral_boundaries": ["不会主动战斗"],
                },
                "ending_state": {
                    "personality": "勇敢、主动承担责任",
                    "emotional_baseline": "坚定",
                },
                "phases": [
                    {
                        "name": "被迫面对",
                        "start_chapter": 1,
                        "end_chapter": 50,
                        "expected_state": {
                            "personality": "被动中开始动摇",
                            "emotion_tendency": "恐惧中带着好奇",
                        },
                        "milestones": [
                            {"name": "第一次主动保护他人", "trigger_keywords": ["保护", "挡在"]},
                        ],
                    },
                    # ...更多阶段
                ],
            }
        """
        starting = arc_definition["starting_state"]
        first_phase = arc_definition["phases"][0] if arc_definition.get("phases") else None
        
        runtime = CharacterRuntimeState(
            current_emotion=starting.get("emotional_baseline", "平静"),
            behavioral_boundaries=starting.get("behavioral_boundaries", []),
            current_goals=starting.get("core_goals", []),
            arc_phase=first_phase["name"] if first_phase else None,
            arc_phase_expected_state=first_phase.get("expected_state") if first_phase else None,
        )
        
        # 初始化情感触发器（从起点状态推导）
        # 例：如果起点是"懦弱"，则"被要求战斗"→"恐惧"
        runtime.emotional_triggers = self._derive_triggers_from_state(starting)
        
        self.save_runtime_state(entity_id, runtime)
        
        # 更新弧线关联
        entity = self.entity_engine._get(entity_id)
        entity.arc_position = 0.0
        entity.updated_at = datetime.now()
    
    def _derive_triggers_from_state(self, state: dict) -> Dict[str, str]:
        """从角色起点状态推导初始情感触发器（LLM辅助）"""
        # 实际实现中由LLM根据personality和emotional_baseline推导
        # 这里返回空字典，由LLM在初始化时填充
        return {}

    # ── OUTLINE_UPDATED 事件处理 ──

    def on_outline_updated(self, entity_id: str, outline_diff: dict):
        """
        处理大纲变更事件（OUTLINE_UPDATED），检查弧线阶段定义是否变更，
        如果变更则重置角色的 arc_phase 和 arc_position。

        当用户修改大纲中的角色弧线阶段（如增删阶段、修改阶段名称或预期状态）时，
        角色当前的运行时弧线位置可能不再有效。此方法通过对比变更前后的阶段定义，
        判断是否需要重置，确保角色状态与最新大纲保持一致。

        Args:
            entity_id: 角色实体ID
            outline_diff: 大纲变更差异，格式示例：
                {
                    "arc_id": "arc_001",
                    "changed_fields": ["phases"],           # 变更的字段列表
                    "old_phases": [...],                    # 变更前的阶段定义
                    "new_phases": [...],                    # 变更后的阶段定义
                    "phase_names_changed": bool,            # 阶段名称是否变更
                    "phase_states_changed": bool,           # 阶段预期状态是否变更
                }
        """
        entity = self.entity_engine._get(entity_id)
        runtime = self.load_runtime_state(entity_id)

        # 仅处理与当前角色弧线相关的变更
        if outline_diff.get("arc_id") != entity.arc_id:
            return  # 非本角色弧线的变更，跳过

        # 判断是否需要重置：阶段名称或预期状态发生变更
        need_reset = (
            outline_diff.get("phase_names_changed", False)
            or outline_diff.get("phase_states_changed", False)
        )

        if not need_reset:
            return  # 弧线阶段定义未变更，无需重置

        # 重置弧线阶段和位置
        old_phase = runtime.arc_phase
        old_position = entity.arc_position

        # 将 arc_phase 重置为 None，下次写作时将根据当前章节重新匹配阶段
        runtime.arc_phase = None
        runtime.arc_phase_expected_state = None

        # 将 arc_position 重置为 0.0，弧线进度需根据新阶段定义重新计算
        entity.arc_position = 0.0
        entity.updated_at = datetime.now()

        # 持久化重置后的状态
        self.save_runtime_state(entity_id, runtime)

        # 记录重置日志，便于调试和审计
        logger.info(
            f"[B6] on_outline_updated: 角色 {entity_id} 弧线阶段已重置 "
            f"(arc_id={entity.arc_id}, "
            f"旧阶段={old_phase}, 旧位置={old_position:.2f}) "
            f"原因：大纲弧线阶段定义变更"
        )

    # ── 职责3：角色↔记忆双向同步 ──

    def save_chapter_callback(self, chapter_id: str, chapter_num: int,
                               content: str, character_reactions: list[dict]):
        """
        PostSavePipeline回调入口：章节保存后触发角色状态同步。

        【触发时机说明】
        本方法由PostSavePipeline（附录 F.4）在章节保存后异步调用，
        是sync_agent_to_memory()的回调入口封装。PostSavePipeline在完成
        以下步骤后调用本方法：
          步骤1：保存章节正文
          步骤2：B4风格特征提取
          步骤3：B6角色状态同步（即本方法）
          步骤4：B7伏笔回收检测
          步骤5：B8节奏画像计算
          步骤6：统一检测Pipeline

        调用链：PostSavePipeline → save_chapter_callback() → sync_agent_to_memory()

        Args:
            chapter_id: 章节ID
            chapter_num: 章节号
            content: 章节正文内容
            character_reactions: 本章中各角色的反应列表，每项包含：
                - entity_id: 角色实体ID
                - agent_reaction: CharacterAgent.react_to()的返回值
        """
        for reaction in character_reactions:
            try:
                self.sync_agent_to_memory(
                    entity_id=reaction["entity_id"],
                    agent_reaction=reaction["agent_reaction"],
                    chapter_num=chapter_num,
                )
            except Exception as e:
                # 单个角色同步失败不影响其他角色，记录错误后继续
                logger.error(
                    f"[B6] save_chapter_callback: 角色状态同步失败 "
                    f"(entity_id={reaction['entity_id']}, chapter={chapter_num}): {e}"
                )

    def sync_agent_to_memory(self, entity_id: str,
                              agent_reaction: dict, chapter_num: int):
        """
        CharacterAgent.react_to()的结果 → 写入记忆系统

        【触发时机】
        本方法不直接被外部调用，而是通过save_chapter_callback()间接调用。
        save_chapter_callback()由PostSavePipeline（附录 F.4）在章节保存后异步触发。
        请勿在写作过程中直接调用本方法，以避免与PostSavePipeline的异步流程冲突。

        将Agent的反应拆解为记忆系统的五层：
        - 事实信息 → 第1层（事实记忆）【P2实现，见下方注释】
        - 情感变化 → 第2层（情感记忆）
        - 关系变化 → 第3层（关系记忆）
        - 技能/经验获得 → 第4层（技能/经验记忆）【P2实现，见下方注释】
        - 目标变化 → 第5层（目标/动机记忆）

        【M81补充说明】
        当前MVP阶段仅实现第2层（情感记忆）和第3层（关系记忆）的写入，
        以及第5层（目标/动机记忆）的写入。第1层和第4层为P2实现优先级：
        - 第1层（事实记忆）：角色在章节中陈述的事实信息，需LLM提取后写入B3事实记忆。
          例：角色得知"苏瑶是青梅竹马"→ 提取为事实记忆写入第1层。
        - 第4层（技能/经验记忆）：角色在章节中展现的新技能或积累的经验，写入B3技能记忆。
          例：角色学会"玄天剑诀第三式"→ 提取为技能记忆写入第4层。
        """
        runtime = self.load_runtime_state(entity_id)

        # ── 第1层：事实记忆（P2实现） ──
        # TODO(P2): 角色在章节中陈述的事实信息提取后写入B3事实记忆
        # 需LLM从章节正文中识别角色"知道"了什么新事实，
        # 然后调用 self.memory_system.add_memory(layer=1, ...) 写入。
        # 当前MVP阶段跳过，角色事实信息由第8章记忆系统的其他途径补充。
        pass

        # 1. 情感记忆（第2层）
        if agent_reaction.get("emotion_change"):
            self.memory_system.add_memory(
                entity_id=entity_id,
                layer=2,  # 情感记忆
                chapter_num=chapter_num,
                content=f"{agent_reaction['event']}: {agent_reaction['emotion_change']}",
                emotion=agent_reaction.get("new_emotion", ""),
                intensity=agent_reaction.get("emotion_intensity", 0.5),
            )
        
        # 2. 关系记忆（第3层）
        if agent_reaction.get("relationship_change"):
            self.memory_system.add_memory(
                entity_id=entity_id,
                layer=3,  # 关系记忆
                chapter_num=chapter_num,
                content=agent_reaction["relationship_change"],
                related_character=agent_reaction.get("related_character"),
            )
        
        # ── 第4层：技能/经验记忆（P2实现） ──
        # TODO(P2): 角色在章节中展现的新技能/经验写入B3技能记忆
        # 需LLM从章节正文中识别角色"学会"了什么新技能或积累了什么经验，
        # 然后调用 self.memory_system.add_memory(layer=4, ...) 写入。
        # 当前MVP阶段跳过，技能信息由角色设定和剧情推进自然体现。
        pass

        # 3. 目标/动机记忆（第5层）
        if agent_reaction.get("goal_change"):
            self.memory_system.add_memory(
                entity_id=entity_id,
                layer=5,  # 目标/动机记忆
                chapter_num=chapter_num,
                content=agent_reaction["goal_change"],
            )
            # 同步更新运行时状态中的目标
            runtime.current_goals = agent_reaction["new_goals"]
        
        # 4. 更新运行时状态
        if agent_reaction.get("new_emotion"):
            runtime.current_emotion = agent_reaction["new_emotion"]
        if agent_reaction.get("accumulation_updates"):
            for key, delta in agent_reaction["accumulation_updates"].items():
                old = runtime.emotional_accumulation.get(key, 0.0)
                runtime.emotional_accumulation[key] = max(0.0, min(1.0, old + delta))
        
        runtime.emotional_history_sync_chapter = chapter_num
        self.save_runtime_state(entity_id, runtime)
    
    def sync_memory_to_agent(self, entity_id: str, 
                              scene_context: dict) -> dict:
        """
        记忆系统 → CharacterAgent上下文
        
        根据当前场景，从五层记忆中检索相关记忆，注入Agent
        
        Args:
            scene_context: {
                "chapter_num": int,
                "location": str,
                "present_characters": [str],  # 在场角色名
                "scene_type": str,  # 战斗/对话/情感/日常
                "event_description": str,
            }
        
        Returns:
            注入CharacterAgent的记忆上下文
        """
        # 从记忆系统检索（利用第8章的触发机制）
        relevant_memories = self.memory_system.retrieve_by_scene(
            entity_id=entity_id,
            scene_context=scene_context,
            max_memories=5,  # 控制token预算
        )
        
        # 从第5层提取当前活跃目标
        active_goals = self.memory_system.get_active_goals(
            entity_id=entity_id,
            chapter_num=scene_context["chapter_num"],
        )
        
        # 更新运行时状态中的目标快照
        runtime = self.load_runtime_state(entity_id)
        if active_goals:
            runtime.current_goals = active_goals
            self.save_runtime_state(entity_id, runtime)
        
        return {
            "relevant_memories": relevant_memories,
            "active_goals": active_goals,
            "current_emotion": runtime.current_emotion,
            "emotional_accumulation": runtime.emotional_accumulation,
        }
    
    # ── 职责4：伏笔回收事件响应（B7→B6桥梁） ──
    
    def on_foreshadowing_resolved(self, foreshadow_id: str, 
                                   chapter_num: int,
                                   event_description: str = ""):
        """
        监听 FORESHADOW_RESOLVED 事件，将伏笔回收关联到角色弧线里程碑
        
        当B7 ForeshadowCoordinator 确认伏笔回收时，通过事件总线触发此方法。
        本方法查找伏笔关联的角色，更新对应的 arc_milestones 记录。
        
        Args:
            foreshadow_id: 已回收的伏笔ID（对应 unified_entities 中的实体ID）
            chapter_num: 回收发生的章节号
            event_description: 回收事件描述（用于里程碑描述）
        
        数据流：
            伏笔实体(unified_entities, domain=foreshadowing)
            → 关联角色ID（通过 foreshadowing 关联的 character 实体）
            → character_arcs 表
            → arc_milestones 表（更新 triggered_by_foreshadow_id）
        
        注意：需要在事件总线中注册此监听器，示例：
            event_bus.subscribe(EventType.FORESHADOW_RESOLVED, 
                                state_bridge.on_foreshadowing_resolved)
        """
        # 1. 查找伏笔关联的角色
        foreshadow_entity = self.entity_engine._get(foreshadow_id)
        if not foreshadow_entity:
            return  # 伏笔实体不存在，忽略
        
        # 从伏笔实体的关联关系中提取角色ID
        # 关联路径：foreshadow_entity.related_entities → character类型
        character_ids = [
            rel["target_id"] for rel in foreshadow_entity.related_entities
            if rel.get("relation_type") == "foreshadows_character"
        ]
        
        if not character_ids:
            return  # 该伏笔未关联角色，无需处理
        
        # 2. 为每个关联角色更新弧线里程碑
        for char_id in character_ids:
            entity = self.entity_engine._get(char_id)
            if not entity or not hasattr(entity, 'arc_id') or not entity.arc_id:
                continue  # 角色无弧线，跳过
            
            # 查找当前章节对应的未触发里程碑
            milestone = db.query(
                """SELECT id, name FROM arc_milestones 
                   WHERE arc_id = %s AND triggered = false 
                   AND (trigger_chapter IS NULL OR trigger_chapter <= %s)
                   ORDER BY trigger_chapter DESC NULLS LAST LIMIT 1""",
                entity.arc_id, chapter_num
            )
            
            if milestone:
                # 更新里程碑：标记为已触发，并记录伏笔关联
                db.execute(
                    """UPDATE arc_milestones 
                       SET triggered = true, 
                           triggered_at = NOW(),
                           triggered_by_foreshadow_id = %s
                       WHERE id = %s""",
                    foreshadow_id, milestone[0]["id"]
                )
    
    # ── 弧线阶段推进 ──
    
    def advance_arc_phase(self, entity_id: str, 
                           milestone_name: str, chapter_num: int):
        """
        弧线里程碑触发 → 推进阶段 → 更新角色状态
        
        由B2检查管线或大纲系统调用
        """
        entity = self.entity_engine._get(entity_id)
        runtime = self.load_runtime_state(entity_id)
        
        # 更新弧线进度
        total_milestones = db.query(
            "SELECT COUNT(*) as c FROM arc_milestones WHERE arc_id = %s",
            entity.arc_id
        )[0]["c"]
        triggered = db.query(
            "SELECT COUNT(*) as c FROM arc_milestones WHERE arc_id = %s AND triggered = true",
            entity.arc_id
        )[0]["c"]
        entity.arc_position = min(1.0, triggered / max(total_milestones, 1))
        
        # 更新运行时状态中的弧线阶段
        next_phase = db.query(
            """SELECT name, expected_state FROM arc_phases 
               WHERE arc_id = %s AND start_chapter <= %s 
               ORDER BY phase_order DESC LIMIT 1""",
            entity.arc_id, chapter_num
        )
            runtime.arc_phase = next_phase[0]["name"]
            runtime.arc_phase_expected_state = next_phase[0]["expected_state"]
        
        # 如果阶段变化触发了行为边界更新
        if runtime.arc_phase_expected_state:
            new_boundaries = runtime.arc_phase_expected_state.get("behavioral_boundaries")
            if new_boundaries:
                runtime.behavioral_boundaries = new_boundaries
        
        self.save_runtime_state(entity_id, runtime)
        
        # 通知B4风格系统（角色成长触发风格变化）
        self.entity_engine.event_bus.emit(
            EventType.CHECK_RESULT, source="B6", payload={
                "entity_id": entity_id,
                "milestone": milestone_name,
                "chapter_num": chapter_num,
                "type": "arc_milestone_triggered",
            }
        )
```

### H.2 ForeshadowCoordinator 完整实现（B7 伏笔协调层）

> 从 15.5 伏笔仪表盘 API 提取。包含 ForeshadowCoordinator class 的完整实现，管理伏笔全生命周期。

```python
# --- 摘要：ForeshadowCoordinator —— B7伏笔协调层统一入口，管理伏笔全生命周期（仪表盘/注入/检测/回收/提醒） ---
class ForeshadowCoordinator:
    """B7 伏笔协调层 —— 统一入口"""

    def __init__(self, db, llm_client=None):
        """初始化伏笔协调器

        参数:
            db: 数据库连接实例
            llm_client: 可选的LLM客户端，用于AI伏笔识别和回收检测（按需调用）
        """
        self.db = db
        self.llm_client = llm_client

    def get_dashboard(self, work_id: str) -> dict:
        """
        返回伏笔仪表盘数据，供编辑器UI展示。
        """
        view = self.get_unified_view(work_id)
        density = self._compute_density(view)

        return {
            # 摘要统计
            "summary": {
                "total": len(view),
                "by_status": self._count_by_status(view),
                "by_type": self._count_by_type(view),
                "by_importance": self._count_by_importance(view),
            },

            # 预警列表（来自B3衰减模型）
            # 注意：不同伏笔类型使用不同的预警阈值（见 #15.6 TYPE_CONFIG），
            # worldview类型阈值为0.2，其余类型为0.3，此处按类型动态判断
            "alerts": [
                fp for fp in view
                if fp.status in ("ACTIVE", "DORMANT")
                and fp.reader_memory < TYPE_CONFIG.get(fp.foreshadow_type, {}).get(
                    "memory_warning_threshold", 0.3
                )
            ],

            # 场景共振推荐（来自B3 #11.4）
            "suggestions": self._get_resonance_suggestions(work_id),

            # AI识别的候选伏笔（来自 #15.3）
            "candidates": self._get_pending_candidates(work_id),

            # 回收检测提示（来自 #15.4）
            "recovery_hints": self._get_recovery_hints(work_id),

            # 密度监控（来自 #15.7）
            "density": density,

            # 健康评分（用于作品健康度 #17.5）
            "health_score": self._compute_health_score(view),
        }

    def get_unified_view(self, work_id: str, status: list[str] | None = None) -> list[UnifiedForeshadowing]:
        """返回统一伏笔视图，可按状态过滤"""
        # 整合 ForeshadowingTracker + B3元素三态 + B5跨线标签
        # 通过 UnifiedEntity.foreshadow_ids 关联
        # TODO(P3): 待实现
        ...

    def confirm_recovery(self, foreshadow_id: str, chapter_num: int, event_description: str) -> dict:
        """作者确认回收伏笔"""
        # 1. 更新状态为 RESOLVED
        # 2. 触发 FORESHADOW_RESOLVED 事件
        # 3. 调用 B3 evaluate_foreshadowing_payoff() 生成质量评分
        # 4. 检查 triggers 列表，触发下游伏笔
        # TODO(P3): 待实现
        ...

    def confirm_progression(self, foreshadow_id: str, chapter_num: int) -> None:
        """作者确认伏笔推进（部分提及/暗示）"""
        # 1. 刷新读者记忆（+0.1~0.3）
        # 2. 如果当前是 DORMANT，转回 ACTIVE
        # 3. 更新 last_mentioned_chapter
        # TODO(P3): 待实现
        ...

    def get_character_foreshadowings(self, character_entity_id: str) -> list[UnifiedForeshadowing]:
        """
        查询指定角色关联的所有人物伏笔
        
        用于B6角色弧线系统获取角色的伏笔全景，辅助弧线里程碑规划。
        
        数据关联路径：
            角色实体(unified_entities, domain=character, id=character_entity_id)
            ← related_entities 反向关联
            ← 伏笔实体(unified_entities, domain=foreshadowing, type=character)
            → character_arcs 表（通过角色 entity_id）
            → arc_milestones 表
        
        Args:
            character_entity_id: 角色在 unified_entities 中的实体ID
            
        Returns:
            该角色关联的所有人物伏笔列表（UnifiedForeshadowing对象）
            
        使用场景：
            - B6 CharacterStateBridge 初始化角色时获取伏笔上下文
            - 编辑器UI展示角色伏笔面板
            - 弧线规划时参考待回收伏笔
        """
        # 1. 从 unified_entities 中查找 type=character 且关联到该角色的伏笔
        #    通过 related_entities 表反向查询：
        #    SELECT * FROM unified_entities ue
        #    JOIN entity_relations er ON er.from_id = ue.id
        #    WHERE er.to_id = %s AND ue.domain = 'foreshadowing' AND ue.type = 'character'
        # TODO(P3): 待实现
        ...

    def inject_writing_context(self, work_id: str, chapter_num: int) -> dict:
        """
        生成注入WriterAgent写作上下文的伏笔摘要

        将 ForeshadowCoordinator.get_unified_view() 的输出精炼为写作上下文，
        供 #5.4 ContextRouter 的 foreshadowing_enhanced 通道注入。

        Args:
            work_id: 作品ID
            chapter_num: 当前章节号

        Returns:
            {
                "active_foreshadowings": [
                    {
                        "id": "uuid",
                        "description": "神秘戒指的来历",
                        "reader_memory": 0.6,
                        "importance": "critical",
                        "suggested_action": "progress",  # 本章建议操作：progress/resolve/wake
                    },
                    ...
                ],
                "density_summary": {
                    "current_density": 3,
                    "max_safe_density": 5,
                    "status": "healthy",  # healthy/warning/overload
                },
                "recovery_suggestions": [
                    {
                        "foreshadow_id": "uuid",
                        "description": "建议在本章回收的伏笔",
                        "reason": "读者记忆已衰减至0.25，需尽快唤醒",
                    },
                    ...
                ],
            }

        使用场景：
            - ContextRouter 在 write_chapter 任务中调用，注入写作上下文
            - WriterAgent 据此在本章中自然推进或回收伏笔
            - 与 B6 character_runtime 协同，确保伏笔推进与角色弧线阶段一致
        """
        view = self.get_unified_view(work_id, status=["ACTIVE", "DORMANT"])
        density = self._compute_density(view)

        # 筛选本章需要关注的伏笔（读者记忆衰减预警 + 预期回收章节临近）
        active = []
        for fp in view:
            suggested_action = "progress"  # 默认：推进
            if fp.reader_memory < 0.3:
                suggested_action = "wake"   # 唤醒（读者记忆过低）
            elif fp.expected_chapter and abs(chapter_num - fp.expected_chapter) <= 3:
                suggested_action = "resolve"  # 建议回收

            active.append({
                "id": fp.id,
                "description": fp.description,
                "reader_memory": fp.reader_memory,
                "importance": fp.importance,
                "suggested_action": suggested_action,
            })

        # 回收建议：优先级为读者记忆最低的 critical 伏笔
        recovery = sorted(
            [fp for fp in view if fp.importance == "critical" and fp.reader_memory < 0.4],
            key=lambda x: x.reader_memory
        )

        return {
            "active_foreshadowings": active,
            "density_summary": {
                "current_density": density.get("current", 0),
                "max_safe_density": density.get("max_safe", 5),
                "status": density.get("status", "healthy"),
            },
            "recovery_suggestions": [
                {
                    "foreshadow_id": fp.id,
                    "description": fp.description,
                    "reason": f"读者记忆已衰减至{fp.reader_memory:.2f}，需尽快唤醒",
                }
                for fp in recovery[:3]  # 最多返回3条建议，控制token消耗
            ],
        }

    def get_writing_context(self, work_id: str, chapter_num: int) -> dict:
        """
        写作伏笔上下文获取入口（inject_writing_context的别名）。

        H31修复说明：ContextRouter.write_chapter任务中通过本方法获取B7增强伏笔数据。
        本方法是inject_writing_context()的语义别名，保持与ContextRouter调用约定一致。
        返回数据包含：reader_memory、density、dependency_chain、suggested_action等。
        完整实现见inject_writing_context()。
        """
        return self.inject_writing_context(work_id, chapter_num)

    def on_outline_updated(self, work_id: str, outline_diff: dict) -> dict:
        """响应大纲变更事件（OUTLINE_UPDATED），检查章节增删/移动对伏笔的影响

        当作者修改大纲（增删章节、调整章节顺序、修改章节pacing等）时，
        需要同步更新受影响伏笔的 planted_chapter 和 expected_chapter 引用，
        避免伏笔指向已删除或移位的章节。

        Args:
            work_id: 作品ID
            outline_diff: 大纲变更差异，结构如下：
                {
                    "added_chapters": [{"chapter_num": 5, "title": "..."}],   # 新增的章节
                    "removed_chapters": [{"chapter_num": 10, "title": "..."}], # 删除的章节
                    "moved_chapters": [{"old_num": 8, "new_num": 12}],        # 移动的章节（旧号→新号）
                    "modified_chapters": [{"chapter_num": 3, "changes": {...}}] # 修改的章节
                }

        Returns:
            处理结果摘要：
                {
                    "affected_foreshadowings": 3,   # 受影响的伏笔数量
                    "updated_planted": 1,           # 更新planted_chapter的数量
                    "updated_expected": 2,          # 更新expected_chapter的数量
                    "warnings": ["..."]             # 需要人工确认的警告列表
                }
        """
        result = {
            "affected_foreshadowings": 0,
            "updated_planted": 0,
            "updated_expected": 0,
            "warnings": []
        }

        # 获取该作品所有活跃伏笔
        view = self.get_unified_view(work_id, status=["ACTIVE", "DORMANT", "PLANTED"])
        if not view:
            return result

        # 构建章节号映射表（用于处理章节移动导致的号段偏移）
        # moved_chapters 中的 old_num → new_num 映射
        chapter_num_map = {}
        for move in outline_diff.get("moved_chapters", []):
            chapter_num_map[move["old_num"]] = move["new_num"]

        # 收集被删除的章节号集合
        removed_nums = {ch["chapter_num"] for ch in outline_diff.get("removed_chapters", [])}

        # 收集新增的章节号集合（用于检测插入导致的后续章节号偏移）
        added_nums = {ch["chapter_num"] for ch in outline_diff.get("added_chapters", [])}

        for fp in view:
            affected = False

            # 1. 检查 planted_chapter 是否受影响
            if fp.planted_chapter is not None:
                # 如果伏笔的埋设章节被删除，发出警告
                if fp.planted_chapter in removed_nums:
                    result["warnings"].append(
                        f"伏笔「{fp.description}」的埋设章节（第{fp.planted_chapter}章）已被删除，"
                        f"请确认是否需要重新指定埋设位置或删除该伏笔。"
                    )
                    affected = True
                # 如果伏笔的埋设章节被移动，更新引用
                elif fp.planted_chapter in chapter_num_map:
                    new_planted = chapter_num_map[fp.planted_chapter]
                    # 更新埋设章节号
                    self._update_foreshadow_chapter(fp.id, "planted_chapter", new_planted)
                    result["updated_planted"] += 1
                    affected = True

            # 2. 检查 expected_chapter 是否受影响
            if fp.expected_chapter is not None:
                # 如果伏笔的预期回收章节被删除
                if fp.expected_chapter in removed_nums:
                    result["warnings"].append(
                        f"伏笔「{fp.description}」的预期回收章节（第{fp.expected_chapter}章）已被删除，"
                        f"建议重新设定预期回收位置。"
                    )
                    affected = True
                # 如果伏笔的预期回收章节被移动，更新引用
                elif fp.expected_chapter in chapter_num_map:
                    new_expected = chapter_num_map[fp.expected_chapter]
                    self._update_foreshadow_chapter(fp.id, "expected_chapter", new_expected)
                    result["updated_expected"] += 1
                    affected = True

            # 3. 检查章节插入导致的后续章节号偏移
            #    如果在伏笔埋设/回收章节之前插入了新章节，
            #    且该伏笔使用绝对章节号，则需要调整
            if added_nums:
                for added_num in sorted(added_nums):
                    if fp.planted_chapter is not None and added_num <= fp.planted_chapter:
                        # 插入点在埋设章节之前，埋设章节号应+1
                        new_planted = fp.planted_chapter + 1
                        self._update_foreshadow_chapter(fp.id, "planted_chapter", new_planted)
                        result["updated_planted"] += 1
                        affected = True
                    if fp.expected_chapter is not None and added_num <= fp.expected_chapter:
                        new_expected = fp.expected_chapter + 1
                        self._update_foreshadow_chapter(fp.id, "expected_chapter", new_expected)
                        result["updated_expected"] += 1
                        affected = True

            if affected:
                result["affected_foreshadowings"] += 1

        # 4. 如果有警告，通过事件总线通知编辑器UI
        if result["warnings"]:
            event_bus.emit(
                EventType.FORESHADOWING_OUTLINE_WARNING,
                source="B7",
                payload={
                    "work_id": work_id,
                    "warnings": result["warnings"],
                    "affected_count": result["affected_foreshadowings"],
                }
            )

        return result

    def _update_foreshadow_chapter(self, foreshadow_id: str, field: str, new_chapter_num: int) -> None:
        """更新伏笔的章节引用字段

        Args:
            foreshadow_id: 伏笔ID
            field: 字段名（"planted_chapter" 或 "expected_chapter"）
            new_chapter_num: 新的章节号
        """
        # 通过算法层 ForeshadowingTracker 更新
        # 同时更新 UnifiedEntity 中的缓存数据
        # TODO(P2): 待 ForeshadowingTracker 实现后对接
        ...
```
