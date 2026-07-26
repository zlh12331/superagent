// src/renderer/components/novel/Character/CharacterPanel.tsx
// 角色管理面板组件
// ──────────────────────────────────────────────────────────────
// 职责：
// - 角色列表 + 详情编辑
// - 从 IPC 获取数据
// - 支持添加/删除角色
// ──────────────────────────────────────────────────────────────

import { Plus, User, UserX } from 'lucide-react';
import { type ReactElement, useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { getNovelApi } from '@/types/novel-api';

interface CharacterPanelProps {
  projectId: string;
}

export function CharacterPanel({ projectId }: CharacterPanelProps): ReactElement {
  const [characters, setCharacters] = useState<CharacterData[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<CharacterData | null>(null);
  const [showNewForm, setShowNewForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newRole, setNewRole] = useState('');

  const loadCharacters = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getNovelApi().character.list({ projectId });
      setCharacters(res.data);
    } catch {
      toast.error('加载角色列表失败');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void loadCharacters();
  }, [loadCharacters]);

  const handleCreate = useCallback(async () => {
    if (!newName.trim()) return;
    try {
      const res = await getNovelApi().character.create({
        projectId,
        name: newName.trim(),
        role: newRole.trim() || '龙套',
      });
      setCharacters((prev) => [...prev, res.data]);
      setShowNewForm(false);
      setNewName('');
      setNewRole('');
      setSelectedId(res.data.id);
      setEditing(res.data);
    } catch {
      toast.error('创建角色失败');
    }
  }, [projectId, newName, newRole]);

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        await getNovelApi().character.delete({ id });
        setCharacters((prev) => prev.filter((c) => c.id !== id));
        if (selectedId === id) {
          setSelectedId(null);
          setEditing(null);
        }
      } catch {
        toast.error('删除角色失败');
      }
    },
    [selectedId],
  );

  const handleUpdate = useCallback(
    async (updates: Partial<CharacterData>) => {
      if (!editing) return;
      try {
        const res = await getNovelApi().character.update({
          id: editing.id,
          ...updates,
        });
        setCharacters((prev) => prev.map((c) => (c.id === res.data.id ? res.data : c)));
        setEditing(res.data);
        toast.success('已更新');
      } catch {
        toast.error('更新失败');
      }
    },
    [editing],
  );

  if (loading) {
    return (
      <div className="text-muted-foreground flex items-center justify-center py-8 text-xs">
        加载中...
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* 顶栏 */}
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-xs font-medium">角色</span>
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground rounded px-1.5 py-0.5 text-xs transition-colors"
          onClick={() => setShowNewForm(true)}
        >
          <Plus className="size-3" />
        </button>
      </div>

      {/* 新建表单 */}
      {showNewForm && (
        <div className="border-b px-3 py-2">
          <input
            className="border-input bg-background text-foreground placeholder:text-muted-foreground mb-1 w-full rounded border px-2 py-1 text-xs"
            placeholder="角色名称"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            autoFocus
          />
          <div className="flex gap-1">
            <input
              className="border-input bg-background text-foreground placeholder:text-muted-foreground flex-1 rounded border px-2 py-1 text-xs"
              placeholder="角色定位（主角/重要/龙套）"
              value={newRole}
              onChange={(e) => setNewRole(e.target.value)}
            />
            <button
              type="button"
              className="rounded bg-primary px-2 py-1 text-xs text-white"
              onClick={handleCreate}
            >
              添加
            </button>
            <button
              type="button"
              className="text-muted-foreground rounded px-2 py-1 text-xs"
              onClick={() => setShowNewForm(false)}
            >
              取消
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-1 flex-row overflow-hidden">
        {/* 角色列表 */}
        <div className="w-28 shrink-0 border-r">
          <ScrollArea className="h-full">
            {characters.length === 0 ? (
              <div className="text-muted-foreground px-2 py-4 text-center text-[10px]">
                暂无角色
              </div>
            ) : (
              characters.map((character) => (
                <button
                  key={character.id}
                  type="button"
                  className={cn(
                    'hover:bg-accent flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-xs transition-colors',
                    selectedId === character.id && 'bg-accent',
                  )}
                  onClick={() => {
                    setSelectedId(character.id);
                    setEditing(character);
                  }}
                >
                  <User className="size-3 shrink-0" />
                  <span className="truncate">{character.name}</span>
                </button>
              ))
            )}
          </ScrollArea>
        </div>

        {/* 详情编辑 */}
        <div className="flex-1">
          {editing === null ? (
            <div className="text-muted-foreground flex items-center justify-center py-8 text-xs">
              选择角色查看详情
            </div>
          ) : (
            <ScrollArea className="h-full">
              <div className="flex flex-col gap-2 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium">{editing.name}</span>
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-destructive rounded p-0.5 transition-colors"
                    onClick={() => handleDelete(editing.id)}
                  >
                    <UserX className="size-3" />
                  </button>
                </div>

                <div className="flex flex-col gap-2">
                  <Field label="别名" value={editing.aliases.join(', ')} onChange={(v) => handleUpdate({ aliases: v ? v.split(/[,，]/).map((s) => s.trim()).filter(Boolean) : [] })} />
                  <Field label="角色定位" value={editing.role} onChange={(v) => handleUpdate({ role: v })} />
                  <FieldArea label="外貌" value={editing.appearance} onChange={(v) => handleUpdate({ appearance: v })} />
                  <FieldArea label="性格" value={editing.personality} onChange={(v) => handleUpdate({ personality: v })} />
                  <FieldArea label="背景" value={editing.background} onChange={(v) => handleUpdate({ background: v })} />
                  <FieldArea label="能力" value={editing.abilities} onChange={(v) => handleUpdate({ abilities: v })} />
                </div>
              </div>
            </ScrollArea>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}): ReactElement {
  return (
    <div>
      <label className="text-muted-foreground mb-0.5 block text-[10px]">{label}</label>
      <input
        className="border-input bg-background text-foreground w-full rounded border px-2 py-1 text-xs"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function FieldArea({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}): ReactElement {
  return (
    <div>
      <label className="text-muted-foreground mb-0.5 block text-[10px]">{label}</label>
      <textarea
        className="border-input bg-background text-foreground min-h-[60px] w-full rounded border px-2 py-1 text-xs"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

export default CharacterPanel;
