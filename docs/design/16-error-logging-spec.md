# 16. 错误与日志规范

> 统一主进程（electron-log + traceId）、渲染层（ErrorBoundary + sonner）与观测（Sentry + OTel）的错误处理约定。
> 最后同步：2026-08-11

---

## 一、错误对象契约（主进程 → 渲染层）

### 1.1 AppError

- 主进程所有可预期失败返回 `AppError`（继承 Error）：`code`（ErrorCode 枚举）+ `statusCode` + `message`
- 错误码集中在 `packages/shared/src/constants/`（ErrorCode），跨进程共享
- IPC 失败走 `IpcResponse.error` 判别联合（`{ data } | { error }`），渲染层 `unwrap()` 解包（已有 `lib/ipc.ts`）

### 1.2 渲染层处理

| 场景 | 处理 |
|---|---|
| IPC 调用失败 | `unwrap` 捕获 → 按 `error.code` 查 i18n errors.json → toast.error 或行内提示 |
| 组件渲染异常 | 三级 ErrorBoundary：AppErrorBoundary（根）/ SectionErrorBoundary（域）/ AsyncBoundary（异步五态） |
| 异步数据 | AsyncBoundary 五态契约（loading/refreshing/error/empty/ready），error 态展示重试 |

## 二、日志规范（主进程）

### 2.1 electron-log 层级

| 级别 | 用途 |
|---|---|
| error | 未预期异常（带 stack + traceId） |
| warn | 可恢复异常/降级（fallback 路径） |
| info | 生命周期事件（启动/服务注册/会话开关） |
| debug | IPC 调用明细（traceId + channel + 耗时）——生产关闭 |

### 2.2 traceId 贯穿

- 每次 IPC invoke 生成 `crypto.randomUUID()` 作为 traceId（preload `ipc-bridge.ts` 自动附加，第三参数传主进程）
- 日志条目必须包含 traceId（结构化字段），支持按 traceId 串联一次调用的全链路日志
- 渲染层 console 禁用（Biome 规则），调试用 logger/日志文件

### 2.3 日志纪律

- 禁止记录：API Key/Token/密码（safeStorage 加密存储，日志只记 `***`）
- 禁止空 catch（必须按 unknown 缩小 + 记录）
- 网络错误指数退避最多 3 次（TypeScript 规范 §错误）

## 三、Sentry 与 OTel

- **Sentry**（@sentry/electron）：初始化必须在 `app.whenReady()` 之前（AGENTS.md 关键约束）；主进程 + 渲染层双端上报
- **OTel**（@opentelemetry/*）：telemetry/otel.ts 导出 span（可观测性），与 electron-log 互补（结构化指标 vs 文本日志）
- 浏览器模式（dev:web 无主进程）：Sentry IPC 过滤 allowlist（06-testing-design §5.3）

## 四、渲染层错误 UI 约定

1. **错误文案**：优先 i18n（errors.json 按 code）；无匹配显示原始 message；禁止裸 `error.toString()`
2. **空态**：`EmptyState` 组件（图标 + 标题 + 描述 + 可选操作），禁止空白屏
3. **加载失败重试**：AsyncBoundary error 态带重试按钮（重新 query/重新订阅）
4. **不可逆操作**：AlertDialog 确认（删除/清空类，已有 DialogHost confirm/prompt）

## 五、检查清单

- [ ] 可预期失败返回 AppError（code + statusCode），不抛裸 Error
- [ ] IPC 入参过 zod（13-form-validation L2）
- [ ] catch 按 unknown 缩小，含 traceId 日志，无空 catch
- [ ] 渲染层错误走 ErrorBoundary 体系 + i18n 文案
- [ ] 日志无敏感信息
