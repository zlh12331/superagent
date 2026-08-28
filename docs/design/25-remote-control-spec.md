# 25. 远程控制规范

> 基于项目实际远程控制体系（RemoteControlService + RemoteAgentBridge + 内置手机 Web 控制页 + 设置「移动端」面板）。
> 最后同步：2026-08-28

---

## 一、定位与分层

移动端与桌面端**同处局域网直连**，不依赖云端中继、不开公网、不需要账号体系（用户已拍板，勿重复讨论）。

```
手机浏览器 / 移动端 App
  ↓ UDP 公告（发现）· HTTP（命令与回传）
RemoteControlService   src/main/infra/remote/remote-control.ts     传输层：HTTP 端点 + UDP 发现 + 令牌校验 + 路由
RemoteAgentBridge      src/main/infra/remote/remote-agent-bridge.ts 执行层：无头 Agent 回合 + 会话映射 + 结果回传
remote-web-client.ts   src/main/infra/remote/remote-web-client.ts  内置手机控制页（常量 HTML/CSP）
network-info.ts        src/main/infra/remote/network-info.ts       局域网 IPv4 枚举 + 端点组装
        ↑ onCommand（唯一挂载点）                        ↓ IPC
AgentService / PermissionService / SessionService    remote.handler.ts → 设置「移动端」面板
```

- **传输层不碰执行**：只做校验与路由；执行由桥接层订阅 `onCommand` 挂载。
- **执行层不碰协议**：增量事件通过传输层注入的 `emit` 通道回推，SSE 与同步 JSON 共用一条执行路径。
- **执行路径与 IM 桥接同款**（`AgentService.startAgent` 无头 + approvalMode 门控 + transcript 落库），**不新开执行通道**。

## 二、生命周期与 IPC 契约

| 通道 | 语义 | 说明 |
|---|---|---|
| `remote:getStatus` | 状态快照 | 运行状态 + 令牌 + 局域网地址 + 执行活动 |
| `remote:start` | 开启 LAN 监听 | 生成新令牌，返回变更后快照 |
| `remote:stop` | 关闭监听（幂等） | 返回快照，`token`/`port`/`addresses` 一律置空 |

响应统一为 `RemoteStatusRes`（`packages/shared/src/schemas/remote.ts`，含 zod schema 做响应契约校验，规则见 `19-ipc-spec.md`）。启停**立即回读状态返回**，渲染层无需二次请求。

- **懒创建**：`ServiceContainer.getRemoteControlService()` 首次访问时创建服务并 `bridge.mount()`；`releaseRemoteControl()`（dispose 顺序 5.5）先 `unmount` 再 `stop`。
- **令牌只在运行期下发**：`snapshot()` 要求 `running && port !== null && token !== null` 才回传凭据；`stop()` 置 `sessionToken = null`，面板不残留可配对凭据，关闭服务即撤销全部局域网入口。
- **`stop()` 不清 `onCommand` 订阅**：订阅是桥接层的结构性挂载，与配对话轮无关——清掉会导致"关闭再开启"后命令被接收却无人执行。
- **每次 `start()` 重新生成令牌**：旧移动端凭据随对话轮结束自然失效（重连需重新配对）。
- 渲染层轮询：仅 `running === true` 时以 3s 间隔轮询活动计数（`use-remote-control.ts`），停止后不占用 IPC 往返；启停 mutation 用返回快照直接 `setQueryData`，避免"开关点完又显示旧状态"的竞态。

## 三、局域网发现与 HTTP 端点

**UDP 公告**（`node:dgram`，默认参数生产使用，测试注入单播与短间隔）：

- 目标 `255.255.255.255:45918`，间隔 3000ms，启动时立即先播一次
- 公告体 `{ service: 'code-agent-remote', version: 1, name, port, protocol: 'http' }`——**永不含令牌**
- 广播地址枚举保留虚拟网卡（VMware/Hyper-V/Docker 网段）：是否命中由用户按自己的网络环境判断，代码不做启发式猜测误删真实地址
- UDP bind / `setBroadcast` 失败**只降级不阻断**（HTTP 直连仍可用），日志 warn

**HTTP**（`node:http`，监听 `0.0.0.0`，端口默认 0 = 随机，经公告与配对界面告知）：

| 方法 · 路径 | 用途 | 失败语义 |
|---|---|---|
| `GET /` | 内置手机控制页 | 静态常量，带 CSP / `no-store` / `nosniff` / `no-referrer` |
| `GET /info` | 配对元数据（名称/端口/`requiresToken`） | 不含令牌 |
| `POST /command` | 命令入口 | 413 请求体超限 · 503 未运行 · 400 JSON 非法或字段校验失败 · 403 令牌不匹配 |

路径匹配忽略 query string（`req.url` 先 `split('?')`）；其余一律 404。`server.on('clientError')` 回 400 并结束 socket，不抛未捕获异常。

