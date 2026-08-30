// packages/shared/src/__tests__/terminal-schema.test.ts
// terminal schema 单测：P0 env 注入面——系统关键环境变量禁止由渲染层覆盖
// （PATH/PATHEXT 决定命令解析、LD_PRELOAD/NODE_OPTIONS 决定启动即加载哪里的代码）

import { describe, expect, it } from 'vitest';
import { isTerminalEnvDenied, TerminalCreateReqSchema } from '../schemas/terminal';

describe('isTerminalEnvDenied', () => {
  it('命中清单：可执行文件解析 + 动态库预加载 + 解释器选项注入', () => {
    for (const key of ['PATH', 'PATHEXT', 'COMSPEC', 'LD_PRELOAD', 'NODE_OPTIONS', 'PYTHONPATH']) {
      expect(isTerminalEnvDenied(key)).toBe(true);
    }
  });

  it('大小写/空白变体同样命中（Windows 环境变量大小写不敏感）', () => {
    expect(isTerminalEnvDenied('path')).toBe(true);
    expect(isTerminalEnvDenied(' Path ')).toBe(true);
    expect(isTerminalEnvDenied('node_options')).toBe(true);
  });

  it('普通自定义变量不误伤', () => {
    for (const key of ['MY_API_KEY', 'HTTP_PROXY', 'EDITOR', 'CODE_AGENT_PROFILE']) {
      expect(isTerminalEnvDenied(key)).toBe(false);
    }
  });
});

describe('TerminalCreateReqSchema · env 关键变量拒绝（P0）', () => {
  /**
   * 构造 env 记录。真实环境变量名本就是大写蛇形（PATH / LD_PRELOAD），
   * 写成字面量属性会被 useNamingConvention(strictCase) 判为违规，
   * 故经 Object.fromEntries 转为运行期键。
   */
  function envOf(...pairs: Array<readonly [string, string]>): Record<string, string> {
    return Object.fromEntries(pairs);
  }

  /** 断言 env 校验失败，且 issue 落在 env 字段并点名被拒键 */
  function expectEnvDenied(env: Record<string, string>, ...keys: string[]): void {
    const result = TerminalCreateReqSchema.safeParse({ env });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issues = result.error.issues.filter((issue) => issue.path.join('.') === 'env');
      expect(issues).toHaveLength(1);
      for (const key of keys) {
        expect(issues[0]?.message).toContain(key);
      }
    }
  }

  it('拒绝 PATH 覆盖', () => {
    expectEnvDenied(envOf(['PATH', 'C:\\evil']), 'PATH');
  });

  it('拒绝 PATH/PATHEXT 之外的劫持面（LD_PRELOAD / NODE_OPTIONS / 小写变体）', () => {
    expectEnvDenied(envOf(['LD_PRELOAD', '/tmp/x.so']), 'LD_PRELOAD');
    expectEnvDenied(envOf(['NODE_OPTIONS', '--require /tmp/evil.js']), 'NODE_OPTIONS');
    expectEnvDenied(envOf(['path', '/tmp/evil']), 'path');
  });

  it('一次报出全部被拒键（便于调用方修正）', () => {
    const result = TerminalCreateReqSchema.safeParse({
      env: envOf(['PATH', 'x'], ['COMSPEC', 'y'], ['MY_KEY', 'ok']),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const message = result.error.issues[0]?.message ?? '';
      expect(message).toContain('PATH');
      expect(message).toContain('COMSPEC');
      expect(message).not.toContain('MY_KEY');
    }
  });

  it('普通 env 正常通过（自定义变量仍可注入）', () => {
    const result = TerminalCreateReqSchema.safeParse({
      cwd: '/work',
      env: envOf(['MY_API_KEY', 'k'], ['HTTP_PROXY', 'http://127.0.0.1:8']),
    });
    expect(result.success).toBe(true);
  });

  it('无 env / 空 env 通过（向后兼容既有调用方 env: undefined）', () => {
    expect(TerminalCreateReqSchema.safeParse({}).success).toBe(true);
    expect(TerminalCreateReqSchema.safeParse({ env: {} }).success).toBe(true);
    const withCols = TerminalCreateReqSchema.parse({ cols: 120 });
    expect(withCols.cols).toBe(120);
    expect(withCols.env).toBeUndefined();
  });
});
