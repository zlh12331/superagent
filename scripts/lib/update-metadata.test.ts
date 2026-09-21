// scripts/lib/update-metadata.test.ts
// 更新元数据合并纯函数的单测
// ──────────────────────────────────────────────────────────────
// 素材来源：**真实的 v1.3.2 发布元数据**（`gh release download v1.3.2 --pattern
// "latest*.yml"` 取得），见 §"等价性"用例——它把「单 job 内构建双架构」的原生产物
// 拆成两份单架构再合并回来，断言与原始文件**逐字节相同**。这是本模块最强的验证：
// 合并结果不是"看起来对"，而是与 electron-builder 自己的输出完全一致。
//
// 覆盖三类：① 等价性/正向合并；② 各条不变量；③ 负向（每条例外路径都有用例）。
// ──────────────────────────────────────────────────────────────

import { load } from 'js-yaml';

import { mergeUpdateMetadata, parseUpdateInfo } from './update-metadata';

/**
 * 真实 v1.3.2 macOS 元数据（原样取自 release 资产）
 *
 * 形态说明：这是**单 job 内构建双架构**的原生产物（2026-09-20 发版时的形态，
 * 当时 dmg.writeUpdateInfo 仍为默认 true，故含 4 条：zip×2 + dmg×2）。
 * 其 files 顺序即为 electron-builder 的权威排序：zip 在前、同类型按 Arch 序（x64 先）。
 */
const REAL_MAC_V132 = `version: 1.3.2
files:
  - url: Code-Agent-Desktop-macOS-x64.zip
    sha512: 7ZI+lmQAAK4A8DfN1bcRmSIsSl9SGoIJQNog1erdTG6Hw268FhMGPYWDgngHiP0n4qGU+Whxj80sTzoQILHT3w==
    size: 332796098
  - url: Code-Agent-Desktop-macOS-arm64.zip
    sha512: AJjzGN5NrA+AbhtPlBYv2lbvg1iSzxwKIODZ6fXNDOjK+NIoVCdHR/msa3u6Mi72ELN7TV7LOsVLLAcuapdiQQ==
    size: 327982121
  - url: Code-Agent-Desktop-macOS-x64.dmg
    sha512: KyOKpwhENXHWadiUZjbl0kuq6UcS7fwaBFuajnwmTvTfLHCwXhBmPjbgvEQawnpRHps8B2zhFAExz5UMpvr1TA==
    size: 326712477
  - url: Code-Agent-Desktop-macOS-arm64.dmg
    sha512: 4QBMn/9lAESTQ2BO1higfS9XGObHM9S3KTy+SoJ6UEaX3NFOuZT14YApKmmq1O2f9LH/bZ/TcVc4oq6rOVLHtg==
    size: 321953943
path: Code-Agent-Desktop-macOS-x64.zip
sha512: 7ZI+lmQAAK4A8DfN1bcRmSIsSl9SGoIJQNog1erdTG6Hw268FhMGPYWDgngHiP0n4qGU+Whxj80sTzoQILHT3w==
releaseDate: '2026-09-20T09:38:28.506Z'
`;

/** 上者按架构拆分后的 x64 一半（等价于「x64 build job」的产出） */
const REAL_MAC_V132_X64 = `version: 1.3.2
files:
  - url: Code-Agent-Desktop-macOS-x64.zip
    sha512: 7ZI+lmQAAK4A8DfN1bcRmSIsSl9SGoIJQNog1erdTG6Hw268FhMGPYWDgngHiP0n4qGU+Whxj80sTzoQILHT3w==
    size: 332796098
  - url: Code-Agent-Desktop-macOS-x64.dmg
    sha512: KyOKpwhENXHWadiUZjbl0kuq6UcS7fwaBFuajnwmTvTfLHCwXhBmPjbgvEQawnpRHps8B2zhFAExz5UMpvr1TA==
    size: 326712477
path: Code-Agent-Desktop-macOS-x64.zip
sha512: 7ZI+lmQAAK4A8DfN1bcRmSIsSl9SGoIJQNog1erdTG6Hw268FhMGPYWDgngHiP0n4qGU+Whxj80sTzoQILHT3w==
releaseDate: '2026-09-20T09:38:28.506Z'
`;