**命令体校验**（系统边界，逐字段）：请求体上限 64KB（超限即刻 413 + `req.destroy()`）；`sessionToken` 非空；`text` trim 后非空且 ≤ 8192 字符；`clientId` 1..128 字符。

## 四、SSE 流式回传协议

`POST /command` 带 `Accept: text/event-stream` 时走流式，**否则保持原同步 JSON 语义**（向后兼容，客户端按能力择一，无第二端点、不引入 `ws` 依赖）。

**协商顺序是关键**：读取体 → 结构校验 → 令牌校验全部通过后**才**分流。令牌不匹配时仍返回 403 JSON，不会先开启流再拒绝。

帧格式（`event: <name>\ndata: <单行 JSON>\n\n`）：

| 帧 | data | 时机 |
|---|---|---|
| `hello` | `{ protocol, clientId }` | 响应头写入后立即 |
| `delta` | `{ type, text }` | 每个 `TEXT_DELTA` |
| `tool` | `{ type, toolName }` | 每个 `TOOL_CALL` |
| `error` | `{ type, message }` | 每个 `ERROR` |
| `end` | `RemoteCommandResult { accepted, reply, reason }` | 回合结束收尾并 `res.end()` |

- **保活**：每 15s 写一帧注释 `: ping`——回合可静默数分钟（长思考/长工具），否则易被客户端与中间层判超时掐断。
- **不做多行 data 折行**：换行已在 JSON 字符串内转义，`data` 恒为单行。
- **写入守卫**：`closed || res.writableEnded` 时静默丢弃；`res.on('close')` 置位并清心跳定时器。
- **断连语义（刻意的）**：客户端断开**不中断回合**——无头执行与 transcript 落库在桥接层，与本次连接无关，重开页面在桌面端会话历史可看到完整结果。
- **增量事件面刻意收窄**：内部事件（step 计数、usage、reasoning）不外泄给局域网客户端，只暴露"正文在长 / 工具在跑 / 出错了"。

## 五、内置手机 Web 控制页

存在理由：远程控制的价值是"手边没有客户端也能立刻用"。扫码/点链接若落在 404 上，扫码就只是把令牌搬运了一遍。

- 打开即 `GET /info` 显示实例名与端口；未配对显示令牌输入框，已配对显示对话输入区
- 命令走 SSE 增量渲染（`delta` 追加正文、`tool` 挂工具 chip、`end` 收尾）；`streamed > 0` 时**不再重播 `end.reply`**，避免同一文本出现两遍
- **能力探测回退**：`window.ReadableStream` 不可用时不声明 SSE 能力，改发 `Accept: application/json` 取同步结果
- 所有模型输出与用户输入一律 `textContent` 注入，**不拼 innerHTML**

## 六、安全模型

下表只列远程控制特有的部分；密钥加密存储、CSP 通用要求等基线见 `17-security-spec.md`。

| 面 | 约定 |
|---|---|
| 凭据 | 会话令牌（每次 `start` 随机 UUID）是局域网内唯一凭据；面板显式展示 + 二维码分发，发现公告与 `/info` 均不携带 |
| 令牌传递 | 二维码/链接形如 `http://192.168.1.10:4173#<token>`——**fragment 不随请求发往服务端**，不进服务端日志与 Referer；页面读入后 `history.replaceState` 立即抹掉 URL，只存 `sessionStorage`（关页即散） |
| 页面源码 | 控制页是无参数的纯静态常量，本身不含任何令牌，拿到页面源码也连不上 |
| CSP | `default-src 'none'` 起白名单；`script-src` / `style-src` 用内联内容的 `sha256-` 哈希授权（**无 `unsafe-inline`、无外部源**）；`connect-src 'self'`、`base-uri 'none'`、`form-action 'none'`、`frame-ancestors 'none'`。`frame-ancestors`/`sandbox` 类指令在 `<meta>` 中无效，必须走响应头——故 CSP 与 HTML 由同一处（`GET /`）下发 |
| 审批门控 | 仅 `approvalMode` 为 `auto` / `yolo` 时执行；`ask`/`plan` 无审批通道，回传可读提示而不是静默失败 |
| 工作目录 | 应用 `userData/remote-workspace` 专用沙箱，**不用用户主目录**——避免第三方诱导读取 `~/.ssh`、`~/.aws` 等敏感文件并回传 |
| 滥用面 | 命令体 64KB、文本 8192 字符、回传 20000 字符三重上限；同 clientId 串行，不放大并发 |
| 暴露前提 | HTTP 明文 + `0.0.0.0`：等价于"同局域网内任何持令牌主机可驱动桌面端"，因此默认关闭、由用户显式开启，且只在可信网络启用；关闭服务即撤销全部入口 |

## 七、Agent 桥接执行语义

