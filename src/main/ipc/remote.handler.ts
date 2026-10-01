// src/main/ipc/remote.handler.ts
// 远程控制域 IPC handler（状态查询 / 启停 / 绑定范围，定义表驱动）
// ──────────────────────────────────────────────────────────────
// 实现 4 个请求-响应方法：
// - remote:getStatus     运行状态 + 配对令牌 + 直连地址 + 执行活动
// - remote:start         开启监听（HTTP 命令入口 + LAN 发现广播），返回新状态
// - remote:stop          关闭监听（幂等），返回新状态
// - remote:setBindScope  切换绑定范围（lan=0.0.0.0 / loopback=仅本机），返回新状态
//
// 设计：
// - 变更后立即回读状态返回，渲染层无需二次请求即可刷新面板
// - setBindScope 先应用后落库：应用失败（重启监听出错）不写偏好，
//   偏好与运行态保持一致（渲染层收到错误 toast，回读仍是旧值）
// - 令牌只在 running 时回传（停止后 token=null，面板不残留可配对凭据）
// - 命令执行由 RemoteAgentBridge 挂载在传输层 onCommand 上，本 handler 不碰执行
// ──────────────────────────────────────────────────────────────

import type { InferHandlers, IPC_DEFINITIONS, RemoteStatusRes } from '@code-agent/shared/main';

import type { buildRemoteEndpoints, getLanIPv4Addresses } from '../infra/remote/network-info';
import type { IRemoteControlService } from '../infra/remote/remote-control';
import { writeRemoteBindScope } from '../infra/storage/remote-pref';
import type { IpcHandlerContext } from '../utils/wrap';

/** 局域网地址枚举 + 端点组装（注入以便单测覆盖无网卡/多网卡分支） */
export interface RemoteHandlerNetwork {
  readonly listAddresses: typeof getLanIPv4Addresses;
  readonly buildEndpoints: typeof buildRemoteEndpoints;
}

/**
 * 远程控制域 handler 工厂（依赖注入：RemoteControlService 由 ServiceContainer 持有）
 */
export function createRemoteHandlers(params: {
  remoteControl: IRemoteControlService;
  network: RemoteHandlerNetwork;
}): InferHandlers<typeof IPC_DEFINITIONS, IpcHandlerContext>['remote'] {
  const { remoteControl, network } = params;

  /** 组装状态快照（未运行时端口/令牌/地址一律置空） */
  const snapshot = (): RemoteStatusRes => {
    const running = remoteControl.isRunning();
    const port = remoteControl.getPort();
    const token = remoteControl.getSessionToken();
    const activity = remoteControl.getActivity();
    const bindScope = remoteControl.getBindScope();
    const isPairable = running && port !== null && token !== null;
    return {
      running,
      port: isPairable ? port : null,
      token: isPairable ? token : null,
      instanceName: remoteControl.getInstanceName(),
      bindScope,
      // 仅本机模式不列局域网端点（列出也无法连通，只会误导配对），回本机回环端点
      addresses:
        isPairable && port !== null
          ? bindScope === 'loopback'
            ? [`http://127.0.0.1:${port}`]
            : network.buildEndpoints(network.listAddresses(), port)
          : [],
      activeCommands: activity.activeCommands,
      lastCommandAt: activity.lastCommandAt,
    };
  };

  return {
    getStatus: async () => snapshot(),

    start: async () => {
      await remoteControl.start();
      return snapshot();
    },

    stop: async () => {
      await remoteControl.stop();
      return snapshot();
    },

    setBindScope: async (input) => {
      // 先应用后落库：应用失败时偏好保持旧值（渲染层 toast 报错，回读一致）
      await remoteControl.setBindScope(input.scope);
      writeRemoteBindScope(input.scope);
      return snapshot();
    },
  };
}
