export function combineAbortSignals(
  signals: readonly (AbortSignal | undefined)[],
): AbortSignal | undefined {
  const defined = signals.filter((s): s is AbortSignal => s !== undefined);
  if (defined.length === 0) {
    return undefined;
  }
  if (defined.length === 1) {
    return defined[0];
  }
  return AbortSignal.any(defined);
}

export function createTimeoutSignal(timeoutMs: number): {
  readonly signal: AbortSignal;
  readonly clear: () => void;
} {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(id),
  };
}
