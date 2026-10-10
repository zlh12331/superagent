import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TelemetryLevel } from '@code-agent/shared/main';
import { app } from 'electron';

const DEFAULT_LEVEL: TelemetryLevel = 'full';

const VALID_LEVELS: readonly TelemetryLevel[] = ['off', 'error-only', 'full'];

function getPrefPath(): string {
  return join(app.getPath('userData'), 'telemetry-pref.json');
}

interface TelemetryPref {
  level: TelemetryLevel;
}

export function readTelemetryLevelSync(): TelemetryLevel {
  try {
    const path = getPrefPath();
    if (!existsSync(path)) {
      return DEFAULT_LEVEL;
    }
    const content = readFileSync(path, 'utf8');
    const pref = JSON.parse(content) as Partial<TelemetryPref>;
    const level = pref.level;
    if (level !== undefined && VALID_LEVELS.includes(level)) {
      return level;
    }
    return DEFAULT_LEVEL;
  } catch {
    return DEFAULT_LEVEL;
  }
}

export async function writeTelemetryLevel(level: TelemetryLevel): Promise<void> {
  const path = getPrefPath();
  const dir = join(path, '..');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const pref: TelemetryPref = { level };
  writeFileSync(path, JSON.stringify(pref, null, 2), { encoding: 'utf8', mode: 0o600 });
}
