# 贡献指南（CONTRIBUTING）

感谢你愿意为本项目出力。本文说明**如何搭建环境、提交改动、以及本项目特有的一些硬规矩**——
后者尤其重要：本项目有若干与常见 React/Electron 项目不同的约定，不了解容易反复踩坑。

## 一、环境要求

| 工具 | 版本 | 说明 |
|---|---|---|
| Node.js | **≥ 24.13.0** | 见 `.nvmrc` / `package.json` 的 `engines` |
| pnpm | **≥ 11.0.0** | 包管理器，**不要用 npm / yarn**（`preinstall` 会拒绝） |
| Git | 任意较新版本 | 跨平台均可（Windows / macOS / Linux） |

```bash
git clone https://github.com/zlh12331/superagent.git
cd superagent
pnpm install
pnpm dev          # 启动 dev server + Electron 窗口
```

若只想在浏览器里看渲染层（无需 Electron）：

```bash
pnpm dev:web      # 浏览器模式，配合 src/renderer/dev/mock-api.ts 提供假 window.api
```

> ⚠️ 浏览器模式**必须**用 `pnpm dev:web`。直接访问 Electron dev 的 5173 端口既没有真实
> `window.api` 也没有 mock，页面会空转。

## 二、提交前必须跑的门禁

本地 `pre-push` 钩子会自动跑下列大部分检查；**CI 会完整跑一遍**，两者任一失败都不能合并。

```bash
pnpm typecheck     # tsc --build（注意：不是 --noEmit，本项目用 project references）
pnpm lint          # biome check .（含格式化与 import 排序）
pnpm check:static  # 静态审计 10 项（tokens/i18n/注释/文件大小/函数体/覆盖率下限等）
pnpm test          # 全量单测（packages → main → renderer → integration → scripts）
pnpm knip          # 死代码 / 死依赖检测
```

**门禁不是建议，是硬性要求**。若某个检查报错但它指向的是历史遗留问题，正确做法是修它或
调整棘轮基线并说明理由，**不要**用 `--no-verify` 绕过（`SKIP_PREPUSH=1` 仅限紧急情况且有痕迹）。

## 三、提交信息规范

本项目用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)，`commit-msg`
钩子会强制校验。

```
<type>(<scope>): <subject>
```

**type 必须准确**——它不只是标签，而是**发布流水线的输入**：

| type | 是否升版 | 进入 CHANGELOG |
|---|---|---|
| `feat` | minor | ✅ 新增 |
| `fix` | patch | ✅ 修复 |
| `perf` | patch | ✅ 性能 |
| `refactor` / `docs` / `chore` / `test` / `style` / `build` / `ci` / `revert` | 不升版 | ❌ 隐藏 |

所以：**改 CI 配置用 `ci`，不要用 `feat`**——用错会让 release-please 误开一个空版本。

**scope** 是可选的作用域（如 `renderer` / `main` / `release`），取值为引导性枚举，写错只警告不阻断。

**破坏性变更**用 `!` 或 footer 表达：

```
feat(api)!: 移除旧的模型配置字段
```

```
feat(api): 移除旧的模型配置字段

BREAKING CHANGE: 旧字段 `modelConfig` 不再被读取，需迁移到 `models`。
```

> ⚠️ 没有 `breaking` 这个 type——破坏性变更靠上面的后缀/footer 表达。

## 四、代码约定（本项目的硬规矩）

这些是容易踩坑的地方，请务必遵守：

### 状态管理分层

| 场景 | 用什么 |
|---|---|
| 组件内瞬态（输入框/折叠/编辑态） | `useState` |
| 客户端共享状态 | Zustand（`persistent/` 跨重启、`transient/` 会话内） |
| IPC invoke 请求-响应 | **TanStack Query**（query 逻辑放 `hooks/` 并导出 queryKey 常量） |
| IPC 推送事件 | Zustand transient，经 subscribe 回调写入 |

- 响应一律用 `lib/ipc.ts` 的 `unwrap()`，**不要**手写 `'data' in res` 判别
- 变更操作用 `useMutation`，且**必须挂 `onError`** 弹 toast（错误解析真源在 `lib/ipc.ts`）

### 数据契约

- **IPC 必须走定义表**：新增方法 = 改 `packages/shared/src/ipc/meta.ts` 一行 +
  `definitions.ts` 一行 + handler 加一个方法，其余（通道/preload/类型/注册）自动生成。
  **禁止手写 channel 字符串**（常量表在 `packages/shared/src/ipc/channels.ts`）。
- **数据库 schema 唯一真源是 `src/main/infra/storage/schema.ts`**。改它之后必须跑
  `pnpm exec drizzle-kit generate` 并提交产物——**禁止手写第二份建表 SQL**。

### 渲染层写法

- **React Compiler 已启用**（infer 模式），**新代码不要写 `useMemo` / `useCallback`**，
  编译器会自动记忆化。
- 条件 className 一律用 `cn()`；**禁用裸 `<button>`**，用 `ui/button` 的 `Button`。
- 危险操作（删除/清空）用命令式 `confirm()` store（`confirm-dialog-store`），
  不要内联 `AlertDialog`。
- 复制反馈统一用 `useCopy()`，不要手写 copied state + 定时器。
- 动效统一走 MotionVault（`src/renderer/lib/motion/`），不要散写 CSS transition。

### 其他

- **禁止 `default export`**（例外：renderer 的 `*.tsx`、config、scripts）。
- **禁止 `console`**（例外：`tests/integration/`、`e2e/`、scripts）。
- `exactOptionalPropertyTypes` 与 `noUncheckedIndexedAccess` 已启用，可选字段传 `undefined`
  需要条件展开 `...(x !== undefined ? { x } : {})`。

## 五、测试约定

- **业务逻辑不 mock**：测试真实实现，用 DI 注入 fake。只有基础设施（electron、SQLite 原生模块）
  可以 `vi.mock` / alias stub。
- 测试文件与源码**同目录**：`**/*.test.ts` / `*.test.tsx`；集成测试放 `tests/integration/`；
  E2E 在 `e2e/`。
- Vitest globals 已开启（`describe`/`it`/`expect` 无需 import）。
- **覆盖率下限是棘轮门禁**（`scripts/coverage-floors.json`），改动后覆盖率不能下降。

```bash
pnpm test:main          # 单层
pnpm test:renderer
pnpm test:integration
pnpm test:e2e           # 浏览器 E2E
pnpm test:e2e:electron  # 真实 Electron 窗口
```

## 六、提 PR 的流程

1. **Fork** 仓库（或如果你有权限，从 `main` 切一个描述性分支）
2. 开发，确保上面所有门禁本地通过
3. 推送并开 PR，描述里写明改了什么、为什么
4. CI 会跑 8 项必需检查（含三平台 E2E、smoke），**全绿才能合并**
5. 合并采用 **squash**（保持线性历史）

PR 会被自动请求给 @zlh12331 审阅。请耐心等待——这是个人维护的项目。

## 七、发现安全问题怎么办

**请勿公开提交 Issue**——那会立刻暴露问题。请走私密渠道：

👉 https://github.com/zlh12331/superagent/security/advisories/new

## 八、可以帮忙的地方

- 报告 bug（用 Bug Report 模板，附版本/系统/复现步骤）
- 提功能建议（用 Feature Request 模板，说明**要解决的问题**）
- 文档改进、翻译修正
- 有争议的设计讨论 → 到 [Discussions](https://github.com/zlh12331/superagent/discussions)

## 许可

本项目采用 [MIT License](./LICENSE)。提交贡献即表示你同意以该许可分发你的贡献。
