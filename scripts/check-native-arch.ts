// scripts/check-native-arch.ts
// 打包产物原生模块架构断言（防「交叉构建静默产出错误架构二进制」）
// ──────────────────────────────────────────────────────────────
// 为什么需要（2026-09-20 实测）：在 x64 runner 上为 arm64 目标打包时，
// @electron/rebuild 会以 0.4s 完成「编译」（vs 真实编译 9s/98s），实际未产出
// aarch64 二进制、静默复用 host 架构——构建日志**不报任何错**，产出的 arm64
// 安装包内是 x64 原生模块（用户装上即崩）。唯一可靠的探针是读二进制头。
//
// 检查对象（每个 unpacked 目录内，按目录名推断目标架构）：
// - app.asar.unpacked/node_modules/node-pty/build/Release/*.{node,exe}
//   （@electron/rebuild 编译产物，主动加载路径）
// - app.asar.unpacked/node_modules/better-sqlite3/build/Release/*.node
//   （同上；若缺失则回退检查其主动加载的 prebuilds/<platform>-<arch>.node）
// - resources/codegraph/{node.exe,bin/codegraph}（平台捆绑包，extraResources 按
//   ${arch} 宏选取——架构错配时这里必然暴露）
//
// 跳过规则：包自带的多平台 prebuilds 目录（如 better-sqlite3/prebuilds/darwin-*）
// 不属于本平台运行路径，不参与判定；无法识别格式/架构的文件跳过并计数。
//
// 运行：pnpm check:native-arch（CI 的 smoke job 与 release.yml 的 build job 都跑）
// ──────────────────────────────────────────────────────────────

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

import type { BinaryArch } from './lib/native-arch';
import { archMatches, detectBinaryInfo, expectedArchFromDirName } from './lib/native-arch';

/** 仓库根（脚本以 pnpm 从根执行） */
const ROOT = process.cwd();
/** 打包输出目录 */
const RELEASE_DIR = join(ROOT, 'release');
/** 读文件头所需字节数（足够覆盖三类格式表头） */
const HEADER_BYTES = 4096;

/** 一处检查项 */
interface CheckTarget {
  /** 展示用相对路径 */
  readonly label: string;
  /** 绝对路径 */
  readonly path: string;
  /** 目标架构 */
  readonly expected: 'x64' | 'arm64';
}

/** 检查结果统计 */
interface CheckResult {
  readonly checked: number;
  readonly skipped: number;
  readonly mismatches: Array<{ label: string; expected: string; actual: BinaryArch }>;
}

/** 列出 release/ 下的 unpacked 目录（含 macOS 的 .app 所在目录） */
function findUnpackedDirs(): string[] {
  let entries: string[];
  try {
    entries = readdirSync(RELEASE_DIR);
  } catch {
    return [];
  }
  const dirs: string[] = [];
  for (const entry of entries) {
    if (entry.endsWith('-unpacked')) {
      dirs.push(join(RELEASE_DIR, entry));
      continue;
    }
    // macOS：mac / mac-arm64 目录内是 <Product>.app（本检查用其 Contents 下的路径）
    if (entry === 'mac' || entry === 'mac-x64' || entry === 'mac-arm64') {
      dirs.push(join(RELEASE_DIR, entry));
    }
  }
  return dirs;
}

