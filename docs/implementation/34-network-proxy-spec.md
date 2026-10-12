# 34 · 网络代理（需求 → 设计 → 实施状态）

- **状态**：**已实施**（2026-09-29；6834d4a5 → a5aecaf9 → 4c50994e → a1095521 →
  本提交；CP2 双路深读 4 fail 全部修复，分歧处置表见 §3.1；V1-V10 核对见 §3.2）
- **判级**：四问全 yes（新增持久化结构 settings.proxy 键 + 跨进程副作用全覆盖 +
  多组件联动 + 新设置分区交互）→ 全量流程
- **形态轴**：全链路 + 主进程子系统（比 33 号多「平台网络栈」维度）——CP2 后回审
  32 号时按此记形态
- **用户拍板记录**：D1 = 合一个 spec 两工作包（不拆独立收敛重构）；D2 = 路线 B
  接缝级收敛（不做统一网关、不替换飞书 axios）；D3 = v1 范围外三出口
  （钉钉 WS 长连接 / OTLP 遥测 / 飞书 axios 代码内接缝——侧门 env 兜底）

## 0. 需求期实测基线（本 spec 的事实底座，全部代码/探针实证）

网络出口全量清点（2026-09-29，逐文件核实 + Electron 运行时探针）：

| 出口 | 网络栈 | 位置 | 现有注入缝 |
|---|---|---|---|
| AI 供应商 ×10 | Node fetch（undici 7.29） | `providers/registry.ts` BUILTIN_FACTORIES 十工厂集中 | `fetch?: FetchFunction`（AI SDK v7 实测） |
| IM/Telegram | Node 全局 fetch | `im/adapters/telegram-adapter.ts` | `fetchFn` 缝（实测） |
| IM/钉钉 HTTP | Node fetch + **全局 WebSocket** | `im/adapters/dingtalk-stream.ts` | `fetchFn`/`wsCtor` 缝（实测） |
| IM/QQ | Node fetch（Gateway+API） | `im/adapters/qq-adapter.ts` + `qq-stream.ts` | `fetchFn`/`fetchTokenFn` 缝（实测） |
| IM/企微+飞书 webhook | Node fetch | `im/adapters/webhook-channel.ts` postWebhook | **无缝**（模块级函数直调全局 fetch） |
| IM/微信长轮询 | Node fetch | `im/adapters/weixin-stream.ts` | `fetchUpdatesFn` 缝（实测） |
| IM/飞书长连接 | **axios**（@larksuiteoapi/node-sdk 自建实例） | `im/adapters/feishu-stream.ts` | 无；axios 原生读 `http_proxy/https_proxy` env |
| MCP 远程 | SDK transport（sse/streamableHttp） | `ai/mcp/mcp-client.ts:67-69` | `fetch?: FetchLike`（SDK 实测）+ requestInit |
| 自动更新 | **Chromium，独立分区 `electron-updater`**（ElectronHttpExecutor 实测） | `infra/update/update-service.ts` | session.fromPartition 分区 → setProxy 可覆盖 |
| 浏览器预览 | Chromium，`browser-preview` 内存分区 | `infra/browser/preview-service.ts:81` | setProxy 可覆盖 |
| 记忆引擎 healthcheck | fetch → **localhost** | `memory-hub-service.ts:437` | 无缝；**本地回环必须绕过代理** |
| OTLP 遥测 | node http/https（非全局 fetch） | `telemetry/otel.ts:110` | 无缝；默认关闭不外发 |
| 渲染层 | 零直连（全部经 window.api） | — | 无需处理 |

**探针关键事实**（`.tmp` 实测，2026-09-29）：Electron 44 内嵌 **Node 24.20 / undici
7.29.0**；全局 fetch **不认 `dispatcher` 选项**（传入自定义 dispatcher 被静默忽略）——
Node 栈代理必须用 **npm undici 的 `fetch` + `ProxyAgent` 闭环**，不能用全局 fetch
加选项，也不能用 `NODE_USE_ENV_PROXY`（需显式 opt-in 且行为在 Electron 内未验证）。
AI SDK `fetch?: FetchFunction` 与 MCP SDK `fetch?: FetchLike` 的注入签名均已实测存在。

