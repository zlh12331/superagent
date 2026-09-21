// scripts/merge-update-metadata.test.ts
// 合并 CLI 的「双架构来源判定」单测
// ──────────────────────────────────────────────────────────────
// CLI 主体做的是目录遍历与文件读写（在 CD 里验证），但其**判定逻辑**是纯函数，
// 且是 CD 回滚路径的关键：回滚到「单 job 双架构」后 merge job 仍在流水线里，
// 必须识别「这份已是双架构」并原样透传，否则回滚后流水线会卡在 merge 阶段。
// ──────────────────────────────────────────────────────────────

import { isAlreadyDualArch } from './merge-update-metadata';

/**
 * 真实的 v1.3.2 macOS 双架构元数据（原样取自 release 资产，逐字节）
 *
 * 内联而非读文件：单测不得依赖 .tmp/ 等临时产物（会被清理）。
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

/** 拆开后的单架构（仅 x64） */
const SINGLE_X64 = `version: 1.3.2
files:
  - url: Code-Agent-Desktop-macOS-x64.zip
    sha512: aaa
path: Code-Agent-Desktop-macOS-x64.zip
sha512: aaa
`;

/** 单架构（仅 arm64） */
const SINGLE_ARM64 = `version: 1.3.2
files:
  - url: Code-Agent-Desktop-macOS-arm64.zip
    sha512: bbb
path: Code-Agent-Desktop-macOS-arm64.zip
sha512: bbb
`;

describe('isAlreadyDualArch · 回滚形态判定', () => {
  it('真实的双架构元数据（含 x64 与 arm64 条目）→ true', () => {
    expect(isAlreadyDualArch(REAL_MAC_V132)).toBe(true);
  });

  it('只有 x64 的单架构元数据 → false', () => {
    expect(isAlreadyDualArch(SINGLE_X64)).toBe(false);
  });

  it('只有 arm64 的单架构元数据 → false', () => {
    expect(isAlreadyDualArch(SINGLE_ARM64)).toBe(false);
  });

  it('Windows 形态（exe 而非 zip/dmg）同样可判定', () => {
    const win = `version: 1.3.2
files:
  - url: Code-Agent-Desktop-Windows-x64.exe
    sha512: aaa
  - url: Code-Agent-Desktop-Windows-arm64.exe
    sha512: bbb
path: Code-Agent-Desktop-Windows-x64.exe
sha512: aaa
`;
    expect(isAlreadyDualArch(win)).toBe(true);
  });

  it('只有 arm64 的两个条目（zip + dmg）→ false（不误判为双架构）', () => {
    const armOnly = `version: 1.3.2
files:
  - url: Code-Agent-Desktop-macOS-arm64.zip
    sha512: bbb
  - url: Code-Agent-Desktop-macOS-arm64.dmg
    sha512: ccc
path: Code-Agent-Desktop-macOS-arm64.zip
sha512: bbb
`;
    expect(isAlreadyDualArch(armOnly)).toBe(false);
  });

  it('判定是字面匹配 -<arch>.：无关文案里的 arm64 不算数', () => {
    // 刻意保持廉价（不做语义解析）：判定只看内容里有没有 `-x64.` 与 `-arm64.`
    // 两个字面串。语义正确性由 mergeUpdateMetadata 的结构校验兜底
    // （真正的双架构输入必然能通过 parseUpdateInfo）。
    const decoy = `${SINGLE_X64}note: 修复 arm64-bugfix-1234 相关路径
`;
    expect(isAlreadyDualArch(decoy)).toBe(false);
  });
});
