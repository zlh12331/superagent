import { isAbsolute } from 'node:path';

import { resolveRealTarget } from '../ai/tools/path-guard';

const MAX_GRANTS = 200;

const grants = new Map<string, number>();

function canonicalize(inputPath: string): string | null {
  const trimmed = inputPath.trim();
  if (trimmed.length === 0 || !isAbsolute(trimmed)) return null;
  return resolveRealTarget(trimmed);
}

export function grantUserReadPaths(paths: readonly string[]): number {
  let added = 0;
  for (const p of paths) {
    const canonical = canonicalize(p);
    if (canonical === null) continue;
    if (!grants.has(canonical)) {
      added += 1;
      if (grants.size >= MAX_GRANTS) {
        const oldest = grants.keys().next();
        if (!oldest.done) grants.delete(oldest.value);
      }
    }
    grants.delete(canonical);
    grants.set(canonical, Date.now());
  }
  return added;
}

export function matchUserGrantedReadPath(inputPath: string): string | null {
  const canonical = canonicalize(inputPath);
  if (canonical === null) return null;
  return grants.has(canonical) ? canonical : null;
}

export function userReadGrantCount(): number {
  return grants.size;
}

export function clearUserReadGrants(): void {
  grants.clear();
}
