# 23. 可观测性规范（OTel span 与指标）

> 补充 16-error-logging（错误/日志主线）的指标与追踪维度；基于 telemetry/otel.ts 实际实现（NodeTracerProvider + OTLP + Console 回退）。
> 最后同步：2026-08-11

---

## 一、追踪（Trace）

### 1.1 Span 命名约定（强制）

```
格式：<domain>.<operation>
示例：
  ipc.invoke            # IPC 请求-响应（channel 属性区分）
  agent.run             # Agent 回合
  agent.turn            # 单次回合
  tool.execute          # 工具执行（tool.name 属性）
  llm.complete          # LLM 调用
  terminal.spawn        # 终端创建
  git.status            # Git 操作
  db.query              # 数据库查询
```

- 首字母小写 + 点分隔（OpenTelemetry 惯例）；禁空格/斜杠
- 与 electron-log 的 **traceId 关联**：日志含 traceId，span 属性 `trace_id` 同步——支持日志 ↔ 追踪互查

### 1.2 Span 属性（Attributes）

| 场景 | 必需属性 | 禁止 |
|---|---|---|
| IPC | `channel`、`domain` | 入参 payload（可能含敏感数据） |
| LLM | `model_id`、`provider`、`input_tokens`、`output_tokens` | prompt 全文 |
| Tool | `tool.name`、`permission.mode` | 命令全文（run-command 的 command 摘要可记前 N 字符） |
| 通用 | `host.platform`（已实现） | API Key/Token/密码 |

### 1.3 采样与导出

- 生产导出：OTLPTraceExporter（Sentry/自托管 OTLP 端点）
- 回退：未配置端点时 ConsoleSpanExporter（dev 可见）
- 采样率按需配置；高频 span（terminal:output 类事件不建 span——事件流不进追踪，防噪声）

## 二、指标（Metrics，当前未启用——触发条件）

- 预留给业务指标（token 用量/工具调用次数/错误率）
- **触发条件**：出现容量/成本分析需求时启用 OTel Metrics（当前 token 用量走 IPC usage 统计，未重复埋点）

## 三、与日志/Sentry 的分工

| 维度 | 工具 | 职责 |
|---|---|---|
| 文本日志 | electron-log + traceId | 逐条事件/错误详情 |
| 追踪 | OTel span | 跨服务调用链（IPC/LLM/Tool） |
| 错误聚合 | Sentry | 未预期异常上报（堆栈/符号化） |

## 四、检查清单

- [ ] 新 span：命名 `<domain>.<operation>` + 必需属性 + 无敏感数据
- [ ] 高频事件不进 span（终端输出/流式 part）
- [ ] span trace_id 与日志 traceId 关联
- [ ] 指标触发条件未到前不重复埋点
