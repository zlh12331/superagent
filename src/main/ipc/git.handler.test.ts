// src/main/ipc/git.handler.test.ts
// git.handler 单测：5 个方法转发（fake GitService DI 注入）

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createGitHandlers, type GitHandlerDeps } from './git.handler';

/** 创建 fake GitService */
function createFakeGitService() {
  return {
    status: vi.fn(async () => ({ branch: 'main', ahead: 0, behind: 0, files: [], clean: true })),
    diff: vi.fn(async () => ({ diff: '' })),
    add: vi.fn(async () => ({ stagedCount: 0, stdout: '' })),
    commit: vi.fn(async () => ({ sha: 'abc', branch: 'main', filesChanged: 0 })),
    push: vi.fn(async () => ({ ok: true, pushedCount: 0, stdout: '', stderr: '' })),
  } as unknown as GitHandlerDeps['gitService'];
}

const EMPTY_CTX = {} as never;

describe('git.handler', () => {
  let gitService: ReturnType<typeof createFakeGitService>;
  let handlers: ReturnType<typeof createGitHandlers>;

  beforeEach(() => {
    vi.clearAllMocks();
    gitService = createFakeGitService();
    handlers = createGitHandlers({ gitService });
  });

  it('status：转发 path', async () => {
    await handlers.status({ path: '/repo' }, EMPTY_CTX);
    expect(gitService.status).toHaveBeenCalledWith('/repo');
  });

  it('diff：转发全部参数', async () => {
    await handlers.diff(
      { path: '/repo', ref: 'HEAD', staged: false, filePath: undefined },
      EMPTY_CTX,
    );
    expect(gitService.diff).toHaveBeenCalledWith({
      path: '/repo',
      ref: 'HEAD',
      staged: false,
      filePath: undefined,
    });
  });

  it('add：转发 path/paths', async () => {
    await handlers.add({ path: '/repo', paths: [] }, EMPTY_CTX);
    expect(gitService.add).toHaveBeenCalledWith({ path: '/repo', paths: [] });
  });

  it('commit：转发 message/amend', async () => {
    await handlers.commit({ path: '/repo', message: 'fix', amend: false }, EMPTY_CTX);
    expect(gitService.commit).toHaveBeenCalledWith({ path: '/repo', message: 'fix', amend: false });
  });

  it('push：转发 remote/refspec/setUpstream/force', async () => {
    await handlers.push(
      { path: '/repo', remote: 'origin', refspec: 'main', setUpstream: false, force: false },
      EMPTY_CTX,
    );
    expect(gitService.push).toHaveBeenCalledWith({
      path: '/repo',
      remote: 'origin',
      refspec: 'main',
      setUpstream: false,
      force: false,
    });
  });
});
