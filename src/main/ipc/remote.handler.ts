import type { InferHandlers, IPC_DEFINITIONS, RemoteStatusRes } from '@code-agent/shared/main';

import type { buildRemoteEndpoints, getLanIPv4Addresses } from '../infra/remote/network-info';
import type { IRemoteControlService } from '../infra/remote/remote-control';
import { writeRemoteBindScope } from '../infra/storage/remote-pref';
import type { IpcHandlerContext } from '../utils/wrap';

export interface RemoteHandlerNetwork {
  readonly listAddresses: typeof getLanIPv4Addresses;
  readonly buildEndpoints: typeof buildRemoteEndpoints;
}

export function createRemoteHandlers(params: {
  remoteControl: IRemoteControlService;
  network: RemoteHandlerNetwork;
}): InferHandlers<typeof IPC_DEFINITIONS, IpcHandlerContext>['remote'] {
  const { remoteControl, network } = params;

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
      writeRemoteBindScope(input.scope);
      return snapshot();
    },
  };
}
