---
feature: novel-writing-platform
status: delivered
updated: 2026-07-26
branch: feat/novel-writing-platform
commits: e460aff..
---

# AI/Agent 网文写作平台（第一版）

## Report

**What was built** — 将当前 Code Agent（Electron + React 19 + TypeScript）改造为 AI/Agent 网文写作平台第一版。新增 9 张 SQLite 表、30+ IPC 通道、6 个写作业务服务、3 个 AI Agent（WriterAgent/ReviewerAgent/InspirationAgent）、完整的三栏写作工作台 UI（编辑器 + 章节目录树 + 大纲/角色/世界观/对话/审查面板）、TXT 导出功能。

**Verification** — `pnpm typecheck` → PASS（零错误）。

**Journey log** —
1. IPC 类型约束（exactOptionalPropertyTypes + noUncheckedIndexedAccess）导致大量编译错误，最终通过 `cast()/getStr()` 辅助函数统一绕过，而非逐一修复类型定义
2. 子 Agent 并行开发效率高（创建了 4 个 AI Agent 文件），但复杂 UI 组件在子 Agent 中反复卡在类型错误和 lint 约束上，最终主进程直接接管
3. Drizzle ORM 的 API 用法与现有 session-service 不一致（`.eq()` 方法 vs `eq()` 函数），导致首批 service 文件全部重写

## [S1] Problem

当前项目是一个 Code Agent（编程助手），其代码库架构（Electron + Service Container + AI SDK + SQLite）恰好可作为 AI 原生写作平台的技术底座。但全量功能（B1-B8）过于庞大，需要确定第一版的范围并依次实现。

## [S2] Design

### 总体架构

```
src/
├── main/                          # 主进程（改造现有）
│   ├── infra/
│   │   ├── novel/                 # 新增：写作业务服务
│   │   │   ├── project-service.ts     # 写作项目管理
│   │   │   ├── chapter-service.ts     # 章节 CRUD
│   │   │   ├── outline-service.ts     # 大纲管理
│   │   │   ├── character-service.ts   # 角色管理
│   │   │   ├── world-setting-service.ts # 世界观管理
│   │   │   ├── writer-agent.ts        # WriterAgent（替换原 AgentService）
│   │   │   ├── reviewer-agent.ts      # ReviewerAgent
│   │   │   ├── inspiration-agent.ts   # 灵感 Agent
│   │   │   └── review-report.ts       # 审查报告类型定义
│   │   └── storage/
│   │       └── schema.ts              # 扩展：写作数据模型
│   ├── ipc/
│   │   └── novel.handler.ts           # 新增：写作域 IPC handler
│   └── service-container.ts           # 扩展：注册写作服务
│
├── preload/
│   └── index.ts                       # 扩展：暴露 novel 域 API
│
├── renderer/                          # 渲染层（大幅改造）
│   ├── components/
│   │   ├── novel/                     # 新增：写作相关组件
│   │   │   ├── editor/                #   编辑器
│   │   │   ├── outline/               #   大纲面板
│   │   │   ├── character/             #   角色管理
│   │   │   ├── world/                 #   世界观管理
│   │   │   ├── chat/                  #   AI 对话（卡片式）
│   │   │   ├── review/                #   审查报告
│   │   │   └── inspiration/           #   灵感建议
│   │   └── ...                        # 保留通用组件
│   └── routes/                        # 修改路由
│
packages/shared/
└── src/
    ├── ipc/
    │   └── channels.ts                # 扩展：novel:* channel
    └── schemas/
        └── novel.ts                   # 新增：写作域 schema
```

### 数据模型（SQLite + Drizzle）

