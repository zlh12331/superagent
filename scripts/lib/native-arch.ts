// scripts/lib/native-arch.ts
// 本机二进制格式与架构识别（ELF / PE / Mach-O）
// ──────────────────────────────────────────────────────────────
// 用途：打包产物的原生模块架构断言（scripts/check-native-arch.ts）。
// 为什么需要：2026-09-20 实测发现「在 x64 机器上为 arm64 目标打包」时，
// @electron/rebuild 会以 0.4s 的耗时"成功"完成（实际未产出 aarch64 二进制，
// 静默复用了 host 架构）——产出的 arm64 安装包内是 x64 原生模块，用户装上会崩。
// 该失败在构建日志里**没有任何错误**，只能靠读二进制头识别。
//
// 三类格式的识别依据（均为官方格式规范的最小必要字段）：
// - ELF（Linux）：magic 7F 'E' 'L' 'F'；e_machine 位于偏移 18（uint16 LE）
// - PE（Windows）：'MZ' 头；偏移 0x3C 为 PE 头偏移（uint32 LE），
//   'PE\0\0' 后紧跟 Machine（uint16 LE）
// - Mach-O（macOS）：magic 0xFEEDFACF（64 位）/ 0xFEEDFACE（32 位）；
//   cputype 位于偏移 4（uint32 LE）；fat/universal 为 0xCAFEBABE
// ──────────────────────────────────────────────────────────────

/** 支持的架构标识（与 electron-builder 的 Arch 名称一致） */
export type BinaryArch = 'x64' | 'arm64' | 'ia32' | 'armv7l' | 'universal';

/** 识别结果 */
export interface BinaryInfo {
  /** 容器格式 */
  readonly format: 'elf' | 'pe' | 'macho';
  /** 架构；universal（fat Mach-O）表示同时含多架构 */
  readonly arch: BinaryArch;
}

/** 判定所需的最小字节数（覆盖三种格式的表头） */
const MIN_HEADER_BYTES = 64;

function readU16le(buf: Buffer, offset: number): number | null {
  if (offset + 2 > buf.length) {
    return null;
  }
  return buf.readUInt16LE(offset);
}

function readU32le(buf: Buffer, offset: number): number | null {
  if (offset + 4 > buf.length) {
    return null;
  }
  return buf.readUInt32LE(offset);
}

/** ELF e_machine → 架构 */
function elfArch(machine: number): BinaryArch | null {
  switch (machine) {
    case 0x3e: // EM_X86_64
      return 'x64';
    case 0xb7: // EM_AARCH64
      return 'arm64';
    case 0x03: // EM_386
      return 'ia32';
    case 0x28: // EM_ARM
      return 'armv7l';
    default:
      return null;
  }
}

/** PE Machine → 架构 */
function peArch(machine: number): BinaryArch | null {
  switch (machine) {
    case 0x8664: // IMAGE_FILE_MACHINE_AMD64
      return 'x64';
    case 0xaa64: // IMAGE_FILE_MACHINE_ARM64
      return 'arm64';
    case 0x014c: // IMAGE_FILE_MACHINE_I386
      return 'ia32';
    case 0x01c4: // IMAGE_FILE_MACHINE_ARMNT
      return 'armv7l';
    default:
      return null;
  }
}

/** Mach-O cputype → 架构 */
function machoArch(cpuType: number): BinaryArch | null {
  switch (cpuType) {
    case 0x01000007: // CPU_TYPE_X86_64
      return 'x64';
    case 0x0100000c: // CPU_TYPE_ARM64
      return 'arm64';
    case 0x00000007: // CPU_TYPE_X86
      return 'ia32';
    case 0x0000000c: // CPU_TYPE_ARM
      return 'armv7l';
    default:
      return null;
  }
}

/**
 * 识别二进制文件的格式与架构
 *
 * @param buf 文件头字节（至少 64 字节；不足时返回 null）
 * @returns 识别结果；无法识别（非二进制 / 未知架构 / 头不完整）时为 null
 */
export function detectBinaryInfo(buf: Buffer): BinaryInfo | null {
  if (buf.length < MIN_HEADER_BYTES) {
    return null;
  }

  // ELF
  if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) {
    const machine = readU16le(buf, 18);
    const arch = machine === null ? null : elfArch(machine);
    return arch === null ? null : { format: 'elf', arch };
  }

  // PE（MZ + PE 头）
  if (buf[0] === 0x4d && buf[1] === 0x5a) {
    const peOffset = readU32le(buf, 0x3c);
    if (peOffset === null || peOffset + 6 > buf.length) {
      return null;
    }
    if (
      buf[peOffset] !== 0x50 || // 'P'
      buf[peOffset + 1] !== 0x45 || // 'E'
      buf[peOffset + 2] !== 0x00 ||
      buf[peOffset + 3] !== 0x00
    ) {
      return null;
    }
    const machine = readU16le(buf, peOffset + 4);
    const arch = machine === null ? null : peArch(machine);
    return arch === null ? null : { format: 'pe', arch };
  }

  // Mach-O（thin）
  const magic = readU32le(buf, 0);
  if (magic === 0xfeedfacf || magic === 0xfeedface) {
    const cpuType = readU32le(buf, 4);
    const arch = cpuType === null ? null : machoArch(cpuType);
    return arch === null ? null : { format: 'macho', arch };
  }
  // Mach-O（fat / universal）：同时含多架构，按 universal 处理
  if (magic === 0xcafebabe || magic === 0xbebafeca) {
    return { format: 'macho', arch: 'universal' };
  }

  return null;
}

/**
 * 架构是否匹配期望
 *
 * universal（fat Mach-O）视为匹配任意期望架构——它确实同时包含两者。
 */
export function archMatches(actual: BinaryArch, expected: 'x64' | 'arm64'): boolean {
  return actual === expected || actual === 'universal';
}

/**
 * 从 unpacked 目录名推断目标架构
 *
 * electron-builder 的目录命名（platformPackager.computeAppOutDir）：
 * `${platform}${getArchSuffix(arch, defaultArch)}-unpacked`，x64 为默认架构故不带
 * 后缀（win-unpacked / linux-unpacked / mac），arm64 带 `-arm64` 后缀。
 *
 * @param dirName 目录 basename（如 win-unpacked / linux-arm64-unpacked / mac-arm64）
 * @returns 期望架构；无法从名字判断时为 null（调用方应跳过而非误判）
 */
export function expectedArchFromDirName(dirName: string): 'x64' | 'arm64' | null {
  if (dirName.includes('-arm64')) {
    return 'arm64';
  }
  if (dirName.endsWith('-x64')) {
    return 'x64';
  }
  if (dirName.startsWith('win-') || dirName.startsWith('linux-') || dirName === 'mac') {
    return 'x64';
  }
  return null;
}
