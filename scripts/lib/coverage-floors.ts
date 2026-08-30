// scripts/lib/coverage-floors.ts
// 覆盖率门槛「单一真源」读取与校验（对应门禁 scripts/check-coverage-floors.ts）
// ──────────────────────────────────────────────────────────────
// 背景问题：各层 vitest.config.ts 内联了互不一致的四组数字
// （main 80/75/80/80、renderer 59/50/54/59、shared 80/30/39/80），
// 而对外文档一律自称「按规范值 80/75/80/80 卡关」——门槛与事实脱钩，
// 且任何人可以在 config 里悄悄调低数字而不被发现。
//
// 本模块把三件事分离并保持可校验：
//   specTarget 该层应达到的规范目标（shared 是类型包，目标本身低于业务层）
//   floor      当前真正强制的门槛（vitest 直接读本 JSON，config 内不再出现数字）
//   ratchet    已批准的历史最高门槛（floor 只能 ≥ 它，降级必须显式改此处并留理由）
//   measured   最近一次真实实测（报告口径：必须 ≥ floor，且不得过期太久）
// ──────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 四项覆盖率指标名（与 vitest thresholds 字段一致） */
export const METRIC_KEYS = ['statements', 'branches', 'functions', 'lines'] as const;

/** 参与门槛治理的层级（preload 无独立测试工程，不单列） */
export const LAYER_KEYS = ['shared', 'main', 'renderer'] as const;

/** 收紧机制（设计文档 §3.3）：新实测减去该缓冲才可作为新门槛 */
export const MEASURE_BUFFER = 5;

/** 指标名类型 */
export type MetricKey = (typeof METRIC_KEYS)[number];

/** 层级名类型 */
export type LayerKey = (typeof LAYER_KEYS)[number];

/** 一组四项指标数值 */
export type MetricSet = Record<MetricKey, number>;

/** vitest 的 thresholds 结构 */
export type Thresholds = {
  statements: number;
  branches: number;
  functions: number;
  lines: number;
};

/** 单层门槛记录 */
export interface LayerFloors {
  specTarget: MetricSet;
  floor: MetricSet;
  ratchet: MetricSet;
  measured: MetricSet;
  measuredAt: string;
}

/** 真源文件结构 */
export interface CoverageFloorsFile {
  maxStaleDays: number;
  layers: Record<LayerKey, LayerFloors>;
}

/** 一条校验问题 */
export interface FloorsProblem {
  readonly key: string;
  readonly detail: string;
}

const DAY_MS = 86_400_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readMetricSet(value: unknown, where: string): MetricSet {
  if (!isRecord(value)) {
    throw new Error(`${where} 必须是包含四项指标的对象`);
  }
  const out = {} as MetricSet;
  for (const key of METRIC_KEYS) {
    const v = value[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) {
      throw new Error(`${where}.${key} 必须是 0–100 的数值，当前为 ${JSON.stringify(v)}`);
    }
    out[key] = v;
  }
  return out;
}

function readLayer(value: unknown, layer: LayerKey): LayerFloors {
  if (!isRecord(value)) {
    throw new Error(`layers.${layer} 必须是对象`);
  }
  const { specTarget, floor, ratchet, measured, measuredAt } = value;
  if (typeof measuredAt !== 'string' || Number.isNaN(Date.parse(measuredAt))) {
    throw new Error(`layers.${layer}.measuredAt 必须是 ISO 日期字符串`);
  }
  return {
    specTarget: readMetricSet(specTarget, `layers.${layer}.specTarget`),
    floor: readMetricSet(floor, `layers.${layer}.floor`),
    ratchet: readMetricSet(ratchet, `layers.${layer}.ratchet`),
    measured: readMetricSet(measured, `layers.${layer}.measured`),
    measuredAt,
  };
}

/**
 * 解析真源原始内容；结构非法时抛错（门禁宁可显式失败也不静默放行）
 *
 * @param raw scripts/coverage-floors.json 的文本内容
 * @returns 校验过字段完整性的门槛真源
 */
export function parseCoverageFloors(raw: string): CoverageFloorsFile {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || !isRecord(parsed.layers)) {
    throw new Error('覆盖率真源格式错误：顶层必须是含 layers 对象');
  }
  for (const layer of LAYER_KEYS) {
    if (!(layer in parsed.layers)) {
      throw new Error(`覆盖率真源缺少层级 ${layer}`);
    }
  }
  if (typeof parsed.maxStaleDays !== 'number' || parsed.maxStaleDays <= 0) {
    throw new Error('覆盖率真源的 maxStaleDays 必须是正数（实测过期上限，单位：天）');
  }
  return {
    maxStaleDays: parsed.maxStaleDays,
    layers: Object.fromEntries(
      LAYER_KEYS.map((layer) => [layer, readLayer(parsed.layers[layer], layer)]),
    ) as Record<LayerKey, LayerFloors>,
  };
}