## 1 需求

### 1.1 问题与动机

- **谁**：中国大陆用户（主力）+ 企业内网用户（次要）。
- **场景与可观察的问题**：① 直连 api.openai.com / api.anthropic.com / api.telegram.org
  被墙或被企业防火墙拦——配置了 Key 也无法对话/收发消息，无任何绕行手段（用户系统
  代理对 Electron 主进程 Node 栈**完全不生效**，这是 Electron 应用的通病）；② 自动更新
  走 GitHub Releases 同样被拦；③ 浏览器预览访问外站被拦。
- **不做的代价**：目标用户群（国内开发者）的核心价值链（对话 + Telegram IM + 更新）
  在关键市场不可用；用户只能用「改 hosts / 全局 TUN 模式 VPN」等系统级手段，门槛高
  且不可按应用粒度控制。

### 1.2 语义边界

**影响清单**：`app_settings` 新键 `proxy`（值结构见 §2.2）；主进程三条应用路径
（Chromium 三分区 setProxy / Node proxiedFetch 注入 / env 侧门）；设置页新「网络代理」
分区；`SETTING_KEYS` 登记。

**不碰清单**：钉钉 WS 长连接（D3）；OTLP 遥测（D3）；keychain 凭据、会话数据、
MCP stdio 子进程（本地管道无网络）；remote-control 本地 HTTP 服务器（入站监听，
与出站代理正交）；系统代理自动探测（PAC/auto_detect，见 1.6 D6）。
**无缝出口的显式改造点**（CP2 第二路补位）：`webhook-channel.ts` 的 postWebhook
（模块级直调全局 fetch，企微/飞书 webhook 共用）——WP1 内改为经 proxiedFetch。

### 1.3 验收标准（V1…Vn；收尾逐条核对）

- **V1** 默认（mode=system，无设置）行为不变：全出口与现状一致（不出错不绕行）。
- **V2** mode=fixed + 填 `http://127.0.0.1:7890` → AI 供应商请求经代理发出（探针级
  测试：dispatcher 路由断言）。
- **V3** mode=direct → 全出口强制直连（系统代理也不走）。
- **V4** bypass 列表含 localhost → localhost 的记忆引擎 healthcheck 不经代理。
- **V5** 设置修改后**无需重启**：下一次 AI 请求即按新配置（工厂重建链）。
- **V6** 重启后设置保持（SQLite 真源 + 启动应用）。
- **V7** 恢复默认设置（resetAll）后回落 mode=system。
- **V8** 导入含 proxy 键的设置文件 → 广播后主进程生效（与 33 号 V8 同链路语义）。
- **V9** 代理地址非法（非 URL / 非 http(s) 协议）→ 设置写入被拒 + UI 报错，不产生
  半生效状态。
- **V10** UI：模式三选一（system/direct/fixed），fixed 显示地址输入 + bypass 编辑；
  「测试连接」按钮给出发达/失败即时反馈。

### 1.4 影响面盘点

- 进程：main（三应用点 + resolver）+ renderer（store/UI）；shared（键白名单 + 值
  schema）；preload 零改动（复用 settings:set/getAll 链）。
- 存储：`app_settings` 新键；无表结构演进。
- 契约：`SETTING_KEYS` 扩一项 + settings:set superRefine 值级门禁（非空 mode 时校验
  fixed 地址，同 lsp 命令门禁先例）。
- 依赖：undici 由传递依赖**转正为直接依赖**（`pnpm add undici`，版本锁 7.x 与
  运行时内嵌 7.29 同 minor 对齐）。

### 1.5 反例点名（设计节逐条处置，禁静默丢弃）