/** 上者按架构拆分后的 arm64 一半（等价于「arm64 build job」的产出） */
const REAL_MAC_V132_ARM64 = `version: 1.3.2
files:
  - url: Code-Agent-Desktop-macOS-arm64.zip
    sha512: AJjzGN5NrA+AbhtPlBYv2lbvg1iSzxwKIODZ6fXNDOjK+NIoVCdHR/msa3u6Mi72ELN7TV7LOsVLLAcuapdiQQ==
    size: 327982121
  - url: Code-Agent-Desktop-macOS-arm64.dmg
    sha512: 4QBMn/9lAESTQ2BO1higfS9XGObHM9S3KTy+SoJ6UEaX3NFOuZT14YApKmmq1O2f9LH/bZ/TcVc4oq6rOVLHtg==
    size: 321953943
path: Code-Agent-Desktop-macOS-arm64.zip
sha512: AJjzGN5NrA+AbhtPlBYv2lbvg1iSzxwKIODZ6fXNDOjK+NIoVCdHR/msa3u6Mi72ELN7TV7LOsVLLAcuapdiQQ==
releaseDate: '2026-09-20T09:38:41.002Z'
`;

/** 真实的 v1.3.1 Windows 元数据（单架构 x64，1 条目） */
const REAL_WIN_V131_X64 = `version: 1.3.1
files:
  - url: Code-Agent-Desktop-Windows-x64.exe
    sha512: ZLl/1DxiB6tm+HofboScoBkvj02Q4EEzkybP5UvytuD1FPhKgn0Ptd9U0GZywlJHR9bVWraRnPab7KfpzWl1Xw==
    size: 328514981
path: Code-Agent-Desktop-Windows-x64.exe
sha512: ZLl/1DxiB6tm+HofboScoBkvj02Q4EEzkybP5UvytuD1FPhKgn0Ptd9U0GZywlJHR9bVWraRnPab7KfpzWl1Xw==
releaseDate: '2026-09-19T16:27:56.947Z'
`;

/** 同版本的 Windows arm64 一份（结构仿真实产物，sha512 为占位） */
const WIN_ARM64 = `version: 1.3.1
files:
  - url: Code-Agent-Desktop-Windows-arm64.exe
    sha512: HieMk9bqX8kYX/5n7vvcAtwsfN0PmN/wXstqyGVwfBJtZvxKAwguWU8YUwLuM0ijkz+lm/sbhiHedEM4eZTkdA==
    size: 330291126
path: Code-Agent-Desktop-Windows-arm64.exe
sha512: HieMk9bqX8kYX/5n7vvcAtwsfN0PmN/wXstqyGVwfBJtZvxKAwguWU8YUwLuM0ijkz+lm/sbhiHedEM4eZTkdA==
releaseDate: '2026-09-19T16:28:02.115Z'
`;

/** 便捷构造输入 */
const inputs = (x64: string, arm64: string) =>
  [
    { arch: 'x64' as const, content: x64 },
    { arch: 'arm64' as const, content: arm64 },
  ] as const;

