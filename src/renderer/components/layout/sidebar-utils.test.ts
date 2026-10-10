import { describe, expect, it } from 'vitest';

import {
  buildSidebarEntries,
  filterSessions,
  getFolderName,
  groupSessionsByFolder,
  type SidebarSession,
} from './sidebar-utils';

/** 会话构造器：只填必查字段，其余给合法默认 */
function sess(overrides: Partial<SidebarSession> & { id: string }): SidebarSession {
  return {
    title: `标题${overrides.id}`,
    lastMessage: undefined,
    updatedAt: 1000,
    workingDir: 'C:\\proj\\repo-a',
    pinned: false,
    lastRunStatus: 'idle',
    ...overrides,
  };
}

describe('getFolderName', () => {
  it('取 basename（Windows 反斜杠）', () => {
    expect(getFolderName('C:\\Users\\me\\repo-a')).toBe('repo-a');
  });
  it('取 basename（POSIX 斜杠）', () => {
    expect(getFolderName('/home/me/repo-b')).toBe('repo-b');
  });
  it('无分隔符时返回原值', () => {
    expect(getFolderName('repo-c')).toBe('repo-c');
  });
  it('空串返回空串', () => {
    expect(getFolderName('')).toBe('');
  });

  it('回归：尾部分隔符不产生空串（此前 split().pop() 返回 ""，与无尾斜杠路径分裂成两组）', () => {
    expect(getFolderName('C:\\proj\\src\\')).toBe('src');
    expect(getFolderName('/proj/src/')).toBe('src');
    expect(getFolderName('C:\\proj\\src\\')).toBe(getFolderName('C:\\proj\\src'));
  });

  it('边界：文件系统根给出真实标签（而非空串归入「未分组」）', () => {
    expect(getFolderName('/')).toBe('/');
    expect(getFolderName('C:\\')).toBe('C:');
  });
});

describe('filterSessions', () => {
  const sessions = [
    sess({ id: '1', title: 'Fix login bug', workingDir: 'C:\\proj\\frontend' }),
    sess({ id: '2', title: '添加支付功能', workingDir: 'C:\\proj\\backend' }),
    sess({ id: '3', title: 'Docs update', workingDir: 'D:\\work\\FrontEnd' }),
  ];

  it('空白关键词：原样返回（不重排）', () => {
    expect(filterSessions(sessions, '')).toEqual(sessions);
    expect(filterSessions(sessions, '   ')).toEqual(sessions);
  });

  it('标题匹配（大小写不敏感）', () => {
    expect(filterSessions(sessions, 'FIX').map((s) => s.id)).toEqual(['1']);
    expect(filterSessions(sessions, 'login').map((s) => s.id)).toEqual(['1']);
  });

  it('workingDir 匹配', () => {
    expect(filterSessions(sessions, 'backend').map((s) => s.id)).toEqual(['2']);
  });

  it('中英混合关键词', () => {
    expect(filterSessions(sessions, '支付').map((s) => s.id)).toEqual(['2']);
  });

  it('无匹配返回空数组', () => {
    expect(filterSessions(sessions, 'nope')).toEqual([]);
  });
});

describe('groupSessionsByFolder', () => {
  it('按 basename 分组并保持输入顺序', () => {
    const grouped = groupSessionsByFolder([
      sess({ id: '1', workingDir: 'C:\\a\\repo' }),
      sess({ id: '2', workingDir: 'C:\\b\\other' }),
      sess({ id: '3', workingDir: 'C:\\c\\repo' }),
    ]);
    expect(grouped.get('repo')?.map((s) => s.id)).toEqual(['1', '3']);
    expect(grouped.get('other')?.map((s) => s.id)).toEqual(['2']);
  });

  it('POSIX 与 Windows 分隔符归入同一组', () => {
    const grouped = groupSessionsByFolder([
      sess({ id: '1', workingDir: '/w/repo' }),
      sess({ id: '2', workingDir: 'C:\\w\\repo' }),
    ]);
    expect(grouped.size).toBe(1);
    expect(grouped.get('repo')?.map((s) => s.id)).toEqual(['1', '2']);
  });

  it('空输入返回空 Map', () => {
    expect(groupSessionsByFolder([]).size).toBe(0);
  });
});

