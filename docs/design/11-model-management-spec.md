# 11. 模型管理模块 · 多页面开发计划规格说明

> **文档用途**：本文档为开发蓝图——依据产品截图逆向推导，用于开发本项目全新的模型设置页面（前端：列表页 + 3 类弹窗；后端配套：`runtime_models` 表迁移 + 新增 IPC，见六、后端开发范围）。
>
> 依据产品截图逆向推导（列表页 + 添加模型选择器 + 配置弹窗 + 编辑弹窗 + 删除确认弹窗）。
>
> **实现状态（已落地）**：本文描述的目标形态已全部实现——列表页 `models-section.tsx`、三类弹窗 `sections/dialogs/{add-model-dialog,model-config-dialog,model-config-fields}.tsx`、删除确认；后端 `settings:addRuntimeModel / updateRuntimeModel / removeRuntimeModel / listRuntimeModels` 与 `models:test` 均已进定义表并接线。
> 表单锁定规则：编辑模式下 `providerKind` 与 `modelId` 均为只读（`updateRuntimeModel` 以 `modelId` 为主键定位行，允许改动会导致保存静默失效）。

## 一、设置页面全局概览

1. 这是什么：设置页中「模型」设置项对应的设置页面（`Ctrl+,` 打开设置页 → 左侧导航「能力」组 → 模型），负责添加、编辑、启停、删除 AI 模型。
2. 包含界面（按使用流程）：模型管理列表页 → 添加模型弹窗 → 模型配置弹窗（服务商模式/自定义模式/编辑模式）→ 删除确认弹窗。
3. 页面形态：弹窗驱动的列表页（列表页 + 3 类弹窗，无独立路由页；整体嵌于设置页全屏 Sheet 的右侧内容区）。
4. 整体布局：列表页竖版（标题区 + 表格）；弹窗居中模态。
5. 视觉风格：简洁、圆角卡片、表格无重阴影、必填红星、黑色主按钮（跟随项目亮/暗双主题，非固定浅色）。

页面流转：

```
模型管理列表页
├── [+ 添加模型] ──→ 添加模型弹窗（模型选择器）
│                     ├── 选厂商（本项目已适配清单）→ 配置弹窗·服务商模式
│                     └── 选"自定义模型" ──→ 配置弹窗·自定义模式
├── 行操作 ✎ 编辑 ──→ 配置弹窗·编辑模式（预填）──保存──→ 返回列表刷新
├── 行操作 🗑 删除 ──→ 删除确认弹窗 ──确认──→ 删除行刷新列表
├── 行操作 开关 ◐ ──→ 直接切换启停（推断，无弹窗）
```

## 二、全局公共组件

| 组件          | 出现的页面  | 内容                                    | 交互       | 状态               |
| ----------- | ------ | ------------------------------------- | -------- | ---------------- |
| 弹窗头部        | 所有弹窗   | 标题 + × 关闭（返回箭头：推断）                 | × 关闭弹窗   | 始终可见             |
| 下拉选择器       | 配置弹窗   | 厂商/配置方式/模型/模型系列                       | 点击展开     | 必填红星             |
| 输入框         | 配置弹窗   | 模型ID/名称/API密钥/Token                   | 键盘输入     | placeholder + 必填 |
| 单选组         | 配置弹窗   | 支持图片输入/思考模式                           | 点击互斥切换   | 蓝点选中             |
| 开关          | 列表页行   | 启停开关                                  | 点击切换     | 开启蓝/关闭灰          |
| Token 快捷按钮组 | 配置弹窗   | `128k/256k/512k/1M`、`4k/16k/32k/128k` | 点击填入预设   | 小号胶囊             |
| 底部操作栏       | 配置弹窗   | 取消/重置/添加模型(或保存)                       | 关闭/清空/提交 | 保存为黑色主按钮         |
| 连通性测试提示     | 配置弹窗底部 | "连通性测试会消耗少量 Token"                    | 无        | 灰色小字 + ⓘ         |
| 必填红星        | 配置弹窗字段 | 红色星号                                  | 无        | 必填标识             |