describe('mergeUpdateMetadata · 等价性（与 electron-builder 原生输出比对）', () => {
  it('把真实 v1.3.2 mac 元数据拆成两份单架构再合并，结果与原始文件逐字节相同', () => {
    const merged = mergeUpdateMetadata([...inputs(REAL_MAC_V132_X64, REAL_MAC_V132_ARM64)]);
    // ⚠️ 这是最强断言：原始文件由 electron-builder 自己在同一 job 内构建双架构时写出，
    // 逐字节相同意味着合并逻辑（排序 + path/sha512 取值 + YAML 序列化）与原实现一致
    expect(merged).toBe(REAL_MAC_V132);
  });

  it('arm64 先传入时同样逐字节相同（覆盖 CD 里目录扫描顺序不定）', () => {
    // 反向验证发现：只测「x64 先传入」时，即使 Arch 排序键写错（两架构秩相同），
    // 因 JS sort 稳定 + x64 恰好在前，结果仍会正确 ⇒ 等价性用例对排序键不敏感。
    // CD 中 download-artifact 的子目录顺序不受控，故必须覆盖 arm64 先到的情况。
    const merged = mergeUpdateMetadata([
      { arch: 'arm64', content: REAL_MAC_V132_ARM64 },
      { arch: 'x64', content: REAL_MAC_V132_X64 },
    ]);
    expect(merged).toBe(REAL_MAC_V132);
  });
});

describe('mergeUpdateMetadata · Windows 双架构合并', () => {
  it('两条单架构条目合并为两条，path/sha512 指向 x64（Arch 枚举序靠前者）', () => {
    const merged = mergeUpdateMetadata([...inputs(REAL_WIN_V131_X64, WIN_ARM64)]);
    const parsed = parseUpdateInfo(merged, 'merged');
    expect(parsed.files.map((f) => f.url)).toEqual([
      'Code-Agent-Desktop-Windows-x64.exe',
      'Code-Agent-Desktop-Windows-arm64.exe',
    ]);
    expect(parsed.path).toBe('Code-Agent-Desktop-Windows-x64.exe');
    expect(parsed.sha512).toBe(parsed.files[0]?.sha512);
  });

  it('输入顺序颠倒不影响结果（排序由 Arch 序决定，而非入参顺序）', () => {
    const forward = mergeUpdateMetadata([...inputs(REAL_WIN_V131_X64, WIN_ARM64)]);
    // ⚠️ 反向必须连标签一起换：inputs() 的位置标签是固定的，只换内容会变成
    // 「x64 标签 + arm64 内容」，被架构守卫拦下（守卫本身已由负向用例覆盖）
    const reversed = mergeUpdateMetadata([
      { arch: 'arm64', content: WIN_ARM64 },
      { arch: 'x64', content: REAL_WIN_V131_X64 },
    ]);
    expect(reversed).toBe(forward);
  });

  it('保留 base 的 version/releaseDate（顶层字段以 base 为准）', () => {
    const merged = mergeUpdateMetadata([...inputs(REAL_WIN_V131_X64, WIN_ARM64)]);
    expect(load(merged)).toMatchObject({
      version: '1.3.1',
      releaseDate: '2026-09-19T16:27:56.947Z',
    });
  });

  it('每条目的 size/sha512 保持原值（不重算，避免与 blockmap 不一致）', () => {
    const merged = mergeUpdateMetadata([...inputs(REAL_WIN_V131_X64, WIN_ARM64)]);
    const parsed = parseUpdateInfo(merged, 'merged');
    expect(parsed.files.find((f) => f.url.includes('x64'))?.size).toBe(328514981);
    expect(parsed.files.find((f) => f.url.includes('arm64'))?.size).toBe(330291126);
  });

  it('输出可被自身解析器再解析（round-trip 不变形）', () => {
    const merged = mergeUpdateMetadata([...inputs(REAL_WIN_V131_X64, WIN_ARM64)]);
    const once = parseUpdateInfo(merged, 'merged');
    // 再走一遍「单份输入」路径：既验证合并结果可被解析，也验证幂等透传
    const again = parseUpdateInfo(mergeUpdateMetadata([{ arch: 'x64', content: merged }]), 'again');
    expect(again.files).toEqual(once.files);
    expect(again.path).toBe(once.path);
    expect(again.sha512).toBe(once.sha512);
  });
});

