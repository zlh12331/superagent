# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

> 版本段由 release-please 基于 Conventional Commits 自动生成；发版前请在 Release PR 中将机器文案润色为面向用户的描述（历史版本段 release-please 会保留，不会被覆盖）。

## [1.0.4](https://github.com/zlh12331/superagent/compare/v1.0.3...v1.0.4) (2026-09-10)


### Bug Fixes

* **main:** watcher usePolling 条件展开，适配 exactOptionalPropertyTypes ([43e53c8](https://github.com/zlh12331/superagent/commit/43e53c8029e587bd8a98639c3c20663b050d2b55))
* **release:** mac 空证书不导出 CSC_LINK + Windows 测试 watcher 走轮询模式 ([5b5b3f6](https://github.com/zlh12331/superagent/commit/5b5b3f64e7dd6933b767339298dc3b0f8e5a8526))

## [1.0.3](https://github.com/zlh12331/superagent/compare/v1.0.2...v1.0.3) (2026-09-09)


### Bug Fixes

* **release:** draft 发布保护+mac 签名自发现修复+beta 分支+watcher 关闭治本 ([6c45eea](https://github.com/zlh12331/superagent/commit/6c45eea091adec5114abf0277469d0080c2f1772))

## [1.0.2](https://github.com/zlh12331/superagent/compare/v1.0.1...v1.0.2) (2026-09-09)


### Bug Fixes

* **ci:** release smoke 补 xvfb + file-service 测试禁用 chokidar 原生监视规避 Windows 崩溃 ([2a1ee91](https://github.com/zlh12331/superagent/commit/2a1ee91ce26250c273e9e2b5ccc23c399027b3ce))
* **main:** 修正 env 索引访问类型，通过 typecheck ([4bb7af1](https://github.com/zlh12331/superagent/commit/4bb7af1463654761576eb1d2f58be8d80eb8786b))

## [1.0.1](https://github.com/zlh12331/superagent/compare/v1.0.0...v1.0.1) (2026-09-09)


### Bug Fixes

* **main:** 修复路径守卫 realpath 比较不对称致 CI 三平台单测失败 ([8002437](https://github.com/zlh12331/superagent/commit/800243766330972bb1238894120240165058a5c3))

## [1.0.0] - 2026-09-09

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
- 移动端：控制页二维码配对，扫码直开

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