## 三、逐页面详细规格

***

### 页面 1：模型管理列表页

#### 3.1.1 页面信息

* 用途：展示所有已配置模型，支持增删改查启停

* 形态：设置页右侧内容区（非独立路由，嵌于全屏 Sheet）

* 进入方式：`Ctrl+,` 打开设置页 → 左侧导航「模型」项

* 离开方式：打开各弹窗 / 弹窗保存后刷新本页

#### 3.1.2 区域与元素扫描

头部区域：

| 元素   | 类型 | 内容                                  | 状态 | 位置    | 视觉        |
| ---- | -- | ----------------------------------- | -- | ----- | --------- |
| 主标题  | 文本 | "模型"                                | 正常 | 顶部左对齐 | 大字号粗体     |
| 副标题  | 文本 | "模型管理"                              | 正常 | 主标题下  | 中字号粗体     |
| 说明文字 | 文本 | "配置 API key 添加更多可用模型，预置模型默认使用稳定版本。" | 正常 | 副标题下  | 灰色小字      |
| 添加按钮 | 按钮 | "+ 添加模型"                            | 正常 | 头部右侧  | 圆角灰底 + 加号 |

表格区域（表头 `模型 \| 服务商 \| 操作`；行数据 = 用户添加的模型，读取自配置非硬编码）：

| 元素   | 类型    | 内容                         | 状态 | 位置       | 视觉       |
| ---- | ----- | -------------------------- | -- | -------- | -------- |
| 类型标签 | 标签/图标 | 品牌图标 + 类型文字；图标取配置，无配置则显示默认图标 | 正常 | 模型列第 1 行 | 灰小字/深色图标 |
| 模型名  | 文本    | 模型显示名                      | 正常 | 模型列第 2 行 | 黑色正文     |
| 服务商  | 文本    | 服务商名称（来自配置）           | 正常 | 服务商列     | 黑色正文     |
| 编辑图标 | 图标按钮  | ✎ 铅笔=编辑                    | 正常 | 操作列左     | 灰色图标     |
| 删除图标 | 图标按钮  | 🗑 垃圾桶=删除                  | 正常 | 操作列中     | 灰色图标     |
| 开关   | 开关    | 启停开关                       | 开启 | 操作列右     | 开启蓝/关闭灰  |

#### 3.1.3 交互与行为

| 元素     | 触发 | 行为                 | 反馈   | 条件          |
| ------ | -- | ------------------ | ---- | ----------- |
| + 添加模型 | 点击 | 打开"添加模型弹窗"         | 弹窗淡入 | 始终可点        |
| 编辑 ✎   | 点击 | 打开配置弹窗·编辑模式（预填）    | 弹窗淡入 | 始终可点        |
| 删除 🗑  | 点击 | 打开删除确认弹窗           | 确认弹窗 | 始终可点 |
| 开关     | 点击 | 切换 is\_enabled，调接口 | 开关翻转 | 始终可点 |

#### 3.1.4 数据与状态

```typescript
interface Model {
  id: string;              // 模型 id（全局唯一，对齐 AvailableModelInfo.id）
  label: string;           // 展示名（预置条目为 displayName，用户添加为 modelId，对齐契约注释）
  providerKind: string;    // 供应商 kind（deepseek/openai/...，来自配置，非硬编码）
  isRuntime: boolean;      // 数据来源标识（契约字段），不区分操作权限（无内置/自定义之分）
  is_enabled: boolean;     // 启停状态（新增字段：runtime_models 表加 is_enabled 列，见六、后端开发范围）
}
```

* 数据来源：列表页展示**用户添加的模型**（`settings:listRuntimeModels`，持久化于 SQLite `runtime_models` 表：modelId / providerKind / baseUrl / displayName / isEnabled / createdAt；该通道扩展后直接返回 displayName/isEnabled，无需 models:list 过滤）；厂商/模型预置清单（`models:list`）仅作为添加弹窗与配置弹窗下拉的选择来源