1. **缓存的工厂/模型实例持旧配置**：AI provider 工厂按 kind 缓存（ai-provider.ts
   providerCache），设置变更后缓存实例仍走旧 fetch → 改配置不生效。
2. **localhost 经代理被墙在代理上**：不配 bypass 时本地服务（记忆引擎 healthcheck、
   ollama 本地模型）的请求会被发去代理 → 全挂。
3. **升级下载中断**：更新器 setProxy 后在途下载失败——下载有续传（update-cache），
   但切换代理时正在下载会出错。
4. **env 侧门的全局副作用**：写 `http_proxy` env 影响所有读 env 的组件（含未来
   新增依赖），且 env 只在启动时读的库（axios 实例创建于 import 期）改晚了不生效。
5. **无桥（浏览器模式）**：mock 透传 proxy 键，主进程不存在——UI 可用行为无感。
6. **代理自身不可达**：配置了挂掉的代理 → AI 请求报 ECONNREFUSED（代理端口），
   错误信息必须能归因到代理（而非供应商），否则用户排查无门。
7. **多窗口/多 session 一致性**：defaultSession 与两个专用分区的 setProxy 时机不同步
   → 短暂不一致窗口（可接受，需注明）。

### 1.6 不做清单 + 待拍板项表

- 不做（D3 定案）：钉钉 WS 长连接代理（Node WS 无 CONNECT 隧道能力；国内服务无
  代理需求）；OTLP 遥测代理（默认关闭 + 内网场景）；飞书 axios 代码内接缝（仅 env
  侧门）；统一 HTTP 网关（D2）；PAC 脚本模式（价值低复杂度高）；SOCKS 代理
  （undici ProxyAgent 支持 http(s) 代理 CONNECT；SOCKS 需 socks-proxy-agent 另一
  依赖，用户面窄，v2 视需求）。
- 待拍板项表（CP1 已按建议拍板的 D1-D3 + 遗留 D4-D7）：

| # | 争议选择 | 建议 | 理由 |
|---|---|---|---|
| D4 | 模式枚举：system/direct/fixed 三选 vs 只做 fixed | 三选 | system=默认不改变现状（V1）；direct 是「系统有全局 VPN 但想绕开」的真实需求；fixed 是核心场景 |
| D5 | 代理认证：v1 是否支持 user:pass@host | 支持 URL 内嵌凭据 | URL 规范自带（http://user:pass@host:port），undici ProxyAgent 与 Chromium proxyRules 均原生支持，零额外代码；不做独立用户名/密码字段（明文入库，URL 内嵌同样明文但少一套 UI）——凭据不入 keychain 的理由：代理凭据敏感度远低于 API Key，且 keychain 读取是异步会拖累 setProxy 同步语义 |
| D6 | Chromium 栈 v1 是否也接 system 模式探测 | 直接透传 mode | mode=system → setProxy({mode:'system'})（Electron 默认行为，零代码）；mode=direct → setProxy({mode:'direct'})；fixed → proxyRules。三模式在 Chromium API 上是一等公民，无探测需求 |
| D7 | 测试连接按钮的实现深度 | 真·TCP 探测 | 主进程经代理 fetch 一个轻量端点（如 https://api.deepseek.com 的 405 响应也算「通」），3s 超时；不做供应商级连通性矩阵（每家测太重） |

## 2 设计

### 2.1 业务逻辑

- **纯函数核心**（`src/main/infra/network/proxy-resolver.ts`，新模块）：
  - `parseProxyConfig(raw: unknown): ProxyConfig` —— DB 值不可信：zod 校验 + 归一化，
    损坏/缺失 → mode='system' 缺省（fail-open 向既有行为，同 33 号 D2 语义）；
  - `buildChromiumProxyConfig(cfg): Electron.ProxyConfig` —— 三模式映射
    （system→{mode:'system'} / direct→{mode:'direct'} / fixed→{mode:'fixed_servers',
    proxyRules, proxyBypassRules}）；
  - `buildProxyUrl(cfg): string | undefined` —— fixed 时输出 `http://[user:pass@]host:port`
    供 undici ProxyAgent / env 侧门共用；
  - `shouldBypass(cfg, url): boolean` —— localhost/127.0.0.1/::1 恒绕过（硬规则）+
    用户 bypass 列表匹配（后缀/通配符简化匹配，子集于 Chromium bypass 语义）。
