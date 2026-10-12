// scripts/lib/update-metadata.ts
// 更新元数据（latest*.yml）双架构合并纯函数。背景：CD 每架构一个 build job 后，
// Windows/macOS 两 job 各产一份**同名**元数据——electron-builder 只对 Linux 追加
// 架构后缀，release job 的 cp -n 只有一份能生效 ⇒ 另一架构用户拿不到自己的条目
// 合并语义对齐 electron-builder 自身多架构合并（writeUpdateInfoFiles）：files 排序
// 先 zip 后 Arch 枚举序（MacUpdater 只下载 zip）；path/顶层 sha512/其余字段取首条；
// 序列化 js-yaml.dump({lineWidth:8000, noRefs:true}) 与 builder-util 逐字一致

import { dump, load } from 'js-yaml';

/** 参与合并的架构（本项目只发布这两种） */
export type UpdateArch = 'x64' | 'arm64';

/** 合并输入：一份单架构元数据及其架构声明 */
export interface MergeInput {
  /** 该份元数据所属架构（由调用方声明；用于排序与防串档校验） */
  readonly arch: UpdateArch;
  /** 元数据 YAML 文本 */
  readonly content: string;
}

/** 元数据中的单条文件记录（字段出自 builder-util-runtime 的 UpdateFileInfo） */
export interface UpdateFileEntry {
  url: string;
  sha512: string;
  size?: number;
  blockMapSize?: number;
  isAdminRightsRequired?: boolean;
}

/** 解析后的更新元数据（字段出自 builder-util-runtime 的 UpdateInfo） */
export interface UpdateInfo {
  version: string;
  files: UpdateFileEntry[];
  /** @deprecated electron-updater 1.x 兼容字段；仍被写入 */
  path: string;
  /**
   * @deprecated 同 path（electron-updater 1.x 兼容字段）
   *
   * 标为可选的原因：parseUpdateInfo 以展开运算原样透传来源字段，只强制校验
   * `path`，并未校验 sha512 ⇒ 类型如实反映「可能缺失」。
   * 未改为解析期强制校验，是因为那会收紧 CD 合并脚本的接受面（高风险），
   * 且本仓库无任何代码读取该字段（仅测试 fixture 中出现）。
   */
  sha512?: string;
  releaseName?: string | null;
  releaseNotes?: unknown;
  releaseDate?: string;
  stagingPercentage?: number;
  minimumSystemVersion?: string;
  /** 其余字段原样保留（如 Windows 的 packages / sha2） */
  [extra: string]: unknown;
}

/**
 * Arch 枚举序（builder-util/out/arch.js）——决定同类型条目的先后。
 *
 * 只列本项目涉及的两种；值必须与 electron-builder 的枚举值一致，否则合并出的
 * files 顺序会与「单 job 内构建双架构」的原生产物不同。
 */
const ARCH_RANK: Readonly<Record<UpdateArch, number>> = { x64: 1, arm64: 3 };

/** 与 builder-util 的 serializeToYaml 逐字一致的 dump 选项 */
const YAML_DUMP_OPTIONS = { lineWidth: 8000, skipInvalid: false, noRefs: true } as const;

/** 是否普通对象（排除 null 与数组） */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 提取并校验单条文件记录 */
function parseFileEntry(raw: unknown, label: string, index: number): UpdateFileEntry {
  if (!isRecord(raw)) {
    throw new Error(`${label}：files[${index}] 不是对象`);
  }
  const { url, sha512 } = raw;
  if (typeof url !== 'string' || url === '') {
    throw new Error(`${label}：files[${index}].url 缺失或非字符串`);
  }
  if (typeof sha512 !== 'string' || sha512 === '') {
    throw new Error(
      `${label}：files[${index}].sha512 缺失或非字符串（electron-updater 会拒绝无校验和的条目）`,
    );
  }
  const entry: UpdateFileEntry = { ...raw, url, sha512 };
  return entry;
}

/**
 * 解析并校验一份更新元数据
 *
 * 校验项与「用户侧能否正确选包」直接对应，不是形式检查：
 * - `files` 非空且每条含 url/sha512（缺 sha512 会被 electron-updater 以
 *   ERR_UPDATER_NO_CHECKSUM 拒绝）；
 * - `path` 必须指向 `files` 中已存在的条目（悬空 path 是 27-spec §14.11 修过的
 *   同类问题：元数据引用一个未被发布的资产）。
 *
 * @param content YAML 文本
 * @param label 出错信息中使用的来源标识（文件名或 artifact 名）
 */