* 状态（按四层架构）：
  - models 列表：L3 TanStack Query（`useModelsQuery`，共享 `MODELS_QUERY_KEY`，与 ModelSelector 同源同 key）
  - 弹窗/删除态：L1 useState（deleteConfirmId、editDialogOpen、editingModel）

* 接口（IPC 通道，非 REST）：
  - 列表：`settings:listRuntimeModels`（扩展返回 displayName / isEnabled）
  - 新增：`settings:addRuntimeModel`（已有）
  - 编辑/启停：`settings:updateRuntimeModel`（新增，见六、后端开发范围）
  - 删除：`settings:removeRuntimeModel`（已有）

#### 3.1.5 动态与条件逻辑

* 空列表显示空态；加载显示骨架

* 行数据循环渲染；增删成功后失效 `MODELS_QUERY_KEY` 刷新列表

***

### 页面 2：添加模型弹窗（模型选择器）

#### 3.2.1 页面信息

* 用途：从厂商列表或"自定义模型"选择入口

* 形态：模态弹窗

* 进入方式：列表页点"+ 添加模型"

* 离开方式：选模型→进入配置弹窗；× 关闭

#### 3.2.2 区域与元素扫描

| 元素   | 类型    | 内容                   | 状态 | 位置  | 视觉    |
| ---- | ----- | -------------------- | -- | --- | ----- |
| 标题   | 文本    | "添加模型"               | 正常 | 头部左 | 大字号粗体 |
| × 关闭 | 图标按钮  | ×=关闭                 | 正常 | 头部右 | 灰色 ×  |
| 模型网格 | 2 列网格 | 模型卡片（数量 = 本项目实际适配厂商数） | 正常 | 内容区 | 圆角卡片  |
| 模型卡片 | 卡片项   | 品牌 Logo + 名称 + 右箭头 > | 正常 | 网格项 | 圆角卡片、悬停背景色加深 |

网格项 = 本项目已适配厂商全量清单（kind 单一真源 shared `ApiKeyProviderSchema`，渲染层 `PROVIDER_LABELS` 静态展示映射）：DeepSeek / OpenAI / Anthropic / Ollama / Moonshot Kimi / 智谱 GLM / 通义千问 / 豆包（火山方舟）/ 硅基流动 / OpenRouter，另置「自定义模型」入口。全量展示不依赖 API Key 配置状态（密钥在配置弹窗内填写）。

> 注：产品截图中的厂商（MiniMax CN、阿里云、小米 MiMo 等）为参考项目的适配清单，本项目未适配则不显示，不照抄。

#### 3.2.3 交互与行为

| 元素   | 触发 | 行为                      | 反馈     |
| ---- | -- | ----------------------- | ------ |
| 模型卡片 | 点击 | 厂商→配置弹窗·服务商模式；自定义→自定义模式 | 卡片背景色加深 |
| × 关闭 | 点击 | 关闭弹窗，不保存                | 弹窗淡出   |

#### 3.2.4 数据与状态

* 状态：弹窗开关（L1 useState）

* 接口（IPC 通道，非 REST）：
  - 厂商网格：本项目已适配厂商全量（kind 单一真源 `ApiKeyProviderSchema`，无 IPC 拉取）
  - 品牌图标：取配置，无则默认图标（推断：现有实现无图标数据源，提供商行头为首字母色块，无单独接口）

* 跨页数据：传递 `provider` 或 `mode='custom'` 给配置弹窗

#### 3.2.5 动态与条件逻辑

* 厂商卡片 = 已适配厂商全量清单（静态映射，非数据派生）；「自定义模型」为固定入口（非数据派生），始终显示

***

### 页面 3：模型配置弹窗（统一表单 · 多模式）

> 合并"自定义模型配置弹窗""通过服务商添加弹窗""编辑模型弹窗"——同一表单，多种模式。

#### 3.3.1 页面信息

* 用途：填写模型完整配置并保存

