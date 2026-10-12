# 26. 记忆引擎集成规范（vendored 上游 + sidecar）

> 最后同步：2026-09-13
>
> 本文记录记忆引擎（上游 TencentDB-Agent-Memory · MemoryCore）的集成方式、约束与运维。
> 源码真源：`packages/memory-engine/`（含 `UPSTREAM.md` 升级手册）。

---

## 一、架构

```
主进程 ──MemoryPort 接口──> HttpMemoryPort ──HTTP/127.0.0.1──> 引擎子进程 ──> SQLite
  │        (infra/memory-hub/types.ts)   (adapter.ts)          (utilityProcess)   +FTS5
  └─ MemoryHubService：生命周期（配置生成 / 启动 / 健康轮询 / 停止）
```

**进程边界**：引擎以独立子进程运行，主进程只经 loopback HTTP 通信。
- 崩溃隔离：引擎挂掉不影响应用（`MemoryPort` 降级为空实现）
- 事件循环保护：BM25/分词/LLM 蒸馏不在主进程线程（已有 EventLoopLagMonitor 监控此类阻塞）

**代码边界**（三条纪律）：
1. `adapter.ts` 是**全项目唯一**知晓上游 HTTP 协议（路径/鉴权头/响应形状）的文件
2. 本模块**不 import 上游代码**（引擎源码经构建脚本打包，运行时子进程加载）
3. 上层只认 `MemoryPort` 接口（`types.ts`）

## 二、源码来源：vendored 进仓

| 项 | 值 |
|---|---|
| 上游 | https://github.com/TencentCloud/TencentDB-Agent-Memory |
| 收录 | **仅 `MemoryCore/`**（上游为 monorepo） |
| 版本锚点 | `packages/memory-engine/versions.json`（标签 + commit + 子包版本三号） |
| 许可 | MIT（Copyright (C) 2026 Tencent；全文见 `LICENSE-THIRD-PARTY`） |

**为什么进仓**：上游不发布 npm 2.0.x（registry 仅 `1.0.0-beta.1`）、不发 Release 资产，
唯一分发方式是源码归档。此前依赖维护者本机目录 → **CI 构建拿不到引擎**，产物静默缺功能。

**改动上游的唯一通道**：`packages/memory-engine/patches/`（补丁形式）。
直接改 `MemoryCore/` 会被 `memory-engine:integrity` 拦下（聚合哈希校验，接入 `check:static`）。

### 升级流程

```bash
pnpm memory-engine:check                # 查上游新版本（网络不可用时提示，不算失败）
pnpm memory-engine:sync --from <解压目录> --tag <tag> [--commit <sha>]
pnpm memory-engine:integrity            # 校验源码与锚点一致
MEMORY_HUB_ROOT=... pnpm test:main      # 契约测试（真实拉起引擎）
git diff --stat packages/memory-engine  # 复核上游改动
```

同步脚本**不直接访问 GitHub**（部分环境不可达），由人工/CI 预先取得归档后指定路径；
事务性替换（暂存 → 原子改名 → 失败回滚），同步后自动重放补丁并重生成完整性记录。

**升级后必查**：`gateway.yaml` 字段（`server.*` / `data.baseDir` / `llm.*` /
`memory.recall.*` / `bm25.*`）与 `adapter.ts` 消费的六个端点
（`/health` `/capture` `/recall` `/search/memories` `/search/conversations`
`/v2/conversation/delete`）。

## 三、进程启动：Electron utilityProcess

```ts
utilityProcess.fork(launcherPath, [], {
  cwd: hubRoot,
  env: { MEMORY_HUB_ENTRY, TDAI_GATEWAY_CONFIG, MEMORY_TENCENTDB_ROOT, ... },
  execArgv: useTsx ? ['--import', 'tsx'] : [],   // 仅 dev（src 直跑）分支；打包版为纯 JS，无需 loader
  serviceName: 'memory-engine',                   // app.getAppMetrics() 可归因
  stdio: ['ignore', 'pipe', 'pipe'],
})
```

**入口双分支**（`MemoryHubService.resolveEntry`）：打包版优先 `dist/gateway/server.js`
（2026-10-05 be09ae49 起，bundle 单文件纯 JS——此前 tsx 直跑在打包环境 100% 启动失败：
Electron 剥掉 `NODE_OPTIONS` 挂不上 tsx loader，见 §六构建）；dev 回退 `src` + tsx。

**为什么不是 `spawn(process.execPath)` + `ELECTRON_RUN_AS_NODE=1`**（2026-09-13 变更）：
后者要求 `RunAsNode` 熔断**保持开启**；而该熔断开启时签名应用二进制可被同机任意进程
复用为通用 Node 运行时（LOLBin），并绕过 asar 完整性校验。Electron 官方文档明确
"关闭 runAsNode 会使 `process.fork` 失效，推荐改用 utilityProcess"——本集成即按此迁移。

**启动器可注入**（`MemoryHubServiceOptions.launcher`）：生产用 utilityProcess；
vitest（无 Electron 运行时）用 `node-launcher.ts`，故契约测试仍能真实拉起引擎。

