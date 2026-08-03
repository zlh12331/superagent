# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [Semantic Versioning](https://semver.org/lang/zh-CN/)。
版本变更记录由 changesets 自动生成（`pnpm changeset` → `pnpm version:packages`）。

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
