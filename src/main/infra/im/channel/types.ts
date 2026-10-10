import type { ChannelKind } from '@code-agent/shared/main';

export interface ChannelIncomingMessage {
  readonly channel: ChannelKind;
  readonly chatId: string;
  readonly senderId: string | undefined;
  readonly text: string;
  readonly messageId: string;
  readonly channelType?: 'group' | 'user';
  readonly timestamp: number;
}

export interface ChannelTarget {
  readonly chatId: string;
}

export interface IChannelAdapter {
  readonly kind: ChannelKind;
  readonly displayName: string;
  readonly implemented: boolean;
  readonly isConnected: boolean;
  readonly configHint: string;

  connect(token: string | undefined): Promise<void>;

  disconnect(): Promise<void>;

  sendMessage(target: ChannelTarget, text: string): Promise<void>;

  onMessage(handler: (message: ChannelIncomingMessage) => void): () => void;
}
