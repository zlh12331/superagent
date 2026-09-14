// src/main/infra/memory-hub/node-launcher.ts
// 非 Electron 环境（vitest / 纯 Node）下的引擎启动器实现
// ──────────────────────────────────────────────────────────────
// 用途：契约测试要在 vitest（纯 Node，无 Electron 运行时）中"真实拉起引擎"，
//   而生产的 utilityProcess 在该环境不可用。本实现以 spawn 的**数组参数**形式
//   启动同一个 launcher 脚本，契约与生产一致（pid / stderr 尾巴 / 退出 / 终止）。
//
// 安全说明（供审计）：启动使用参数数组、不经 shell 解释；参数由本模块与
//   MemoryHubService 在进程内构造（modulePath 为 dataDir 下的 launcher.mjs，
//   loader 参数为冻结常量），无外部输入参与。生产环境**不使用本模块**
//   （固定走 Electron utilityProcess，见 engine-process.ts）。
// ──────────────────────────────────────────────────────────────

import type { ChildProcess } from 'node:child_process';
import type { EngineLauncher, EngineProcessHandle, LaunchEngineOptions } from './engine-process';

const STDERR_TAIL_LIMIT = 2000;

/** 惰性获取 spawn（避免在无关路径引入 child_process 依赖） */
async function loadSpawn(): Promise<(file: string, args: string[], opts: object) => ChildProcess> {
  const mod = await import('node:child_process');
  return mod.spawn as unknown as (file: string, args: string[], opts: object) => ChildProcess;
}

/**
 * 创建 Node 启动器（异步工厂：内部惰性加载 child_process）
 *
 * @example
 * ```ts
 * // 契约测试（vitest，无 Electron）
 * const service = new MemoryHubService({ ..., launcher: await createNodeLauncher() });
 * ```
 */
export async function createNodeLauncher(): Promise<EngineLauncher> {
  const spawnFn = await loadSpawn();

  const launcher: EngineLauncher = (options: LaunchEngineOptions): EngineProcessHandle => {
    const argv: string[] = [];
    if (options.useTsx) {
      argv.push('--import', 'tsx');
    }
    argv.push(options.launcherPath);

    const child = spawnFn(process.execPath, argv, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stderrTail = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_LIMIT);
    });

    let exited = false;
    child.on('exit', () => {
      exited = true;
    });

    return {
      get pid() {
        return exited ? undefined : child.pid;
      },
      hasExited: () => exited,
      stderrTail: () => stderrTail,
      onExit: (listener) => {
        child.on('exit', (code) => listener(code ?? -1));
      },
      kill: () => {
        child.kill();
      },
    };
  };

  return launcher;
}
