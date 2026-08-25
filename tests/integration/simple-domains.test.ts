// tests/integration/simple-domains.test.ts
// 简单域聚合集成测试（batch 8/9：app/dialog/system/models/tool/logs）
// ──────────────────────────────────────────────────────────────
// 链路：IPC handler（真实）→ 真实逻辑/注册表/文件（SDK 边界替身：dialog/shell/app.getVersion）
//
// 维度覆盖：接口契约 / 错误传播（openExternal URL 校验）
// 场景：安全边界（URL scheme 校验）/ 边界（dialog 取消）
// ──────────────────────────────────────────────────────────────

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../../src/main/infra/ai/tools/tool-registry';
import { resetSessionService } from '../../src/main/infra/storage/session-service';
import { appHandlers } from '../../src/main/ipc/app.handler';
import { dialogHandlers } from '../../src/main/ipc/dialog.handler';
import { modelsHandlers } from '../../src/main/ipc/models.handler';
import { logsHandlers, systemHandlers } from '../../src/main/ipc/system.handler';
import { createToolHandlers } from '../../src/main/ipc/tool.handler';
import { withTempUserData } from './helpers/with-db';

/** 设置 openDialog 返回（dialog 用例用；默认取消） */
function setOpenDialogResult(result: { canceled: boolean; filePaths?: string[] }): void {
  (
    (globalThis as Record<string, unknown>)['__itState'] as {
      openDialogResult: { canceled: boolean; filePaths?: string[] };
    }
  ).openDialogResult = result;
}

describe('简单域聚合（batch 8）', () => {
  it('app：getStatus 返回协议版本', async () => {
    const handlers = appHandlers;
    const res = await handlers.getStatus();
    expect(res.ready).toBe(true);
    expect(res.protocolVersion).toBeDefined();
  });

  it('app：getInfo 返回版本（SDK 边界）', async () => {
    const handlers = appHandlers;
    const res = await handlers.getInfo();
    expect(res.version).toBe('9.9.9-test');
  });

  it('安全边界：openExternal 拒绝非 http(s) URL', async () => {
    const handlers = appHandlers;
    await expect(handlers.openExternal({ url: 'file:///etc/passwd' })).rejects.toBeDefined();
    await expect(handlers.openExternal({ url: 'javascript:alert(1)' })).rejects.toBeDefined();
  });

  it('正向：openExternal 合法 URL（SDK 边界替身）', async () => {
    const handlers = appHandlers;
    const res = await handlers.openExternal({ url: 'https://example.com' });
    expect(res.ok).toBe(true);
  });

  it('dialog：pickDirectory 返回路径（SDK 边界替身）', async () => {
    setOpenDialogResult({ canceled: false, filePaths: ['/tmp/project'] });
    try {
      const handlers = dialogHandlers;
      const res = await handlers.pickDirectory();
      expect(res.path).toBe('/tmp/project');
    } finally {
      setOpenDialogResult({ canceled: true });
    }
  });

  it('dialog：pickFiles multiple（SDK 边界替身）', async () => {
    setOpenDialogResult({ canceled: false, filePaths: ['/a.ts', '/b.ts'] });
    try {
      const handlers = dialogHandlers;
      const res = await handlers.pickFiles({ multiple: true });
      expect(res.paths).toHaveLength(2);
    } finally {
      setOpenDialogResult({ canceled: true });
    }
  });

  it('边界：dialog 取消 → 空结果', async () => {
    setOpenDialogResult({ canceled: true });
    const handlers = dialogHandlers;
    const res = await handlers.pickDirectory();
    expect(res.canceled).toBe(true);
  });

  it('system：getStatus 返回内存与平台信息', async () => {
    const handlers = systemHandlers;
    const res = await handlers.getStatus();
    expect(typeof res.memory.rss).toBe('number');
    expect(res.memory.rss).toBeGreaterThan(0);
    expect(res.platform).toBe(process.platform);
  });

  it('system：read 日志 tail（真实文件，userData/main.log）', async () => {
    resetSessionService();
    await withTempUserData(async () => {
      // logs:read 固定读 app.getPath('logs')/main.log（mock 下 logs = userData）
      const userData = (globalThis as Record<string, unknown>)['__itState'] as { userData: string };
      writeFileSync(
        join(userData.userData, 'main.log'),
        Array.from({ length: 10 }, (_, i) => `line-${i}`).join('\n'),
        'utf-8',
      );
      const res = await logsHandlers.read({ lines: 3 });
      expect(res.lines).toHaveLength(3);
      expect(res.lines[2]).toBe('line-9');
    });
  });

  it('models：listBuiltin 返回厂商内置模型（配置页数据源，无需 API Key）', async () => {
    resetSessionService();
    await withTempUserData(async () => {
      // 配置页数据源：未配置 key 也能看到厂商全部官方模型（供"待添加"选择）
      const res = await modelsHandlers.listBuiltin({});
      expect(res.models.some((m) => m.providerKind === 'deepseek')).toBe(true);
      expect(res.models.some((m) => m.isRuntime)).toBe(false);
    });
  });

  it('models：list 未配置运行时模型时返回空（只列用户添加的模型）', async () => {
    resetSessionService();
    await withTempUserData(async () => {
      const res = await modelsHandlers.list();
      expect(res.models).toEqual([]);
    });
  });

  it('tool：list 返回工具注册表结构', async () => {
    const handlers = createToolHandlers({ toolRegistry: new ToolRegistry() });
    const res = await handlers.list({});
    expect(Array.isArray(res.tools)).toBe(true);
  });
});
