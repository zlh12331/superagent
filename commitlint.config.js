// commitlint.config.js：提交信息门禁配置（Conventional Commits），由 .husky/commit-msg 钩子加载
// 取值依据：docs/design/07-engineering-design.md §7.3
// 边界：header 的严格结构校验不在本文件（commitlint 无 header-pattern 规则，且会放行 `fix(x)+build(y):`
// 双 type 标题 → release-please 拒绝该提交、发版静默阻断），由 .husky/commit-msg → scripts/check-commit-msg.ts 校验
export default {
  // 官方预设：未在下方覆盖的规则沿用其默认值
  extends: ['@commitlint/config-conventional'],
  rules: {
    // 规则表：每条为 [level, when, value]，level 0 = 关闭 / 1 = 警告 / 2 = 错误
    // type 值域 = Conventional Commits 类型集（release-please 只对 feat/fix/perf 计入升版与 CHANGELOG）
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
    // 值 'lowerCase' 与 'lower-case' 等价（Angular v4 时代的兼容写法）
    'type-case': [2, 'always', 'lowerCase'],
    'type-empty': [2, 'never'],
    // subject 禁止四种「标题化」风格（小写与保持原样的写法放行）
    'subject-case': [2, 'never', ['sentence-case', 'start-case', 'pascal-case', 'upper-case']],
    'subject-empty': [2, 'never'],
    'subject-full-stop': [2, 'never', '.'],
    // 100 = commitlint / Angular 官方默认值（Git 官方建议为 50，100 已是上限档）；subject 会出现在
    // git log --oneline、PR 标题等窄位，放宽会让摘要失去可扫读性
    'header-max-length': [2, 'always', 100],
    // 重述预设默认值（warning 级：只提示不阻断）
    'body-leading-blank': [1, 'always'],
    // body / footer 行宽限制都取 0（关闭），且必须显式写 0——删掉规则会继承预设的 [2, 'always', 100]；
    // 这类排版约束会误伤无法折行的 URL / 日志 / 代码片段，而 git pager、GitHub、IDE 一律自动折行；
    // level 0 的规则不参与校验，尾部 100 不生效
    'body-max-line-length': [0, 'always', 100],
    'footer-leading-blank': [1, 'always'],
    'footer-max-line-length': [0, 'always', 100],
    // scope 取 1（警告级，只提示不阻断）：Conventional Commits 中 scope 本就可选，枚举只作引导
    'scope-enum': [
      1,
      'always',
      [
        // 进程边界 / 架构层
        'main',
        'renderer',
        'preload',
        'shared',
        'ipc',
        // src/main/infra 下的领域模块
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
        // 前端与设计
        'ui',
        'i18n',
        'tokens',
        'design',
        'chat',
        'about',
        'models',
        // 工程与流程
        'security',
        'e2e',
        'integration',
        'scripts',
        'build',
        'deps',
        'release',
        'ci',
        'docs',
        'test',
        'quality',
        'tsconfig',
      ],
    ],
  },
};
