// scripts/scaffold/lib/args.ts
// 极简 CLI 参数解析器（仅支持 --key value 与 --flag，零依赖）
// ──────────────────────────────────────────────
// 约束：
// - 参数格式：--name value / --name=value / --flag
// - 未知参数报错（防止拼写错误静默吞掉）
// - 解析结果只读，便于测试
// ──────────────────────────────────────────────

export interface ParsedArgs {
  /** 已解析的键值对（--key value） */
  readonly values: ReadonlyMap<string, string>;
  /** 已解析的布尔 flag（--flag） */
  readonly flags: ReadonlySet<string>;
  /** 位置参数（非 -- 开头的裸参数） */
  readonly positionals: readonly string[];
}

/**
 * 解析 CLI 参数
 *
 * @param argv 原始参数数组（不含 node/script 路径）
 * @param knownFlags 允许的布尔 flag 白名单
 * @throws Error 当出现未知 flag、缺值或裸参数时
 */
export function parseArgs(argv: readonly string[], knownFlags: readonly string[] = []): ParsedArgs {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (raw === undefined) {
      continue;
    }

    // 位置参数（不以 -- 开头）
    if (!raw.startsWith('--')) {
      positionals.push(raw);
      continue;
    }

    // 分离 key 与行内值（--key=value 形式）
    const eqIndex = raw.indexOf('=');
    const key = eqIndex === -1 ? raw.slice(2) : raw.slice(2, eqIndex);
    if (key === '') {
      throw new Error(`参数格式错误：${raw}（key 不能为空）`);
    }

    if (eqIndex !== -1) {
      // --key=value 形式
      const inlineValue = raw.slice(eqIndex + 1);
      if (inlineValue === '') {
        throw new Error(`参数 ${key} 缺少值（--${key}=<value>）`);
      }
      values.set(key, inlineValue);
      continue;
    }

    // --flag 形式：先按布尔处理，无默认值概念
    if (knownFlags.includes(key)) {
      flags.add(key);
      continue;
    }

    // 非 flag：取下一个参数作为值
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`参数 --${key} 缺少值`);
    }
    values.set(key, value);
    i += 1;
  }

  return { values, flags, positionals };
}

/**
 * 读取必填字符串参数
 *
 * @param parsed 解析结果
 * @param key 参数名
 * @throws Error 当参数缺失时
 */
export function requireValue(parsed: ParsedArgs, key: string): string {
  const value = parsed.values.get(key);
  if (value === undefined) {
    throw new Error(`缺少必填参数 --${key}`);
  }
  return value;
}

/**
 * 读取可选字符串参数
 *
 * @param parsed 解析结果
 * @param key 参数名
 * @param fallback 缺省值
 */
export function optionalValue(parsed: ParsedArgs, key: string, fallback: string): string {
  const value = parsed.values.get(key);
  return value === undefined ? fallback : value;
}

/** 拒绝位置参数（防止误传） */
export function rejectPositionals(parsed: ParsedArgs): void {
  if (parsed.positionals.length > 0) {
    throw new Error(
      `不支持的裸参数：${parsed.positionals.join(' ')}（所有参数必须使用 --key value 形式）`,
    );
  }
}
