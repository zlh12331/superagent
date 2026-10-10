export function stableStringify(value: unknown): string {
  return stableStringifyInternal(value, new WeakSet());
}

function stableStringifyInternal(value: unknown, visited: WeakSet<object>): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (visited.has(value)) {
    throw new TypeError('Converting circular structure to JSON in stableStringify');
  }
  visited.add(value);
  let serialized: string;
  if (Array.isArray(value)) {
    serialized = `[${value.map((v) => stableStringifyInternal(v, visited)).join(',')}]`;
  } else {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    serialized = `{${keys
      .map(
        (k) =>
          `${JSON.stringify(k)}:${stableStringifyInternal((value as Record<string, unknown>)[k], visited)}`,
      )
      .join(',')}}`;
  }
  visited.delete(value);
  return serialized;
}