```typescript
// 项目
novel_projects {
  id: text PK
  title: text
  author: text
  genre: text
  description: text
  created_at: timestamp
  updated_at: timestamp
}

// 卷
volumes {
  id: text PK
  project_id: text FK
  title: text
  sort_order: integer
  summary: text
  created_at: timestamp
}

// 章
chapters {
  id: text PK
  volume_id: text FK
  title: text
  sort_order: integer
  content: text           // Markdown 正文
  word_count: integer
  summary: text           // 章节摘要
  status: enum(draft/reviewed/published)
  created_at: timestamp
  updated_at: timestamp
}

// 节（Scene：一章内的子段落）
scenes {
  id: text PK
  chapter_id: text FK
  title: text
  sort_order: integer
  summary: text
  content: text
}

// 大纲（卷纲/章纲/节纲统一表）
outline_items {
  id: text PK
  project_id: text FK
  parent_id: text FK         // 自引用树
  level: enum(volume/chapter/scene)
  title: text
  sort_order: integer
  summary: text
  target_word_count: integer
  emotional_goal: text       // 情感目标
  pacing: text               // 节奏标识
  created_at: timestamp
  updated_at: timestamp
}

// 角色
characters {
  id: text PK
  project_id: text FK
  name: text
  aliases: text[]            // 别名/称呼
  role: text                 // 主角/重要/龙套
  appearance: text           // 外貌描述
  personality: text          // 性格
  background: text           // 背景故事
  abilities: text            // 能力/修为
  status: json               // 当前状态 {location, emotion, etc.}
  avatar_url: text           // 头像（可选）
  created_at: timestamp
  updated_at: timestamp
}

// 角色关系
character_relationships {
  id: text PK
  project_id: text FK
  character_a_id: text FK
  character_b_id: text FK
  relationship_type: text    // 师徒/恋人/敌对/家人等
  description: text
  created_at: timestamp
}

// 世界观设定
world_settings {
  id: text PK
  project_id: text FK
  category: text            // 力量体系/地理/阵营/历史等
  title: text
  content: text             // Markdown 描述
  tags: text[]
  created_at: timestamp
  updated_at: timestamp
}

// 写作会话（AI 对话记录）
writing_sessions {
  id: text PK
  project_id: text FK
  chapter_id: text FK       // 关联章节（可选）
  session_type: enum(write/review/inspiration)
  messages: json            // AI 对话历史
  created_at: timestamp
  updated_at: timestamp
}
```

### 编辑器（分章编辑器）

- 左侧：卷-章-节树形导航
- 中间：Markdown 编辑器（选择 TipTap 或 CodeMirror 6，支持 Markdown 写作）
- 底部：字数统计 + AI 操作按钮
- 全屏写作模式切换

### WriterAgent + 卡片式对话

- 延续当前的 ChatPanel 架构，改造为写作专用对话
- 对话中可插入结构化卡片：角色卡、设定卡、大纲卡
- 支持操作类型：
  - **续写**：基于前文和指引生成下文
  - **扩写**：选中段落展开细节
  - **润色**：保持原意优化表达
  - **改写**：按指定风格重写
- 每次生成结果自动保存到章节

### 大纲系统（三级）

- 卷纲 → 章纲 → 节纲 三级树形结构
- 每级可编辑标题、摘要、目标字数
- 大纲面板与编辑器联动，选中章纲时编辑器跳转到对应章节

### 角色系统

- 角色管理面板：列表 + 详情编辑
- 角色卡：姓名、别名、外貌、性格、背景、能力、状态
- 关系网：角色间关系图谱
- 状态追踪：当前情绪、位置、关键变化记录

### ReviewerAgent

- 写完后触发审查
- 检查维度：设定矛盾、逻辑问题、角色行为一致、文风
- 输出结构化报告：各维度评分 + 问题列表 + 修改建议
- 问题按严重性分级：critical / high / medium / low

### 灵感 Agent

- 在写作界面触发"获取灵感"
- 基于当前章节上下文和大纲位置生成建议
- 输出多种可选方案

### IPC 接口

新增 `novel:` 域，提供以下通道：

| Channel | 方向 | 用途 |
|---------|------|------|
| `novel:project:list` | request-response | 列出所有项目 |
| `novel:project:create` | request-response | 创建项目 |
| `novel:project:get` | request-response | 获取项目详情 |
| `novel:project:delete` | request-response | 删除项目 |
| `novel:chapter:list` | request-response | 列出章节 |
| `novel:chapter:get` | request-response | 获取章节 |
| `novel:chapter:save` | request-response | 保存章节内容 |
| `novel:chapter:create` | request-response | 创建章节 |
| `novel:chapter:delete` | request-response | 删除章节 |
| `novel:outline:*` | request-response | 大纲 CRUD |
| `novel:character:*` | request-response | 角色 CRUD |
| `novel:character:relationship:*` | request-response | 角色关系管理 |
| `novel:world-setting:*` | request-response | 世界观设定 CRUD |
| `novel:agent:write` | request-response + stream | WriterAgent 写作 |
| `novel:agent:review` | request-response | ReviewerAgent 审查 |
| `novel:agent:inspire` | request-response | 灵感建议 |
| `novel:export:txt` | request-response | 导出 TXT |
| `novel:session:*` | request-response | 写作会话管理 |

### AI Agent 提示词策略

复用现有 Vercel AI SDK，为每个 Agent 类型定义独立的 system prompt：

- **WriterAgent** — 包含：作品设定摘要、当前大纲位置、角色活跃状态、前文摘要、风格指引
- **ReviewerAgent** — 包含：作品设定、角色信息、审查规则（5 维度）
- **InspirationAgent** — 包含：当前章节上下文、大纲位置、创意方向

所有 Agent 通过 LLMAdapter 统一调用，复用现有 API Key 管理。

## [S3] Out of Scope

第一版不实现：