/**
 * 读取并解析门槛真源
 *
 * @param file coverage-floors.json 绝对路径
 * @returns 已解析真源
 */
export function loadCoverageFloors(file: string): CoverageFloorsFile {
  return parseCoverageFloors(readFileSync(file, 'utf-8'));
}

/**
 * 返回某一层供 vitest 使用的 thresholds（数值来自 floor，四字段显式构造，
 * 便于在开启 exactOptionalPropertyTypes 时也不会带入可选属性语义）
 *
 * @param file 已解析的门槛真源
 * @param layer 层级名
 * @returns vitest coverage.thresholds 值
 */
export function thresholdsOf(file: CoverageFloorsFile, layer: LayerKey): Thresholds {
  const floor = file.layers[layer].floor;
  return {
    statements: floor.statements,
    branches: floor.branches,
    functions: floor.functions,
    lines: floor.lines,
  };
}

/**
 * 校验门槛真源自洽性（棘轮未降级、实测满足门槛、实测未过期）
 *
 * @param file 已解析的门槛真源
 * @param today 校验基准时间（测试可注入固定时间）
 * @returns 问题列表；空数组代表通过
 */
export function validateCoverageFloors(file: CoverageFloorsFile, today: Date): FloorsProblem[] {
  const problems: FloorsProblem[] = [];
  for (const layer of LAYER_KEYS) {
    const entry = file.layers[layer];
    for (const metric of METRIC_KEYS) {
      const { floor, ratchet, measured } = entry;
      if (floor[metric] < ratchet[metric]) {
        problems.push({
          key: `${layer}.${metric}`,
          detail: `门槛 ${floor[metric]} 低于棘轮下限 ${ratchet[metric]}（静默降级，必须显式说明理由）`,
        });
      }
      if (measured[metric] < floor[metric]) {
        problems.push({
          key: `${layer}.${metric}`,
          detail: `记录的实测 ${measured[metric]} 低于门槛 ${floor[metric]}（数字不自洽：门槛不可能通过，或实测被美化）`,
        });
      }
    }
    const ageDays = (today.getTime() - Date.parse(entry.measuredAt)) / DAY_MS;
    if (ageDays < 0) {
      problems.push({
        key: `${layer}.measuredAt`,
        detail: `实测时间 ${entry.measuredAt} 在未来（应为真实跑测日期）`,
      });
    } else if (ageDays > file.maxStaleDays) {
      problems.push({
        key: `${layer}.measuredAt`,
        detail: `实测数据已过期 ${Math.floor(ageDays)} 天（上限 ${file.maxStaleDays} 天），请重跑 pnpm test:coverage 并回填 measured/measuredAt`,
      });
    }
  }
  return problems;
}

/**
 * 按 §3.3 收紧机制计算建议门槛：min(规范目标, 实测 − 缓冲)，只升不降
 *
 * @param entry 单层门槛记录
 * @returns 指标名 → 建议门槛
 */
export function proposeTighten(entry: LayerFloors): MetricSet {
  const out = {} as MetricSet;
  for (const metric of METRIC_KEYS) {
    const fromMeasured = Math.floor(entry.measured[metric] - MEASURE_BUFFER);
    out[metric] = Math.max(entry.floor[metric], Math.min(entry.specTarget[metric], fromMeasured));
  }
  return out;
}

/**
 * 逐项取较大者（棘轮只能上升）
 *
 * @param previous 现有值
 * @param next 新值
 * @returns 合并结果
 */
export function raiseSet(previous: MetricSet, next: MetricSet): MetricSet {
  const out = {} as MetricSet;
  for (const metric of METRIC_KEYS) {
    out[metric] = Math.max(previous[metric], next[metric]);
  }
  return out;
}

/**
 * 把一组指标渲染成 `80/75/80/80` 形式（statements/branches/functions/lines 顺序）
 *
 * @param set 指标数值
 * @returns 斜杠分隔字符串
 */
export function formatMetricSet(set: MetricSet): string {
  return METRIC_KEYS.map((metric) => set[metric]).join('/');
}

/** 表头（供门禁与测试共用，避免文案漂移） */
export const FLOORS_TABLE_HEADER =
  '  层级       门槛 St/Br/Fn/Li      实测 St/Br/Fn/Li        与规范目标差';

/**
 * 渲染门槛对照表：门槛 / 实测 / 与规范目标的真实差距（逐指标）
 *
 * @param file 已解析真源
 * @returns 表头 + 每层一行
 */
