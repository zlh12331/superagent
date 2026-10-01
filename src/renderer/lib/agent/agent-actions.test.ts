// src/renderer/lib/agent/agent-actions.test.ts
// Agent one-shot IPC bridge: respondAsk / approvalResponse

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ipcErr, ipcOk } from '@/lib/ipc-factories';

import { respondAgentAsk, sendApprovalResponse } from './agent-actions';

function mockAgentApi(impl: Record<string, ReturnType<typeof vi.fn>>): void {
  (window.api as unknown as Record<string, Record<string, unknown>>)['agent'] = impl;
}

function removeBridge(): void {
  (window as unknown as { api: undefined }).api = undefined;
}

describe('agent-actions', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('respondAgentAsk', () => {
    it('bridge success resolves and forwards askId/answers', async () => {
      const respondMock = vi.fn(async () => ipcOk({ ok: true }));
      mockAgentApi({ respondAsk: respondMock });
      const answers = [{ selectedIndexes: [0], text: 'yes' }];
      await expect(respondAgentAsk({ askId: 'ask-1', answers })).resolves.toBeUndefined();
      expect(respondMock).toHaveBeenCalledWith({ askId: 'ask-1', answers: [...answers] });
    });

    it('no bridge throws [NO_BRIDGE]', async () => {
      removeBridge();
      await expect(
        respondAgentAsk({ askId: 'ask-1', answers: [{ selectedIndexes: [0] }] }),
      ).rejects.toThrow(/\[NO_BRIDGE\]/);
    });

    it('IPC error response throws [CODE]', async () => {
      mockAgentApi({ respondAsk: vi.fn(async () => ipcErr('AGENT_ASK_TIMEOUT', 'expired')) });
      await expect(
        respondAgentAsk({ askId: 'ask-1', answers: [{ text: 'free form' }] }),
      ).rejects.toThrow(/\[AGENT_ASK_TIMEOUT\]/);
    });
  });

  describe('sendApprovalResponse', () => {
    it('bridge success returns true', async () => {
      mockAgentApi({ approvalResponse: vi.fn(async () => ipcOk({ ok: true })) });
      await expect(
        sendApprovalResponse({ approvalId: 'a-1', approved: true, rememberDecision: false }),
      ).resolves.toBe(true);
    });

    it('no bridge returns false without throwing', async () => {
      removeBridge();
      await expect(
        sendApprovalResponse({ approvalId: 'a-1', approved: true, rememberDecision: false }),
      ).resolves.toBe(false);
    });

    it('IPC error response returns false (swallowed; 5 min timeout still applies)', async () => {
      mockAgentApi({
        approvalResponse: vi.fn(async () => ipcErr('AGENT_APPROVAL_FAILED', 'gone')),
      });
      await expect(
        sendApprovalResponse({ approvalId: 'a-1', approved: false, rememberDecision: true }),
      ).resolves.toBe(false);
    });
  });
});
