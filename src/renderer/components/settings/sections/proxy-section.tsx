import { useMutation } from '@tanstack/react-query';
import { Network } from 'lucide-react';
import type { ReactElement } from 'react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useErrorMessage, useTranslation } from '@/i18n/use-translation';
import { unwrapErrorMessage } from '@/lib/ipc';
import { testProxyConnection } from '@/lib/settings-ops';
import { useSettingsStore } from '@/stores/persistent/settings-store';
import { SegControl, SettingRow } from '../settings-controls';

/** 测试连接结果（kind → 渲染层文案映射） */
type TestResult = {
  ok: boolean;
  kind: 'ok' | 'proxy-unreachable' | 'target-unreachable' | 'not-applicable';
};

/** 网络代理分区（通用分组：与窗口行为/系统通知同属运行环境域） */
export function ProxySection(): ReactElement {
  const { t } = useTranslation();
  const { getErrorMessage } = useErrorMessage();
  const proxy = useSettingsStore((s) => s.proxy);
  const updateProxy = useSettingsStore((s) => s.updateProxy);

  const [testResult, setTestResult] = useState<TestResult | null>(null);

  const testMutation = useMutation({
    mutationFn: async (): Promise<TestResult> => {
      const res = await testProxyConnection();
      return { ok: res.ok, kind: res.kind };
    },
    onSuccess: (result) => {
      setTestResult(result);
    },
    onError: (error) => {
      setTestResult({ ok: false, kind: 'target-unreachable' });
      unwrapErrorMessage(error, getErrorMessage);
    },
  });

  const isFixed = proxy.mode === 'fixed';

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Network className="text-muted-foreground size-3.5" strokeWidth={1.5} />
        <h3 className="text-foreground text-sm font-semibold">{t('settings.proxyTitle')}</h3>
      </div>
      <div className="mt-2 flex flex-col gap-2">
        <SettingRow label={t('settings.proxyModeLabel')} description={t('settings.proxyModeDesc')}>
          <SegControl
            value={proxy.mode}
            options={[
              { value: 'system', label: t('settings.proxyModeSystem') },
              { value: 'direct', label: t('settings.proxyModeDirect') },
              { value: 'fixed', label: t('settings.proxyModeFixed') },
            ]}
            onChange={(value) => {
              setTestResult(null);
              updateProxy({ mode: value as 'system' | 'direct' | 'fixed' });
            }}
          />
        </SettingRow>

        {isFixed && (
          <>
            <div className="bg-card rounded-lg border px-3 py-2.5">
              <Label className="text-foreground text-sm" htmlFor="proxy-url-input">
                {t('settings.proxyUrlLabel')}
              </Label>
              <Input
                id="proxy-url-input"
                className="mt-1.5 font-mono text-xs"
                placeholder={t('settings.proxyUrlPlaceholder')}
                defaultValue={proxy.url ?? ''}
                onBlur={(e) => {
                  const url = e.target.value.trim();
                  if (url === '') {
                    return;
                  }
                  try {
                    const parsed = new URL(url);
                    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
                      updateProxy({ url });
                    }
                  } catch {}
                }}
              />
              <p className="text-muted-foreground mt-1 text-xs leading-[1.5]">
                {t('settings.proxyUrlDesc')}
              </p>
            </div>

            <SettingRow
              label={t('settings.proxyBypassLabel')}
              description={t('settings.proxyBypassDesc')}
            >
              <Input
                className="w-[220px] font-mono text-xs"
                placeholder="corp.example, 10.0.0.0/8"
                defaultValue={(proxy.bypass ?? []).join(', ')}
                onBlur={(e) => {
                  const list = e.target.value
                    .split(',')
                    .map((s) => s.trim())
                    .filter((s) => s.length > 0);
                  updateProxy(list.length > 0 ? { bypass: list } : { bypass: [] });
                }}
              />
            </SettingRow>

            <div className="bg-card flex items-center gap-2.5 rounded-lg border px-3 py-2.5">
              <Button
                variant="outline"
                size="sm"
                disabled={testMutation.isPending}
                onClick={() => testMutation.mutate()}
              >
                {t('settings.proxyTestButton')}
              </Button>
              {testResult !== null && (
                <span className="text-muted-foreground text-xs">
                  {testResult.ok
                    ? t('settings.proxyTestSuccess')
                    : testResult.kind === 'not-applicable'
                      ? t('settings.proxyTestNotApplicable')
                      : t('settings.proxyTestFailed')}
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
