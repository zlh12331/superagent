// src/renderer/stores/transient/file-tree-store.test.ts
// 文件树 store 单测：根目录重置 / 展开集合 / 条目缓存增量更新 / 内联新建 / 操作中状态 / 搜索

import type { FileEntry } from '@code-agent/shared/renderer';
import { beforeEach, describe, expect, it } from 'vitest';
import { useFileTreeStore } from './file-tree-store';

/** FileEntry 构造器（默认文件） */
function entry(name: string, type: FileEntry['type'] = 'file', dir = '/proj'): FileEntry {
  return { name, path: `${dir}/${name}`, type, size: 10, modifiedAt: 1000 };
}

describe('useFileTreeStore', () => {
  beforeEach(() => {
    useFileTreeStore.getState().reset();
  });

  describe('setRootPath', () => {
    it('设置根目录：重置状态并默认展开根', () => {
      useFileTreeStore.getState().setRootPath('/proj');
      const s = useFileTreeStore.getState();
      expect(s.rootPath).toBe('/proj');
      expect([...s.expandedPaths]).toEqual(['/proj']);
      expect(s.activeFilePath).toBeNull();
      expect(s.entries.size).toBe(0);
    });

    it('设置 null：全部重置（会话卸载）', () => {
      useFileTreeStore.getState().setRootPath('/proj');
      useFileTreeStore.getState().setEntries('/proj', [entry('a.txt')]);
      useFileTreeStore.getState().setRootPath(null);
      const s = useFileTreeStore.getState();
      expect(s.rootPath).toBeNull();
      expect(s.expandedPaths.size).toBe(0);
      expect(s.entries.size).toBe(0);
    });
  });

  describe('展开状态', () => {
    it('toggleExpand：展开 ↔ 折叠', () => {
      useFileTreeStore.getState().setRootPath('/proj');
      useFileTreeStore.getState().toggleExpand('/proj/src');
      expect(useFileTreeStore.getState().expandedPaths.has('/proj/src')).toBe(true);
      useFileTreeStore.getState().toggleExpand('/proj/src');
      expect(useFileTreeStore.getState().expandedPaths.has('/proj/src')).toBe(false);
    });

    it('setExpanded：显式设置（幂等）', () => {
      useFileTreeStore.getState().setRootPath('/proj');
      useFileTreeStore.getState().setExpanded('/proj/a', true);
      useFileTreeStore.getState().setExpanded('/proj/a', true);
      expect(useFileTreeStore.getState().expandedPaths.has('/proj/a')).toBe(true);
      useFileTreeStore.getState().setExpanded('/proj/a', false);
      expect(useFileTreeStore.getState().expandedPaths.has('/proj/a')).toBe(false);
    });
  });

  describe('条目缓存与增量更新', () => {
    it('setEntries：排序后存入（目录在前，同类名称升序不区分大小写）', () => {
      useFileTreeStore.getState().setRootPath('/proj');
      useFileTreeStore
        .getState()
        .setEntries('/proj', [entry('zeta.txt'), entry('Alpha.txt'), entry('beta', 'directory')]);
      const names = useFileTreeStore
        .getState()
        .entries.get('/proj')
        ?.map((e) => e.name);
      expect(names).toEqual(['beta', 'Alpha.txt', 'zeta.txt']);
    });

    it('removeEntry：按路径移除', () => {
      useFileTreeStore.getState().setRootPath('/proj');
      useFileTreeStore.getState().setEntries('/proj', [entry('a.txt'), entry('b.txt')]);
      useFileTreeStore.getState().removeEntry('/proj', '/proj/a.txt');
      const names = useFileTreeStore
        .getState()
        .entries.get('/proj')
        ?.map((e) => e.name);
      expect(names).toEqual(['b.txt']);
    });

    it('removeEntry：父目录无缓存时不抛且状态不变', () => {
      const before = useFileTreeStore.getState().entries;
      useFileTreeStore.getState().removeEntry('/ghost', '/ghost/x');
      expect(useFileTreeStore.getState().entries).toBe(before);
    });
  });

  describe('加载与激活状态', () => {
    it('setLoading：加入/移出加载中集合', () => {
      useFileTreeStore.getState().setLoading('/proj/src', true);
      expect(useFileTreeStore.getState().loadingPaths.has('/proj/src')).toBe(true);
      useFileTreeStore.getState().setLoading('/proj/src', false);
      expect(useFileTreeStore.getState().loadingPaths.has('/proj/src')).toBe(false);
    });

    it('setActiveFile：设置与清空', () => {
      useFileTreeStore.getState().setActiveFile('/proj/a.txt');
      expect(useFileTreeStore.getState().activeFilePath).toBe('/proj/a.txt');
      useFileTreeStore.getState().setActiveFile(null);
      expect(useFileTreeStore.getState().activeFilePath).toBeNull();
    });
  });

  describe('内联新建', () => {
    it('startCreate：创建临时节点（parentDir + type）', () => {
      useFileTreeStore.getState().startCreate('/proj/src', 'directory');
      expect(useFileTreeStore.getState().creatingEntry).toEqual({
        parentDir: '/proj/src',
        type: 'directory',
      });
    });

    it('cancelCreate：清空新建状态', () => {
      useFileTreeStore.getState().startCreate('/proj', 'file');
      useFileTreeStore.getState().cancelCreate();
      expect(useFileTreeStore.getState().creatingEntry).toBeNull();
    });
  });

  describe('新建在途状态与搜索', () => {
    it('setPendingDir：标记与清除（键为父目录）', () => {
      useFileTreeStore.getState().setPendingDir('/proj', true);
      expect(useFileTreeStore.getState().pendingDirs.has('/proj')).toBe(true);
      useFileTreeStore.getState().setPendingDir('/proj', false);
      expect(useFileTreeStore.getState().pendingDirs.has('/proj')).toBe(false);
    });

    it('setPendingDir：重复标记幂等（不产生重复条目）', () => {
      useFileTreeStore.getState().setPendingDir('/proj', true);
      useFileTreeStore.getState().setPendingDir('/proj', true);
      expect(useFileTreeStore.getState().pendingDirs.size).toBe(1);
    });

    it('getAllFilePaths：仅文件（排除目录），按名称不区分大小写升序', () => {
      useFileTreeStore.getState().setRootPath('/proj');
      useFileTreeStore
        .getState()
        .setEntries('/proj', [entry('b.txt'), entry('sub', 'directory'), entry('A.md')]);
      useFileTreeStore.getState().setEntries('/proj/sub', [entry('c.ts', 'file', '/proj/sub')]);
      const paths = useFileTreeStore.getState().getAllFilePaths();
      expect(paths).toEqual(['/proj/A.md', '/proj/b.txt', '/proj/sub/c.ts']);
    });

    it('边界：无任何条目缓存时 getAllFilePaths 返回空数组', () => {
      expect(useFileTreeStore.getState().getAllFilePaths()).toEqual([]);
    });
  });

  describe('展开集合的引用稳定（防 effect 空转）', () => {
    it('expandPaths：无新增时返回原集合引用（下游 effect 不重跑）', () => {
      useFileTreeStore.getState().setExpanded('/proj/a', true);
      const before = useFileTreeStore.getState().expandedPaths;
      useFileTreeStore.getState().expandPaths(['/proj/a']);
      expect(useFileTreeStore.getState().expandedPaths).toBe(before);
    });

    it('expandPaths：有新增时返回新集合（含去重）', () => {
      useFileTreeStore.getState().expandPaths(['/proj/a', '/proj/a']);
      expect([...useFileTreeStore.getState().expandedPaths]).toEqual(['/proj/a']);
    });

    it('边界：expandPaths 空数组不改变引用', () => {
      const before = useFileTreeStore.getState().expandedPaths;
      useFileTreeStore.getState().expandPaths([]);
      expect(useFileTreeStore.getState().expandedPaths).toBe(before);
    });
  });

  describe('reset', () => {
    it('全量清空（会话切换 / 卸载）', () => {
      const store = useFileTreeStore.getState();
      store.setRootPath('/proj');
      store.setEntries('/proj', [entry('a.txt')]);
      store.setActiveFile('/proj/a.txt');
      store.setLoading('/proj', true);
      store.setPendingDir('/proj', true);
      store.startCreate('/proj', 'file');
      store.toggleExpand('/proj/src');

      store.reset();

      const s = useFileTreeStore.getState();
      expect(s.rootPath).toBeNull();
      expect(s.expandedPaths.size).toBe(0);
      expect(s.activeFilePath).toBeNull();
      expect(s.entries.size).toBe(0);
      expect(s.loadingPaths.size).toBe(0);
      expect(s.pendingDirs.size).toBe(0);
      expect(s.creatingEntry).toBeNull();
    });
  });
});
