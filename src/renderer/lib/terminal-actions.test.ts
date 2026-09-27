// src/renderer/lib/terminal-actions.test.ts
// Terminal IPC bridge: create/kill/input/resize/subscribe + no-bridge degradation

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ipcErr, ipcOk } from './ipc-factories';
import {
  createTerminal,
  killTerminal,
  resizeTerminal,
  subscribeTerminalExit,
  subscribeTerminalOutput,
  writeTerminalInput,
} from './terminal-actions';

function mockTerminalApi(impl: Record<string, ReturnType<typeof vi.fn>>): void {
  (window.api as unknown as Record<string, Record<string, unknown>>)['terminal'] = impl;
}

function removeBridge(): void {
  (window as unknown as { api: undefined }).api = undefined;
}

const CREATE_REQ = {
  cwd: '/proj',
  command: undefined,
  env: undefined,
  cols: 80,
  rows: 24,
} as const;

describe('terminal-actions', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('createTerminal', () => {
    it('bridge success returns terminalId / cols / rows', async () => {
      mockTerminalApi({
        create: vi.fn(async () => ipcOk({ terminalId: 't-1', cols: 80, rows: 24 })),
      });
      await expect(createTerminal(CREATE_REQ)).resolves.toEqual({
        terminalId: 't-1',
        cols: 80,
        rows: 24,
      });
    });

    it('no bridge throws [NO_BRIDGE]', async () => {
      removeBridge();
      await expect(createTerminal(CREATE_REQ)).rejects.toThrow(/\[NO_BRIDGE\]/);
    });

    it('IPC error response throws [CODE]', async () => {
      mockTerminalApi({ create: vi.fn(async () => ipcErr('TERM_SPAWN_FAILED', 'no pty')) });
      await expect(createTerminal(CREATE_REQ)).rejects.toThrow(/\[TERM_SPAWN_FAILED\]/);
    });
  });

  describe('killTerminal', () => {
    it('bridge success resolves', async () => {
      const killMock = vi.fn(async () => ipcOk({ ok: true }));
      mockTerminalApi({ kill: killMock });
      await expect(killTerminal({ terminalId: 't-1' })).resolves.toBeUndefined();
      expect(killMock).toHaveBeenCalledWith({ terminalId: 't-1' });
    });

    it('no bridge throws [NO_BRIDGE]', async () => {
      removeBridge();
      await expect(killTerminal({ terminalId: 't-1' })).rejects.toThrow(/\[NO_BRIDGE\]/);
    });

    it('IPC error response throws [CODE]', async () => {
      mockTerminalApi({ kill: vi.fn(async () => ipcErr('TERM_KILL_FAILED', 'already gone')) });
      await expect(killTerminal({ terminalId: 't-1' })).rejects.toThrow(/\[TERM_KILL_FAILED\]/);
    });
  });

  describe('writeTerminalInput', () => {
    it('bridge returns true and forwards input', () => {
      const inputMock = vi.fn(async () => ipcOk(undefined));
      mockTerminalApi({ input: inputMock });
      expect(writeTerminalInput('t-1', 'ls\n')).toBe(true);
      expect(inputMock).toHaveBeenCalledWith({ terminalId: 't-1', data: 'ls\n' });
    });

    it('no bridge returns false without throwing', () => {
      removeBridge();
      expect(writeTerminalInput('t-1', 'ls\n')).toBe(false);
    });
  });

  describe('resizeTerminal', () => {
    it('bridge returns true and forwards size', () => {
      const resizeMock = vi.fn(async () => ipcOk(undefined));
      mockTerminalApi({ resize: resizeMock });
      expect(resizeTerminal('t-1', 120, 40)).toBe(true);
      expect(resizeMock).toHaveBeenCalledWith({ terminalId: 't-1', cols: 120, rows: 40 });
    });

    it('no bridge returns false without throwing', () => {
      removeBridge();
      expect(resizeTerminal('t-1', 120, 40)).toBe(false);
    });
  });

  describe('subscribeTerminalOutput / subscribeTerminalExit', () => {
    it('bridge registers handlers and returns working unsubscribe', () => {
      const unsubOut = vi.fn();
      const unsubExit = vi.fn();
      const subOut = vi.fn(() => unsubOut);
      const subExit = vi.fn(() => unsubExit);
      mockTerminalApi({
        subscribeOutputEvent: subOut,
        subscribeExitEvent: subExit,
      });

      const onOutput = vi.fn();
      const onExit = vi.fn();
      const offOutput = subscribeTerminalOutput(onOutput);
      const offExit = subscribeTerminalExit(onExit);

      expect(subOut).toHaveBeenCalledWith(onOutput);
      expect(subExit).toHaveBeenCalledWith(onExit);
      offOutput();
      offExit();
      expect(unsubOut).toHaveBeenCalledTimes(1);
      expect(unsubExit).toHaveBeenCalledTimes(1);
    });

    it('no bridge returns callable no-op unsubscribe', () => {
      removeBridge();
      const offOutput = subscribeTerminalOutput(() => {});
      const offExit = subscribeTerminalExit(() => {});
      expect(() => offOutput()).not.toThrow();
      expect(() => offExit()).not.toThrow();
    });
  });
});
