// scripts/scaffold/lib/naming.ts
// 命名转换与校验（IPC domain / tool name 的规范约束）
// ──────────────────────────────────────────────
// 约定（与现有代码一致）：
// - IPC domain：camelCase（app / session / codebase）
// - tool name（LLM 可见）：snake_case（read_file / git_commit）
// - tool 文件名：kebab-case（read-file.tool.ts）
// - 工厂函数 / 类型：PascalCase（createReadFileTool / ReadFileInput）
// ──────────────────────────────────────────────

const SNAKE_NAME_RE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
const DOMAIN_RE = /^[a-z][a-zA-Z0-9]*$/;

/** 校验 tool name（snake_case，小写字母/数字/下划线，不能以数字或下划线开头） */
export function isValidToolName(name: string): boolean {
  return SNAKE_NAME_RE.test(name);
}

/** 校验 IPC domain（camelCase，小写字母开头） */
export function isValidDomain(domain: string): boolean {
  return DOMAIN_RE.test(domain);
}

/** snake_case → PascalCase（read_file → ReadFile） */
export function snakeToPascal(name: string): string {
  return name
    .split('_')
    .map((seg) => (seg === '' ? seg : seg[0].toUpperCase() + seg.slice(1)))
    .join('');
}

/** snake_case → kebab-case（read_file → read-file） */
export function snakeToKebab(name: string): string {
  return name.replace(/_/g, '-');
}

/** camelCase → PascalCase（codebase → Codebase；myDomain → MyDomain） */
export function camelToPascal(domain: string): string {
  return domain[0].toUpperCase() + domain.slice(1);
}

/** 校验 tool 权限取值 */
export function isValidPermission(permission: string): boolean {
  return permission === 'auto' || permission === 'ask';
}

/** 校验 IPC 方法名（camelCase，小写字母开头） */
export function isValidMethod(method: string): boolean {
  return DOMAIN_RE.test(method);
}
