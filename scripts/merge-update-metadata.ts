// scripts/merge-update-metadata.ts
// 合并 Windows / macOS 的双架构更新元数据（CD 拆 job 后的必需配套）
// ──────────────────────────────────────────────────────────────
// 背景：CD 的 build 从「Windows/macOS 各 1 个 job 兼双架构」拆成「每架构 1 个 job」
// 后，两个 job 都会产出同名元数据（latest.yml / latest-mac.yml）——release job 用
// `cp -n` 收集，只有一份能生效，另一架构的用户将拿不到自己的更新条目。本 CLI 在
// merge job 里把两份合成一份（Linux 的元数据本就按架构分文件，不参与合并）。
//
// 用法（无路径参数——源/目标目录是脚本内常量，见下）：
//   tsx scripts/merge-update-metadata.ts
//     · 读   artifacts/          （download-artifact 落盘的目录）
//     · 写   merged-meta/        （作为独立 artifact 上传，供 release job 取用）
//
// 为什么不留 --dir/--out 之类的路径开关：本脚本在 CI 里只在两个固定目录间搬运，
// 开放路径参数会引入不必要的路径注入面。本地复现时把产物放到 artifacts/ 即可；
// 合并逻辑本身是纯函数（scripts/lib/update-metadata.ts），单测直接覆盖。
//
// 合并语义见 scripts/lib/update-metadata.ts 的文件头（与 electron-builder 对齐）。
// ──────────────────────────────────────────────────────────────

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { MergeInput, UpdateArch } from './lib/update-metadata';
import { mergeUpdateMetadata } from './lib/update-metadata';

/** 仓库根（脚本以 pnpm 从根执行） */
const ROOT = process.cwd();
/** 输入：download-artifact 的落盘目录（脚本内常量，非参数） */
const SOURCE_DIR_NAME = 'artifacts';
/** 输出：合并结果目录（作为独立 artifact 上传） */
const OUT_DIR_NAME = 'merged-meta';
/** 需要合并的元数据文件名（Linux 的 latest-linux*.yml 按架构分文件，不在列） */
const MERGEABLE_NAMES: readonly string[] = ['latest.yml', 'latest-mac.yml'];
/** 扫描深度上限（产物目录形如 artifacts/release-win-x64-<ref>/latest.yml） */
const MAX_SCAN_DEPTH = 3;

/** 递归收集指定名字的文件（仅遍历子目录，名字来自脚本内常量表） */
function collectByName(dir: string, names: readonly string[], depth = 0): string[] {
  if (depth > MAX_SCAN_DEPTH) {
    return [];
  }
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    let isDir: boolean;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      found.push(...collectByName(full, names, depth + 1));
    } else if (names.includes(entry)) {
      found.push(full);
    }
  }
  return found;
}

/**
 * 从相对路径推断架构
 *
 * 依据 artifact 名（`release-win-x64-<ref>` / `release-mac-arm64-<ref>`）。
 */
function archFromPath(relPath: string): UpdateArch | null {
  if (relPath.includes('arm64')) {
    return 'arm64';
  }
  if (relPath.includes('x64')) {
    return 'x64';
  }
  return null;
}

/** 报告实际找到的那一份架构（用于"缺另一份"的错误信息） */
function presentArch(x64: string | undefined, arm64: string | undefined): string {
  if (x64 !== undefined) {
    return 'x64';
  }
  return arm64 !== undefined ? 'arm64' : '未知架构';
}

/** 在产物根下按元数据名找出 x64 / arm64 两份 */
function findPair(
  files: readonly string[],
  dir: string,
  name: string,
): { pair: Partial<Record<UpdateArch, string>>; unclassified: string[] } {
  const pair: Partial<Record<UpdateArch, string>> = {};
  const unclassified: string[] = [];
  const normalizedDir = dir.replace(/\\/g, '/');
  for (const file of files) {
    const normalizedFile = file.replace(/\\/g, '/');
    if (!normalizedFile.endsWith(`/${name}`)) {
      continue;
    }
    const arch = archFromPath(relative(normalizedDir, normalizedFile).replace(/\\/g, '/'));
    if (arch !== null) {
      if (pair[arch] === undefined) {
        pair[arch] = file;
      }
    } else {
      // 路径里没有架构串：可能是 CD 回滚到「单 job 双架构」后的产物
      // （artifact-suffix 回到 win / mac），也可能是目录结构不符预期
      unclassified.push(file);
    }
  }
  return { pair, unclassified };
}