1. **会话映射**：`clientId → sessionId` 内存 Map，首条命令 `sessionService.create({ workingDir: 沙箱, title: 'Remote:<clientId>' })`。**`sessionId` 必须取 `create` 返回值**——`create` 内部自行生成 id，传入自定义 id 不会被采用（沿用调用方 id 会导致后续落库 `SESSION_NOT_FOUND`）。
2. **多轮上下文**：每回合从 DB 回读该会话历史再追加本条命令（IM 桥接只发单条消息，此处按远程控制"连续对话"定位补齐）。回读失败**降级为空历史**（单轮执行），不因此拒绝命令。
3. **串行控制**：`busyClients` 集合，执行中收到同 clientId 的新命令回传排队提示。
4. **建会话失败**：本回合降级为一次性执行（用 `randomUUID()`，不缓存），下条命令重试建会话。
5. **事件过滤**：`agentService.onTurnEvent` 是**类级全局监听**，必须按 `sessionId` 过滤，否则桌面端并发会话的文本/工具事件会串入本次回传。
6. **兜底超时**：10 分钟（HTTP 长请求不宜像 IM 那样挂 30 分钟），定时器 `unref`，超时以 `reason = 'timeout'` 收尾。`MAX_STEPS = 20`（与 IM 桥接一致）。
7. **落库**：`persistTurnMessages` 为 fire-and-forget——user + assistant 写入会话；assistant 文本为空（纯工具回合）时只落 user；失败静默不影响回传。
8. **回传组装**：正文 + 工具/错误摘要 + 非 `completed` 状态标注（`✅ 完成 / ⏹ 已中断 / 🔁 达步数上限 / ❌ 异常结束 / ⏱ 执行超时`），无文本输出时回传占位说明而不是空串，超 20000 字符截断加标记。
9. **始终 `accepted: true`**：命令到达即视为已接管，拒绝原因写在 `reply` 里——移动端拿到的是可读助手回复，而不是无解释的 `accepted: false`。执行异常回传 `❌ 执行异常，请查看桌面端日志。`，不把异常抛给传输层。

## 八、配对二维码（桌面端）

设置 →「移动端」运行中展示 `端点#令牌` 二维码（`qrcode` 的 `toDataURL`，`margin: 2`、`errorCorrectionLevel: 'M'`）：

- 编码 `addresses[0]`（首个局域网端点）+ `#` + 令牌；**无局域网端点时不生成**（无地址可编码），降级为手动输入
- 生成失败静默降级：令牌文本仍在，可手抄配对
- 黑白配色不写死 CSS 背景：二维码本身带白色静默区，深色主题下仍可扫（反色二维码识别率低）

## 九、已知边界（有意不做 / 阶段 4 议题）

1. **不做断线续传**：断连后回合继续执行并落库，但移动端不会补收丢失帧；重开页面从新命令继续。
2. **不做多会话列表 / 历史回看**：桌面端才是会话主端，本页定位是"远程指挥"。
3. **不做跨设备会话共享**：`clientId → sessionId` 是内存映射，应用重启后由新命令重建。
4. **不引入 `ws`**：SSE 已覆盖"服务端持续推送"这一唯一需求；双向流留待阶段 4（若需要中途取消/权限交互再评估）。
5. **无 HTTPS / 无证书固定**：明文局域网，令牌是唯一防线。跨信任网络场景需要 TLS 或反向代理，属阶段 4。
6. **移动端无法中断执行中的回合**：桌面端才有中断入口。

## 十、测试策略

| 层 | 做法 |
|---|---|
| 传输层 | 真实 HTTP server + `fetch`（不 mock 网络）：端点路由、状态码、SSE 帧序（`hello/delta/tool/error/end`）、403 早于开流、64KB 超限、UDP 公告（注入单播 + 短间隔） |
| 桥接层 | 依赖全 stub 注入（无网络、无 DB、无真实 agent）：模式门控、串行、多轮回读、sessionId 过滤不串台、截断、落库/回读失败降级；回合完成由测试手动发射 `TurnEvent` 驱动 |
| 控制页 | **锁 CSP 与内联字节一致性**：`cspSource('script-src') === sha256(inlineBlock('script'))`。HTML 由常量拼接，任一侧改动都会使页面被 CSP 拦死，且只在真机上暴露——必须用断言兜住 |
| 面板 | `qrcode` 只 stub 到 data URL 生成边界（锁"编码了什么"，点阵正确性由库自身保证）；无端点不生成、生成失败静默降级 |
| 端到端 | 浏览器实测（`pnpm dev:web` + mock）验证二维码真实渲染（148×148 PNG）；手机控制页 + SSE 对话需在真实 Electron + 局域网两台设备验证，单测无法覆盖 |

相关门禁：`pnpm test:main`（`infra/remote`）、`pnpm test:renderer`、`pnpm check:static`。