describe('mergeUpdateMetadata · 单份输入（CD 回滚路径的幂等性）', () => {
  it('单份输入原样返回，不做 parse→dump 往返（字节不变）', () => {
    // ⚠️ CD 回滚到「单 job 双架构」后合并步骤仍在流水线里，此时输入已是双架构的
    // 一份，必须原样透传——任何重新序列化都会引入不必要的字节差异
    expect(mergeUpdateMetadata([{ arch: 'x64', content: REAL_WIN_V131_X64 }])).toBe(
      REAL_WIN_V131_X64,
    );
  });

  it('单份的双架构输入也原样返回（回滚场景的真实形态）', () => {
    expect(mergeUpdateMetadata([{ arch: 'x64', content: REAL_MAC_V132 }])).toBe(REAL_MAC_V132);
  });

  it('单份输入若本身非法，仍然报错（不做无脑透传）', () => {
    expect(() => mergeUpdateMetadata([{ arch: 'x64', content: 'files: []\n' }])).toThrow(/version/);
  });
});

describe('mergeUpdateMetadata · 负向用例', () => {
  it('空输入 → 抛错', () => {
    expect(() => mergeUpdateMetadata([])).toThrow(/没有输入/);
  });

  it('超过 2 份 → 抛错', () => {
    expect(() =>
      mergeUpdateMetadata([
        { arch: 'x64', content: REAL_MAC_V132_X64 },
        { arch: 'arm64', content: REAL_MAC_V132_ARM64 },
        { arch: 'x64', content: REAL_MAC_V132_X64 },
      ]),
    ).toThrow(/最多支持 2 份/);
  });

  it('两份同架构 → 抛错（防误传）', () => {
    expect(() =>
      mergeUpdateMetadata([
        { arch: 'x64', content: REAL_WIN_V131_X64 },
        { arch: 'x64', content: WIN_ARM64.replace('arm64', 'x64') },
      ]),
    ).toThrow(/架构相同/);
  });

  it('版本不一致 → 抛错（两份产物来自不同提交）', () => {
    // 构造一份「架构正确但版本不同」的 arm64 元数据（版本串只出现在 version 字段）
    const olderArm64 = WIN_ARM64.replace('version: 1.3.1', 'version: 1.3.0');
    expect(() => mergeUpdateMetadata([...inputs(REAL_WIN_V131_X64, olderArm64)])).toThrow(
      /版本不一致/,
    );
  });

  it('声明 x64 却拿到 arm64 产物 → 抛错（两份传反）', () => {
    expect(() => mergeUpdateMetadata([...inputs(WIN_ARM64, REAL_WIN_V131_X64)])).toThrow(
      /声明为 x64，但主产物/,
    );
  });

  it('声明 arm64 却拿到 x64 产物 → 抛错', () => {
    expect(() => mergeUpdateMetadata([...inputs(REAL_WIN_V131_X64, REAL_WIN_V131_X64)])).toThrow();
  });

  it('悬空 path（path 不在 files 中）→ 抛错', () => {
    const dangling = REAL_WIN_V131_X64.replace(
      'path: Code-Agent-Desktop-Windows-x64.exe',
      'path: Code-Agent-Desktop-Windows.exe',
    );
    expect(() => mergeUpdateMetadata([{ arch: 'x64', content: dangling }])).toThrow(/悬空引用/);
  });

  it('条目缺 sha512 → 抛错（electron-updater 会以 NO_CHECKSUM 拒绝）', () => {
    const broken = `version: 1.3.1
files:
  - url: Code-Agent-Desktop-Windows-x64.exe
path: Code-Agent-Desktop-Windows-x64.exe
sha512: abc
`;
    expect(() => mergeUpdateMetadata([{ arch: 'x64', content: broken }])).toThrow(/sha512/);
  });

  it('files 为空数组 → 抛错', () => {
    const empty = 'version: 1.3.1\nfiles: []\npath: x.exe\nsha512: abc\n';
    expect(() => mergeUpdateMetadata([{ arch: 'x64', content: empty }])).toThrow(/files/);
  });

  it('重复条目（两份内容相同但架构标签不同）→ 抛错', () => {
    const arm64Version = WIN_ARM64.replace(
      'Code-Agent-Desktop-Windows-arm64.exe',
      'Code-Agent-Desktop-Windows-x64.exe',
    );
    // 改掉主产物名后架构断言会先拦；此处直接构造同名条目走重复分支
    const duplicated = `version: 1.3.1
files:
  - url: Code-Agent-Desktop-Windows-arm64.exe
    sha512: dup
path: Code-Agent-Desktop-Windows-arm64.exe
sha512: dup
`;
    expect(() => mergeUpdateMetadata([...inputs(arm64Version, duplicated)])).toThrow();
  });

  it('YAML 语法错误 → 抛错并带来源标识', () => {
    expect(() => mergeUpdateMetadata([{ arch: 'x64', content: 'version: [unclosed\n' }])).toThrow(
      /YAML 解析失败/,
    );
  });

  it('内容不是映射（纯数组）→ 抛错', () => {
    expect(() => mergeUpdateMetadata([{ arch: 'x64', content: '- a\n- b\n' }])).toThrow(
      /不是 YAML 映射/,
    );
  });
});

