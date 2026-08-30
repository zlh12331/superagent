// src/main/infra/file/user-grants.ts
// 「用户手势授权路径」登记表 —— 工作区收口的唯一合法放行通道
//
// 为什么需要：file:* 全域经 confineToWorkspace 收口后，边界集合只有会话 workingDir，
// 而用户用原生对话框亲手选中的文件（聊天附件 dialog:pickFiles）天然在工作区之外，
// 结果是「用户点了允许却读不到自己选的文件」——这是收口引入的可用性回归。
//
// 语义边界（严格区分「用户显式选中」与「LLM 提供路径」）：
// - 只登记 realpath 规范化后的绝对路径，命中判定是精确相等而非前缀（不放开子树）
// - 只有 file:read 查询本表；write / delete / rename / create 一律不看，越权面不扩大
// - 授权来源只有原生对话框（操作系统级选择器），渲染层无法伪造
// - 进程内存态，重启即失效；容量有上限，防无界增长
//
// 已知代价（诚实记录）：授权项在文件被替换成 symlink 前一直有效；
// 大小写不同的路径在 Windows 上依赖 realpath 归一，归一失败即拒绝（fail closed）。

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
      // 容量兜底：满则淘汰最早登记项（先淘汰再插入，避免刚好在上限时插入失败）
      if (grants.size >= MAX_GRANTS) {
        const oldest = grants.keys().next();
        if (!oldest.done) grants.delete(oldest.value);
      }
    }
    // 重复登记也算「最近使用」：删除后重插，使 Map 顺序按最后授权时间排列
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
