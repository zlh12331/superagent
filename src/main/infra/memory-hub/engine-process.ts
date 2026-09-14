// src/main/infra/memory-hub/engine-process.ts
// 记忆引擎子进程启动器（Electron utilityProcess 实现 + 句柄契约）
// ──────────────────────────────────────────────────────────────
// 职责：把引擎子进程拉起来，暴露最小句柄（pid / stderr 尾巴 / 退出回调 / 终止）。
//   健康检查与配置生成仍在 MemoryHubService（职责单一）。
//
// 启动方式：Electron utilityProcess.fork（官方后台 Node 子进程 API）。
//   经模块路径 + 参数数组启动，无 shell 参与；launcherPath 由本进程生成，
//   execArgv 为模块级冻结常量，环境变量由调用方以固定键名构造。
//
// 访问方式：可指定 Electron 官方 helper（macOS 上经 Helper(Plugin) 可加载未签名
//   原生库）——由 allowLoadingUnsignedLibraries 控制，默认关闭。
// ──────────────────────────────────────────────────────────────

import { utilityProcess } from 'electron';
import { logger } from '../../utils/logger';
import { buildEngineEnv } from './engine-env';

const TAG = '[memory-hub]';

/** stderr 保留末尾长度（诊断启动失败用） */
const STDERR_TAIL_LIMIT = 2000;

/** 引擎子进程句柄（最小面） */
export interface EngineProcessHandle {
  /** 进程 id（undefined = 尚未 spawn 或已退出；**不可据此判存活**，见 hasExited） */
  readonly pid: number | undefined;
  /**
   * 是否已收到 exit 事件
   *
   * ⚠️ 存活判定必须用本方法，**不能用 `pid === undefined`**：实测 Electron
   * utilityProcess 在 fork 返回后 pid 仍为 undefined（约 29ms 后 'spawn' 才赋值、
   * 63ms 才稳定可读），启动期轮询会把「尚未 spawn」误判成「已退出」而立刻失败
   * （2026-09-14 探针：PID_SYNC=undefined@1ms → spawn@29ms → pid=8832@63ms）。
   */
  hasExited(): boolean;
  /** stderr 末尾（启动失败时报出，便于定位） */
  stderrTail(): string;
  /** 注册退出回调（code 为退出码） */
  onExit(listener: (code: number) => void): void;
  /** 终止进程（已退出时安全 no-op） */
  kill(): void;
}

/** 启动参数 */
export interface LaunchEngineOptions {
  /** 启动器脚本绝对路径（.mjs，由 service 内联生成） */
  readonly launcherPath: string;
  /** 工作目录（tsx loader 需从上游 node_modules 解析） */
  readonly cwd: string;
  /** 子进程环境变量（含上游约定的 TDAI_* 等固定键） */
  readonly env: NodeJS.ProcessEnv;
  /** 是否经 tsx 运行 TS 源码（打包产物为 JS 时无需） */
  readonly useTsx: boolean;
}

/** 启动器类型（生产用下方默认实现；测试注入 fake） */
export type EngineLauncher = (options: LaunchEngineOptions) => EngineProcessHandle;

/**
 * 默认启动器：Electron utilityProcess
 */
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