## 四、数据归属与隐私

**数据位置**：`userData/memory-hub/`（`gateway.yaml` + `data/` 下的 SQLite 与 JSONL 审计镜像）。
显式设 `MEMORY_TENCENTDB_ROOT` 指向此处——上游默认落到 `~/.memory-tencentdb/`，
会导致备份不覆盖、卸载不清理、多用户环境串数据。既有数据由 `migrateLegacyDataDir()`
一次性迁移（保守策略：不覆盖新数据、不删旧目录）。

**L0 双写**：引擎 SQLite（权威存储）+ `<dataDir>/data/conversations/*.jsonl`（可 grep 的
审计镜像，供设置页列出）。清除需两处同步（`removeL0JsonlBySession`），否则 UI 残留造成
"假清空"。

**用户开关**（`settings.memory.enabled`，默认开启）：关闭后**不捕获也不使用**——
capture-wire 跳过、预取召回跳过、`save_memory`/`recall_memory` 工具拒绝、启动预热跳过。
已记录数据保留（用户可在设置页清除，含"清除全部记忆"）。

## 五、检索：sqlite 后端 + FTS5（不含 BM25 稀疏向量）

本集成使用默认 **sqlite 后端**（未配置 `storeBackend`），关键词检索走 **FTS5**，
分词为 jieba `cutForSearch`（中英文统一处理）。

**因此 `bm25.language` 配置对本集成不生效**——该配置只影响 tcvdb 后端的
`BM25Encoder.default(lang)`，而 sqlite 后端的 `getCapabilities().sparseVectors === false`。
中英文检索能力由 jieba + FTS5 提供（契约测试有实测守卫）。

> 若未来改用 tcvdb 后端（需服务端向量库），才需重新评估多语言策略与语言切换语义。

## 六、构建：prepare-memory-hub.mjs

从 `packages/memory-engine/MemoryCore` 生成 `resources/memory-hub/`（经 extraResources
部署到 `process.resourcesPath/memory-hub`）。现行四阶段（2026-10-05 bundle 架构，
be09ae49/68e14714/4d9c4853 等系列改造；替代初版「tsx 直跑源码」方案）：

1. **拷贝 + 装依赖**：`src/` + `package.json`（optionalDependencies **不能清空**——
   可选后端在静态 import 链上，bundle 沿链解析缺包即 Build failed）→ 目标目录内
   `pnpm install --prod --ignore-scripts`（shamefullyHoist + virtualStoreDirMaxLength 24，
   后者治 NSIS 卸载器 MAX_PATH 重命名失败）
2. **bundle 单文件**：esbuild 以 `src/gateway/server.ts` 单入口 bundle 到
   `dist/gateway/server.js`（非 external 依赖全部内联，产物 ~19MB 单文件）；
   external 只留原生绑定（`@node-rs/jieba` / `sqlite-vec` / `@reflink/reflink`）
   与 `../integrations/*`；随后删除 src。**散装数据文件显式补拷**：
   `metadata_config_params.json` → `dist/gateway/`（param-registry 按 `__dirname`
   读取）、tcvdb-text `data/` → `dist/data/`（BM25 词典，#92）
3. **裁剪孤儿依赖**：从 BUNDLE_EXTERNAL 求可达闭包，node_modules 只留 external
   原生子树（~10 包）；依赖链接实体化 + 删 `.pnpm` 私有层（junction 解引用坑见脚本注释）
4. **裁剪运行期无用文件**：sourcemap / `.d.ts` / `.d.ts.map` 等

**失败即失败**：源码缺失、bundle 失败、入口/数据文件校验不过时 `exit 1`（历史上
"生成占位并成功"的静默降级已删除）。`pnpm check:packaged-engine` 进一步断言
**最终产物**含可运行引擎（入口 + node_modules + 无占位标记 + external 关键依赖 +
**数据文件**：metadata_config_params.json 与 dist/data 非空，2026-10-06 哨兵补数据
断言），在 release.yml 打包后运行。

## 七、已知约束

- **Windows 路径长度**：bundle 架构后产物仅 ~38 个文件（原 7078，2026-10-05 实测），
  MAX_PATH 风险面大幅收缩；残余防线 = `virtualStoreDirMaxLength: 24`（治 NSIS 卸载器
  重命名超限，2026-09-20 实测建模）+ 5.2 步 sourcemap/类型声明裁剪。Electron manifest
  仍未声明 longPathAware。
- **冷启动**：打包版为 bundle 纯 JS（无 TS 编译开销），sidecar 就绪超时
  `START_TIMEOUT_MS = 60s`（memory-hub-service.ts:54；2026-10-05 从上游 20s 放宽——
  安装后首次冷启动 HDD + Defender 首读大量文件，纯慢非崩）。应用启动后 3s 后台预热
  （`prewarm.ts`）把该成本前移。
- **多语言**：见第五节（sqlite 后端天然支持中英文；`bm25.language` 不适用）。