- **失败路径**：resolver 解析失败 fail-open 回 system（log warn 一次）；setProxy 调用
  失败（分区未创建等）log warn 不抛——代理是增强能力，不能让它阻断启动链。
- **反例 7 处置**（多 session 时机窗口，CP2 第一路 fail 修复——落位设计节）：
  不处理时序窗口本身，理由与注记义务如下——三分区/Node 栈各有独立生效时机
  （settings:set 收口顺序：先 Chromium 后 Node），窗口内短秒级不一致；影响限于
  「部分出口走新代理、部分走旧配置」的过渡态，无数据损坏；注记义务 = 本节即为
  注记 + applyProxyChange 内部按固定顺序执行（default → updater 分区 → preview
  分区 → env → resetAIProvider）使窗口确定化；不为此引入跨 session 事务（无该
  原语，造轮子违反 D2）。
- **D5 依据修正**（CP2 双路一致存疑项）：undici ProxyAgent 对 URL 内嵌凭据原生支持
  **成立**（Node 栈：AI/IM/MCP 探测）；Chromium proxyRules **不支持** URL 内嵌凭据
  （鉴权走 app 'login' 事件）——v1 补一个 `app.on('login')` 处理器：从 resolver
  当前配置提取凭据响应鉴权挑战（同步读取，零 keychain 异步依赖）；处理器幂等注册。
  若实施期实测 proxyRules 竟然支持凭据（低概率），login 处理器保留为兜底不删。
- **复用清单**：readSetting/readCloseAction 读取范式（33 号同款）；settings:set
  superRefine 值门禁（lsp 先例）；applyMainChange 对象域合并（P2-6 防线）。
- **安全边界**：代理 URL 可能内嵌凭据——**不落日志**（resolver 输出 log 时脱敏
  `http://***@host:port`）；值 schema 白名单校验拒绝 file:/ftp: 等协议。

### 2.2 数据管理

- 真源：`app_settings` 键 `proxy`，值结构：
  `{ mode: 'system'|'direct'|'fixed', url?: string, bypass?: string[] }`
  （url 仅 mode=fixed 时有效；bypass 是主机后缀数组如 `['internal.company.com']`）。
- 缺失语义：键缺失/损坏/字段缺省 → mode='system' 全栈兜底（三应用点各自兜底 +
  resolver 单点归一，两处都有测试）。
- 写入：渲染层写穿透（persistSetting 既有链）；主进程**无直写通道**（无托盘项），
  导入路径经广播（同 33 号）。
- **反例 1 处置**（缓存持旧）：settings:set handler 收口——`key === 'proxy'` 时调
  `applyProxyChange(value)`（network 模块新导出）：重设三分区 setProxy + 调
  `resetAIProvider()`（既有导出，清 providerCache 与 per-model 缓存）+ 更新 env 侧门。
  下一次 getModel 即按新 fetch 重建工厂（V5 机制；三层缓存证据链经 CP2 第一路
  专项核实：providerCache → llmClient.reset → modelCache → createFactory 重建，
  无死角）。
- **主进程写路径收口三处全接**（CP2 双路一致 fail 修复项——广播只达渲染层，代理是
  推送式急切副作用，与 33 号拉取式消费有本质区别）：① `settings:set`（上述）；
  ② `settings:import` handler——applied 含 proxy 键时对导入值调 `applyProxyChange`
  （镜像 theme→syncTitleBarOverlay 先例）；③ `settings:resetAll` handler——删键后调
  `applyProxyChange(undefined)` 回落 system（否则分区代理/env/缓存残留，V7 不成立）；
  ④ 启动 whenReady 早期一次（V6）。四条路径统一走 applyProxyChange 单点。
