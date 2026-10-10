import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const AGENTS_MD_FILENAME = 'AGENTS.md';
const AGENTS_MD_FILENAME_LOWER = 'agents.md';

const BYTE_BUDGET = 8192;

export interface FoundAgentsMd {
  readonly path: string;
  readonly content: string;
}

function fileExists(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function findAgentsMdInDir(dir: string): string | null {
  const upperPath = join(dir, AGENTS_MD_FILENAME);
  if (fileExists(upperPath)) {
    return upperPath;
  }
  const lowerPath = join(dir, AGENTS_MD_FILENAME_LOWER);
  if (fileExists(lowerPath)) {
    return lowerPath;
  }
  return null;
}

interface AgentsMdMemoEntry {
  readonly files: readonly FoundAgentsMd[];
  readonly fileMtimes: ReadonlyMap<string, number>;
  readonly rootMtime: number;
}

const memo = new Map<string, AgentsMdMemoEntry>();

export function resetAgentsMdMemo(): void {
  memo.clear();
}

function mtimeOf(filePath: string): number | null {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

function isMemoFresh(root: string, entry: AgentsMdMemoEntry): boolean {
  if (mtimeOf(root) !== entry.rootMtime) {
    return false;
  }
  for (const [path, mtime] of entry.fileMtimes) {
    if (mtimeOf(path) !== mtime) {
      return false;
    }
  }
  return true;
}

function walkAgentsMdUpward(root: string, maxBytes: number): FoundAgentsMd[] {
  const results: FoundAgentsMd[] = [];
  let remainingBudget = maxBytes;
  let currentDir = root;

  for (let i = 0; i < 20; i += 1) {
    const filePath = findAgentsMdInDir(currentDir);
    if (filePath !== null) {
      try {
        const content = readFileSync(filePath, 'utf-8');
        if (content.trim().length > 0) {
          results.push({ path: filePath, content });
          remainingBudget -= Buffer.byteLength(content, 'utf-8');
          if (remainingBudget <= 0) {
            break;
          }
        }
      } catch {}
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  return results;
}

export function discoverAgentsMd(
  workingDir: string,
  maxBytes: number = BYTE_BUDGET,
): readonly FoundAgentsMd[] {
  const root = resolve(workingDir);
  const memoKey = `${root}\u0000${maxBytes}`;
  const cached = memo.get(memoKey);
  if (cached !== undefined && isMemoFresh(root, cached)) {
    return cached.files;
  }

  const results = walkAgentsMdUpward(root, maxBytes);
  memo.set(memoKey, {
    files: results,
    fileMtimes: new Map(results.map((file) => [file.path, mtimeOf(file.path) ?? 0])),
    rootMtime: mtimeOf(root) ?? 0,
  });
  return results;
}

export function formatAgentsMdSection(files: readonly FoundAgentsMd[]): string {
  if (files.length === 0) {
    return '';
  }

  const sections = files.map((file) => {
    const relativePath = file.path;
    return `## ${relativePath}\n${file.content.trim()}`;
  });

  return `# 项目约定（AGENTS.md）\n\n${sections.join('\n\n')}`;
}

export function resolveAgentsMd(workingDir: string): string {
  const files = discoverAgentsMd(workingDir);
  return formatAgentsMdSection(files);
}
