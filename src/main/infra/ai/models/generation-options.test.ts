import { describe, expect, it } from 'vitest';
import { BUILTIN_MODELS, DEFAULT_KIND, DEFAULT_MODEL_BY_KIND } from './builtin-models';
import { buildGenerationOptions } from './generation-options';
import { ModelRegistry } from './registry';

function createRegistry(): ModelRegistry {
  return new ModelRegistry({
    entries: BUILTIN_MODELS,
    defaultModelByKind: DEFAULT_MODEL_BY_KIND,
    defaultKind: DEFAULT_KIND,
  });
}

describe('buildGenerationOptions', () => {
  const registry = createRegistry();

  it('reasoning 模型（deepseek-flash）：注入 reasoningEffort（max），不传采样参数', () => {
    const resolved = registry.resolve('deepseek-flash');
    const gen = buildGenerationOptions(resolved, 100);

    expect(gen.providerOptions).toEqual({ deepseek: { reasoningEffort: 'max' } });
    expect(gen.samplingOptions).toEqual({});
    expect(gen.maxOutputTokens).toBe(384_000);
  });

  it('reasoning 模型无 reasoningEffort 配置：不注入 providerOptions', () => {
    const resolved = registry.resolve('deepseek-reasoner');
    const gen = buildGenerationOptions(resolved, 0);

    expect(gen.providerOptions).toBeUndefined();
  });

  it('非 reasoning 模型配置采样参数：应用 temperature / topP / maxTokens', () => {
    const customRegistry = new ModelRegistry({
      entries: BUILTIN_MODELS.map((entry) =>
        entry.id === 'deepseek-chat'
          ? { ...entry, generationConfig: { temperature: 0.7, topP: 0.9, maxTokens: 8_000 } }
          : entry,
      ),
      defaultModelByKind: DEFAULT_MODEL_BY_KIND,
      defaultKind: DEFAULT_KIND,
    });
    const gen = buildGenerationOptions(customRegistry.resolve('deepseek-chat'), 0);

    expect(gen.samplingOptions).toEqual({ temperature: 0.7, topP: 0.9 });
    expect(gen.maxOutputTokens).toBe(8_000);
    expect(gen.providerOptions).toBeUndefined();
  });

  it('prompt 接近窗口：输出上限按窗口余量钳制（gpt 载体换 deepseek-reasoner，64K 窗口/64K 输出）', () => {
    // deepseek-reasoner：窗口 64K —— 110K prompt 已超窗，输出被钳到窗口余量方向的最小值
    const gen = buildGenerationOptions(registry.resolve('deepseek-reasoner'), 110_000);

    expect(gen.maxOutputTokens).toBeLessThanOrEqual(64_000);
  });

  it('用户温度覆盖：非 reasoning 模型以 temperatureOverride 为准', () => {
    const customRegistry = new ModelRegistry({
      entries: BUILTIN_MODELS.map((entry) =>
        entry.id === 'deepseek-chat'
          ? { ...entry, generationConfig: { temperature: 0.7, topP: 0.9, maxTokens: 8_000 } }
          : entry,
      ),
      defaultModelByKind: DEFAULT_MODEL_BY_KIND,
      defaultKind: DEFAULT_KIND,
    });
    const gen = buildGenerationOptions(customRegistry.resolve('deepseek-chat'), 0, undefined, 1.2);

    expect(gen.samplingOptions).toEqual({ temperature: 1.2, topP: 0.9 });
  });

  it('用户温度覆盖：reasoning 模型忽略采样参数（思考模式官方限制）', () => {
    const gen = buildGenerationOptions(registry.resolve('deepseek-flash'), 100, undefined, 0.3);

    expect(gen.samplingOptions).toEqual({});
    expect(gen.providerOptions).toEqual({ deepseek: { reasoningEffort: 'max' } });
  });
});
