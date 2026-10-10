/**
 * 稳定 JSON 序列化
 *
 * 与 JSON.stringify 的区别：对象的键按字典序排序，
 * 确保相同内容不同键顺序的对象生成相同的 hash。
 *
 * 用于 buildRememberKey，避免对象键顺序影响记忆决策的 key。
 */
export function stableStringify(value: unknown): string {
  return stableStringifyInternal(value, new WeakSet());
}

/**
 * stableStringify 内部实现，携带已访问对象集合检测循环引用
 *
 * 与原生 JSON.stringify 行为一致：遇到循环引用抛 TypeError，
 * 而非无限递归导致栈溢出（栈溢出会崩溃主进程，TypeError 可被调用方 catch）。
 */
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
