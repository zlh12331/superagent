# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [1.2.0](https://github.com/zlh12331/superagent/compare/v1.1.2...v1.2.0) (2026-09-18)

> 本版本为应用加入了完整的自动更新能力：打开应用即自动检查新版本，下载进度可见也可随时取消，更新在退出时自动安装。

### 新增

- **自动检查更新**：每次启动应用后自动检查一次；若网络不通会静默按 1/5/15 分钟重试，窗口长期开着也会定期复查。设置 → 关于新增「自动检查更新」开关（默认开启），关闭后仍可手动点「检查更新」（[#47](https://github.com/zlh12331/superagent/issues/47)）
- **下载进度可见、可取消**：设置 → 关于显示当前下载的进度条、已下载/总量、实时速度与预计剩余时间；顶栏出现下载指示，点击直接跳到该界面；不想现在更新可以随时点「取消」（[#47](https://github.com/zlh12331/superagent/issues/47)）
- **更新就绪与安装**：下载完成后顶栏显示提示徽标，可一键「重启并安装」；也可以选「稍后」或「跳过此版本」（跳过的版本不再提醒，出现更高版本会自动恢复提醒）。若当时有正在执行的任务，会先弹出确认框，避免打断正在进行的工作（[#47](https://github.com/zlh12331/superagent/issues/47)）
- **更新说明**：就绪时可直接查看该版本的更新内容（即本 CHANGELOG 的对应段落），不用另外去翻发布页面（[#47](https://github.com/zlh12331/superagent/issues/47)）
- **下载进度同步到任务栏**：Windows/macOS 任务栏图标会显示下载进度，无需留在应用窗口（[#47](https://github.com/zlh12331/superagent/issues/47)）

### 修复

- **更新失败看得懂**：检查/下载失败的提示改为分类文案（网络不可达、请求被限流、安装包校验失败、磁盘空间不足），不再直接抛出英文技术报错；无法归类时才保留原始信息以便排查（[#47](https://github.com/zlh12331/superagent/issues/47)）
- **弱网下不再卡死**：修复检查请求可能永久挂起、导致此后「检查更新」按钮一直转圈且只能重启应用的问题（新增 45 秒超时，超时后自动恢复可重试）（[#47](https://github.com/zlh12331/superagent/issues/47)）
- **窗口刷新后状态不丢**：修复刷新窗口后更新状态（下载中/已就绪）丢失、界面回到「检查更新」的问题（[#47](https://github.com/zlh12331/superagent/issues/47)）
- **更新缓存可清理**：设置 → 数据新增更新缓存占用展示与清理入口；清理前会提示「下次升级将改为全量下载」；下载进行中不允许清理，避免破坏在途下载（[#47](https://github.com/zlh12331/superagent/issues/47)）

### 内部改进

- 更新过程日志接入应用日志文件（此前走主进程控制台，打包后无从查看），排查更新问题时可随诊断包导出（[#47](https://github.com/zlh12331/superagent/issues/47)）
- 发布流程新增硬性门禁：安装包必须带差分更新产物（Windows/macOS 的 blockmap、Linux 元数据中的 `blockMapSize`），否则发布失败——防止差分更新静默退化为全量下载（[#47](https://github.com/zlh12331/superagent/issues/47)）
- 新增开发期调试开关 `CODE_AGENT_DEV_UPDATE=1`，可在未打包环境下走通更新链路以便验证界面（[#47](https://github.com/zlh12331/superagent/issues/47)）

## [1.1.2](https://github.com/zlh12331/superagent/compare/v1.1.1...v1.1.2) (2026-09-17)

> 本版本无应用功能变更，为发布流程与文档改进。

### 内部改进

- 发布说明加固：新增润色门禁——后续版本的更新说明若未改写为面向用户的文案，Release PR 将被 CI 阻塞无法合并；发版前还会二次校验，未通过则在打 tag 前失败（不占版本号、可重试）
- 新增 `pnpm release:draft`：展开版本区间内的提交明细生成底稿，降低撰写更新说明的成本
- 修正 v1.1.1 的发布说明：由内部提交标题改写为面向用户的表述

## [1.1.1](https://github.com/zlh12331/superagent/compare/v1.1.0...v1.1.1) (2026-09-17)

### 修复

- **记忆功能恢复可用**：修复记忆引擎子进程从未启动——此前每次对话都静默降级为「无记忆」，且已发布的安装包同样受影响（[08942aa](https://github.com/zlh12331/superagent/commit/08942aaedc0229096354b284f52f2fc957dc0102)）
- **亮色主题可读性**：修复首页、会话、设置三个界面共 59 处文字对比度不达 WCAG AA 的问题（列表时间、分组标题、空态提示、设置项标题等）；部分问题此前被失效的测试分支长期掩盖（[674e32e](https://github.com/zlh12331/superagent/commit/674e32e95e6479df01edaf36a9193ff97d6a97fe)、[#44](https://github.com/zlh12331/superagent/issues/44)）
- **终端面板**：修复创建失败时的高频重试（实测单次操作 12157 次 IPC 调用）、补齐方向键导航、显示真实标题与进程号（[#44](https://github.com/zlh12331/superagent/issues/44)）
- **输入框与交互**：修复输入法组合输入期间误发送、快捷键提示文字对比度过低、待办队列在部分场景被误取消、设置项被写坏、文件树 `dirname` 根路径计算、vim `dd` 后状态残留等问题（[#44](https://github.com/zlh12331/superagent/issues/44)）
- **欢迎页品牌**：文案与图标改为产品自有标识（不再使用第三方商标，与顶栏标识统一）（[#44](https://github.com/zlh12331/superagent/issues/44)）
- **修复会话切换时的订阅泄漏**：消息转换出错时未释放流式监听与定时器（[ce7267b](https://github.com/zlh12331/superagent/commit/ce7267b1be362128b81e6877df26301897a2a319)）

### 内部改进

- Web 抓取工具修复 HTML 实体二次解码与 `<script>` 变体剥离；API Key 不再有任何明文落盘路径（[09ce70c](https://github.com/zlh12331/superagent/commit/09ce70c2a595901da0c66e97e8a2f6afea66ecec)）
- 静态分析迁至 advanced setup 并排除 vendored 第三方源码，消除噪声告警（[4f5fa5e](https://github.com/zlh12331/superagent/commit/4f5fa5eb0ea6f6b3ced43e7b2df46a3458f5f907)）
- 新增 3 项工程门禁（动画 keyframes 引用、CSS 变量引用、写法一致性）并修复视觉回归门禁长期失效问题（[#44](https://github.com/zlh12331/superagent/issues/44)）

## [1.1.0](https://github.com/zlh12331/superagent/compare/v1.0.0...v1.1.0) (2026-09-14)


### Features

* 记忆引擎 vendoring 集成（9 批次）+ 发版链路加固 ([d70c938](https://github.com/zlh12331/superagent/commit/d70c9389e497555bba0fdab04b732d5e2a8ba012))


### Bug Fixes

* **ci:** 发布链路补 label 收尾，修复「开不出 Release PR」静默死锁 ([e10a98b](https://github.com/zlh12331/superagent/commit/e10a98b6ef938b8fee42c2c78ffc71595c7ff3ac))

## [1.0.0] - 2026-09-10

首个正式版本。

### 首发亮点

- 生产级 Code Agent 桌面端首发：Electron 44 + React 19 + TypeScript 三进程架构
- 多 AI 供应商可插拔路由（DeepSeek / OpenAI / Anthropic / Ollama）
- plan/build 双模式工作流（plan 只读探索，build 审批执行）
- 主进程 Service Container + IPC 定义表体系 + ipc/工具 CLI 脚手架

### 新增

- 即时通讯：QQ / 微信(ilink) / 企业微信 / 飞书 / 钉钉 / Telegram / webhook 七渠道消息收发与设置体系
- 远程控制：局域网设备发现、HTTP + SSE 命令通道、手机扫码配对开启控制页
- Agent 能力：多会话并发回合、定时任务（cron）、工作流编排工具、采样温度覆盖、上下文手动压缩、回合（含工具调用与思考过程）落库、prompt 注入真实 git 状态
- 记忆引擎：整体替换为 TencentDB-Agent-Memory（MemoryHub 服务）
- 模型与 AI：MCP SSE / streamable-http 传输与远端服务器管理、lsp_hover / code_symbols / codebase 工具、模型调用统一观测（wrapLanguageModel + telemetry）、模型管理页重构
- 渲染层：React Compiler（infer 模式）、shiki 语言按需加载、消息列表分页渲染、长会话自动压缩（opt-in）、vim 模式、快捷键接线、pinned 会话分组、目标栏（goal bar）、设置持久化迁移 SQLite、设计令牌重构、动效库与 Radix ToggleGroup
- 桌面集成：深度链接（code-agent:// 协议）、系统托盘、回合通知、系统主题联动、关窗协商
- 移动端：控制页二维码配对，扫码直开内置控制页

### 修复

- 可靠性：注册竞态 / 序号冲突 / 句柄泄漏等主进程缺口、数据库启动自愈、无头回合重复落库、记忆自动捕获与展示
- 安全：路径越权 / 命令绕过 / 参数注入 / 密钥外泄 / SSRF / 符号链接逃逸 / IM 群聊未授权执行等防御加固，传递依赖漏洞批量修复
- 渲染：a11y 对比度与键盘可达性、设置页崩溃风险、模型配置弹窗、消息分页越界、文件树刷新反馈、流式跟随与输入草稿交叉污染
- 构建与打包：NSIS 图标配置、memory-hub 资源打包、安装包排除 source map、postinstall 原生模块编译降级、覆盖率门禁参数透传
- 测试与 CI：flaky 与竞态修复、check-bundle 超限崩溃、Sentry 符号上传、release 流水线 memory-hub 变量

### 性能

- 编码检测只采样头部 64KB（2MB 文件读取 24s → 441ms）
- token 计数缓存、流式输出闸门、异步日志与 IO、SQLite 热查询索引
- 渲染层流式滚动 rAF 合帧、浮层与右面板懒加载拆分首屏 chunk
