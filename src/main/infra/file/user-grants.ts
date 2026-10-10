// user-grants.ts：用户手动授权读路径登记表——用户经系统对话框亲自选中的文件/目录视为已授权
// Agent 后续读这些路径时（file 域 guardRead）直接放行，不再重复弹审批
import { isAbsolute } from 'node:path';

import { resolveRealTarget } from '../ai/tools/path-guard';

// 授权条目上限 200：LRU 淘汰最旧（防长期运行无限累积）
const MAX_GRANTS = 200;

// key 为 realpath 规范化后的路径：符号链接/大小写差异不会绕过或重复登记
const grants = new Map<string, number>();

// realpath 解析：授予时目标必须真实存在；相对路径/空串直接拒
function canonicalize(inputPath: string): string | null {
  const trimmed = inputPath.trim();
  if (trimmed.length === 0 || !isAbsolute(trimmed)) return null;
  return resolveRealTarget(trimmed);
}

/** 登记授权路径（重复登记刷新时间戳保持 LRU 新鲜度）；@returns 实际新增条数 */
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

/** 查询路径是否已授权；命中返回规范化路径（调用方直接用它访问） */
export function matchUserGrantedReadPath(inputPath: string): string | null {
  const canonical = canonicalize(inputPath);
  if (canonical === null) return null;
  return grants.has(canonical) ? canonical : null;
}

/** 当前授权条数（测试断言用） */
export function userReadGrantCount(): number {
  return grants.size;
}

/** 清空授权表（测试隔离用） */
export function clearUserReadGrants(): void {
  grants.clear();
}
