# Code Wiki — Code Agent Desktop

> 面向开发者（尤其是新成员）的代码库导航 Wiki。基于代码库真实实现整理，非产品文档。
> 设计规范与功能实施记录见 [docs/design/README.md](../design/README.md)（三区索引）。

## 项目一句话

一个生产级的 **Electron Code Agent 桌面应用**（当前 v1.3.3），在本地桌面环境中让 AI 智能体具备：多轮工具调用、权限审批流、多模型供应商路由、代码智能查询、终端与 Git 集成、会话持久化、IM 渠道桥接、记忆引擎（vendored 上游 sidecar）、本地优先错误处理 + OpenTelemetry 单通道遥测。

## 关键技术栈

| 层 | 选型 |
|---|---|
| 桌面框架 | Electron 44 + electron-vite 6 (beta.1) |
| 前端 | React 19 + React Router 8 + Vite 8（React Compiler 自动模式） |
| UI | Radix UI + Tailwind CSS 4 + Lucide + shiki + xterm.js |
| 状态 | Zustand（瞬时/持久 store）+ TanStack Query（IPC invoke 服务端状态） |
| AI | Vercel AI SDK v7（`streamText` + `tools` + `stopWhen` 多轮循环） |
| 供应商 | DeepSeek / OpenAI / Anthropic / Ollama 等（自定义模型可插拔，OpenAI Compatible 为主） |
| 数据库 | SQLite（better-sqlite3）+ Drizzle ORM（启动备份轮转 + 损坏自愈） |
| 终端 | xterm.js + node-pty |
| 搜索 | @vscode/ripgrep |
| 代码智能 | codegraph CLI + LSP（tree-sitter WASM / JSON-RPC） |
| 遥测 | OpenTelemetry 单通道（本地优先错误处理，Sentry 已于 2026-09-13 移除） |
| 测试 | Vitest（单元）+ Playwright（E2E / Electron / Smoke 三套） |

## 文档地图

| # | 文档 | 内容 |
|---|---|---|
| 00 | 本文件 | 导航与快速理解 |
| 01 | [整体架构](01-architecture.md) | 进程模型、分层、目录结构、依赖流向、关键架构决策 |
| 02 | [主进程入口与生命周期](02-main-entry.md) | `main/index.ts` 启动链、ServiceContainer 生命周期、安全基线 |
| 03 | [IPC 通信层](03-ipc-layer.md) | 类型契约单一真源、channel 命名、preload 桥、handler 注册 |
| 04 | [AI 智能体层](04-ai-layer.md) | AgentService / 回合运行时 / LLM 客户端 / Provider / Prompt |
| 05 | [工具系统与 MCP](05-tools-system.md) | Tool 抽象、注册表、执行器、权限审批、内置工具、MCP 集成 |
| 06 | [数据层与存储](06-data-storage.md) | SQLite schema、SessionService、keychain、偏好持久化、备份与自愈 |
| 07 | [支撑服务与守护](07-support-services.md) | 文件/搜索/终端/Git/Codebase/LSP/远程/更新/代理/遥测/安全 |
| 08 | [渲染进程](08-renderer.md) | 路由、组件树、hooks、stores、lib、i18n |
| 09 | [运行方式与质量门禁](09-run.md) | dev/build/test/发布命令与工程纪律 |
| 10 | [依赖关系总览](10-dependencies.md) | 包/服务/模块间的依赖图 |

## 快速上手读法

1. 先读 `01-architecture.md` 建立整体心智模型（进程模型 + 分层）。
2. 需要理解"一条消息如何变成 AI 回复" → 读 `04` 的 AgentService + agent-runtime，`05` 的工具系统。
3. 需要给前端加功能 → 读 `03`（新增 IPC）+ `08`（渲染层）；新功能流程见 `../design/32-feature-workflow-spec.md`。
4. 需要排查数据问题 → 读 `06`。
