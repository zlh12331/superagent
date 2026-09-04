/**
 * popup.ts —— MotionLens 弹窗控制。
 * 主按钮 → ML_START_CAPTURE / ML_START_RECORD 发给 background 后关闭弹窗；
 * 设置读写 chrome.storage.sync；底部展示库条目数 + 打开灵感库。
 */

declare const chrome: any;

const SETTINGS_KEY = 'ml_settings';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function send(type: string): Promise<any> {
  return chrome.runtime.sendMessage({ type });
}

async function initSettings(): Promise<void> {
  const got = await chrome.storage.sync.get(SETTINGS_KEY);
  const s = got?.[SETTINGS_KEY] ?? {};
  $<HTMLSelectElement>('provider').value = s.provider ?? 'openai';
  $<HTMLInputElement>('apiKey').value = s.apiKey ?? '';
  $<HTMLInputElement>('model').value = s.model ?? '';
  $<HTMLInputElement>('baseUrl').value = s.baseUrl ?? '';
  if (!s.apiKey) (document.getElementById('settings-details') as HTMLDetailsElement).open = true;
}

async function saveSettings(): Promise<void> {
  const s = {
    provider: $<HTMLSelectElement>('provider').value,
    apiKey: $<HTMLInputElement>('apiKey').value.trim(),
    model: $<HTMLInputElement>('model').value.trim(),
    baseUrl: $<HTMLInputElement>('baseUrl').value.trim(),
  };
  await chrome.storage.sync.set({ [SETTINGS_KEY]: s });
  const status = $('save-status');
  status.textContent = '已保存';
  setTimeout(() => (status.textContent = ''), 2000);
}

async function refreshCount(): Promise<void> {
  try {
    const res = await send('ML_GET_STATE');
    if (res?.ok) $('lib-count').textContent = `已捕捉 ${res.value.count} 条`;
  } catch {
    /* background 未就绪时静默 */
  }
}

function wireCaptureButton(id: string, type: string): void {
  $(id).addEventListener('click', async () => {
    const status = $('popup-status');
    status.textContent = '';
    try {
      // 先发出消息再关闭弹窗；background 异步完成后续流程
      const p = send(type);
      window.close();
      const res = await p;
      if (!res?.ok) console.warn('MotionLens:', res?.error);
    } catch (err) {
      console.warn('MotionLens:', err);
    }
  });
}

function main(): void {
  const manifest = chrome.runtime.getManifest();
  document.getElementById('version')!.textContent = `v${manifest.version}`;

  wireCaptureButton('capture', 'ML_START_CAPTURE');
  wireCaptureButton('record', 'ML_START_RECORD');

  $('save-settings').addEventListener('click', () => void saveSettings());
  $('open-library').addEventListener('click', () => {
    void send('ML_OPEN_LIBRARY');
    window.close();
  });

  void initSettings();
  void refreshCount();
}

main();