- **反例 2 处置**（localhost 被代理）：resolver 硬编码 localhost 恒绕过——Chromium
  侧 proxyBypassRules 强制含 `<local>`；Node 侧 proxiedFetch 内部先过
  shouldBypass 再决定 dispatcher。
- **反例 3 处置**（下载中断）：setProxy 切换前查 updateStatus，in-flight 下载时
  延迟到下次启动生效（log info 说明）——不主动取消用户下载。
- **反例 4 处置**（env 副作用）：env 写入点收敛在 `applyProxyChange` 单处；只写
  `HTTPS_PROXY/HTTP_PROXY/NO_PROXY`（大写为主、小写同步写，axios 两读都有）；
  **仅在 mode=fixed 时写、其它模式清空**；文档头注明全局副作用；启动时在
  app.whenReady 早期（飞书 adapter import 之前）应用一次——启动链顺序在实施期
  实测验证（axios 实例创建时机）。
- 导出/导入/resetAll：**白名单自动覆盖存储层，但主进程应用不自动**（CP2 修正：
  推送式应用点必须显式收口，见反例 1 处置节四路径）——V6/V7/V8 靠四路径收口 +
  resolver fail-open 兜底，非「零代码」。

### 2.3 契约/IPC

- settings 域：`SETTING_KEYS` 加 `'proxy'`；`SettingsSetReqSchema` superRefine
  加 proxy 值级门禁：mode=fixed 时 url 必须是合法 http(s) URL（V9；lsp 门禁先例），
  其它模式忽略 url；bypass 项必须是合法主机名形态。
- **新增一个 IPC 方法 `proxy:test`**（CP2 第二路 fail 修复项——D7 的主进程探测
  渲染层够不着，「零新增 IPC」与 D7 矛盾，二选一取加方法）：定义表三步
  （meta + definitions + handler）；请求 `{ timeoutMs?: number }`；响应
  `{ ok: boolean, kind: 'proxy-unreachable'|'target-unreachable'|'ok', message?: string }`
  （响应 schema 必写，R3）。handler 内部：读 resolver 当前配置 → mode 非 fixed 时
  直接返回 ok=false + 提示「当前非自定义代理模式」→ 经 proxiedFetch 探测轻量端点。
- mock-api：kv 透传零改动；`proxy:test` mock 返回 ok（浏览器模式行为无感）。
- **反例 5 处置**（无桥）：mock 透传，浏览器模式 UI 可用，行为无感，不特判。

### 2.4 状态管理

- L2 Zustand persistent：settings-store `proxy` 域（`updateProxy` 部分合并 + 写穿透，
  33 号 notification 域同构）；快照缺键回落 `{mode:'system'}`。
- 测试连接按钮的 pending/result 是组件级瞬态 → L1 useState（不进 store）。
- file-size 棘轮预判：settings-store 净行 372+30 预估余量足；新逻辑全部落新模块
  proxy-resolver.ts（净行预估 150-200），零棘轮触碰。

### 2.5 UX 设计

- 入口：设置页「通用」分组下新独立分区项「网络代理」（不塞进 general-section——
  该 pane 已聚合 6 个子区，且代理含「测试连接」交互值得独立 pane）；导航项图标
  `Network`，id `proxy`（ui-store SettingsSectionId 联动 + NAV_GROUPS 注册）。
- 布局（自上而下）：模式 SegControl（跟随系统 / 直连 / 自定义代理）→ fixed 时展开
  地址输入（placeholder `http://127.0.0.1:7890`）+ 绕过列表（逗号分隔或标签输入，
  v1 用 textarea 简单形态）→ 测试连接按钮 + 结果反馈行。
- 反馈闭环：保存即时生效（写穿透 + 主进程收口，无「应用」按钮）；测试连接
  pending/成功/失败三态行内展示；非法地址写穿透失败经既有 reportError + toast。