export function renderFloorsTable(file: CoverageFloorsFile): string[] {
  const rows: string[] = [FLOORS_TABLE_HEADER];
  for (const layer of LAYER_KEYS) {
    const entry = file.layers[layer];
    const gapText = METRIC_KEYS.map((metric) => {
      const gap = entry.specTarget[metric] - entry.floor[metric];
      return gap === 0 ? '✓' : `-${gap}pp`;
    }).join(' ');
    rows.push(
      `  ${layer.padEnd(10)} ${formatMetricSet(entry.floor).padEnd(21)} ${formatMetricSet(entry.measured).padEnd(23)} ${gapText}`,
    );
  }
  return rows;
}

/** 层级 → 该层强制门槛的配置文件（相对仓库根） */
export const LAYER_CONFIGS: Record<LayerKey, string> = {
  shared: 'packages/shared/vitest.config.ts',
  main: 'src/main/vitest.config.ts',
  renderer: 'src/renderer/vitest.config.ts',
};

/** thresholds 块内出现数字即视为「config 里内联了门槛」 */
const INLINE_THRESHOLDS_RE = /thresholds\s*:\s*\{[^{}]*\d/;

/**
 * 校验各层 vitest 配置确实以真源为准（引用正确层级、且不再内联数字）
 *
 * @param root 仓库根目录绝对路径
 * @returns 问题列表；空数组代表通过
 */
export function validateConfigWiring(root: string): FloorsProblem[] {
  const problems: FloorsProblem[] = [];
  for (const layer of LAYER_KEYS) {
    const rel = LAYER_CONFIGS[layer];
    let text: string;
    try {
      text = readFileSync(join(root, rel), 'utf-8');
    } catch {
      problems.push({ key: `${layer}.config`, detail: `读不到配置文件 ${rel}` });
      continue;
    }
    if (!text.includes('coverage-floors.json')) {
      problems.push({
        key: `${layer}.config`,
        detail: `${rel} 未读取唯一真源 scripts/coverage-floors.json`,
      });
    }
    if (!text.includes(`layers.${layer}.floor`)) {
      problems.push({
        key: `${layer}.config`,
        detail: `${rel} 未从真源取 layers.${layer}.floor 作为 thresholds 来源`,
      });
    }
    if (INLINE_THRESHOLDS_RE.test(text)) {
      problems.push({
        key: `${layer}.config`,
        detail: `${rel} 的 thresholds 仍内联数字（必须改为引用真源）`,
      });
    }
  }
  return problems;
}

function jsonSet(set: MetricSet): string {
  return `{ ${METRIC_KEYS.map((metric) => `"${metric}": ${set[metric]}`).join(', ')} }`;
}

/**
 * 按 §3.3 机制回填 floor/ratchet（只升不降）。
 * 逐行替换而非整体 stringify：真源里的 `$comment` 是治理说明，不能丢。
 * 约定缩进：层级键 4 空格、字段 6 空格（与 coverage-floors.json 一致）。
 *
 * @param raw coverage-floors.json 原始文本
 * @param file 已解析真源
 * @returns 新文本 + 变更摘要
 */
export function applyTighten(
  raw: string,
  file: CoverageFloorsFile,
): { text: string; changed: string[] } {
  const replacement = new Map<LayerKey, { floor: string; ratchet: string }>();
  const changed: string[] = [];
  for (const layer of LAYER_KEYS) {
    const entry = file.layers[layer];
    const floor = proposeTighten(entry);
    const ratchet = raiseSet(entry.ratchet, floor);
    const floorChanged = formatMetricSet(entry.floor) !== formatMetricSet(floor);
    const ratchetChanged = formatMetricSet(entry.ratchet) !== formatMetricSet(ratchet);
    if (floorChanged || ratchetChanged) {
      changed.push(
        `${layer}: floor ${formatMetricSet(entry.floor)} → ${formatMetricSet(floor)}，ratchet → ${formatMetricSet(ratchet)}`,
      );
    }
    replacement.set(layer, { floor: jsonSet(floor), ratchet: jsonSet(ratchet) });
  }

  let current: LayerKey | null = null;
  const text = raw
    .split('\n')
    .map((line) => {
      const layerMatch = /^ {4}"([a-z]+)": \{$/.exec(line);
      if (layerMatch?.[1] && LAYER_KEYS.includes(layerMatch[1] as LayerKey)) {
        current = layerMatch[1] as LayerKey;
        return line;
      }
      if (/^ {2}\}$/.test(line)) current = null;
      if (current === null) return line;
      const field = /^(\s*)"(floor|ratchet)": \{[^{}]*\}(,?)$/.exec(line);
      const value = field && replacement.get(current)?.[field[2] as 'floor' | 'ratchet'];
      if (!field?.[1] || !field[2] || !value) return line;
      return `${field[1]}"${field[2]}": ${value}${field[3] ?? ''}`;
    })
    .join('\n');
  return { text, changed };
}
