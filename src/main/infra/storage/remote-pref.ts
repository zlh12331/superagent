import type { RemoteBindScope } from '@code-agent/shared/main';

import { readSetting, writeSetting } from './settings-pref';

const REMOTE_BIND_SCOPE_KEY = 'remote.bindScope';

const DEFAULT_BIND_SCOPE: RemoteBindScope = 'lan';

export function readRemoteBindScope(): RemoteBindScope {
  const raw = readSetting(REMOTE_BIND_SCOPE_KEY);
  return raw === 'loopback' || raw === 'lan' ? raw : DEFAULT_BIND_SCOPE;
}

export function writeRemoteBindScope(scope: RemoteBindScope): void {
  writeSetting(REMOTE_BIND_SCOPE_KEY, scope);
}

export function resolveBindAddress(scope: RemoteBindScope): string {
  return scope === 'loopback' ? '127.0.0.1' : '0.0.0.0';
}