- i18n 七键双语：settings.nav.proxy / proxyTitle / proxyModeLabel /
  proxyModeSystem / proxyModeDirect / proxyModeFixed / proxyUrlLabel /
  proxyUrlPlaceholder / proxyBypassLabel / proxyBypassDesc / proxyTestButton /
  proxyTestSuccess / proxyTestFailed 等（成文时定稿清单，双语同批）。
- **反例 6 处置**（代理不可达归因）：测试连接失败文案区分「代理不可达」（连代理
  失败）与「经代理仍不可达」（代理通但目标不通）；AI 请求错误信息经 unwrapErrorMessage
  透出原始 ECONNREFUSED 端口（不吞不转译）。**CP2 补位**：ModelFallback 会把
  ECONNREFUSED 当可降级错误先降级重试（llm-client isFallbackEligibleError），原始
  错误可能被降级链掩蔽——注记：降级链所有尝试均失败后的最终错误仍是网络层错误，
  unwrapErrorMessage 透出的是该最终错误，归因语义成立；测试连接按钮是用户主动
  归因的主路径，不受降级链影响。
- 空态/加载态：无异步数据（store 直读），无四态需求。

### 2.6 UI 设计

- 组件：`sections/proxy-section.tsx` 独立 pane（telemetry-section 拆分先例）；
  SegControl（模式三选）+ ui/input（地址）+ ui/textarea（bypass）+ ui/button（测试），
  全现成控件零新 CSS；图标 `Network`（lucide）size-3.5 惯例。
- SettingsDialog：NAV_GROUPS general 组加 `{ id: 'proxy', ... }` + ui-store
  SettingsSectionId 联合类型加 `'proxy'`（两处同步，ui-store 头注释明言的义务）。
- 动效：无新增（fixed 展开用条件渲染，不引入新 keyframes）。

### 2.7 测试与安全

- **resolver 单测**（新 `proxy-resolver.test.ts`，红灯先行）：三模式归一化 / 缺失
  损坏回 system / localhost 恒绕过 / bypass 匹配 / URL 脱敏（log 断言不含凭据）/
  非法协议拒绝。
- **应用点测试**：
  - Chromium 侧：buildChromiumProxyConfig 三模式映射纯函数断言（setProxy 调用参数
    断言，mock session.fromPartition）；
  - Node 侧：proxiedFetch —— localhost 绕过（直连 dispatcher）+ fixed 时
    ProxyAgent(dispatcher) 被传入（探针已证 npm undici fetch 可行，测试用 spy
    dispatcher 断言调用参数而非真连）；
  - 收口链（四触发路径全覆盖，CP2 fail 修复项扩展）：settings:set / settings:import /
    settings:resetAll / 启动——各自触发后 applyProxyChange 被调（mock 断言三分区
    setProxy + resetAIProvider + env 更新/清空 + login 处理器幂等）；**SDK fetch 缝
    断言是实施期第一张红灯**（AI SDK `fetch?: FetchFunction` 传 proxiedFetch 后
    spy 断言工厂重建链持有新 fetch——CP2 指出该缝为探针声明，红灯先行即首日
    证实/证伪）。
- **store**：缺键回落 / 部分合并 / 写穿透 key / applyMainChange 不回写（33 号四件套同构）。
- **组件**：模式切换显隐 / V9 非法地址 toast / 测试按钮三态。
- 安全：凭据脱敏进日志；值 schema 拒绝非 http(s)；代理不经手凭据存储（URL 内嵌
  见 D5）；确认框无（非危险操作）。

### 2.8 发布与复盘

- experimental 不需要（非实验能力，正交开关）。成功指标：本地优先无遥测——复盘锚
  = 用户反馈 + 诊断包（resolver warn / setProxy warn / 测试连接结果均落 logger）。
- v2 候选（留痕不做）：PAC / SOCKS / 钉钉 WS / 供应商级连通矩阵。