* 形态：模态弹窗（大弹窗 + 内部滚动，字段多）

* 三种模式：

  * 服务商模式：从"添加模型弹窗"选厂商进入，显示服务商/配置方式/模型/API 密钥

  * 自定义模式：选"自定义模型"进入，显示 API 格式/请求地址/模型 ID/名称/密钥

  * 编辑模式：从列表页"编辑"进入，预填已有配置，按钮变"保存"

* 离开方式：保存→关闭并刷新列表；取消/× 关闭不保存

#### 3.3.2 区域与元素扫描

API 基础配置区（必填红星）：

| 元素        | 类型   | 内容                                      | 状态   | 备注           |
| --------- | ---- | --------------------------------------- | ---- | ------------ |
| API 格式    | 下拉   | `OpenAI Chat Completions 格式`            | 正常   | 自定义模式        |
| 自定义请求地址   | 输入框  | placeholder `https://api.openai.com/v1` | 正常   | 自定义模式        |
| 服务商       | 下拉   | 本项目已适配厂商（见 3.2.2 网格项） | 必填\* | 服务商模式        |
| 配置方式      | 下拉   | `按量计费`                                  | 必填\* | 服务商模式        |
| 模型        | 下拉   | `选择模型`/`使用其他模型`                         | 必填\* | 联动模型 ID      |
| 模型 ID     | 输入框  | `deepseek-chat`                        | 必填\* | "使用其他模型"时可编辑 |
| 模型展示名称    | 输入框  | placeholder + 字符计数 `0/32`               | 选填   | 自定义模式        |
| API 密钥    | 输入框  | placeholder"请输入 API Key" + 眼睛图标         | 必填\* | 显隐切换         |
| 获取 API 密钥 | 链接按钮 | 文字链（跳转所选厂商官网 API Key 申请页，按 providerKind 映射官网地址） | 正常   | 跳转官网 |

高级配置区（折叠，可展开）：

| 元素          | 类型   | 内容                                   | 备注           |
| ----------- | ---- | ------------------------------------ | ------------ |
| 模型系列        | 下拉   | `默认`                                 | 提示"针对特定系列优化" |
| 上下文窗口-输入    | 输入框  | 如 `872000` + 快捷键 `128k/256k/512k/1M` | <br />       |
| 上下文窗口-输出    | 输入框  | 如 `128000` + 快捷键 `4k/16k/32k/128k`   | <br />       |
| 工具调用轮数      | 数字输入 | `200`/`500`                          | <br />       |
| 支持图片输入      | 单选组  | `支持`/`不支持`                           | 蓝点选中         |
| 思考模式        | 单选组  | `跟随模型默认`/`开启`/`关闭`                   | 蓝点选中         |
| Temperature | 输入框  | placeholder"留空或输入 0\~2"              | <br />       |
| Top P       | 输入框  | placeholder"留空或输入 0\~1"              | <br />       |
| Top K       | 输入框  | placeholder"留空或输入 1\~100"            | <br />       |

底部操作区：

| 元素      | 类型  | 内容                 | 状态 | 位置   |
| ------- | --- | ------------------ | -- | ---- |
| 连通性提示   | 文本  | "连通性测试会消耗少量 Token" | 正常 | 左下灰字 |
| 取消      | 按钮  | "取消"               | 正常 | 右下   |
| 重置      | 按钮  | "重置"               | 正常 | 右下   |
| 添加模型/保存 | 主按钮 | 黑色主按钮              | 正常 | 最右   |

#### 3.3.3 交互与行为

