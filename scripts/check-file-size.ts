// scripts/check-file-size.ts
// 文件行数门槛（工程化强制）：新文件 ≤300 行，存量超限文件豁免清单渐进清理
// ──────────────────────────────────────────────────────────────
// 依据 typescript-dev-standards-ai.md §工程：文件 ≤300 行。
// 策略（与 check:bundle 一致）：豁免清单记录存量超限文件（2026-08-11 基线 32 个），
// 清单外文件超 300 行即卡关；存量文件重构变短后应从清单移除。
//
// 运行：pnpm check:file-size
// ──────────────────────────────────────────────────────────────

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const SCAN_DIRS = [
  join(ROOT, 'src', 'main'),
  join(ROOT, 'src', 'renderer'),
  join(ROOT, 'src', 'preload'),
];
const LIMIT = 300;

// 存量超限豁免清单（2026-08-11 基线 32 个；重构拆短后移除）
const EXEMPT = new Set([
  'src/main/infra/storage/session-service.ts',
  'src/main/infra/ai/agent/agent-service.ts',
  'src/main/service-container.ts',
  'src/renderer/dev/mock-api.ts',
  'src/renderer/components/chat/ChatInput.tsx',
  'src/main/infra/ai/tools/permission-service.ts',
  'src/main/infra/file/file-service.ts',
  'src/renderer/components/layout/right-panel-panes.tsx',
  'src/main/infra/search/search-service.ts',
  'src/main/infra/git/git-service.ts',
  'src/main/infra/ai/agent/chat-service.ts',
  'src/renderer/components/chat/message-item.tsx',
  'src/main/infra/im/adapters/qq-stream.ts',
  'src/renderer/components/layout/Sidebar.tsx',
  'src/main/index.ts',
  'src/renderer/components/file-tree/fuzzy-search-dialog.tsx',
  'src/main/infra/codebase/codebase-service.ts',
  'src/main/infra/lsp/lsp-client.ts',
  'src/main/infra/ai/knowledge/memory-service.ts',
  'src/renderer/components/layout/thread-item.tsx',
  'src/main/infra/terminal/terminal-service.ts',
  'src/renderer/components/chat/ChatPanel.tsx',
  'src/renderer/components/file-tree/FileViewerDialog.tsx',
  'src/renderer/components/settings/sections/models-section.tsx',
  'src/renderer/components/layout/AppShell.tsx',
  'src/renderer/routes/home.tsx',
  'src/main/infra/ai/tools/tool-executor.ts',
  'src/main/infra/ai/providers/registry.ts',
  'src/main/infra/storage/schema.ts',
  'src/main/infra/im/adapters/weixin-stream.ts',
  'src/main/infra/ai/llm-client/llm-client.ts',
  'src/renderer/components/chat/Markdown.tsx',
  'src/main/infra/ai/agent/context-compression.ts',
  'src/main/infra/ai/mcp/mcp-client.ts',
  'src/main/infra/im/adapters/dingtalk-stream.ts',
  'src/renderer/components/chat/ChatMessageList.tsx',
  'src/renderer/components/common/CommandPalette.tsx',
  'src/renderer/components/dev/browser-pane.tsx',
  'src/renderer/components/file-tree/FileTreeNode.tsx',
  'src/renderer/components/ui/dropdown-menu.tsx',
  'src/renderer/hooks/use-sessions.ts',
  'src/renderer/stores/transient/file-tree-store.ts',
]);

function collectFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(full, acc);
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      if (!entry.name.includes('.test.')) acc.push(full);
    }
  }
  return acc;
}

function main(): number {
  const files = SCAN_DIRS.flatMap((d) => collectFiles(d));
  const problems: Array<{ file: string; lines: number }> = [];

  for (const file of files) {
    const rel = relative(ROOT, file).replace(/\\/g, '/');
    const lines = readFileSync(file, 'utf8').split('\n').length;
    if (lines > LIMIT && !EXEMPT.has(rel)) {
      problems.push({ file: rel, lines });
    }
  }

  if (problems.length === 0) {
    console.log(
      `[check-file-size] ✅ 通过：${files.length} 文件，0 超限（豁免清单 ${EXEMPT.size} 个存量）`,
    );
    return 0;
  }

  console.error(`[check-file-size] ❌ ${problems.length} 个文件超 ${LIMIT} 行（豁免清单外）：`);
  for (const p of problems) console.error(`  ${p.file}: ${p.lines} 行`);
  console.error(
    '[check-file-size] 修复指引：拆分文件（typescript-dev-standards-ai.md §工程）；存量文件移除豁免需先重构',
  );
  return 1;
}

process.exitCode = main();
