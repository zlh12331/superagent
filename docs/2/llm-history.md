> **🆕 前端验证版新增功能**
>
> 本文档为前端验证版**新增**的功能需求文档，不存在原始全栈版本。
>
> **技术实现要点**：
> - 所有功能在前端 TypeScript 中实现
> - 数据存储使用 Supabase（llm_call_history 表）
> - 搜索功能使用 Supabase 全文搜索（pg tsvector）
> - 与 Prompt 模板管理联动（保存为模板功能）
>
> ---

# LLM 调用历史 - 功能需求文档

## 1. 功能概述

- **所属模块**：手动 LLM 模式
- **功能描述**：记录每次 LLM 调用的完整信息（Agent 类型、时间、prompt、回答），支持搜索筛选和回溯复用。
- **优先级**：P1
- **页面路由**：/project/:id/llm-history

---

## 2. 验收标准 (Acceptance Criteria)

### AC-1: 调用记录列表

- **Given** 用户进入 LLM 调用历史页面
- **When** 页面加载完成
- **Then** 按时间倒序显示当前项目的所有 LLM 调用记录，每条记录显示：时间、Agent 类型、调用模式（手动/API）、状态（成功/失败/中断）

### AC-2: 调用详情查看

- **Given** 用户点击某条调用记录
- **When** 进入详情页
- **Then** 显示完整的 prompt 和回答内容，支持复制

### AC-3: 搜索筛选

- **Given** 用户想查找特定调用记录
- **When** 使用搜索框按 Agent 类型、时间范围、关键词筛选
- **Then** 列表实时过滤显示匹配的记录

### AC-4: 保存为模板

- **Given** 用户发现某次调用的 prompt 效果很好
- **When** 点击"保存为模板"
- **Then** 该 prompt 被导入到 Prompt 模板管理页作为对应 Agent 的新模板版本

### AC-5: 重新执行

- **Given** 用户想复用某次调用的结果
- **When** 点击"重新执行"
- **Then** 系统基于该 prompt 重新发起调用（使用当前模式：手动或 API）

---

## 3. 业务规则 (Business Rules)

| 编号 | 规则描述 |
|------|----------|
| BR-1 | 调用记录按项目隔离，不同项目的记录不互通 |
| BR-2 | 每条记录包含：id、project_id、chapter_id（可选）、agent_type、mode（manual/api）、prompt（完整）、response（完整）、status、token_count（预估）、version_fingerprint（SHA-256 hash）、conversation_history（多轮对话历史）、duration（手动模式为用户操作耗时）、created_at |
| BR-3 | 搜索支持模糊匹配（prompt 和 response 内容） |
| BR-4 | 调用记录不可删除（保留完整历史），但支持归档 |

---

## 4. 用户故事 (User Stories)

| 编号 | 用户故事 |
|------|----------|
| US-1 | 作为作者，我希望查看历史 LLM 调用记录，以便回溯和分析哪些 prompt 效果好 |
| US-2 | 作为作者，我希望按 Agent 类型和关键词搜索调用记录，以便快速找到特定场景的 prompt |
| US-3 | 作为作者，我希望将效果好的 prompt 保存为模板，以便后续复用 |
| US-4 | 作为作者，我希望重新执行某次调用的 prompt，以便在修改数据后对比效果 |

---

## 5. 界面要求 (UI Requirements)

### 5.1 页面布局

- **顶部**：搜索栏 + 筛选器（Agent 类型下拉、时间范围选择器、模式筛选）
- **主体**：时间线列表，每条记录为卡片形式
- **卡片内容**：时间、Agent 类型标签、模式标签、状态指示、prompt 摘要（前 100 字）
- **详情页**：左右分栏，左侧 prompt，右侧 response

### 5.2 各区域说明

| 区域 | 说明 |
|------|------|
| 搜索栏 | 支持按关键词搜索，实时过滤调用记录 |
| 筛选器 | Agent 类型下拉、时间范围选择器、模式筛选（手动/API） |
| 时间线列表 | 按时间倒序展示调用记录，每条记录为卡片形式 |
| 卡片内容 | 显示时间、Agent 类型标签、模式标签、状态指示、prompt 摘要（前 100 字） |
| 详情页 | 左右分栏布局，左侧展示完整 prompt，右侧展示完整 response，支持复制 |

---

## 6. 数据要求 (Data Requirements)

### 6.1 输入数据

| 数据项 | 说明 | 来源 |
|--------|------|------|
| Agent 类型 | 筛选指定 Agent 的调用记录 | 筛选器选择 |
| 时间范围 | 筛选指定时间段内的调用记录 | 时间范围选择器 |
| 关键词 | 搜索 prompt 和 response 中的关键词 | 搜索框输入 |

### 6.2 输出数据

| 数据项 | 说明 | 格式 |
|--------|------|------|
| 匹配的调用记录列表 | 符合筛选条件的调用记录 | JSON |

### 6.3 存储要求

| 存储位置 | 数据内容 | 生命周期 |
|----------|----------|----------|
| Supabase `llm_call_history` 表 | LLM 调用记录（id、project_id、chapter_id、agent_type、mode、prompt、response、status、token_count、version_fingerprint、conversation_history、duration、created_at） | 永久 |

---

## 7. 依赖关系 (Dependencies)

### 7.1 前置依赖

| 依赖模块 | 说明 |
|----------|------|
| LLMAdapter 统一接口 | 记录所有 LLM 调用（手动和 API 模式） |
| 手动 LLM 模式 | 提供手动调用的记录数据 |

### 7.2 后续影响

| 影响模块 | 说明 |
|----------|------|
| Prompt 模板管理 | 支持从调用历史导入 prompt 作为模板 |
