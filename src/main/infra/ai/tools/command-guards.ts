import { homedir } from 'node:os';
import { isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { splitShellWords } from '../../terminal/terminal-service';
import { resolveRealTarget } from './path-guard';

const UNIVERSAL_WHITELIST_PATTERN = /^[\s.*?]*$/;

export function isUniversalWhitelistPattern(pattern: string): boolean {
  return UNIVERSAL_WHITELIST_PATTERN.test(pattern);
}

export function matchesWhitelistPattern(command: string, pattern: string): boolean {
  const normalized = command.trim();
  const pat = pattern.trim();
  if (normalized === pat) {
    return true;
  }
  return normalized.startsWith(pat) && /\s/.test(normalized.charAt(pat.length));
}

export const PLAN_MODE_CONTROL_TOOLS: ReadonlySet<string> = new Set(['save_memory']);

const COMPOSITE_COMMAND_PATTERN = /[;|&`<>]|\$\(|\n/;

export function isCompositeCommand(command: string): boolean {
  return COMPOSITE_COMMAND_PATTERN.test(command);
}

const WIN_ABSOLUTE_PATTERN = /^[a-zA-Z]:[\\/]/;

export function commandTargetsOutsideBoundary(command: string, boundary: string): boolean {
  let tokens: string[];
  try {
    tokens = splitShellWords(command, process.platform);
  } catch {
    return true;
  }
  const realBoundary = resolveRealTarget(normalize(boundary));
  if (realBoundary === null) {
    return true;
  }
  const normBoundary = realBoundary.toLowerCase();
  for (const raw of tokens) {
    if (!isPathLikeToken(raw)) continue;
    if (isVariablePathToken(raw)) {
      return true;
    }
    let resolved: string;
    try {
      resolved = resolvePathToken(raw, boundary);
    } catch {
      return true;
    }
    const realTarget = resolveRealTarget(resolved);
    if (realTarget === null) {
      return true;
    }
    const rel = relative(normBoundary, realTarget.toLowerCase());
    if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) {
      return true;
    }
  }
  return false;
}

const URL_LIKE_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;

const PURE_VARIABLE_TOKEN = /^(?:\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|%[A-Za-z_][A-Za-z0-9_]*%)$/;
const VARIABLE_WITH_PATH = /\$\{?[A-Za-z_]|%[A-Za-z_][A-Za-z0-9_]*%/;

function isVariablePathToken(token: string): boolean {
  if (PURE_VARIABLE_TOKEN.test(token)) {
    return true;
  }
  return VARIABLE_WITH_PATH.test(token) && /[\\/]/.test(token);
}

function isPathLikeToken(token: string): boolean {
  if (WIN_ABSOLUTE_PATTERN.test(token) || token.startsWith('/') || token.startsWith('~')) {
    return true;
  }
  if (token === '..' || token.startsWith('../') || token.startsWith('..\\')) {
    return true;
  }
  if (URL_LIKE_PATTERN.test(token)) {
    return false;
  }
  if (isVariablePathToken(token)) {
    return true;
  }
  return token.includes('/') || token.includes('\\');
}

function resolvePathToken(token: string, boundary: string): string {
  if (token.startsWith('~')) {
    return resolve(join(homedir(), token.slice(1)));
  }
  if (WIN_ABSOLUTE_PATTERN.test(token) || token.startsWith('/')) {
    return normalize(token);
  }
  return resolve(boundary, token);
}

export function isZeroSideEffectTool(tool: { readonly category: string }): boolean {
  return tool.category === 'read' || tool.category === 'control';
}

export function isDeniedByPlanMode(
  mode: string,
  tool: { readonly name: string; readonly category: string },
): boolean {
  if (mode !== 'plan') {
    return false;
  }
  if (isZeroSideEffectTool(tool)) {
    return false;
  }
  return !PLAN_MODE_CONTROL_TOOLS.has(tool.name);
}

export function extractCommandFromInput(input: unknown): string | undefined {
  const CommandInputKeys = ['command', 'script', 'cmd', 'shell', 'bash'] as const;
  if (typeof input !== 'object' || input === null) {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  for (const key of CommandInputKeys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}
