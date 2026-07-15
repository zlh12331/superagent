/**
 * Commitlint 配置，采用 Conventional Commits 规范。
 *
 * 强制提交信息格式：type(scope): subject
 * @see https://conventionalcommits.org/
 */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // type 必须为以下值之一
    'type-enum': [
      2,
      'always',
      [
        'feat', // 新功能
        'fix', // Bug 修复
        'docs', // 仅文档变更
        'style', // 不影响代码含义的格式调整
        'refactor', // 既非 Bug 修复也非新增功能的代码重构
        'perf', // 提升性能的代码变更
        'test', // 补充缺失测试或修正既有测试
        'build', // 影响构建系统或外部依赖的变更
        'ci', // CI 配置文件与脚本的变更
        'chore', // 其他不修改 src 或测试文件的变更
        'revert', // 回滚之前的提交
      ],
    ],
    // Header 长度必须为 5-100 个字符
    'header-min-length': [2, 'always', 5],
    'header-max-length': [2, 'always', 100],
    // Subject 末尾不能有句号
    'subject-full-stop': [2, 'never', '.'],
    // Subject 必须为小写
    'subject-case': [2, 'always', 'lower-case'],
  },
}
