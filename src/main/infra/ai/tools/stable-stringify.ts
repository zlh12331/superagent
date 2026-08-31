// src/main/infra/ai/tools/stable-stringify.ts
// 稳定 JSON 序列化（自 permission-service.ts 提取的纯函数模块）
// ──────────────────────────────────────────────────────────────
// 用途：记忆决策 key 构建前的入参序列化，避免对象键顺序影响 hash。
// ──────────────────────────────────────────────────────────────

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
  // 对于非对象值（string/number/boolean/null），直接 stringify
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  // 循环引用检测：已访问过的对象抛 TypeError（与 JSON.stringify 行为一致）
  if (visited.has(value)) {
    throw new TypeError('Converting circular structure to JSON in stableStringify');
  }
  visited.add(value);
  let serialized: string;
  // 对于数组，递归处理元素
  if (Array.isArray(value)) {
    serialized = `[${value.map((v) => stableStringifyInternal(v, visited)).join(',')}]`;
  } else {
    // 对于对象，按键排序后递归处理值
    const keys = Object.keys(value as Record<string, unknown>).sort();
    serialized = `{${keys
      .map(
        (k) =>
          `${JSON.stringify(k)}:${stableStringifyInternal((value as Record<string, unknown>)[k], visited)}`,
      )
      .join(',')}}`;
  }
  // 出栈时移除：visited 的语义是「当前递归路径上的祖先」，不是「曾经访问过」。
  // 不移除会把同一子对象的兄弟引用（DAG，如 {a: obj, b: obj}）误判成循环引用
  // 而抛 TypeError —— 原生 JSON.stringify 对这种输入是能正常序列化的。
  visited.delete(value);
  return serialized;
}
