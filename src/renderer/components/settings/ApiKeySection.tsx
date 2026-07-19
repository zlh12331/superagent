// src/renderer/components/settings/ApiKeySection.tsx
// DeepSeek API Key 设置区块
// 设计文档 §7.7 应用设置 + §7.4 错误处理流程
//
// 职责：
// - 提供 API Key 输入框（password 模式，避免明文泄露）
// - 「测试」按钮：调用 useTestApiKey 验证当前 keychain 中的 Key 是否可用
// - 「保存」按钮：调用 useSetApiKey 把输入框中的 Key 写入系统 keychain
// - 操作过程给出 toast 反馈，按钮在 pending 时禁用避免重复提交
//
// 注意：
// - API Key 不会在内存中暂存（输入框为本地 useState，保存成功后立刻清空）
// - 测试时不需要传入 Key，主进程会从 keychain 读取并打一次探针请求
// - 失败的 toast 由 mutation onError 内部统一处理，组件 catch 块仅做兜底

import { KeyRound } from 'lucide-react';
import type { ReactElement } from 'react';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useSetApiKey, useTestApiKey } from '@/hooks/use-settings';
import { handleIpcError } from '@/lib/handle-ipc-error';

/**
 * DeepSeek API Key 设置区块
 *
 * @example
 * <ApiKeySection />
 */
export function ApiKeySection(): ReactElement {
  // 输入框本地状态：保存成功后立刻清空，避免 Key 长时间停留在内存
  const [apiKey, setApiKey] = useState('');
  const testMutation = useTestApiKey();
  const saveMutation = useSetApiKey();

  // 任一 mutation 处于 pending 时禁用两个按钮，避免测试与保存交叉进行
  const isBusy = testMutation.isPending || saveMutation.isPending;

  /**
   * 测试 API Key：调用主进程从 keychain 读取 Key 并打探针请求
   *
   * 成功时 latencyMs 可能不存在（旧版主进程），用 ?? 兜底为"未知"
   */
  const handleTest = async (): Promise<void> => {
    try {
      const result = await testMutation.mutateAsync({ provider: 'deepseek' });
      if (result.ok) {
        const latency = result.latencyMs ?? null;
        toast.success(latency !== null ? `API Key 有效（延迟 ${latency} ms）` : 'API Key 有效');
      } else {
        toast.error('API Key 无效');
      }
    } catch (err) {
      // mutation onError 已统一弹 toast，这里再兜底一次（极端情况下 onError 未触发）
      handleIpcError(err);
    }
  };

  /**
   * 保存 API Key：写入系统 keychain
   *
   * 成功后清空输入框，避免 Key 长时间停留在 React state 中
   */
  const handleSave = async (): Promise<void> => {
    // 空字符串不保存，避免覆盖已有的有效 Key
    if (apiKey.trim().length === 0) return;
    try {
      await saveMutation.mutateAsync({ provider: 'deepseek', apiKey: apiKey.trim() });
      toast.success('API Key 已保存到 keychain');
      setApiKey('');
    } catch (err) {
      handleIpcError(err);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="size-4" />
          DeepSeek API Key
        </CardTitle>
        <CardDescription>用于调用 DeepSeek Chat API，加密存储在系统 keychain</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="deepseek-api-key">API Key</Label>
          <Input
            id="deepseek-api-key"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-xxxxxxxxxxxxxxxx"
            autoComplete="off"
            disabled={isBusy}
          />
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void handleTest()} disabled={isBusy}>
            {testMutation.isPending ? '测试中...' : '测试'}
          </Button>
          <Button
            size="sm"
            onClick={() => void handleSave()}
            disabled={isBusy || apiKey.trim().length === 0}
          >
            {saveMutation.isPending ? '保存中...' : '保存'}
          </Button>
        </div>
        <p className="text-muted-foreground text-xs">API Key 加密存储在系统 keychain，跨项目共享</p>
      </CardContent>
    </Card>
  );
}
