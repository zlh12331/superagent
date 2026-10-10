// scripts/lib/native-arch.ts
// 本机二进制格式与架构识别（ELF / PE / Mach-O），供 check-native-arch.ts 用——
// 2026-09-20 实测「x64 机器为 arm64 打包」时 @electron/rebuild 以 0.4s 假成功
// （静默复用 host 架构、日志零报错），装上即崩；唯一可靠探针是读二进制头
// 识别依据均为官方格式规范最小字段：ELF magic+e_machine@18 / PE MZ+PE 偏移@0x3C+
// Machine / Mach-O magic FEEDFACF(64)+cputype@4（fat=CAFEBABE）

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
    case 0x3e:
      return 'x64';
    case 0xb7:
      return 'arm64';
    case 0x03:
      return 'ia32';
    case 0x28:
      return 'armv7l';
    default:
      return null;
  }
}

/** PE Machine → 架构 */
function peArch(machine: number): BinaryArch | null {
  switch (machine) {
    case 0x8664:
      return 'x64';
    case 0xaa64:
      return 'arm64';
    case 0x014c:
      return 'ia32';
    case 0x01c4:
      return 'armv7l';
    default:
      return null;
  }
}

/** Mach-O cputype → 架构 */
function machoArch(cpuType: number): BinaryArch | null {
  switch (cpuType) {
    case 0x01000007:
      return 'x64';
    case 0x0100000c:
      return 'arm64';
    case 0x00000007:
      return 'ia32';
    case 0x0000000c:
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

  if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) {
    const machine = readU16le(buf, 18);
    const arch = machine === null ? null : elfArch(machine);
    return arch === null ? null : { format: 'elf', arch };
  }

  if (buf[0] === 0x4d && buf[1] === 0x5a) {
    const peOffset = readU32le(buf, 0x3c);
    if (peOffset === null || peOffset + 6 > buf.length) {
      return null;
    }
    if (
      buf[peOffset] !== 0x50 ||
      buf[peOffset + 1] !== 0x45 ||
      buf[peOffset + 2] !== 0x00 ||
      buf[peOffset + 3] !== 0x00
    ) {
      return null;
    }
    const machine = readU16le(buf, peOffset + 4);
    const arch = machine === null ? null : peArch(machine);
    return arch === null ? null : { format: 'pe', arch };
  }

  const magic = readU32le(buf, 0);
  if (magic === 0xfeedfacf || magic === 0xfeedface) {
    const cpuType = readU32le(buf, 4);
    const arch = cpuType === null ? null : machoArch(cpuType);
    return arch === null ? null : { format: 'macho', arch };
  }
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