/** 递归收集匹配的文件（限深度，避免扫进无关子树） */
function collectFiles(
  dir: string,
  predicate: (name: string) => boolean,
  maxDepth: number,
  depth = 0,
): string[] {
  if (depth > maxDepth) {
    return [];
  }
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    let isDir: boolean;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      out.push(...collectFiles(full, predicate, maxDepth, depth + 1));
    } else if (predicate(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** macOS 的 resources 相对路径（.app/Contents/Resources） */
function resourcesDirOf(unpackedDir: string): string {
  const base = basename(unpackedDir);
  if (base.startsWith('mac')) {
    // mac / mac-arm64 / mac-x64 → <dir>/<Product>.app/Contents/Resources
    try {
      const appDir = readdirSync(unpackedDir).find((e) => e.endsWith('.app'));
      if (appDir !== undefined) {
        return join(unpackedDir, appDir, 'Contents', 'Resources');
      }
    } catch {
      // 落到下面回退
    }
  }
  return join(unpackedDir, 'resources');
}

/** 为一个 unpacked 目录构造检查清单 */
function targetsFor(unpackedDir: string, expected: 'x64' | 'arm64'): CheckTarget[] {
  const dirName = basename(unpackedDir);
  const label = (p: string): string => relative(ROOT, p).replace(/\\/g, '/');
  const targets: CheckTarget[] = [];

  // node-pty：build/Release 下的编译产物（.node 与 winpty-agent.exe）
  for (const pattern of ['node', 'exe']) {
    const base = join(
      unpackedDir,
      'resources',
      'app.asar.unpacked',
      'node_modules',
      'node-pty',
      'build',
      'Release',
    );
    for (const file of collectFiles(base, (n) => n.endsWith(`.${pattern}`), 2)) {
      targets.push({ label: label(file), path: file, expected });
    }
  }

  // better-sqlite3：优先 build/Release（rebuild 产物），缺失则用其主动加载的 prebuild
  const sqliteBase = join(
    unpackedDir,
    'resources',
    'app.asar.unpacked',
    'node_modules',
    'better-sqlite3',
  );
  const sqliteRelease = collectFiles(
    join(sqliteBase, 'build', 'Release'),
    (n) => n.endsWith('.node'),
    1,
  );
  if (sqliteRelease.length > 0) {
    for (const file of sqliteRelease) {
      targets.push({ label: label(file), path: file, expected });
    }
  } else {
    // 回退：包内 prebuilds/<platform>-<arch>.node（better-sqlite3 的加载器优先用它）
    const platformDir = dirName.startsWith('win')
      ? 'win32'
      : dirName.startsWith('linux')
        ? 'linux'
        : 'darwin';
    const prebuild = join(sqliteBase, 'prebuilds', `${platformDir}-${expected}.node`);
    try {
      if (statSync(prebuild).isFile()) {
        targets.push({ label: label(prebuild), path: prebuild, expected });
      }
    } catch {
      // 未命中：该平台可能用 build/Release 之外的布局，交由"未检查到任何目标"分支报告
    }
  }

  // codegraph 平台捆绑包（extraResources 按 ${arch} 选取）
  const resourcesDir = resourcesDirOf(unpackedDir);
  for (const rel of [
    join('codegraph', 'node.exe'), // Windows
    join('codegraph', 'bin', 'codegraph'), // 其他平台
  ]) {
    const file = join(resourcesDir, rel);
    try {
      if (statSync(file).isFile()) {
        targets.push({ label: label(file), path: file, expected });
      }
    } catch {
      // 不存在即跳过（平台差异）
    }
  }

  return targets;
}

/** 检查单个文件 */
function checkFile(
  target: CheckTarget,
  result: {
    checked: number;
    skipped: number;
    mismatches: Array<{ label: string; expected: string; actual: BinaryArch }>;
  },
): void {
  let buf: Buffer;
  try {
    const fd = readFileSync(target.path);
    buf = fd.subarray(0, Math.min(HEADER_BYTES, fd.length));
  } catch {
    result.skipped += 1;
    return;
  }
  const info = detectBinaryInfo(buf);
  if (info === null) {
    // 脚本/GZip 等非目标格式：跳过（不误报）
    result.skipped += 1;
    return;
  }
  result.checked += 1;
  if (!archMatches(info.arch, target.expected)) {
    result.mismatches.push({ label: target.label, expected: target.expected, actual: info.arch });
  }
}

function main(): void {
  const dirs = findUnpackedDirs();
  if (dirs.length === 0) {
    console.log('[check-native-arch] 跳过：未找到 release/*-unpacked 或 mac* 目录');
    return;
  }

  const result: CheckResult & {
    checked: number;
    skipped: number;
    mismatches: Array<{ label: string; expected: string; actual: BinaryArch }>;
  } = {
    checked: 0,
    skipped: 0,
    mismatches: [],
  };

  for (const dir of dirs) {
    const expected = expectedArchFromDirName(basename(dir));
    if (expected === null) {
      console.log(`[check-native-arch] ⏭ 跳过无法判定架构的目录：${basename(dir)}`);
      continue;
    }
    const targets = targetsFor(dir, expected);
    if (targets.length === 0) {
      console.log(
        `[check-native-arch] ⏭ ${basename(dir)}（${expected}）：未发现可检查的原生二进制（可能未含原生依赖）`,
      );
      continue;
    }
    for (const target of targets) {
      checkFile(target, result);
    }
  }

  console.log(
    `[check-native-arch] 已检查 ${result.checked} 个二进制（跳过 ${result.skipped} 个非目标格式/不可读）`,
  );

  if (result.mismatches.length > 0) {
    console.error('[check-native-arch] ❌ 原生模块架构与目标不符：');
    for (const m of result.mismatches) {
      console.error(`  ${m.label}：期望 ${m.expected}，实际 ${m.actual}`);
    }
    console.error(
      '  原因通常是「在 A 架构 runner 上为 B 架构打包」（@electron/rebuild 会静默复用 host 架构）。',
    );
    console.error('  修法：用目标架构的原生 runner 构建，或安装对应交叉工具链。');
    process.exit(1);
  }

  console.log('[check-native-arch] ✅ 通过：所有原生模块与目标架构一致');
}

main();
