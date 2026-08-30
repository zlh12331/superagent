// commitlint.config.js
// Conventional Commits 1.0.0 + 官方默认规则
// 设计文档 §9.8
// 注意：commitlint 21.x 起规则名必须使用 kebab-case（如 type-enum）

export default {
  // 继承官方 conventional 配置，避免重复造轮子
  extends: ['@commitlint/config-conventional'],
  rules: {
    // type 必须在下列枚举内（错误级）
    'type-enum': [
      2,
      'always',
      [
        'build',
        'chore',
        'ci',
        'docs',
        'feat',
        'fix',
        'perf',
        'refactor',
        'revert',
        'style',
        'test',
      ],
    ],
    // type 必须小写
    'type-case': [2, 'always', 'lowerCase'],
    // type 不能为空
    'type-empty': [2, 'never'],
    // subject 禁止 sentence/start/pascal/upper case（允许小写或 as-is）
    'subject-case': [2, 'never', ['sentence-case', 'start-case', 'pascal-case', 'upper-case']],
    // subject 不能为空
    'subject-empty': [2, 'never'],
    // subject 末尾不能加句号
    'subject-full-stop': [2, 'never', '.'],
    // header 最大长度 100 字符
    'header-max-length': [2, 'always', 100],
    // body 前必须空一行（warning 级，宽松一些）
    'body-leading-blank': [1, 'always'],
    // body 每行最长 100
    'body-max-line-length': [2, 'always', 100],
    // footer 前必须空一行（warning 级）
    'footer-leading-blank': [1, 'always'],
    // footer 每行最长 100
    'footer-max-line-length': [2, 'always', 100],
    // scope 降为 warning（Conventional Commits scope 是 optional）
    // 枚举取自现有架构：进程边界 + src/main/infra 领域目录 + 测试/构建分类。
    // 曾包含 prisma / pg / rag，这三层已从仓库删除，保留会让门禁指向不存在的模块。
    'scope-enum': [
      1,
      'always',
      [
        'main',
        'renderer',
        'preload',
        'shared',
        'ipc',
        'ai',
        'agent',
        'tools',
        'storage',
        'file',
        'terminal',
        'memory',
        'git',
        'im',
        'lsp',
        'remote',
        'telemetry',
        'update',
        'ui',
        'i18n',
        'tokens',
        'security',
        'e2e',
        'integration',
        'scripts',
        'build',
        'deps',
      ],
    ],
  },
};
