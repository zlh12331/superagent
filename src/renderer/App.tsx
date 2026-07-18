// src/renderer/App.tsx
// 渲染层根组件（Phase 1 仅占位，后续 Phase 填充路由）

import type { ReactElement } from 'react';

// 显式返回类型注解：isolatedDeclarations 要求所有导出必须有显式类型
export default function App(): ReactElement {
  return (
    <div style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <h1>网文写作 Agent</h1>
      <p>Phase 1 基础设施已就绪。</p>
    </div>
  );
}