### 2.9 多入口盘点

入口清单：① 设置页（唯一写入口）；② 导入设置文件（广播 + 主进程显式收口，见 §2.2
四路径）；③ resetAll（回 system，同收口）；④ **env 侧门**（只读 side effect 非入口）。
主进程无直写通道（无托盘项，不做——保持 33 号同款零直写架构）。三分区 + Node 栈 +
env 五个应用点全部读同一 resolver 真源，无双份状态。**MCP 远程连接语义注记**
（CP2 #8）：applyProxyChange 不重建 MCP 长连接——远程 MCP 服务器经代理的存量连接
保持到自然重连，不追求热切换（连接重建语义 MCP 客户端未提供，不造轮子）。

## 3 状态

### 3.1 CP2 双路深读结论（2026-09-29）

- 第一路：**fail ×2**——反例 7 静默丢弃；§2.2「导出/导入/resetAll 零代码」与 V7/V8
  矛盾（推送式应用点广播触达不了）。专项职责（反例 1 三层缓存链可行性）证实可行。
- 第二路：**fail ×2**——§2.3「零新增 IPC」与 D7 主进程探测矛盾（V10 不可达）；
  §2.2/V8 import-resetAll 收口接线缺失（与第一路互证）。专项职责（V1-V10 × 断言
  映射）9/10 pass，V8 fail。
- **分歧处置表**（全部按建议采纳；fail 修复已回写 §2 对应节）：

| # | 来源 | 项 | 处置 | 落点 |
|---|---|---|---|---|
| 1 | 路1 fail | 反例 7 静默丢弃 | 采纳：补处置决策（窗口可接受 + 固定顺序注记 + 不造跨 session 事务） | §2.1 |
| 2 | 路1 fail | import/resetAll「零代码」与 V7/V8 矛盾 | 采纳：四路径收口（set/import/resetAll/启动）统一走 applyProxyChange | §2.2 |
| 3 | 路2 fail | 测试连接需新增 IPC | 采纳：新增 `proxy:test`（定义表三步 + 响应 schema） | §2.3 |
| 4 | 路2 fail | V8 无断言计划 | 采纳：收口链测试扩四触发路径 | §2.7 |
| 5 | 路1+2 | D5 Chromium 侧凭据依据存疑 | 采纳：依据修正——Chromium 走 app 'login' 事件，v1 补处理器；undici 侧原生支持不变 | §2.1 |
| 6 | 路1 | ECONNREFUSED 被 ModelFallback 掩蔽 | 采纳：注记降级链最终错误仍透出 + 测试按钮为主归因路径 | §2.5 |
| 7 | 路1 | SDK fetch 缝为探针声明 | 采纳：标注为实施期第一张红灯（红灯先行即首日证实/证伪） | §2.7 |
| 8 | 路2 | MCP 长连接热切换语义未定义 | 采纳：注记「MCP 远程连接重建/重连后才生效，不做热切换」 | §2.9 |
| 9 | 路2 | postWebhook 改造点未显式点名 | 采纳：§1.2 显式列入无缝出口改造点 | §1.2 |
| 10 | 路2 | updater 分区主张实施首日复核 | 采纳：WP1 第一步复核三分区计数（探针已证，代码复核兜底） | §3.2 WP1 |
| 11 | 路1+2 | i18n 键数「七键」实为约 14 | 采纳：实施期按实际清单双语同批，spec 不预写死计数 | §2.5 |
| 12 | 路1 | D7 探测端点锚定第三方域名耦合 | 采纳：实施期换中立端点（如 https://www.gstatic.com/generate_204） | §2.5 D7 |

### 3.2 实施记录

- **WP1**（接缝收敛）：第一步复核 updater 分区（#10）→ undici 转直接依赖 →
  proxy-resolver.ts + proxiedFetch + applyProxyChange + 四路径收口 + login 处理器
  → 各应用点注入（AI 工厂 fetch / telegram fetchFn / webhook postWebhook / MCP
  requestInit）+ 红灯测试。
