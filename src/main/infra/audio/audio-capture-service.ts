// src/main/infra/audio/audio-capture-service.ts
// 语音捕获服务：renderer（getUserMedia/MediaRecorder）→ IPC 流式 → WAV 文件
// ──────────────────────────────────────────────────────────────
// 背景：qwen audio-capture 是 native addon（wasapi/coreaudio 后端 + prebuilds 分发），
// 违反本项目"仅 3 个原生依赖"约束 → 不搬运。
// 收敛路径（Electron 官方推荐）：renderer 用 Web API 录音（零原生依赖），
// PCM 数据经 IPC 流式传入主进程，封装为 WAV 文件存储。
//
// 借鉴声明：
// 本模块参考 qwen-code 参考项目 packages/audio-capture
// （Copyright 2026 Qwen Team，SPDX-License-Identifier: Apache-2.0）的
// AudioCaptureOptions / 持续录音 / 停止取回 语义，按我们的技术栈收敛重写：
// - 移除 native addon（改用 renderer Web API + IPC 流式）
// - 保留录音生命周期（start/stop）与静音自动停止挂载点（silenceDetection 预留）
// ──────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../../utils/logger';

/** 录音结果 */
export interface AudioCaptureResult {
  /** 文件路径（WAV） */
  readonly path: string;
  /** 录音时长（毫秒） */
  readonly durationMs: number;
  /** 采样率 */
  readonly sampleRate: number;
  /** 通道数 */
  readonly channels: number;
  /** 字节数 */
  readonly byteLength: number;
}

/** 录音选项 */
export interface AudioCaptureOptions {
  /** 采样率（默认 16000——语音场景） */
  readonly sampleRate?: number;
  /** 通道数（默认 1） */
  readonly channels?: number;
  /** 静音自动停止挂载点（预留；renderer 侧 detection 由调用方实现） */
  readonly silenceDetection?: boolean;
}

/** WAV 头（44 字节 RIFF/PCM） */
export function buildWavHeader(sampleRate: number, channels: number, dataSize: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28); // byte rate (16-bit)
  header.writeUInt16LE(channels * 2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataSize, 40);
  return header;
}

/**
 * 语音捕获服务
 *
 * 生命周期：start → appendChunk（多次）→ stop；stop 后返回 WAV 文件路径。
 * 单实例同时仅允许一个录音会话（防冲突）。
 */
export class AudioCaptureService {
  private activeSession: {
    id: string;
    fd: number;
    path: string;
    dataSize: number;
    sampleRate: number;
    channels: number;
    startedAt: number;
  } | null = null;

  /** 录音存储目录（构造注入；默认 userData/recordings） */
  constructor(private readonly recordingsDir?: string) {}

  /**
   * 开始录音（创建 WAV 文件 + 占位头）
   *
   * @throws 已有活动录音会话时抛错
   * @returns 会话 id
   */
  start(options: AudioCaptureOptions = {}): string {
    if (this.activeSession !== null) {
      throw new Error('已有录音会话进行中');
    }
    const sampleRate = options.sampleRate ?? 16_000;
    const channels = options.channels ?? 1;
    const id = randomUUID();
    const dir = this.recordingsDir ?? join(process.cwd(), '.electron-user-data', 'recordings');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${id}.wav`);
    const fd = openSync(path, 'w');
    // 写入 44 字节占位头（stop 时回填真实大小）
    writeSync(fd, buildWavHeader(sampleRate, channels, 0));
    this.activeSession = { id, fd, path, dataSize: 0, sampleRate, channels, startedAt: Date.now() };
    logger.info({ id, sampleRate, channels }, '录音会话已开始');
    return id;
  }

  /**
   * 追加音频数据（PCM 16-bit LE）
   *
   * @throws 无活动会话时抛错
   */
  appendChunk(chunk: Uint8Array): void {
    const session = this.activeSession;
    if (session === null) {
      throw new Error('无活动录音会话');
    }
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    writeSync(session.fd, buffer);
    session.dataSize += buffer.length;
  }

  /**
   * 停止录音：回填 WAV 头 → 关闭文件 → 返回结果
   *
   * @throws 无活动会话时抛错
   */
  stop(): AudioCaptureResult {
    const session = this.activeSession;
    if (session === null) {
      throw new Error('无活动录音会话');
    }
    // 回填头（数据大小）
    const fd = session.fd;
    const header = buildWavHeader(session.sampleRate, session.channels, session.dataSize);
    writeSync(fd, header, 0, 44, 0); // 覆盖写入头部
    closeSync(fd);
    const durationMs = Math.round(
      (session.dataSize / (session.sampleRate * session.channels * 2)) * 1000,
    );
    const result: AudioCaptureResult = {
      path: session.path,
      durationMs,
      sampleRate: session.sampleRate,
      channels: session.channels,
      byteLength: 44 + session.dataSize,
    };
    this.activeSession = null;
    logger.info({ path: result.path, durationMs }, '录音会话已结束');
    return result;
  }

  /** 当前是否有活动录音会话 */
  get recording(): boolean {
    return this.activeSession !== null;
  }

  /** 当前活动会话 id（无会话为 null） */
  get activeSessionId(): string | null {
    return this.activeSession?.id ?? null;
  }

  /** 强制中止（异常路径清理）：关闭文件并丢弃 */
  cancel(): void {
    const session = this.activeSession;
    if (session === null) {
      return;
    }
    closeSync(session.fd);
    this.activeSession = null;
    logger.warn({ path: session.path }, '录音会话已中止（数据丢弃）');
  }
}
