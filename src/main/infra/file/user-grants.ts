import { isAbsolute } from 'node:path';

import { resolveRealTarget } from '../ai/tools/path-guard';

/** 授权表容量上限：超出按登记顺序淘汰最旧项 */
const MAX_GRANTS = 200;

/** canonical 绝对路径 → 登记时间戳（Map 保持插入顺序，淘汰即取首个 key） */
const grants = new Map<string, number>();

/**
 * 规范化输入路径为判定用 canonical 值
 *
 * @returns realpath 解析后的绝对路径；空串 / 相对路径返回 null（不可作为授权项）
 */
function canonicalize(inputPath: string): string | null {
  const trimmed = inputPath.trim();
  if (trimmed.length === 0 || !isAbsolute(trimmed)) return null;
  return resolveRealTarget(trimmed);
}

/**
 * 登记用户通过原生对话框选中的路径（授权读取）
 *
 * @param paths 对话框返回的绝对路径集合
 * @returns 实际新增的授权项数量
 */
export function grantUserReadPaths(paths: readonly string[]): number {
  let added = 0;
  for (const p of paths) {
    const canonical = canonicalize(p);
    if (canonical === null) continue;
    if (!grants.has(canonical)) {
      added += 1;
      if (grants.size >= MAX_GRANTS) {
        const oldest = grants.keys().next();
        if (!oldest.done) grants.delete(oldest.value);
      }
    }
    grants.delete(canonical);
    grants.set(canonical, Date.now());
  }
  return added;
}

/**
 * 命中判定：该路径是否为用户亲手授权过的精确文件
 *
 * @param inputPath 待判定路径（相对路径一律不命中——无法确定落点）
 * @returns 命中时返回 canonical 绝对路径（交给 FileService），否则 null
 */
export function matchUserGrantedReadPath(inputPath: string): string | null {
  const canonical = canonicalize(inputPath);
  if (canonical === null) return null;
  return grants.has(canonical) ? canonical : null;
}

/** 当前授权项数量（测试与可观测用） */
export function userReadGrantCount(): number {
  return grants.size;
}

/** 清空授权表（仅测试用：跨用例隔离进程级状态） */
export function clearUserReadGrants(): void {
  grants.clear();
}
