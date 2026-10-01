// src/renderer/hooks/use-editor-code-style.ts
// 代码面排版行为变量应用单点（37 号 A：AppShell 挂载，订阅 store 单真源）
// ──────────────────────────────────────────────────────────────
// 为什么单点（对齐 use-zoom-effect 先例）：tabSize 的四个入口（设置页/导入广播/
// resetAll/启动快照）全部经 settings-store——挂一个订阅 editor.tabSize 的 effect
// 构造性覆盖全部入口，无需在各入口散布 setProperty 调用。
//
// 变量语义：--code-tab-size 是**行为值**（用户设置驱动），不是设计令牌——定义在
// styles/index.css 的 :root（默认 8=浏览器默认），不随主题变化，故不进 tokens.css
// 生成物（避开 tokens:check 生成物一致性约束）。
//
// 与 theme 首帧镜像的区别：tab 宽度闪变的感知代价可忽略（非默认值在挂载后一帧
// 内收敛），不引入首帧内联脚本级别的镜像机制。
// ──────────────────────────────────────────────────────────────

import { useEffect } from 'react';

import { useSettingsStore } from '@/stores/persistent/settings-store';

/** 订阅 store.editor.tabSize 并写入 --code-tab-size（AppShell 顶层挂载一次） */
export function useEditorCodeStyle(): void {
  const tabSize = useSettingsStore((s) => s.editor.tabSize);
  useEffect(() => {
    document.documentElement.style.setProperty('--code-tab-size', String(tabSize));
  }, [tabSize]);
}
