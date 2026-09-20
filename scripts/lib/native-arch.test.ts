// scripts/lib/native-arch.test.ts
// 二进制格式/架构识别单测
// ──────────────────────────────────────────────────────────────
// 覆盖动机：该模块是「架构错配」这一静默缺陷的唯一探针（构建日志不会报错），
// 识别逻辑必须对三种格式、各架构、以及非二进制/截断输入都有确定行为。
// 测试用合成头（按格式规范手工构造最小字节序列），不依赖真实二进制文件。
// ──────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';

import { archMatches, detectBinaryInfo, expectedArchFromDirName } from './native-arch';

/** 构造 ELF 头（e_machine 在偏移 18，uint16 LE） */
function makeElf(machine: number): Buffer {
  const buf = Buffer.alloc(64);
  buf.writeUInt8(0x7f, 0);
  buf.writeUInt8(0x45, 1); // 'E'
  buf.writeUInt8(0x4c, 2); // 'L'
  buf.writeUInt8(0x46, 3); // 'F'
  buf.writeUInt16LE(machine, 18);
  return buf;
}

/** 构造 PE 头（'MZ' + 偏移 0x3C 指向 PE 头 + Machine） */
function makePe(machine: number): Buffer {
  const buf = Buffer.alloc(256);
  buf.writeUInt8(0x4d, 0); // 'M'
  buf.writeUInt8(0x5a, 1); // 'Z'
  const peOffset = 0x80;
  buf.writeUInt32LE(peOffset, 0x3c);
  buf.writeUInt8(0x50, peOffset); // 'P'
  buf.writeUInt8(0x45, peOffset + 1); // 'E'
  buf.writeUInt8(0x00, peOffset + 2);
  buf.writeUInt8(0x00, peOffset + 3);
  buf.writeUInt16LE(machine, peOffset + 4);
  return buf;
}

/** 构造 Mach-O 头（magic + cputype） */
function makeMacho(magic: number, cpuType: number): Buffer {
  const buf = Buffer.alloc(64);
  buf.writeUInt32LE(magic, 0);
  buf.writeUInt32LE(cpuType, 4);
  return buf;
}