- **WP2b**（设置面，a1095521）：store proxy 域（updateProxy 写穿透 + 非 fixed 清
  残留 + 快照合并四断言）+ ProxySection 三模式/测试连接（经 settings-ops 桥接，
  direct-ipc 棘轮新增项重构消化）+ SettingsDialog 13 项导航（两处同步）+ i18n 17 键
  双语 + 冒烟测试 12→13 tab。
- 棘轮连锁登记（§5.5）：file-size definitions 1028→1037 / mock-api 972→980、
  functions mock-api 374→380——三处均 proxy 键登记/mock 域注册的声明性契约代码
  增长，`--update-baseline --force` 显式放宽（提交 a1095521 内基线文件）。
- **门禁实录**：check:static 15 项全过 / 五层测试链 shared 84 + main 2087 +
  renderer 1791 + integration 152 + scripts 364 全绿。

**V1-V10 逐条核对**（32 号 §5.9②；测试名对照 §2.7）：

| V | 结论 | 证据 |
|---|---|---|
| V1 默认行为不变 | ✅ | resolver「V1 缺失→system」+ proxiedFetch「V1 未初始化直通全局 fetch」+ applier「V1 system 三分区 {mode:system} env 全清」 |
| V2 fixed 经代理 | ✅ | proxiedFetch「V2 fixed → undici fetch + ProxyAgent dispatcher」（spy 断言）+ applier「V2 fixed 三分区 fixed_servers + env 双写」 |
| V3 direct 直连 | ✅ | resolver「V3 direct→{mode:direct}」+ proxiedFetch「V3 direct 直连无 dispatcher」+ applier「V3 resetAll 回落」 |
| V4 localhost 绕过 | ✅ | resolver「V4 localhost 家族恒绕过」+ proxiedFetch「V4 即使 fixed 也直连（不建 agent）」+ applier proxyBypassRules 强制 `<local>` 断言 |
| V5 免重启生效 | ✅ | applier 五断言均含 resetAIProvider 调用断言（settings:set 收口链 → 工厂重建，CP2 第一路三层缓存链核实） |
| V6 重启保持 | ✅ | SQLite 真源 + store 写穿透断言 + 启动路径 applyProxyChange（index.ts whenReady，initDb 后 IM 恢复前） |
| V7 resetAll 回 system | ✅ | handler resetAll 显式 `applyProxyChange(undefined)`（CP2 fail 修复项落地）+ applier「V3 resetAll 语义三分区回落 + env 清空」 |
| V8 导入即时生效 | ✅ | handler importSettings 显式 applyProxyChange（CP2 fail 修复项落地）+ store「applyMainChange 按域合并不回写」 |
| V9 非法地址拒写 | ✅ | shared superRefine 门禁 3 断言（fixed 缺 url/非法协议/mode 未知）+ 组件 blur 前置校验「非法地址不入库」 |
| V10 UI 三态 | ✅ | 组件五断言（三模式显隐/写穿透/blur 校验/测试成功文案/proxy:test 调用） |

**实施期实测补充**（32 号回审素材，全链路+主进程子系统形态）：
- 探针先行价值实证：`.tmp` Electron 探针（全局 fetch 不认 dispatcher）直接决定了
  proxiedFetch 闭环方案，避免实施期推翻设计；该探针结论已沉淀于 §0 与模块头注释。
- CP2 双路 fail 全部集中在「推送式 vs 拉取式」语义差异（33 号 notification 是
  拉取式零代码，34 号是推送式必须四路径显式收口）——**主进程急切副作用功能**
  应在 32 号 §4.2 增补「消费方式判定」检查项，防下个功能再犯。
- direct-ipc 棘轮在 UI 提交时咬到（组件直连 proxy:test）——正确处理是桥接重构
  而非放宽，棘轮设计意图实测有效。
