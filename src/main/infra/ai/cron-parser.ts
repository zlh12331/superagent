// src/main/infra/ai/cron-parser.ts
// Cron 表达式解析器（5 字段：分/时/日/月/周）
// ──────────────────────────────────────────────────────────────
// 支持：*、单值、步进（*/N、a-b/N）、范围（a-b）、逗号列表（a,b,c）
// 不支持扩展语法（L、W、?、名称别名）
//
// 借鉴声明：
// 本模块参考 qwen-code 参考项目 packages/core/src/utils/cronParser.ts
// （Copyright 2026 Qwen Team，SPDX-License-Identifier: Apache-2.0）的
// 5 字段解析语义，按我们的技术栈收敛重写（类型/命名适配项目规范）。
// ──────────────────────────────────────────────────────────────

/** 字段范围：minute/hour/dayOfMonth/month/dayOfWeek */
const FIELD_RANGES: readonly [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7], // 0 和 7 均为周日
];

const INTEGER_TOKEN_RE = /^\d+$/;

/** 解析后的调度计划 */
export interface CronSchedule {
  readonly minute: ReadonlySet<number>;
  readonly hour: ReadonlySet<number>;
  readonly dayOfMonth: ReadonlySet<number>;
  readonly month: ReadonlySet<number>;
  readonly dayOfWeek: ReadonlySet<number>;
  /** 日字段是否为字面 *（不受限） */
  readonly domIsWild: boolean;
  /** 周字段是否为字面 *（不受限） */
  readonly dowIsWild: boolean;
  /** 原始表达式 */
  readonly expression: string;
}

/**
 * 解析单个字段为匹配值集合
 * 支持：星号、单值、斜杠步进（星号/N、范围/N）、范围（a-b）、逗号列表
 */
function parseField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    const trimmed = part.trim();
    if (trimmed.length === 0) {
      throw new Error(`空字段段："${field}"`);
    }
    const stepParts = trimmed.split('/');
    if (stepParts.length > 2) {
      throw new Error(`无效的步进表达式："${trimmed}"`);
    }
    const base = stepParts[0];
    if (base === undefined) {
      throw new Error(`无效的字段段："${trimmed}"`);
    }
    let rangeStart: number;
    let rangeEnd: number;
    if (base === '*') {
      rangeStart = min;
      rangeEnd = max;
    } else if (base.includes('-')) {
      const rangeParts = base.split('-');
      const startStr = rangeParts[0];
      const endStr = rangeParts[1];
      if (
        rangeParts.length !== 2 ||
        startStr === undefined ||
        endStr === undefined ||
        !INTEGER_TOKEN_RE.test(startStr) ||
        !INTEGER_TOKEN_RE.test(endStr)
      ) {
        throw new Error(`无效的范围："${base}"`);
      }
      rangeStart = parseInt(startStr, 10);
      rangeEnd = parseInt(endStr, 10);
      if (rangeStart < min || rangeEnd > max || rangeStart > rangeEnd) {
        throw new Error(`范围 ${base} 越界 [${min}-${max}]`);
      }
    } else {
      if (!INTEGER_TOKEN_RE.test(base)) {
        throw new Error(`无效的值："${base}"`);
      }
      const val = parseInt(base, 10);
      if (val < min || val > max) {
        throw new Error(`值 ${base} 越界 [${min}-${max}]`);
      }
      values.add(val === 7 && min === 0 && max === 7 ? 0 : val);
      continue;
    }
    const step = stepParts[1] !== undefined ? parseInt(stepParts[1], 10) : 1;
    if (Number.isNaN(step) || step < 1) {
      throw new Error(`无效的步长："${stepParts[1]}"`);
    }
    for (let v = rangeStart; v <= rangeEnd; v += step) {
      // 周字段：7 归一为 0（周日）
      values.add(v === 7 && min === 0 && max === 7 ? 0 : v);
    }
  }
  return values;
}

/**
 * 解析 cron 表达式
 *
 * @throws 表达式非法时抛错（字段数/取值越界/语法错误）
 */
export function parseCron(expression: string): CronSchedule {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `cron 表达式需 5 个字段（分 时 日 月 周），实际 ${fields.length} 个："${expression}"`,
    );
  }
  const parsed = fields.map((field, index) => {
    const range = FIELD_RANGES[index];
    const min = range?.[0];
    const max = range?.[1];
    if (min === undefined || max === undefined) {
      throw new Error(`无效字段范围索引 ${index}`);
    }
    return parseField(field, min, max);
  });
  return {
    minute: parsed[0] as Set<number>,
    hour: parsed[1] as Set<number>,
    dayOfMonth: parsed[2] as Set<number>,
    month: parsed[3] as Set<number>,
    dayOfWeek: parsed[4] as Set<number>,
    domIsWild: fields[2] === '*',
    dowIsWild: fields[4] === '*',
    expression: expression.trim(),
  };
}

/** 日期是否匹配调度计划 */
export function matches(schedule: CronSchedule, date: Date): boolean {
  if (!schedule.minute.has(date.getMinutes())) {
    return false;
  }
  if (!schedule.hour.has(date.getHours())) {
    return false;
  }
  if (!schedule.month.has(date.getMonth() + 1)) {
    return false;
  }
  const dayOfWeek = date.getDay(); // 0=周日
  // 日/周双受限时任一匹配即可（标准 cron 语义）；单受限时受限字段必须匹配
  const domMatch = schedule.dayOfMonth.has(date.getDate());
  const dowMatch = schedule.dayOfWeek.has(dayOfWeek);
  if (schedule.domIsWild && schedule.dowIsWild) {
    return true;
  }
  if (schedule.domIsWild) {
    return dowMatch;
  }
  if (schedule.dowIsWild) {
    return domMatch;
  }
  return domMatch || dowMatch;
}

/** 计算 from 之后的首次触发时间（含 from 当秒之后；分钟级精度） */
export function nextFireTime(schedule: CronSchedule, from: Date): Date {
  // 从 from 的下一个整分钟开始扫描（上限 5 年防死循环）
  const candidate = new Date(from);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);
  const deadline = from.getTime() + 5 * 365 * 24 * 60 * 60 * 1000;
  while (candidate.getTime() <= deadline) {
    if (matches(schedule, candidate)) {
      return candidate;
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  throw new Error(`无法在 5 年内找到 cron 表达式的下次触发时间："${schedule.expression}"`);
}
