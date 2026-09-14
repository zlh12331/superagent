# 记忆引擎上游说明（UPSTREAM）

本目录是**第三方源码**（vendored），不是本项目编写的代码。

## 来源

| 项 | 值 |
|---|---|
| 上游项目 | TencentDB Agent Memory |
| 仓库 | https://github.com/TencentCloud/TencentDB-Agent-Memory |
| 当前版本 | tag `v2.0.1`,commit `a5dcbe6e9fee0d1d1e32d935326f1d3bcf927fdb` |
| 收录模块 | **仅 `MemoryCore/`**（上游为 monorepo：另有 MemoryPanel / MemoryKnowledge / MemoryProxy / SDK，均不收录） |
| 子包版本 | `@tencentdb-agent-memory/memory-tencentdb-v2@2.0.0-beta.1` |
| 许可 | MIT,Copyright (C) 2026 Tencent（全文见 `LICENSE-THIRD-PARTY`） |

版本锚点唯一真源：`versions.json`。

## 为什么进仓库

上游不发布 npm 2.0.x 包（registry 上只有 `1.0.0-beta.1`），也不发布 Release 资产；
唯一分发方式是源码归档。本项目原先靠"维护者本地解压目录"（`resources/memory-hub/`，未入仓）
供构建使用，导致 **CI 构建拿不到引擎 → 正式发布产物缺失记忆功能**。

vendoring 后：源码随仓库分发，CI 与本地构建使用同一份代码，可复现、可审计。

## 体积

`MemoryCore/` 约 348 个文件 / 5 MB（源码），依赖由 pnpm 按 `MemoryCore/pnpm-lock.yaml` 安装。

## ⚠️ 不要直接修改本目录

对本目录的任何修改都会导致 `pnpm memory-engine:integrity` 失败（校验源码与锚点一致）。

需要改动上游代码时，走**补丁通道**：

1. 在 `patches/` 下新增补丁文件（`.patch` 格式，`git diff` 产出）
2. 在 `patches/README.md` 登记：目的、影响、上游是否已修复
3. 升级上游时 `memory-engine:sync` 会重放补丁；**补丁打不上即同步失败**（说明上游改了同一处代码，必须人工处理）

这样做的目的：上游改了什么、我们改了什么，永远不会被静默吞掉。

## 如何同步上游新版本

```bash
pnpm memory-engine:check            # 查看上游是否有新版本
pnpm memory-engine:sync <tag>       # 同步到指定 tag（下载 → 校验 → 提取 MemoryCore → 更新锚点 → 重放补丁）
pnpm memory-engine:integrity        # 校验源码与锚点一致
pnpm test:main                      # 契约测试（真实拉起引擎）
git diff --stat packages/memory-engine   # 复核上游改动范围
```

同步后请**逐项核对配置兼容性**：`gateway.yaml` 的字段（`server.*` / `data.baseDir` / `llm.*` /
`memory.recall.*` / `bm25.*`）与 `adapter.ts` 消费的 HTTP 端点（`/health` `/capture` `/recall`
`/search/memories` `/search/conversations` `/v2/conversation/delete`）。上游 CHANGELOG 中
涉及这些面的变更需重点回归。

## 与本项目的关系

- 集成方式：**独立进程 sidecar + loopback HTTP**（`src/main/infra/memory-hub/`）
- 接口边界：本项目只认 `MemoryPort`；`adapter.ts` 是全项目唯一知晓上游 HTTP 协议的文件
- 本目录**不被本项目代码 import**（构建时由 `scripts/prepare-memory-hub.mjs` 打包成运行目录）