describe('buildSidebarEntries', () => {
  it('置顶会话排最前，内部按 updatedAt 倒序（后置顶排更前）', () => {
    const sessions = [
      sess({ id: 'a', pinned: true, updatedAt: 100 }),
      sess({ id: 'b', pinned: true, updatedAt: 300 }),
      sess({ id: 'c', pinned: true, updatedAt: 200 }),
      sess({ id: 'd', workingDir: 'C:\\r' }),
    ];
    const grouped = groupSessionsByFolder(sessions.filter((s) => !s.pinned));
    const { entries } = buildSidebarEntries({
      sessions,
      groupedSessions: grouped,
      collapsedFolders: [],
      isSearching: false,
      orderOverrides: {},
    });
    expect(entries.map((e) => (e.type === 'item' ? e.session.id : `label:${e.name}`))).toEqual([
      'b',
      'c',
      'a',
      'label:r',
      'd',
    ]);
  });

  it('覆盖排序生效；陈旧 id 跳过；覆盖后新建的会话追加在末尾', () => {
    const sessions = [
      sess({ id: 'a', workingDir: 'C:\\r' }),
      sess({ id: 'b', workingDir: 'C:\\r' }),
      sess({ id: 'c', workingDir: 'C:\\r' }),
    ];
    const grouped = groupSessionsByFolder(sessions);
    const { entries } = buildSidebarEntries({
      sessions,
      groupedSessions: grouped,
      collapsedFolders: [],
      isSearching: false,
      orderOverrides: { r: ['b', 'ghost-id', 'a'] },
    });
    expect(entries.map((e) => (e.type === 'item' ? e.session.id : `label:${e.name}`))).toEqual([
      'label:r',
      'b',
      'a',
      'c',
    ]);
  });

  it('非搜索时折叠文件夹只推 label 不推成员', () => {
    const sessions = [sess({ id: 'a', workingDir: 'C:\\r' })];
    const grouped = groupSessionsByFolder(sessions);
    const { entries, sortableIds } = buildSidebarEntries({
      sessions,
      groupedSessions: grouped,
      collapsedFolders: ['r'],
      isSearching: false,
      orderOverrides: {},
    });
    expect(entries.map((e) => e.type)).toEqual(['label']);
    expect(sortableIds).toEqual([]);
  });

  it('搜索时折叠态被忽略（匹配组自动展开）', () => {
    const sessions = [sess({ id: 'a', workingDir: 'C:\\r' })];
    const grouped = groupSessionsByFolder(sessions);
    const { entries, sortableIds } = buildSidebarEntries({
      sessions,
      groupedSessions: grouped,
      collapsedFolders: ['r'],
      isSearching: true,
      orderOverrides: {},
    });
    expect(entries.map((e) => e.type)).toEqual(['label', 'item']);
    expect(sortableIds).toEqual(['a']);
  });

  it('文件夹段跳过置顶会话（已提前到最前，不重复）', () => {
    const pinned = sess({ id: 'p', pinned: true, workingDir: 'C:\\r' });
    const normal = sess({ id: 'n', workingDir: 'C:\\r' });
    const sessions = [pinned, normal];
    const grouped = groupSessionsByFolder(sessions);
    const { entries } = buildSidebarEntries({
      sessions,
      groupedSessions: grouped,
      collapsedFolders: [],
      isSearching: false,
      orderOverrides: {},
    });
    const ids = entries.map((e) => (e.type === 'item' ? e.session.id : `label:${e.name}`));
    expect(ids).toEqual(['p', 'label:r', 'n']);
    expect(ids.filter((x) => x === 'p')).toHaveLength(1);
  });

  it('sortableIds 只含会话项且按展示顺序（label 不计入）', () => {
    const sessions = [
      sess({ id: 'p', pinned: true, updatedAt: 500, workingDir: 'C:\\r' }),
      sess({ id: 'a', workingDir: 'C:\\r' }),
    ];
    const grouped = groupSessionsByFolder(sessions);
    const { sortableIds } = buildSidebarEntries({
      sessions,
      groupedSessions: grouped,
      collapsedFolders: [],
      isSearching: false,
      orderOverrides: {},
    });
    expect(sortableIds).toEqual(['p', 'a']);
  });

  it('空输入产生空 entries 与空 sortableIds', () => {
    const { entries, sortableIds } = buildSidebarEntries({
      sessions: [],
      groupedSessions: groupSessionsByFolder([]),
      collapsedFolders: [],
      isSearching: false,
      orderOverrides: {},
    });
    expect(entries).toEqual([]);
    expect(sortableIds).toEqual([]);
  });
});