describe('detectBinaryInfo', () => {
  describe('ELF', () => {
    it('x86-64（e_machine=0x3E）→ x64', () => {
      expect(detectBinaryInfo(makeElf(0x3e))).toEqual({ format: 'elf', arch: 'x64' });
    });

    it('AArch64（0xB7）→ arm64', () => {
      expect(detectBinaryInfo(makeElf(0xb7))).toEqual({ format: 'elf', arch: 'arm64' });
    });

    it('i386（0x03）→ ia32；ARM（0x28）→ armv7l', () => {
      expect(detectBinaryInfo(makeElf(0x03))?.arch).toBe('ia32');
      expect(detectBinaryInfo(makeElf(0x28))?.arch).toBe('armv7l');
    });

    it('未知 e_machine → null（不猜测）', () => {
      expect(detectBinaryInfo(makeElf(0x1234))).toBeNull();
    });
  });

  describe('PE', () => {
    it('AMD64（0x8664）→ x64', () => {
      expect(detectBinaryInfo(makePe(0x8664))).toEqual({ format: 'pe', arch: 'x64' });
    });

    it('ARM64（0xAA64）→ arm64', () => {
      expect(detectBinaryInfo(makePe(0xaa64))).toEqual({ format: 'pe', arch: 'arm64' });
    });

    it('i386（0x014C）→ ia32', () => {
      expect(detectBinaryInfo(makePe(0x014c))?.arch).toBe('ia32');
    });

    it('MZ 但 PE 偏移越界 → null（截断文件不误判）', () => {
      const buf = Buffer.alloc(64);
      buf.writeUInt8(0x4d, 0);
      buf.writeUInt8(0x5a, 1);
      buf.writeUInt32LE(0xffff, 0x3c);
      expect(detectBinaryInfo(buf)).toBeNull();
    });

    it('MZ 但 PE 签名缺失 → null（非 PE 文件）', () => {
      const buf = Buffer.alloc(256);
      buf.writeUInt8(0x4d, 0);
      buf.writeUInt8(0x5a, 1);
      buf.writeUInt32LE(0x80, 0x3c);
      expect(detectBinaryInfo(buf)).toBeNull();
    });
  });

  describe('Mach-O', () => {
    it('thin x86_64（0x01000007）→ x64', () => {
      expect(detectBinaryInfo(makeMacho(0xfeedfacf, 0x01000007))).toEqual({
        format: 'macho',
        arch: 'x64',
      });
    });

    it('thin arm64（0x0100000C）→ arm64', () => {
      expect(detectBinaryInfo(makeMacho(0xfeedfacf, 0x0100000c))).toEqual({
        format: 'macho',
        arch: 'arm64',
      });
    });

    it('fat/universal（0xCAFEBABE）→ universal', () => {
      expect(detectBinaryInfo(makeMacho(0xcafebabe, 0))).toEqual({
        format: 'macho',
        arch: 'universal',
      });
    });

    it('未知 cputype → null', () => {
      expect(detectBinaryInfo(makeMacho(0xfeedfacf, 0x12345678))).toBeNull();
    });
  });

  describe('非二进制与边界输入', () => {
    it('纯文本 → null', () => {
      expect(detectBinaryInfo(Buffer.from('#!/bin/sh\necho hello'.padEnd(80, ' ')))).toBeNull();
    });

    it('空 buffer / 过短 → null（不抛错）', () => {
      expect(detectBinaryInfo(Buffer.alloc(0))).toBeNull();
      expect(detectBinaryInfo(Buffer.alloc(10))).toBeNull();
      expect(detectBinaryInfo(makeElf(0x3e).subarray(0, 20))).toBeNull();
    });
  });
});

describe('archMatches', () => {
  it('精确匹配', () => {
    expect(archMatches('x64', 'x64')).toBe(true);
    expect(archMatches('arm64', 'arm64')).toBe(true);
  });

  it('错配 → false（核心用途：捕获交叉构建静默失败）', () => {
    expect(archMatches('x64', 'arm64')).toBe(false);
    expect(archMatches('arm64', 'x64')).toBe(false);
  });

  it('universal 视为匹配任意期望（fat 二进制确实含两者）', () => {
    expect(archMatches('universal', 'x64')).toBe(true);
    expect(archMatches('universal', 'arm64')).toBe(true);
  });

  it('其他架构（ia32/armv7l）不匹配 x64/arm64', () => {
    expect(archMatches('ia32', 'x64')).toBe(false);
    expect(archMatches('armv7l', 'arm64')).toBe(false);
  });
});

describe('expectedArchFromDirName', () => {
  it('带 -arm64 后缀 → arm64（win-arm64-unpacked / linux-arm64-unpacked / mac-arm64）', () => {
    expect(expectedArchFromDirName('win-arm64-unpacked')).toBe('arm64');
    expect(expectedArchFromDirName('linux-arm64-unpacked')).toBe('arm64');
    expect(expectedArchFromDirName('mac-arm64')).toBe('arm64');
  });

  it('无后缀的默认架构目录 → x64', () => {
    expect(expectedArchFromDirName('win-unpacked')).toBe('x64');
    expect(expectedArchFromDirName('linux-unpacked')).toBe('x64');
    expect(expectedArchFromDirName('mac')).toBe('x64');
  });

  it('显式 -x64 后缀 → x64（旧版 electron-builder 可能产出 mac-x64）', () => {
    expect(expectedArchFromDirName('mac-x64')).toBe('x64');
    expect(expectedArchFromDirName('win-x64-unpacked')).toBe('x64');
  });

  it('无法判断的名字 → null（调用方跳过，不误判）', () => {
    expect(expectedArchFromDirName('some-random-dir')).toBeNull();
    expect(expectedArchFromDirName('mac-universal')).toBeNull();
  });
});