export function parseUpdateInfo(content: string, label: string): UpdateInfo {
  let parsed: unknown;
  try {
    parsed = load(content);
  } catch (error) {
    throw new Error(
      `${label}：YAML 解析失败——${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new Error(`${label}：内容不是 YAML 映射`);
  }
  const { version, files, path: primary } = parsed;
  if (typeof version !== 'string' || version === '') {
    throw new Error(`${label}：version 缺失或非字符串`);
  }
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error(`${label}：files 缺失、非数组或为空`);
  }
  if (typeof primary !== 'string' || primary === '') {
    throw new Error(`${label}：path 缺失或非字符串`);
  }
  const entries = files.map((entry, index) => parseFileEntry(entry, label, index));
  if (!entries.some((entry) => entry.url === primary)) {
    throw new Error(
      `${label}：path="${primary}" 不在 files 中（悬空引用；electron-updater 1.x 回退路径会 404）`,
    );
  }
  return { ...parsed, version, files: entries, path: primary };
}

/**
 * 校验元数据确属声明的架构（防「两份同架构」或「传反」）
 *
 * 判定依据是主产物文件名是否含 `arm64`：与 electron-updater 的运行时选择逻辑
 * 同源（`url.includes('arm64')` / `includes(process.arch)`）。x64 侧只断言
 * 「不含 arm64」而不要求含 `x64`——Linux 的 x64 产物名用 `x86_64`/`amd64`，
 * 强求 `x64` 会误伤（虽然 Linux 不走合并，规则保持一致更安全）。
 */
function assertArchMatches(info: UpdateInfo, arch: UpdateArch, label: string): void {
  const primaryHasArm64 = info.path.includes('arm64');
  if (arch === 'arm64' && !primaryHasArm64) {
    throw new Error(
      `${label}：声明为 arm64，但主产物 "${info.path}" 不含 arm64——两份元数据可能传反或同架构`,
    );
  }
  if (arch === 'x64' && primaryHasArm64) {
    throw new Error(
      `${label}：声明为 x64，但主产物 "${info.path}" 含 arm64——两份元数据可能传反或同架构`,
    );
  }
}

/** files 排序键：(是否 zip, Arch 枚举序)——复刻 writeUpdateInfoFiles 的比较器 */
function compareEntries(
  a: UpdateFileEntry,
  aRank: number,
  b: UpdateFileEntry,
  bRank: number,
): number {
  const zipDiff =
    (a.url.toLowerCase().endsWith('.zip') ? 0 : 100) -
    (b.url.toLowerCase().endsWith('.zip') ? 0 : 100);
  if (zipDiff !== 0) {
    return zipDiff;
  }
  return aRank - bRank;
}

/**
 * 合并同平台双架构的更新元数据
 *
 * @param inputs 1 份或 2 份（1 份时原样返回，见下）；2 份时架构必须不同
 * @returns 合并后的 YAML 文本
 *
 * 单份输入**原样返回**（不做 parse→dump 往返）：这是 CD 回滚路径（退回单 job
 * 双架构）下的必需性质——此时合并步骤仍在流水线里，必须对已是双架构的输入幂等，
 * 且不因重新序列化引入任何字节差异。
 *
 * @throws 输入为空、架构重复、版本不一致、结构非法、主产物架构与声明不符
 */
export function mergeUpdateMetadata(inputs: readonly MergeInput[]): string {
  if (inputs.length === 0) {
    throw new Error('[merge-update-metadata] 没有输入');
  }
  if (inputs.length === 1) {
    const only = inputs[0];
    if (only === undefined) {
      throw new Error('[merge-update-metadata] 没有输入');
    }
    parseUpdateInfo(only.content, `输入(${only.arch})`);
    return only.content;
  }
  if (inputs.length > 2) {
    throw new Error(`[merge-update-metadata] 最多支持 2 份输入（收到 ${inputs.length} 份）`);
  }

  const first = inputs[0];
  const second = inputs[1];
  if (first === undefined || second === undefined) {
    throw new Error('[merge-update-metadata] 没有输入');
  }
  if (first.arch === second.arch) {
    throw new Error(`[merge-update-metadata] 两份输入架构相同（都是 ${first.arch}）——无法合并`);
  }

  const parsed = inputs.map((input) => {
    const label = `输入(${input.arch})`;
    const info = parseUpdateInfo(input.content, label);
    assertArchMatches(info, input.arch, label);
    return { arch: input.arch, label, info };
  });

  const [base, other] = parsed.sort((a, b) => ARCH_RANK[a.arch] - ARCH_RANK[b.arch]) as [
    (typeof parsed)[number],
    (typeof parsed)[number],
  ];
  if (base.info.version !== other.info.version) {
    throw new Error(
      `[merge-update-metadata] 版本不一致（${base.label}=${base.info.version}，${other.label}=${other.info.version}）——两份产物来自不同提交`,
    );
  }

  const tagged = [
    ...base.info.files.map((entry) => ({ entry, rank: ARCH_RANK[base.arch] })),
    ...other.info.files.map((entry) => ({ entry, rank: ARCH_RANK[other.arch] })),
  ];
  const urls = new Set<string>();
  for (const { entry } of tagged) {
    if (urls.has(entry.url)) {
      throw new Error(`[merge-update-metadata] 重复条目 "${entry.url}"——两份元数据可能内容相同`);
    }
    urls.add(entry.url);
  }
  tagged.sort((a, b) => compareEntries(a.entry, a.rank, b.entry, b.rank));

  const mergedFiles = tagged.map(({ entry }) => entry);
  const head = mergedFiles[0];
  if (head === undefined) {
    throw new Error('[merge-update-metadata] 合并后没有任何条目');
  }

  const merged: UpdateInfo = {
    ...base.info,
    files: mergedFiles,
    path: head.url,
    sha512: head.sha512,
  };
  return dump(merged, YAML_DUMP_OPTIONS);
}
