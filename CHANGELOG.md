# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

> 注：根应用为 pnpm workspace 根包，changesets 不支持将其作为版本管理目标（known limitation），CHANGELOG 手动维护。

## [Unreleased]

### 新增

- `main`：im 渠道配置说明 configHint - 设置页展示各渠道接入指引
- `main`：微信渠道 - ilink 智能机器人长轮询收发
- `main`：qq 渠道 - 官方 gateway 长连接接收与 api 发送
- `main`：企业微信长连接接收 - aibot sdk 消息入站
- `main`：飞书长连接接收 - 官方 sdk wsclient 消息入站
- `main`：钉钉 stream 长连接接收 - 企业应用消息入站
- `main`：im 渠道 webhook 发送 - 钉钉/企业微信/飞书群机器人
- `main`：qwen-code 后端功能对齐 - 编排/权限/记忆/任务/子代理/团队/lsp/workflow/工具
- `main`：im 渠道与设置体系 - telegram 适配器/审批偏好/三平台构建
- `main`：引入后端基础设施依赖 - simple-git/编码检测/代码分析
- `renderer`：前端性能与体验优化 - 懒加载/防闪烁/虚拟化/错误恢复动作/memo 清理
- `renderer`：完善异步视图边界 - 刷新进度指示与空态 CTA
- `renderer`：引入异步视图状态契约 useAsyncView + AsyncBoundary 并接入会话列表
- 可靠性极致 - 崩溃恢复/数据备份/进程兜底/导出入口
- 架构极致阶段 1+2 - 依赖机器闸与复杂度阈值
- 体验极致 - 渲染层硬编码中文 UI 文案零残留收尾
- 体验极致 - 渲染层硬编码中文 UI 文案全量收口完成
- 体验极致 - 终端/错误边界/路由/hooks 文案 i18n 收口（全量完成）
- 体验极致 - Git/FileViewer/FileTree 组件 i18n 收口
- 体验极致 - dev 面板系列 i18n 收口 + 修复 resources 解包 bug
- 体验极致 - SettingsDialog/home 页 i18n 收口
- 体验极致 - ApprovalDialog 审批 UI 全面 i18n 收口
- 体验极致 - chat/update/palette 组件 i18n 收口
- 体验极致 - Topbar/Sidebar 文案 i18n 收口
- 新增 changelog 自动生成器（commit 驱动）

### 修复

- `main`：schema-sql memories 建表段字面换行损坏 - dev 启动 sqlite 崩溃修复
- `main`：qq 渠道 intents 修正 - c2c 与群聊同属 group_and_c2c_event(1<<25)
- `main`：qq 渠道官方协议合规 - 事件名/网关获取/token 刷新/心跳序列号/err_code
- fileViewerDialog 的 useCallback 依赖补充 t
- 修复 electron-updater CJS 互操作与 E2E 实例隔离

## [1.0.0] - 2026-08-03

### 新增

- 转型为生产级 Code Agent 桌面模板（Electron + React 19 + TypeScript）
- 多 AI 供应商可插拔路由（DeepSeek / OpenAI / Anthropic / Ollama）
- plan/build 双模式工作流（plan 只读探索，build 审批执行）
- 自研 IPC 定义表体系：IPC_META → 定义表 → 自动生成 preload API / 类型推导 / 统一注册
- IPC/工具 CLI 代码生成脚手架（`pnpm scaffold:ipc` / `pnpm scaffold:tool`）
- 主进程 Service Container 模式（10+ 服务统一生命周期管理）

### 安全

- CSP 多供应商域名修复（anthropic / localhost）
- 路径守卫加固（空白路径、越界路径拦截）
- 命令注入防护验证、危险命令拦截
- API Key 使用 safeStorage（Windows DPAPI）加密存储

### 测试

- 补齐 handler / hooks / service 层测试，总测试 539 个
- 修复 SearchService 两处真实缺陷（exclude 空值、ripgrep JSON 消息结构差异）
- E2E 三套配置（浏览器 / Electron / 生产 smoke）+ a11y / perf / 视觉回归

### 工程质量

- CI 四 job 门禁（质量 / 浏览器 E2E / Electron E2E / 生产 Smoke）
- Git 工程：Husky + commitlint + lint-staged
- 依赖安全审计（audit-ci + .nsprc 豁免）
