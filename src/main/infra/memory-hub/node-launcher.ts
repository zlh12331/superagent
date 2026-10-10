// node-launcher.ts：以当前 Node 运行时拉起引擎 launcher 脚本（dev/直跑场景的 EngineLauncher 实现）
import type { ChildProcess } from 'node:child_process';
import type { EngineLauncher, EngineProcessHandle, LaunchEngineOptions } from './engine-process';

// stderr 尾部留 2KB：崩溃归因只看尾部就够，全量留会无限涨
const STDERR_TAIL_LIMIT = 2000;

async function loadSpawn(): Promise<(file: string, args: string[], opts: object) => ChildProcess> {
  const mod = await import('node:child_process');
  return mod.spawn as unknown as (file: string, args: string[], opts: object) => ChildProcess;
}

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
