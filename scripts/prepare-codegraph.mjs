// scripts/prepare-codegraph.mjs
// 生成 resources/codegraph-{arch}/（@colbymchenry/codegraph 平台捆绑包，按架构分目录）
// ──────────────────────────────────────────────────────────────
// 背景：codebase 工具（Agent 代码库智能查询）经 spawn 调用 codegraph CLI。
//   @colbymchenry/codegraph 以 optionalDependencies 分发各平台捆绑包
//   （vendored Node 24 + app，esbuild 同款模式），pnpm 装入
//   node_modules/.pnpm/@colbymchenry+codegraph-<platform>-<arch>@*/。
//   CodebaseService.resolveCodegraphBundle 在运行时按平台选择
//   node.exe（Windows）或 bin/codegraph（其他）。
//
// 为什么按架构分目录（2026-09-20 多架构发布）：
//   发布矩阵含 x64 与 arm64，而捆绑包内含**平台二进制**（node.exe / bin/codegraph）
//   ——同名文件无法在同一目录共存。此前只部署 host 架构的那一份，导致交叉构建
//   （如 macos-latest 为 arm64 却要产出 x64 包）把错误架构的二进制打进安装包：
//   mac x64 用户在 codebase 工具上会因架构不匹配而失败（既有缺陷，随本次修复）。
//   现每个架构部署到独立目录，electron-builder 侧用 extraResources 的 ${arch} 宏
//   按构建目标选取（该宏经 app-builder-lib 的 getFileMatchers → expandMacro 展开，
//   已核实：platformPackager.createGetFileMatchersOptions 传入 Arch[arch]）。
//
// 前置：pnpm-workspace.yaml 的 supportedArchitectures 需含 x64 与 arm64
//   （否则 pnpm 只装 host 架构那一个 optionalDependency，本脚本会报缺包）。
//
// 用法：
//   node scripts/prepare-codegraph.mjs                 # 部署 x64 + arm64
//   CODE_AGENT_TARGET_ARCHS=x64 node scripts/...       # 只部署指定架构（CI 单架构 job）
// ──────────────────────────────────────────────────────────────

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const PLATFORM = process.platform;

/** 支持的架构集合（与 electron-builder.yml 的 target.arch 对齐） */
const ALL_ARCHS = ['x64', 'arm64'];

/** 目标架构：可由 CODE_AGENT_TARGET_ARCHS 收窄（逗号分隔），默认全部 */
function resolveTargetArchs() {
  const raw = process.env['CODE_AGENT_TARGET_ARCHS'];
  if (raw === undefined || raw.trim() === '') {
    return ALL_ARCHS;
  }
  const requested = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  const unknown = requested.filter((a) => !ALL_ARCHS.includes(a));
  if (unknown.length > 0) {
    console.error(
      `[prepare-codegraph] CODE_AGENT_TARGET_ARCHS 含未知架构：${unknown.join(', ')}（支持：${ALL_ARCHS.join(', ')}）`,
    );
    process.exit(1);
  }
  return requested;
}

const pnpmRoot = join(ROOT, 'node_modules', '.pnpm');
if (!existsSync(pnpmRoot)) {
  console.error(`[prepare-codegraph] 未找到 pnpm store：${pnpmRoot}`);
  process.exit(1);
}
const entries = readdirSync(pnpmRoot);

/** 清理历史单目录布局（resources/codegraph/），避免残留被误打包 */
const legacyDest = join(ROOT, 'resources', 'codegraph');
if (existsSync(legacyDest)) {
  rmSync(legacyDest, { recursive: true, force: true });
  console.log('[prepare-codegraph] 已清理旧布局 resources/codegraph/');
}

const targetArchs = resolveTargetArchs();
const deployed = [];
const missing = [];

for (const arch of targetArchs) {
  const target = `${PLATFORM}-${arch}`;
  const candidates = entries
    .filter((n) => n.startsWith(`@colbymchenry+codegraph-${target}@`))
    .sort();
  const latest = candidates.at(-1);
  if (latest === undefined) {
    missing.push(target);
    continue;
  }
  const src = join(pnpmRoot, latest, 'node_modules', '@colbymchenry', `codegraph-${target}`);
  if (!existsSync(src)) {
    missing.push(target);
    continue;
  }
  const dest = join(ROOT, 'resources', `codegraph-${arch}`);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true });
  deployed.push(`${target} → resources/codegraph-${arch}/`);
}

for (const line of deployed) {
  console.log(`[prepare-codegraph] ${line}`);
}

if (missing.length > 0) {
  console.error(
    `[prepare-codegraph] ❌ 以下平台捆绑包未安装：${missing.join(', ')}\n` +
      '  需要 pnpm-workspace.yaml 的 supportedArchitectures.cpu 含 x64 与 arm64，' +
      '并执行一次 pnpm install（optionalDependencies 按架构分发，只装 host 架构会导致缺包）。\n' +
      '  若本次只需构建单一架构，可用 CODE_AGENT_TARGET_ARCHS=<arch> 收窄目标。',
  );
  process.exit(1);
}

console.log(`[prepare-codegraph] 完成：${deployed.length} 个架构已就绪`);
