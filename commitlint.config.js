// commitlint.config.js
// Conventional Commits 1.0.0 + 官方默认规则
// 设计文档 docs/design/07-engineering-design.md §7.3
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
    // header 最大长度 100 字符——保持不放松（2026-09-11 复核）
    // 成熟规范：Git 官方建议 50（Pro Git「Limit the subject line to 50 characters」）、
    //          Angular 与 commitlint 官方默认 100。100 已是上限档。
    // 实测本项目近 200 个提交最长 subject 仅 76 字符，从未触及该上限（无实际摩擦）。
    // 不提到 1000 的理由：subject 是「一行摘要」，出现在 git log --oneline、
    // GitHub PR 标题、各 IDE 提交列表等窄位；放长会让摘要失去可扫读性，属反模式。
    'header-max-length': [2, 'always', 100],
    // body 前必须空一行（warning 级，宽松一些）
    'body-leading-blank': [1, 'always'],
    // body / footer 取消行宽强制（2026-09-11 放宽；0 = 关闭该规则）
    // 这两条是「排版美观」而非「语义」约束，且实际书写常出现不可折行内容——
    // URL、粘贴的日志/堆栈、代码片段——100 字符会误伤；而现代工具（git pager、
    // GitHub、IDE）一律自动折行，硬限制收益很低。
    // 注：必须显式写 0；直接删掉规则会**继承** @commitlint/config-conventional 的 100。
    'body-max-line-length': [0, 'always', 100],
    // footer 前必须空一行（warning 级）
    'footer-leading-blank': [1, 'always'],
    'footer-max-line-length': [0, 'always', 100],
    // scope 级别说明（2026-09-11 补充）：0=关闭 / 1=警告（打印提示但不阻断提交）/ 2=错误（阻断提交）。
    // 此处取 1——Conventional Commits 里 scope 本就是 optional，故让枚举只起「引导」作用。
    // 按真实用量补齐：实测近 120 个提交中 release(11)/ci(8)/about(5)/chat(3) 等常用
    // scope 不在旧枚举内，warning 长期空转（提示了也不改）。
    // 枚举取自现有架构：进程边界 + src/main/infra 领域目录 + 前端/设计 + 工程流程分类。
    // 曾包含 prisma / pg / rag，这三层已从仓库删除，保留会让门禁指向不存在的模块。
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
        // 领域模块（src/main/infra 等）
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