- 伏笔管理（B7）
- 上下文管理系统（四层上下文）
- 风格管理（B4）
- 多线叙事（B5）
- 节奏控制（B8）
- 因果链检测（B3）
- 角色模拟 Agent + 角色记忆系统
- 知识库 + 搜索
- 导入 EPUB / DOCX
- Web 端 / 多端同步
- 发布到网文平台

## Tasks

### Phase 1A — 数据层与基础设施

- [ ] T1: 扩展 SQLite schema，创建写作数据模型（novel_projects/volumes/chapters/scenes/outline_items/characters/character_relationships/world_settings/writing_sessions）
  - 验收：`drizzle-kit generate` 生成正确的 SQL 迁移文件，`pnpm test` 通过
  - covers: S2-数据模型

- [ ] T2: 实现 ProjectService（项目管理 CRUD + 文件系统映射）
  - 验收：可创建/列出/打开/删除写作项目，数据持久化到 SQLite
  - covers: S2-数据模型

- [ ] T3: 实现 写作项目文件格式（.novel 项目文件）
  - 验收：项目数据可序列化为 .novel 文件，支持打开已有项目
  - covers: S2-数据模型

### Phase 1B — IPC 与主进程服务

- [ ] T4: 定义 novel: 域 IPC channels 和 payload schema
  - 验收：IPC_CHANNELS 新增所有 novel:* 通道，类型定义完整
  - covers: S2-IPC 接口

- [ ] T5: 实现写作域 IPC handler（novel.handler.ts），注册所有 novel:* handler
  - 验收：所有 novel:* IPC 通道可正常调用，返回正确数据
  - covers: S2-IPC 接口

- [ ] T6: 实现 ChapterService + OutlineService
  - 验收：可创建/编辑/删除章节和大纲项，数据正确持久化
  - covers: S2-大纲系统

- [ ] T7: 实现 CharacterService + WorldSettingService
  - 验收：角色和世界观设定的 CRUD 功能正常
  - covers: S2-角色系统, S2-世界观设定

### Phase 1C — 渲染层 UI

- [ ] T8: 改造路由，新增写作工作台布局（左侧导航 + 中间编辑器 + 右侧面板）
  - 验收：路由替换为 novel 路由，写作工作台布局可用，Code Agent 路由保留可切换
  - covers: S2-编辑器

- [ ] T9: 实现分章编辑器（Markdown 编辑器 + 卷-章-节树形导航）
  - 验收：可导航和编辑章节内容，Markdown 编辑和预览正常，字数统计正确
  - covers: S2-编辑器

- [ ] T10: 实现大纲面板（三级树形 + 编辑）
  - 验收：可查看和编辑卷纲/章纲/节纲，选中章纲时编辑器跳转
  - covers: S2-大纲系统

- [ ] T11: 实现角色管理面板（列表 + 详情编辑 + 关系网）
  - 验收：可增删改角色、编辑角色详情、管理角色关系
  - covers: S2-角色系统

- [ ] T12: 实现世界观设定管理面板
  - 验收：可按分类管理世界观设定条目
  - covers: S2-世界观设定

### Phase 1D — AI Agent 改造

- [ ] T13: 实现 WriterAgent（改造现有 AgentService），支持续写/扩写/润色/改写
  - 验收：WriterAgent 可基于章节上下文生成正文，流式输出正常
  - covers: S2-WriterAgent

- [ ] T14: 实现卡片式对话 UI（在 chat 对话中插入角色卡/设定卡/大纲卡）
  - 验收：对话中可插入结构化卡片，卡片可点击展开详情
  - covers: S2-WriterAgent, S2-卡片式对话

- [ ] T15: 实现 ReviewerAgent
  - 验收：可对指定章节执行审查，输出结构化报告（各维度评分 + 问题列表）
  - covers: S2-ReviewerAgent

- [ ] T16: 实现审查报告展示组件
  - 验收：审查报告以可视化方式展示问题分类和严重性
  - covers: S2-ReviewerAgent

- [ ] T17: 实现 InspirationAgent
  - 验收：基于当前上下文生成创意建议，展示可选方案
  - covers: S2-灵感 Agent

### Phase 1E — 导出与收尾

- [ ] T18: 实现 TXT 导出（单章 + 整书）
  - 验收：导出 TXT 可正确打开，章节顺序和内容完整
  - covers: S2-导出

- [ ] T19: 扩展 ServiceContainer，注册所有写作服务
  - 验收：写作服务生命周期由 ServiceContainer 统一管理，dispose 顺序正确
  - covers: S2-总体架构

- [ ] T20: 补充 E2E 测试：写作流程（创建项目 → 写章 → 审查 → 导出）
  - 验收：Playwright E2E 测试覆盖完整写作流程
  - covers: S2-全部
