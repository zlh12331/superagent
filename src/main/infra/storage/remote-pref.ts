// src/main/infra/storage/remote-pref.ts
// 远程控制绑定范围持久化（app_settings 表，主进程直读 SQLite）
// ──────────────────────────────────────────────────────────────
// 背景（2026-09-27 绑定范围设置，用户拍板 C 方案）：
// 远程控制 HTTP 此前固定监听 0.0.0.0（LAN 直连是功能前提），部分用户只需
// 本机使用、不愿向局域网暴露入口。绑定范围收敛为两态：
// - lan：监听 0.0.0.0 + UDP 发现广播（现状默认，兼容存量行为）
// - loopback：仅监听 127.0.0.1 + 停发 UDP 公告（仅本机模式不应向局域网广播自身存在）
//
// 存储：复用 app_settings 表（key = 'remote.bindScope'），与 im-allowlist-pref
// 同模式：主进程直接读 SQLite，不经渲染层 settings 域白名单（SETTING_KEYS 不动）。
// ──────────────────────────────────────────────────────────────

import type { RemoteBindScope } from '@code-agent/shared/main';

import { readSetting, writeSetting } from './settings-pref';

/** 设置 key（受 KEY_PATTERN 约束：字母开头 + 字母数字/点/下划线/连字符） */
const REMOTE_BIND_SCOPE_KEY = 'remote.bindScope';

/** 默认绑定范围：lan（兼容现状——存量行为即局域网直连） */
const DEFAULT_BIND_SCOPE: RemoteBindScope = 'lan';

/**
 * 读取绑定范围（同步；未设置/损坏/非法值回退默认 'lan'）
 */
export function readRemoteBindScope(): RemoteBindScope {
  const raw = readSetting(REMOTE_BIND_SCOPE_KEY);
  return raw === 'loopback' || raw === 'lan' ? raw : DEFAULT_BIND_SCOPE;
}

/** 覆盖写入绑定范围（供 IPC handler 调用） */
export function writeRemoteBindScope(scope: RemoteBindScope): void {
  writeSetting(REMOTE_BIND_SCOPE_KEY, scope);
}

/**
 * 绑定范围 → HTTP listen 地址
 *
 * lan → '0.0.0.0'（全部网卡，局域网可达）；loopback → '127.0.0.1'（仅本机可达）。
 * 未知值按默认 lan 处理（保守面宽=兼容现状，与 readRemoteBindScope 回退一致）。
 */
export function resolveBindAddress(scope: RemoteBindScope): string {
  return scope === 'loopback' ? '127.0.0.1' : '0.0.0.0';
}