/**
 * 该元数据是否已含双架构条目（用于判定「已是合并后的形态」）
 *
 * CD 回滚到「单 job 双架构」后，merge job 仍在流水线里、但收到的是单份双架构
 * 元数据（artifact-suffix 回到 win / mac，路径里没有架构串）。此判定让它原样透传。
 * 导出供单测直接覆盖（CLI 主流程不便构造该目录形态）。
 */
export function isAlreadyDualArch(content: string): boolean {
  return content.includes('-x64.') && content.includes('-arm64.');
}

function main(): void {
  const sourceDir = join(ROOT, SOURCE_DIR_NAME);
  const outDir = join(ROOT, OUT_DIR_NAME);

  const files = collectByName(sourceDir, MERGEABLE_NAMES);
  if (files.length === 0) {
    console.error(
      `[merge-update-metadata] ❌ 在 ${SOURCE_DIR_NAME}/ 下未找到 ${MERGEABLE_NAMES.join(' / ')}`,
    );
    process.exit(1);
  }
  mkdirSync(outDir, { recursive: true });

  // 每个待合并的元数据必须能确定「双架构来源」，否则失败。
  // 两种可接受的形态：
  //   a) 两份单架构（拆 job 后的正常形态）→ 合并；
  //   b) 一份且已含双架构条目（CD 回滚到「单 job 双架构」后的形态）→ 原样透传。
  // 其余情况（只有一份且是单架构）说明上游 build job 没按预期产出，严格失败：
  // 让问题在 merge 阶段暴露，而不是拖到 publish 的资产断言。
  const problems: string[] = [];
  try {
    for (const name of MERGEABLE_NAMES) {
      const { pair, unclassified } = findPair(files, sourceDir, name);
      const { x64, arm64 } = pair;

      if (x64 !== undefined && arm64 !== undefined) {
        const inputs: MergeInput[] = [
          { arch: 'x64', content: readFileSync(x64, 'utf-8') },
          { arch: 'arm64', content: readFileSync(arm64, 'utf-8') },
        ];
        const output = join(outDir, name);
        writeFileSync(output, mergeUpdateMetadata(inputs), 'utf-8');
        console.log(
          `[merge-update-metadata] ✅ ${name}：合并 x64 + arm64 → ${relative(ROOT, output)}`,
        );
        continue;
      }

      // 无架构标签的候选（回滚场景）：若已是双架构则透传
      const candidates = [...unclassified, x64 ?? arm64].filter(
        (candidate): candidate is string => candidate !== undefined,
      );
      const alreadyMerged = candidates.find((candidate) =>
        isAlreadyDualArch(readFileSync(candidate, 'utf-8')),
      );
      if (candidates.length === 1 && alreadyMerged !== undefined) {
        const output = join(outDir, name);
        writeFileSync(output, readFileSync(alreadyMerged), 'utf-8');
        console.log(
          `[merge-update-metadata] ⏭ ${name}：输入已是双架构（单 job 形态），原样透传 → ${relative(ROOT, output)}`,
        );
        continue;
      }

      const unclassifiedNote =
        unclassified.length > 0 ? `，其中无架构标签的 ${String(unclassified.length)} 份` : '';
      problems.push(
        `${name}（找到 ${candidates.length} 份：${presentArch(x64, arm64)}${unclassifiedNote}）`,
      );
    }
  } catch (error) {
    console.error(
      `[merge-update-metadata] ❌ ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }

  if (problems.length > 0) {
    console.error(
      `[merge-update-metadata] ❌ 以下元数据无法确定为双架构来源：${problems.join('；')}`,
    );
    console.error(
      '  预期每个 build job 各产一份（Windows: release-win-x64 / release-win-arm64；' +
        'macOS: release-mac-x64 / release-mac-arm64），或单份已是双架构（回滚形态）。' +
        '请核对 build 矩阵与 artifact-suffix。',
    );
    process.exit(1);
  }
}

// 仅在被直接执行时运行主逻辑（被单测 import 时不执行——本脚本 main() 会读写
// artifacts/ 并在失败时 exit(1)，无守卫会让导入它的测试进程直接中断）
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