| 元素        | 触发 | 行为                  | 联动                  | 条件    |
| --------- | -- | ------------------- | ------------------- | ----- |
| 服务商下拉     | 点击 | 选厂商                 | 模型下拉清空并加载对应模型       | 必填    |
| 模型下拉      | 点击 | 选模型                 | 选"使用其他模型"→模型 ID 可编辑 | 必填    |
| 模型 ID     | 输入 | 编辑                  | 仅"使用其他模型"可编辑        | 必填、非空 |
| Token 快捷键 | 点击 | 填入预设值               | 对应输入框更新             | —     |
| 单选组       | 点击 | 互斥切换                | 圆点填充                | —     |
| 重置        | 点击 | 清空表单                | 全字段恢复初始             | —     |
| 保存/添加     | 点击 | 校验→连通性测试→提交→关闭→刷新列表 | 校验失败标红              | 必填非空  |
| 取消/×      | 点击 | 关闭弹窗不保存             | 弹窗淡出                | —     |

#### 3.3.4 数据与状态

```typescript
interface ModelConfig {
  mode: 'provider' | 'custom';  // 编辑模式复用同一表单，由 editingModel 预填
  provider?: string;        // 表单字段名，映射 IPC/存储 providerKind
  configType?: string;      // 配置方式（按量计费）
  apiFormat?: string;       // 自定义模式：API 格式
  requestUrl?: string;      // 表单字段名，映射 IPC/存储 baseUrl
  model?: string;
  modelId?: string;
  displayName?: string;     // 展示名（映射列 display_name）
  apiKey?: string;
  modelSeries?: string;
  contextInput?: number;
  contextOutput?: number;
  toolCallRounds?: number;
  imageSupport: 'support' | 'unsupport';
  thinkingMode: 'follow' | 'on' | 'off';
  temperature?: number;
  topP?: number;
  topK?: number;
}
```

* 字段映射与持久化范围（对齐 6.1 数据库变更）：
  - **持久化**（runtime_models 表）：modelId / providerKind（表单 provider）/ baseUrl（表单 requestUrl）/ displayName（列 display_name）/ isEnabled（新增）
  - **不持久化**（首版仅表单交互）：configType / apiFormat / modelSeries / contextInput / contextOutput / toolCallRounds / imageSupport / thinkingMode / temperature / topP / topK —— 若产品确认高级参数需按模型生效，则扩展 6.1 增列

* 状态：formValues、errors、touched、saving、advancedExpanded（均为 L1 useState）

* 接口（IPC 通道，非 REST）：
  - 新增：`settings:addRuntimeModel`（已有，参数 modelId / providerKind / apiKey（可选，省略走 keychain）/ baseUrl（可选））
  - 编辑/启停：`settings:updateRuntimeModel`（新增，参数见六、后端开发范围）
  - 删除：`settings:removeRuntimeModel`（已有）
  - 连通性测试：`models:test`（新增，参数见六、后端开发范围）
  - 厂商/模型下拉数据：`models:list`（按 providerKind 过滤）

* 跨页数据：进入时接收 `provider` 或 `mode`；保存成功后失效 `MODELS_QUERY_KEY` 刷新列表

#### 3.3.5 动态与条件逻辑

* 选"使用其他模型"→模型 ID 可编辑；选厂商预设模型→自动填充

* 必填项非空才可提交；范围校验（Temperature 0\~2 / TopP 0\~1 / TopK 1\~100）

* 思考模式"关闭"时禁用采样参数（Temperature / Top P / Top K）

* 编辑模式预填；保存 loading 禁用按钮

***

### 页面 4：删除确认弹窗

#### 3.4.1 页面信息

* 用途：删除模型前二次确认

* 形态：模态弹窗（小型）

* 进入方式：列表页点删除图标

* 离开方式：确认→删除并刷新；取消→关闭

#### 3.4.2 元素扫描

| 元素     | 类型   | 内容              | 状态 | 位置  |
| ------ | ---- | --------------- | -- | --- |
| 标题     | 文本   | "删除模型"          | 正常 | 头部  |
| ⚠ 警告图标 | 图标   | ⚠=危险操作          | 正常 | 标题旁 |
| 删除     | 危险按钮 | "删除"深灰加粗        | 正常 | 右下  |
| 取消     | 按钮   | "取消"            | 正常 | 右下左 |

#### 3.4.3 交互

* 删除→调 `settings:removeRuntimeModel`→成功→关闭弹窗→失效 `MODELS_QUERY_KEY` 刷新列表

