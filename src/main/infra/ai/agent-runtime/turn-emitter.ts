import type { TurnEvent, TurnEventMap, TurnEventType } from '@code-agent/shared/main';

export class TurnEventEmitter {
  private readonly listeners = new Map<TurnEventType, Set<(event: TurnEvent) => void>>();
  private readonly anyListeners = new Set<(event: TurnEvent) => void>();

  on<E extends TurnEventType>(type: E, listener: (event: TurnEventMap[E]) => void): () => void {
    const bucket = this.listeners.get(type) ?? new Set<(event: TurnEvent) => void>();
    const wrapped = listener as (event: TurnEvent) => void;
    bucket.add(wrapped);
    this.listeners.set(type, bucket);
    return () => {
      bucket.delete(wrapped);
      if (bucket.size === 0) {
        this.listeners.delete(type);
      }
    };
  }

  emit(event: TurnEvent): void {
    for (const anyListener of this.anyListeners) {
      try {
        anyListener(event);
      } catch {}
    }
    const bucket = this.listeners.get(event.type);
    if (bucket === undefined || bucket.size === 0) {
      return;
    }
    for (const listener of bucket) {
      try {
        listener(event);
      } catch {}
    }
  }

  onAny(listener: (event: TurnEvent) => void): () => void {
    this.anyListeners.add(listener);
    return () => {
      this.anyListeners.delete(listener);
    };
  }

  getListenerCount(): number {
    let count = 0;
    for (const bucket of this.listeners.values()) {
      count += bucket.size;
    }
    return count + this.anyListeners.size;
  }
}
