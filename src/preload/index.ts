import { IPC_META } from '@code-agent/shared/ipc/meta';
import { contextBridge } from 'electron';
import { createIpcApi } from './utils/create-api';

const api = createIpcApi(IPC_META);

contextBridge.exposeInMainWorld('api', api);
