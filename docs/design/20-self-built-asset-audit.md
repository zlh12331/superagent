# 20. 自研资产与业界方案对照（替换评估）

> 评估方法：先调研业界成熟方案 → 评估适配性 → 无合适才自研（2026-08-11 全量盘点）。
> 结论：自研资产无必须替换项；核心资产业界方案不匹配，轻量资产已用业界标准或业界无等价。

---

## 一、核心资产（不换——替换=推翻架构）

| 自研资产 | 业界方案 | 结论与理由 |
|---|---|---|
| IPC 自动化体系（meta/definitions/derive/生成器） | tRPC / electron-trpc | ❌ ①沙箱硬伤：preload 必须零依赖（CJS 纯字符串），tRPC client 依赖链进 sandbox preload 存疑（zod 进 preload 静默失败教训）；②流式不匹配：{domain}:stream:{event} 为 AI SDK 高频流式设计，electron-trpc 主攻 query/mutation；③已投产 25 域 105 channel + 编译期强制 + traceId，替换=重写全链路 |
| Service Container（15 服务 + 反向 dispose） | tsyringe / inversify | ❌ 显式工厂 vs DI 反射：核心价值是 dispose 反向依赖编排（DI 库不管），轻量胶水平替无收益 |
| 错误体系（AppError + IpcResponse 判别联合） | neverthrow（Result） | ❌ 功能等价（判别联合即 Result 的 TS 形态），已贯通 i18n errors.json |
| mock-api（IPC 全链路 mock） | MSW | ❌ 不匹配：MSW 拦截 HTTP，本项目 mock 的是 window.api（IPC） |

## 二、Aurora 令牌（唯一可讨论项——暂不换，触发条件引入）

| 维度 | Style Dictionary（W3C Design Tokens 标准）收益 | 当前成本/障碍 |
|---|---|---|
| 类型安全 | tokens.json → 生成 TS 类型（编译期校验） | 213 令牌迁移 + 生成 pipeline |
| 双主题 | light/dark 主题配置化 | globals.css 改生成产物 + check-tokens 适配 |
| 设计协作 | Figma/Tokens Studio 同步 | 当前无设计师协作场景（单开发者） |
| 多平台 | —（本项目仅 CSS 单平台，SD 核心卖点浪费） | — |

**触发条件**（不预置）：①出现设计师/Figma 协作需求；②令牌需跨端复用。当前 DESIGN.md 契约 + check-tokens 门禁已覆盖单一真源与一致性。

## 三、轻量资产（已闭环）

| 自研资产 | 业界对照 | 结论 |
|---|---|---|
| 审计脚本 ×6 | gitleaks ✅ 已替换（100+ 规则）/ TypeDoc ✅ 已接入（AST 级）/ 其余无 CLI 等价（tokens/注释/行数/参数） | ✅ 已闭环 |
| 脚手架 ×2 | plop（代码生成器） | ❌ 逻辑=写 2 行+1 handler，plop 收益为负 |
| TS6 隔离子包 | typedoc/depcruise 本身是业界工具（自研的是隔离方案） | ✅ 已用业界 |
| ui/ 组件库 14 个 | shadcn copy-paste 体系 | ✅ 已对齐 |
| 规范文档 19+ | 无业界等价（项目特定） | ✅ |

## 四、决策原则（固化）

1. 核心域已用成熟库（AI SDK/Electron/React/Radix 等 76 依赖），自研只留差异化资产
2. 替换三关：依赖清单 / 设计体系兼容 / Runtime 绑定（antd agentic-ui 教训）
3. 触发条件不预置：Style Dictionary（设计师协作）、i18next-cli 方案 2（keyPrefix 用法）、State Reducer（复杂交互）
4. 评估结论必须落档（本文件即留痕）
