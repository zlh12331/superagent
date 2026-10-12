// channel/types.ts：IM 渠道适配器契约——收发消息与连接生命周期的统一接口（6 渠道各自实现）
import type { ChannelKind } from '@code-agent/shared/main';

/** 渠道收到的一条消息（chatId 是回复目标；channelType 区分群聊/私聊） */
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

/** 渠道适配器契约：implemented=false 表示协议未落地（UI 灰显）；connect 的 token 可空（读存量） */
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
