// engine-process.ts：引擎进程拉起（Electron utilityProcess，serviceName=memory-engine）——
// ⚠️ 不可用 ELECTRON_RUN_AS_NODE（与 fuses runAsNode:false 互斥）；launcher 注入缝供测试替换
import { utilityProcess } from 'electron';
import { logger } from '../../utils/logger';
import { buildEngineEnv } from './engine-env';

const TAG = '[memory-hub]';

const STDERR_TAIL_LIMIT = 2000;

/** 引擎进程句柄（宿主只经此句柄感知进程：退出/错误尾/杀） */
export interface EngineProcessHandle {
  readonly pid: number | undefined;
  hasExited(): boolean;
  stderrTail(): string;
  onExit(listener: (code: number) => void): void;
  kill(): void;
}

/** 启动参数（launcherPath + 运行目录 + 环境 + 是否 tsx 直跑） */
export interface LaunchEngineOptions {
  readonly launcherPath: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly useTsx: boolean;
}

/** 默认启动器：utilityProcess.fork + 环境构造 + stderr 尾部留存 */
export type EngineLauncher = (options: LaunchEngineOptions) => EngineProcessHandle;

export const launchEngineProcess: EngineLauncher = (options) => {
  const child = utilityProcess.fork(options.launcherPath, [], {
    cwd: options.cwd,
    env: buildEngineEnv(options.env, options.useTsx),
    execArgv: [],
    serviceName: 'memory-engine',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderrTail = '';
  let exited = false;
  child.on('exit', () => {
    exited = true;
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_LIMIT);
  });
  child.on('error', (type, location, report) => {
    const parts = [stderrTail, 'utilityProcess FatalError', String(type), String(location), report];
    stderrTail = parts.join('\n').slice(-STDERR_TAIL_LIMIT);
    logger.warn({ type, location }, `${TAG} utilityProcess 致命错误`);
  });

  return {
    get pid() {
      return child.pid;
    },
    hasExited: () => exited,
    stderrTail: () => stderrTail,
    onExit: (listener) => {
      child.on('exit', listener);
    },
    kill: () => {
      if (!child.kill()) {
        logger.debug({}, `${TAG} 子进程已退出，终止为 no-op`);
      }
    },
  };
};
