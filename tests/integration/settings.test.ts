import { describe, expect, it } from 'vitest';
import { PermissionService } from '../../src/main/infra/ai/tools/permission-service';
import {
  getSessionService,
  resetSessionService,
} from '../../src/main/infra/storage/session-service';
import { createSettingsHandlers } from '../../src/main/ipc/settings.handler';
import { createWhitelistHandlers } from '../../src/main/ipc/whitelist.handler';
import { withTempUserData } from './helpers/with-db';

describe('settings 域集成链路（batch 6）', () => {
  it('正向：setApiKey→getApiKey 往返（加密存储）', async () => {
    resetSessionService();
    await withTempUserData(async () => {
      const handlers = createSettingsHandlers({
        sessionService: getSessionService(),
        permissionService: new PermissionService(),
      });
      await handlers.setApiKey({ provider: 'openai', apiKey: 'sk-test-123' });
      const res = await handlers.getApiKey({ provider: 'openai' });
      expect(res.configured).toBe(true);
    });
  });

  it('正向：deleteApiKey → 读取为未配置', async () => {
    resetSessionService();
    await withTempUserData(async () => {
      const handlers = createSettingsHandlers({
        sessionService: getSessionService(),
        permissionService: new PermissionService(),
      });
      await handlers.setApiKey({ provider: 'deepseek', apiKey: 'sk-ds' });
      await handlers.deleteApiKey({ provider: 'deepseek' });
      const res = await handlers.getApiKey({ provider: 'deepseek' });
      expect(res.configured).toBe(false);
    });
  });

  it('正向：telemetry set→get 往返', async () => {
    resetSessionService();
    await withTempUserData(async () => {
      const handlers = createSettingsHandlers({
        sessionService: getSessionService(),
        permissionService: new PermissionService(),
      });
      await handlers.setTelemetryLevel({ level: 'full' });
      const res = await handlers.getTelemetryLevel();
      expect(res.level).toBe('full');
    });
  });

  it('正向：approvalMode set→get 往返', async () => {
    resetSessionService();
    await withTempUserData(async () => {
      const handlers = createSettingsHandlers({
        sessionService: getSessionService(),
        permissionService: new PermissionService(),
      });
      await handlers.setApprovalMode({ mode: 'ask' });
      const res = await handlers.getApprovalMode();
      expect(res.mode).toBe('ask');
    });
  });

  it('正向：whitelist add→list→remove 往返', async () => {
    resetSessionService();
    await withTempUserData(async () => {
      const whitelist = createWhitelistHandlers({ permissionService: new PermissionService() });
      const entry = { toolName: 'run_command', pattern: 'pnpm install' };
      await whitelist.add(entry);
      const listed = await whitelist.list();
      expect(listed.entries).toHaveLength(1);
      expect(listed.entries[0]?.pattern).toBe('pnpm install');

      await whitelist.remove(entry);
      const after = await whitelist.list();
      expect(after.entries).toHaveLength(0);
    });
  });

  it('安全：通配/空模式添加被拒（白名单不等于该工具免审批）', async () => {
    resetSessionService();
    await withTempUserData(async () => {
      const whitelist = createWhitelistHandlers({ permissionService: new PermissionService() });
      await expect(whitelist.add({ toolName: 'run_command', pattern: '*' })).rejects.toBeDefined();
      expect((await whitelist.list()).entries).toHaveLength(0);
    });
  });

  it('边界：getApiKey 未设置 → configured=false（不抛）', async () => {
    resetSessionService();
    await withTempUserData(async () => {
      const handlers = createSettingsHandlers({
        sessionService: getSessionService(),
        permissionService: new PermissionService(),
      });
      const res = await handlers.getApiKey({ provider: 'nonexistent-provider' });
      expect(res.configured).toBe(false);
    });
  });

  it('边界：空 whitelist', async () => {
    resetSessionService();
    await withTempUserData(async () => {
      const whitelist = createWhitelistHandlers({ permissionService: new PermissionService() });
      const listed = await whitelist.list();
      expect(listed.entries).toEqual([]);
    });
  });

  it('持久化往返：set 后真实落盘（文件级验证）', async () => {
    resetSessionService();
    await withTempUserData(async () => {
      const handlers = createSettingsHandlers({
        sessionService: getSessionService(),
        permissionService: new PermissionService(),
      });
      await handlers.setApiKey({ provider: 'openai', apiKey: 'sk-persist' });
      await handlers.setTelemetryLevel({ level: 'error-only' });

      const { readFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const userData = (globalThis as Record<string, unknown>)['__itState'] as { userData: string };
      const keychainFile = join(userData.userData, 'keychain.dat');
      expect(readFileSync(keychainFile, 'utf-8').length).toBeGreaterThan(0);
      const telemetryFile = join(userData.userData, 'telemetry-pref.json');
      expect(readFileSync(telemetryFile, 'utf-8')).toContain('error-only');
    });
  });

  it('幂等：重复 setApiKey 覆盖（新契约只暴露 configured）', async () => {
    resetSessionService();
    await withTempUserData(async () => {
      const handlers = createSettingsHandlers({
        sessionService: getSessionService(),
        permissionService: new PermissionService(),
      });
      await handlers.setApiKey({ provider: 'openai', apiKey: 'v1' });
      await handlers.setApiKey({ provider: 'openai', apiKey: 'v2' });
      const res = await handlers.getApiKey({ provider: 'openai' });
      expect(res.configured).toBe(true);
    });
  });

  it('异常：safeStorage 不可用 → 错误传播', async () => {
    resetSessionService();
    await withTempUserData(async () => {
      const itState = (globalThis as Record<string, unknown>)['__itState'] as {
        safeStorageAvailable: boolean;
      };
      itState.safeStorageAvailable = false;
      try {
        const handlers = createSettingsHandlers({
          sessionService: getSessionService(),
          permissionService: new PermissionService(),
        });
        await expect(handlers.setApiKey({ provider: 'openai', apiKey: 'x' })).rejects.toBeDefined();
      } finally {
        itState.safeStorageAvailable = true;
      }
    });
  });

  it('并发：多 provider set 互不干扰（串行——IPC 主进程语义）', async () => {
    resetSessionService();
    await withTempUserData(async () => {
      const handlers = createSettingsHandlers({
        sessionService: getSessionService(),
        permissionService: new PermissionService(),
      });
      for (let i = 0; i < 5; i++) {
        await handlers.setApiKey({ provider: `provider-${i}`, apiKey: `sk-${i}` });
      }
      for (let i = 0; i < 5; i++) {
        const res = await handlers.getApiKey({ provider: `provider-${i}` });
        expect(res.configured).toBe(true);
      }
    });
  });
});
