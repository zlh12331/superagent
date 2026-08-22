// src/renderer/components/settings/sections/workspace-section.tsx
// 工作区 pane（对齐 Trae Work：文件树/工作区相关设置）
// ──────────────────────────────────────────────────────────────
// 展示当前工作目录与文件树状态（file-tree-store 真实数据）。
// 文件树行为：忽略模式（每行一条，主进程 file:list 现读——改后即生效）+
// 默认展开层级（1-3，下次打开/切换项目生效）。
// 语言服务器：LSP 按语言命令行覆盖（settings-store lsp 分组写穿透 SQLite，
// 主进程 getLspManager 构造时读取；重启生效）。
// ──────────────────────────────────────────────────────────────

import { FolderTree } from 'lucide-react';
import type { ReactElement } from 'react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useTranslation } from '@/i18n/use-translation';
import { useSettingsStore } from '@/stores/persistent/settings-store';
import { useFileTreeStore } from '@/stores/transient/file-tree-store';
import { SectionTitle, SegControl, SettingRow } from '../settings-controls';

/** 语言服务器配置项（key 与主进程 ls-config 的 LsLanguage 对齐） */
const LS_LANGUAGE_OPTIONS: readonly {
  key: string;
  label: 'TypeScript' | 'Python' | 'Go' | 'Rust';
  placeholder: string;
}[] = [
  { key: 'typescript', label: 'TypeScript', placeholder: 'typescript-language-server --stdio' },
  { key: 'python', label: 'Python', placeholder: 'pyright-langserver --stdio' },
  { key: 'go', label: 'Go', placeholder: 'gopls' },
  { key: 'rust', label: 'Rust', placeholder: 'rust-analyzer' },
];

/** 工作区 pane */
export function WorkspaceSection(): ReactElement {
  const { t } = useTranslation();
  const rootPath = useFileTreeStore((state) => state.rootPath);
  const expandedCount = useFileTreeStore((state) => state.expandedPaths.size);
  const lsp = useSettingsStore((s) => s.lsp);
  const updateLsp = useSettingsStore((s) => s.updateLsp);
  const workspace = useSettingsStore((s) => s.workspace);
  const updateWorkspace = useSettingsStore((s) => s.updateWorkspace);

  return (
    <div className="flex flex-col gap-3 pt-2">
      <div className="flex items-center gap-2">
        <FolderTree className="text-muted-foreground size-3.5" strokeWidth={1.5} />
        <h3 className="text-foreground text-sm font-semibold">{t('settings.nav.workspace')}</h3>
      </div>

      <div className="border-border bg-muted/20 rounded-md border p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground text-xs">{t('settings.workspaceRoot')}</span>
          <span
            className="text-foreground min-w-0 truncate font-mono text-xs"
            title={rootPath ?? undefined}
          >
            {rootPath ?? t('settings.workspaceEmpty')}
          </span>
        </div>
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <span className="text-muted-foreground text-xs">{t('settings.workspaceExpanded')}</span>
          <span className="text-foreground font-mono text-xs">{expandedCount}</span>
        </div>
      </div>

      {/* 文件树行为（忽略模式即时生效；展开层级下次打开/切换项目生效） */}
      <SectionTitle>{t('settings.tree.title')}</SectionTitle>
      <SettingRow
        label={t('settings.tree.expandDepth')}
        description={t('settings.tree.expandDepthHint')}
      >
        <SegControl
          value={String(workspace.defaultExpandDepth)}
          onChange={(value) => updateWorkspace({ defaultExpandDepth: Number(value) })}
          options={[
            { value: '1', label: '1' },
            { value: '2', label: '2' },
            { value: '3', label: '3' },
          ]}
        />
      </SettingRow>
      <SettingRow
        label={t('settings.tree.ignorePatterns')}
        description={t('settings.tree.ignoreHint')}
      >
        <Textarea
          className="max-w-[320px] font-mono text-xs"
          placeholder={'node_modules\ndist\n*.log'}
          rows={4}
          value={workspace.treeIgnorePatterns.join('\n')}
          onChange={(e) =>
            updateWorkspace({
              treeIgnorePatterns: e.target.value
                .split('\n')
                .map((line) => line.trim())
                .filter((line) => line.length > 0),
            })
          }
          spellCheck={false}
        />
      </SettingRow>

      {/* 语言服务器（LSP 按语言覆盖命令行；主进程构造 manager 时读取，重启生效） */}
      <SectionTitle>{t('settings.lsp.title')}</SectionTitle>
      <p className="text-muted-foreground max-w-md text-xs leading-relaxed">
        {t('settings.lsp.hint')}
      </p>
      <div className="flex flex-col gap-1.5">
        {LS_LANGUAGE_OPTIONS.map((option) => (
          <SettingRow key={option.key} label={option.label}>
            <Input
              className="max-w-[320px] font-mono text-xs"
              placeholder={option.placeholder}
              value={lsp.serverCommands[option.key] ?? ''}
              onChange={(e) =>
                updateLsp({
                  serverCommands: { ...lsp.serverCommands, [option.key]: e.target.value },
                })
              }
              spellCheck={false}
            />
          </SettingRow>
        ))}
      </div>
    </div>
  );
}
