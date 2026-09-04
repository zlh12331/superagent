/**
 * index.ts —— MotionLens bookmarklet 入口（esbuild 打包为 IIFE）。
 *
 * 流程：loadSettings() →（无 apiKey 先弹设置面板，可「跳过，仅提取数据」）
 *      → capture()（core 编排：点选 → 触发观察 → 提取/采样；用户取消 = null，静默退出）
 *      →（有 apiKey）analyzeCapture()，面板 loading → 结果面板
 *      → analyze 失败降级展示提取数据；任何全局异常进面板错误页。
 *
 * 防重复注入：window.__motionlens_loaded 已存在时仅重新打开面板。
 */
import { capture } from '../../core/index';
import { analyzeCapture } from '../../analyze/index';
import type { CaptureReport } from '../../core/types';
import { loadSettings, saveSettings } from './settings';
import type { BookmarkletSettings } from './settings';
import { MotionLensPanel } from './ui';

interface MotionLensController {
  open: () => void;
  /** 测试钩子：取面板 closed shadow root（e2e 断言用） */
  __shadow: () => ShadowRoot | null;
}

declare global {
  interface Window {
    __motionlens_loaded?: MotionLensController;
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function bootstrap(): MotionLensController {
  const panel = new MotionLensPanel();
  let running = false;
  /** 最近一次成功捕捉的 report，供全局兜底错误页降级展示 */
  let lastReport: CaptureReport | null = null;

  /** 无 key 时先弹设置面板；resolve 到最终要使用的 settings（可能无 key）或 null（用户关闭=中止） */
  function ensureSettings(): Promise<BookmarkletSettings | null> {
    const existing = loadSettings();
    if (existing?.apiKey) return Promise.resolve(existing);

    return new Promise<BookmarkletSettings | null>((resolve) => {
      let settled = false;
      const done = (v: BookmarkletSettings | null): void => {
        if (settled) return;
        settled = true;
        panel.onClose = null;
        resolve(v);
      };
      panel.onClose = () => done(null);
      panel.showSettingsForm({
        settings: existing ?? { provider: 'openai', apiKey: '' },
        onSave: (s) => {
          const ok = saveSettings(s);
          if (!ok) panel.setSettingsStatus('保存失败：本页 localStorage 不可用', false);
          if (s.apiKey) {
            done(s);
          } else {
            panel.setSettingsStatus(ok ? '已保存（未填 Key）' : '未保存', ok);
          }
        },
        onSkip: () => done(existing ?? { provider: 'openai', apiKey: '' }),
      });
    });
  }

  /** 主流程本体；抛出的异常与已产出的 report 一起交给 runGuarded 兜底 */
  async function runBody(): Promise<CaptureReport | null> {
    panel.open();
    panel.showLoading('准备中…');

    const settings = await ensureSettings();
    if (settings === null) return null; // 用户关闭了设置面板，中止

    // 点选期间隐藏面板（picker 全屏接管）
    panel.setHidden(true);
    let report: CaptureReport | null = null;
    try {
      report = await capture({
        // 点选完成即恢复面板，展示提取进度（观察 ~2.6s + 可能的采样 ~3s，避免"无反应"感）
        onPicked: () => {
          panel.setHidden(false);
          panel.showLoading('提取中…（观察触发约 3 秒，必要时采样 3 秒）');
        },
      });
    } finally {
      panel.setHidden(false);
    }
    if (!report) {
      panel.close(); // 用户取消点选：静默退出
      return null;
    }
    lastReport = report;

    if (settings.apiKey) {
      panel.showTab('prompt');
      panel.showLoading('AI 分析中…');
      try {
        const draft = await analyzeCapture(report, {
          provider: settings.provider,
          apiKey: settings.apiKey,
          model: settings.model,
          baseUrl: settings.baseUrl,
        });
        panel.showResult({ draft, report });
      } catch (err) {
        // analyze 失败（网络/key/解析）：错误提示 + 降级展示提取数据
        panel.showResult({ draft: null, report, analyzeError: errorMessage(err) });
      }
    } else {
      panel.showResult({ draft: null, report });
    }
    return report;
  }

  async function runGuarded(): Promise<void> {
    try {
      await runBody();
    } catch (err) {
      // 全局兜底：任何异常都进面板错误页，不白屏
      panel.open();
      panel.setHidden(false);
      panel.showError(errorMessage(err), lastReport);
    }
  }

  return {
    open(): void {
      if (running) {
        // 已在流程中：只保证面板可见（例如点选期间又点了书签）
        if (panel.isOpen) panel.setHidden(false);
        else panel.open();
        return;
      }
      running = true;
      void runGuarded().finally(() => {
        running = false;
      });
    },
    __shadow: () => panel.getShadowRoot(),
  };
}

const existing = window.__motionlens_loaded;
if (existing) {
  // 已注入过：直接重新打开面板
  existing.open();
} else {
  const controller = bootstrap();
  window.__motionlens_loaded = controller;
  controller.open();
}
