// tests/integration/setup.ts
// 集成测试全局 setup：electron SDK 边界替身（真实协作原则——只替身外部 SDK）
// ──────────────────────────────────────────────────────────────
// 替身范围（业界简化环境 Medium Test 标准）：
// - app.getPath('userData') → 指向可变引用（with-db helper 每用例切换临时目录）
// - dialog.showSaveDialog → 可变结果（exportAll 等用例设置保存路径）
// 其余业务模块全真实（db.ts 初始化/SessionService 落库等）。
// ──────────────────────────────────────────────────────────────

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
    // 测试环境视为未打包（config 加载依赖 isPackaged 布尔）
    isPackaged: false,
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
