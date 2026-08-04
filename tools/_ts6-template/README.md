# TS 6 隔离子包模板

当某个工具（如文档生成器、依赖分析器）**不兼容项目的 TypeScript 7**（tsgo）时，
不要降级根项目 TS，而是为该工具建一个独立 workspace 子包，声明 `typescript@^6.0.2`，
让 pnpm 为该子包单独解析一份 TS 6 副本。工具在子包内运行时即解析到兼容版本。

现有实例：`tools/typedoc`（TypeDoc）、`tools/depcruise`（dependency-cruiser）。

## 新增一个 TS6 隔离工具的步骤

1. 复制本目录为 `tools/<tool>/`（去掉下划线前缀；`_*` 目录被 workspace 排除）。
2. 编辑 `package.json`：
   - `name` 改为 `@code-agent/<tool>`
   - `dependencies` 里把 `__TOOL_PACKAGE__` 换成真实包名与版本，保留 `typescript: ^6.0.2`
   - `scripts.run` 改为该工具的 CLI 命令；如需在仓库根执行，用 `cd ../.. && <cli> ...`
3. 工具自身的配置文件（如 `.dependency-cruiser.cjs`、`typedoc.json`）放进 `tools/<tool>/`。
4. `pnpm install`（workspace 已含 `tools/*`，自动纳入）。
5. 在根 `package.json` 加一个转发脚本，例如：
   `"docs:<tool>": "pnpm --filter @code-agent/<tool> run run"`。

## 约定

- 子包 `private: true`、`version: 0.0.0`，不发布。
- 子包只声明该工具 + `typescript@^6.0.2`，不引入其他业务依赖。
- 根项目 typecheck 仍用 TS 7，不受子包影响。
- 子包不写业务代码，只承载工具运行。
