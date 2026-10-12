// remote-pref.ts：远程控制绑定范围持久化（settings 表 remote.bindScope 键）
import type { RemoteBindScope } from '@code-agent/shared/main';

import { readSetting, writeSetting } from './settings-pref';

const REMOTE_BIND_SCOPE_KEY = 'remote.bindScope';

// 默认绑局域网（远程功能的产品定位是跨机使用）；loopback 是用户显式收紧项
const DEFAULT_BIND_SCOPE: RemoteBindScope = 'lan';

/** 读绑定范围（值域窄校验，未知值回落默认） */
export function readRemoteBindScope(): RemoteBindScope {
  const raw = readSetting(REMOTE_BIND_SCOPE_KEY);
  return raw === 'loopback' || raw === 'lan' ? raw : DEFAULT_BIND_SCOPE;
}

/** 写绑定范围（remote:setBindScope 调用，启停侧同时热切换） */
export function writeRemoteBindScope(scope: RemoteBindScope): void {
  writeSetting(REMOTE_BIND_SCOPE_KEY, scope);
}

/** 范围 → 实际监听地址（loopback 只听本机，lan 听全部网卡） */
export function resolveBindAddress(scope: RemoteBindScope): string {
  return scope === 'loopback' ? '127.0.0.1' : '0.0.0.0';
}
