// hook-registry.ts：工具生命周期钩子注册表——pre/post-tool-use，拒绝型钩子可阻断工具调用
import { logger } from '../../../utils/logger';

export const HookEventName = {
  PRE_TOOL_USE: 'pre-tool-use',
  POST_TOOL_USE: 'post-tool-use',
} as const;

export type HookEventName = (typeof HookEventName)[keyof typeof HookEventName];

export interface HookContext {
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

export type HookHandler = (
  context: HookContext,
) => boolean | HookDenial | undefined | Promise<boolean | HookDenial | undefined>;

export interface HookDenial {
  readonly allowed: false;
  readonly reason?: string;
}

function isDenial(value: unknown): value is HookDenial {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { allowed?: unknown }).allowed === false
  );
}

export interface HookBlock {
  readonly reason: string;
}

export class HookRegistry {
  private readonly handlers = new Map<HookEventName, Set<HookHandler>>();

  register(event: HookEventName, handler: HookHandler): () => void {
    const bucket = this.handlers.get(event) ?? new Set<HookHandler>();
    bucket.add(handler);
    this.handlers.set(event, bucket);
    return () => {
      bucket.delete(handler);
      if (bucket.size === 0) {
        this.handlers.delete(event);
      }
    };
  }

  async trigger(event: HookEventName, context: HookContext): Promise<HookBlock | null> {
    const bucket = this.handlers.get(event);
    if (bucket === undefined || bucket.size === 0) {
      return null;
    }
    let block: HookBlock | null = null;
    for (const handler of bucket) {
      try {
        const result = await handler(context);
        if (result === false) {
          block ??= { reason: '' };
        } else if (isDenial(result)) {
          block ??= { reason: result.reason ?? '' };
        }
      } catch (err: unknown) {
        logger.error({ event, toolName: context.toolName, error: err }, '钩子执行异常');
      }
    }
    return block;
  }

  getHandlerCount(): number {
    let count = 0;
    for (const bucket of this.handlers.values()) {
      count += bucket.size;
    }
    return count;
  }
}

export const hookRegistry = new HookRegistry();
