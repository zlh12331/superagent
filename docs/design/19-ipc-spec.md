# 19. IPC 集成规范（前后端契约开发流程）

> 04-interface-design 是接口清单（是什么），本文是**开发规范**（怎么加/怎么用/怎么传错）。
> 基于项目自研 IPC 自动化体系（meta → definitions → derive → preload 生成 → register 统一注册）。
> 最后同步：2026-08-11

---

## 一、Channel 命名（强制）

| 模式 | 用途 | 示例 |
|---|---|---|
| `{domain}:{action}` | 请求-响应 | `session:list`、`git:diff` |
| `{domain}:stream:{event}` | 流式事件 | `agent:stream:part` |
| `{domain}:event:{name}` | 状态推送 | `terminal:event:output`、`update:event:status` |

- domain 与 meta.ts 域表一致（25 域），新域需评估是否并入现有域
- action 用动词（get/list/create/delete/rename/start/stop/send）

## 二、新增 IPC 方法（三步流程，编译期强制）

1. **meta.ts**：`{ domain: { method: request('domain:method') } }`——纯字符串，零依赖
2. **definitions.ts**：`method: withSchema(IPC_META.domain.method, zSchema, type Res)`——zod schema 声明（L2 校验自动生效）
3. **handler**：主进程 `src/main/ipc/{domain}.handler.ts` 实现——**handler 缺失编译期报错**（类型推导 InferHandlers 强制）

> 其余（preload API/类型/注册）全部自动生成。新增方法=改 2 行 + 写 1 个 handler。

## 三、请求-响应契约

- 返回 `Promise<IpcResponse<T>>`（`{ data } | { error }` 判别联合）——成功/失败显式
- **错误传播**：handler 抛 AppError（code + statusCode）→ IpcResponse.error → 渲染层 `unwrap()` 按 code 查 i18n errors.json（16-error-logging）
- **禁止**：返回裸值（未包 IpcResponse）、错误返回 data（应走 error 分支）、handler 内吞错返回空 data

## 四、事件设计（流式/推送）

1. **subscribe 回调模式**：preload 返回 unsubscribe；渲染层 L4 直接写 transient store（四层架构）
2. **payload 定型**：事件 payload 用 zod schema 声明（withPayload）——发送侧 dev 校验
3. **频率纪律**：高频推送（terminal:output）必须节流/批量（性能规范 §2.2），禁止每字节一条事件
4. **生命周期**：事件与订阅者生命周期绑定（页面卸载 unsubscribe，防泄漏）

## 五、安全与约束（联动 17-security）

- preload 零依赖（CJS + 纯字符串 meta，禁 zod 进 preload）
- 渲染层只能触达白名单 API（contextBridge）
- 敏感方法（settings:setApiKey 等）主进程侧校验来源（senderFrame 校验）

## 六、检查清单

- [ ] 命名合规（三模式之一）
- [ ] meta + definitions + handler 三处齐全（编译期强制）
- [ ] zod schema 声明（L2 自动校验）
- [ ] 错误走 AppError + IpcResponse.error
- [ ] 事件含 schema + 订阅清理