* 取消→关闭弹窗

#### 3.4.4 数据与接口

* `settings:removeRuntimeModel`（已有通道，参数 `{ modelId }`）

## 四、页面间数据流与状态共享

1. 全局状态：模型列表 `models[]`（L3 TanStack Query，`useModelsQuery` 共享 `MODELS_QUERY_KEY`；弹窗保存/删除后失效刷新）
2. 传参：添加模型弹窗 → 配置弹窗传 `provider` 或 `mode='custom'`；编辑模式传 `editingModel` 预填
3. 数据回传：配置弹窗保存成功 → 失效 `MODELS_QUERY_KEY` 刷新（新增/更新）；删除成功 → 同上
4. 状态同步：添加/编辑/删除/启停后列表页必须刷新（统一失效共享查询 key）

## 五、已确认决策

* 连通性测试：保存前自动触发（正文 3.3.3 已定：校验→连通性测试→提交，失败阻止提交）

* 配置弹窗：大弹窗 + 内部滚动（字段多）

* 搜索/筛选/分页：首版不做（列表为用户添加的模型，数据量小）

* 弹窗返回箭头：无（仅 × 关闭）

---

## 六、后端开发范围

### 6.1 数据库变更（runtime_models 表）

新增两列（schema.ts 唯一真源 + drizzle-kit generate 自动出迁移）：

| 列 | 类型 | 说明 |
|---|---|---|
| display_name | text, nullable | 模型展示名称（自定义模式选填） |
| is_enabled | integer, not null, default 1 | 启停状态（0=停用 1=启用） |

### 6.2 新增 IPC 通道（meta.ts + definitions.ts 各一行，其余自动生成）

* `settings:updateRuntimeModel`：编辑 + 启停
  - 请求：`{ modelId, displayName?, baseUrl?, apiKey?, isEnabled? }`（省略字段不修改）
  - 响应：`{ ok: true }`；modelId 不存在返回错误
* `models:test`：连通性测试
  - 请求：`{ providerKind, modelId?, baseUrl?, apiKey? }`
  - 响应：`{ ok: boolean; error?: string }`
  - 规则：真实 HTTP 探测（fetch 直连供应商端点最小请求，apiKey 回退链 input.apiKey → 提供商 keychain key → 运行时模型 key），失败返回 error 提示；"会消耗少量 Token" 为截图既定 UI 文案
* `settings:listRuntimeModels`：**扩展**返回 displayName / isEnabled 字段（列表页开关与展示名的数据源）

### 6.3 API Key 复用（无新增）

* 服务商模式：「API 密钥」字段走 `settings:setApiKey`（提供商级 keychain 加密存储）
* 自定义模式：走 `settings:addRuntimeModel` 的 apiKey 参数（模型级显式 key，可选，省略走 keychain 默认 key）
* 现有契约已支持，无需新增通道

### 6.4 与现有 ModelsSection 的整合（整体重构，非叠加）

* 「模型」pane **整体重构**为文档蓝图形态：标题区（主标题/副标题/说明 + 添加按钮）+ 表格 + 3 类弹窗，不再保留旧「API 提供商」行列表区块
* 提供商 API Key 配置入口迁移到配置弹窗内：服务商模式保存走 `settings:setApiKey`（提供商级 keychain）+ addRuntimeModel 省略 apiKey（回退读 keychain）；自定义模式走 addRuntimeModel 的 apiKey 参数
* 「模型参数」「审批权限」自模型 pane **拆出为独立导航 pane**（能力组 + 智能与行为组），导航从 15 项变 17 项
* 添加弹窗厂商网格 = 本项目已适配厂商全量（`PROVIDER_LABELS`，kind 单一真源 `ApiKeyProviderSchema`），不依赖 key 配置状态
* 数据统一走 `useRuntimeModelsQuery`（`RUNTIME_MODELS_QUERY_KEY`），增删改启停后失效刷新
* 列表页无搜索/分页（首版），数据量小
