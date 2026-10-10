// remote.handler.ts：remote 域 IPC——远程控制启停/状态快照/绑定范围切换
// 快照原则：未就绪（无端口或 token）时地址与 token 一律回 null，不泄露半启动状态
import type { InferHandlers, IPC_DEFINITIONS, RemoteStatusRes } from '@code-agent/shared/main';

import type { buildRemoteEndpoints, getLanIPv4Addresses } from '../infra/remote/network-info';
import type { IRemoteControlService } from '../infra/remote/remote-control';
import { writeRemoteBindScope } from '../infra/storage/remote-pref';
import type { IpcHandlerContext } from '../utils/wrap';

/** network 能力注入（LAN 地址枚举 + 端点拼装），测试可替换 */
export interface RemoteHandlerNetwork {
  readonly listAddresses: typeof getLanIPv4Addresses;
  readonly buildEndpoints: typeof buildRemoteEndpoints;
}

/** 依赖注入工厂：index.ts 传入 remoteControl 与 network 能力 */
export function createRemoteHandlers(params: {
  remoteControl: IRemoteControlService;
  network: RemoteHandlerNetwork;
}): InferHandlers<typeof IPC_DEFINITIONS, IpcHandlerContext>['remote'] {
  const { remoteControl, network } = params;

  // 状态快照：所有方法统一返回全量快照（启停/切绑后渲染层无需再拉一次）
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
      await remoteControl.setBindScope(input.scope);
      // 持久化绑定范围（重启后恢复）；loopback/局域网的语义在 remote-control 内实现
      writeRemoteBindScope(input.scope);
      return snapshot();
    },
  };
}