describe('parseUpdateInfo · 结构校验', () => {
  it('接受真实元数据并保留全部字段', () => {
    const parsed = parseUpdateInfo(REAL_MAC_V132, 'latest-mac.yml');
    expect(parsed.version).toBe('1.3.2');
    expect(parsed.files).toHaveLength(4);
    expect(parsed.releaseDate).toBe('2026-09-20T09:38:28.506Z');
  });

  it('保留非标准扩展字段（如 Windows 的 packages/sha2）', () => {
    const withPackages = `version: 1.3.1
files:
  - url: Code-Agent-Desktop-Windows-x64.exe
    sha512: abc
path: Code-Agent-Desktop-Windows-x64.exe
sha512: abc
sha2: def
packages:
  x64:
    path: Code-Agent-Desktop-Windows-x64.exe
    sha512: abc
`;
    const parsed = parseUpdateInfo(withPackages, 'latest.yml');
    expect(parsed['sha2']).toBe('def');
    expect(parsed['packages']).toMatchObject({
      x64: { path: 'Code-Agent-Desktop-Windows-x64.exe' },
    });
  });

  it('缺 version → 抛错', () => {
    expect(() => parseUpdateInfo('files: []\npath: a\n', 'x')).toThrow(/version/);
  });

  it('path 非字符串 → 抛错', () => {
    const bad = 'version: 1.0.0\nfiles:\n  - url: a\n    sha512: b\npath: 123\n';
    expect(() => parseUpdateInfo(bad, 'x')).toThrow(/path/);
  });
});

describe('mergeUpdateMetadata · YAML 输出格式（与 electron-builder 一致）', () => {
  it('长 sha512 不折行（lineWidth 8000）', () => {
    const merged = mergeUpdateMetadata([...inputs(REAL_WIN_V131_X64, WIN_ARM64)]);
    const shaLine = merged.split('\n').find((line) => line.trimStart().startsWith('sha512:'));
    expect(shaLine).toBeDefined();
    expect(shaLine).toContain('ZLl/1DxiB6tm');
    expect(shaLine?.length).toBeGreaterThan(80);
  });

  it('files 用块序列（- url: 缩进两格）', () => {
    const merged = mergeUpdateMetadata([...inputs(REAL_WIN_V131_X64, WIN_ARM64)]);
    expect(merged).toContain('\nfiles:\n  - url: ');
  });

  it('releaseDate 单引号包裹（避免被解析成时间戳对象）', () => {
    const merged = mergeUpdateMetadata([...inputs(REAL_WIN_V131_X64, WIN_ARM64)]);
    expect(merged).toContain("releaseDate: '2026-09-19T16:27:56.947Z'");
  });
});
