## 变更内容

<!-- 一两句话说明「做了什么、为什么」。对应 Issue 请用 Fixes #123 关联。 -->

## 变更类型

<!-- 勾选一项。注意：type 决定 release-please 是否升版与升多少 -->
- [ ] `feat` 新功能（minor 升版）
- [ ] `fix` 缺陷修复（patch 升版）
- [ ] `perf` 性能优化（patch 升版）
- [ ] `refactor` 重构（不升版）
- [ ] `docs` / `chore` / `ci` / `build` / `test` / `style`（不升版）
- [ ] 破坏性变更（需在提交 body 写 `BREAKING CHANGE:`，major 升版）

## 自检（required）

<!-- 这些是本地就能跑的门禁；CI 会再跑一遍全量 -->
- [ ] `pnpm typecheck` 通过
- [ ] `pnpm lint` 通过
- [ ] `pnpm check:static` 通过
- [ ] 相关测试已补/已更新（业务逻辑不许 mock，基础设施可 stub）
- [ ] 改动了 `src/main/infra/storage/schema.ts` 时，已跑 `pnpm exec drizzle-kit generate` 并提交产物

## 影响面

<!-- 涉及 UI 请附截图/录屏；涉及发布流程/依赖/安全基线请特别说明 -->

## 备注

<!-- 可选：已知问题、后续计划、需要 reviewer 重点关注的地方 -->
