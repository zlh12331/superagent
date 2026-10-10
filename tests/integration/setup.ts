// setup.ts：集成测试全局 setup——只替身 Electron SDK 边界（真实协作原则）。
// 替身范围即业界「简化环境 Medium Test」的标准边界：app.getPath（userData → 系统临时
// 目录，落库/文件全走真实 SQLite 与文件系统）、dialog（保存/打开路径由各用例经
// __itState 注入）、shell（不做真实系统调用）、safeStorage（假加密，加解密可逆且
// 带 enc: 前缀；真实 DPAPI 由 Electron 提供，平台相关不可在 CI 复现）。
// 被测业务模块（service/handler/存储层）一律真实实例，禁 vi.mock（check-test-boundary 卡关）。
// __itState 挂 globalThis：vitest 的 setup 与测试文件不在同一模块实例，
// with-db helper 经它读写共享状态（临时 userData 路径、dialog 返回值）。

import { tmpdir } from 'node:os';
import { vi } from 'vitest';

/** 集成测试共享状态（with-db helper 通过 globalThis 读写） */
const itState = {
  userData: tmpdir(),
  dialogResult: { canceled: true } as { canceled: boolean; filePath?: string },
  openDialogResult: { canceled: true } as { canceled: boolean; filePaths?: string[] },
  safeStorageAvailable: true,
};

(globalThis as Record<string, unknown>)['__itState'] = itState;

/** 假加密：base64（仅测试用——真实 DPAPI 由 Electron safeStorage 提供） */
function fakeEncrypt(value: string): Buffer {
  return Buffer.from(`enc:${value}`, 'utf-8');
}
function fakeDecrypt(buffer: Buffer): string {
  const text = buffer.toString('utf-8');
  return text.startsWith('enc:') ? text.slice(4) : text;
}

vi.mock('electron', () => ({
  app: {
    getPath: () => itState.userData,
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getVersion: () => '9.9.9-test',
  },
  dialog: {
    showSaveDialog: vi.fn(async () => itState.dialogResult),
    showOpenDialog: vi.fn(async () => itState.openDialogResult),
  },
  shell: {
    openExternal: vi.fn(async () => {}),
    openPath: vi.fn(async () => ''),
  },
  safeStorage: {
    isEncryptionAvailable: () => itState.safeStorageAvailable,
    encryptString: (value: string) => fakeEncrypt(value),
    decryptString: (buffer: Buffer) => fakeDecrypt(buffer),
  },
}));
