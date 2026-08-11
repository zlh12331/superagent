# 17. 安全规范（Electron 生产级基线）

> 对齐 Electron 官方安全清单 + OWASP 桌面应用实践，基于项目实际安全实现（sandbox/CSP/safeStorage/zod）制定。
> 最后同步：2026-08-11

---

## 一、进程隔离（已强制，不可回退）

| 项 | 现状 | 约束 |
|---|---|---|
| `sandbox: true` | ✅ 渲染层沙箱 | 不可回退（AGENTS.md 关键约束） |
| `contextIsolation` | ✅ 默认开启 | 渲染层只能通过 `window.api`（contextBridge 白名单） |
| preload 零依赖 | ✅ CJS + 纯字符串 meta | preload 禁止引入 zod 等 ESM 运行时（沙箱限制） |
| `nodeIntegration: false` | ✅ | 渲染层无 Node 能力 |

## 二、CSP（内容安全策略）

- 实现：[src/main/security/csp.ts](file:///f:/TraeProjects/1/src/main/security/csp.ts)（+ csp.test.ts 门禁）
- **约束**：渲染层资源（script/style/img/connect）白名单化；`unsafe-inline`/`unsafe-eval` 禁止（dev 模式例外需显式标注）
- **变更流程**：改 CSP 必须同步更新 csp.test.ts 断言（测试卡关）

## 三、密钥管理（工程化强制：`pnpm check:secrets`）

1. **API Key 存储**：Electron `safeStorage`（Windows DPAPI）加密，`settings:setApiKey` 走主进程，渲染层不得持有明文
2. **禁止硬编码**：源码中禁止真实密钥/令牌（check:secrets 扫描：`sk-` 前缀 / `api_key`/`secret`/`password` 赋值模式，pre-push + CI 卡关）
3. **.env 保护**：环境变量仅主进程启动时 `process.loadEnvFile()` 加载（whenReady 之前），.gitignore 排除
4. **测试密钥**：测试/mock 必须用显式 fake 值（`fake-token` 风格），禁止复制真实密钥
5. **日志纪律**：日志禁止输出密钥（16-error-logging §2.3，traceId 只记前 8 位已实现）

## 四、输入验证与注入防护

1. **IPC 入参**：全部过 zod schema（定义表单一真源，主进程 register.ts 统一 wrap）——L2 强制（13-form-validation）
2. **路径防护**：文件操作（read/write/delete）禁止路径遍历——相对路径规范化 + 工作区边界校验（path-guard 类工具，tools 测试覆盖）
3. **LLM 输出**：工具入参（LLM 生成）必须 zod 验证后才执行（TypeScript 规范 §安全）
4. **SQL 注入**：参数化查询（Drizzle ORM 绑定参数），禁止字符串拼接 SQL（18-data-layer-spec）

## 五、渲染层安全

1. **XSS**：用户/LLM 内容经 react-markdown 渲染——禁 `dangerouslySetInnerHTML`（除已验证的受控场景）
2. **导航防护**：`will-navigate`/`setWindowOpenHandler` 限制外部导航（`app:openExternal` 走系统浏览器）
3. **webview/远程内容**：不加载远程 HTML（本地 UI 为主）；远程资源（浏览器 pane）沙箱化

## 六、依赖安全

- `pnpm audit`（audit-ci，CI 卡关 moderate 门槛）
- `pnpm knip` 死依赖卡关（减少攻击面）
- Renovate 自动更新（electron major 人工评审）

## 七、检查清单

- [ ] 新 IPC 方法：zod schema 声明（L2 自动生效）
- [ ] 新文件操作：路径规范化 + 边界校验
- [ ] 密钥：safeStorage / .env，check:secrets 通过
- [ ] 日志无敏感信息
- [ ] 渲染层无 `dangerouslySetInnerHTML` 新增（有则评审）
