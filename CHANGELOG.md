# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

> 注：根应用为 pnpm workspace 根包，changesets 不支持将其作为版本管理目标（known limitation），CHANGELOG 手动维护。

## [Unreleased]

### 新增

- 转型为生产级 Code Agent 桌面模板：多 AI 供应商可插拔路由（DeepSeek/OpenAI/Anthropic/Ollama）、plan/build 双模式工作流、主进程 Service Container 生命周期管理
- IPC 定义表驱动自动化：单一真源定义表自动生成 preload API、类型推导、通道常量与主进程统一注册，新增 IPC 方法缺 handler 编译期报错
- 新增 IPC/工具 CLI 脚手架：`pnpm scaffold:ipc` 从定义表生成新域/方法骨架，`pnpm scaffold:tool` 生成工具文件并自动接入注册表（幂等保护）
- 补齐工程化工具链：Renovate 依赖自动更新、changesets 版本与 CHANGELOG 管理、包体积分析、pre-push 快速门禁、TypeDoc 契约文档、knip 死代码检测（CI 卡关）
- 接入自动更新链路（electron-updater）：更新检查、下载进度、就绪后一键重启安装，状态事件驱动 UI 提示
- 核心 UI 能力增强：会话列表拖拽排序、消息列表虚拟化、命令面板（模糊搜索）、文件查看器树导航、全局快捷键库化、diff 语义统计
- 新增 token 用量统计：回合结束后展示输入/输出/总 token 消耗（会话级累积，状态条可见）

### 修复

- 修复 SearchService 两处解析缺陷：exclude 参数空值导致的 TypeError、ripgrep --json 消息结构差异（line/lines 字段、缺 path）导致的崩溃
- 修复状态管理正确性：回合结束后会话缓存未失效导致切回会话看到旧消息；工具调用/审批缓冲缺少清理时机导致长会话内存累积

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
