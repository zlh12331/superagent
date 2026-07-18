# Phase 1: 项目基础设施 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从空仓库搭建出能通过 `pnpm typecheck` / `pnpm lint` / `pnpm build` / `pnpm dev` 的最小 Electron 40 + React 19.2 + TypeScript 6 工程，0 业务代码，0 错误 0 警告。

**Architecture:** Electron 三进程模型（main / preload / renderer）+ pnpm workspace + TS Project References + Biome 2 + Husky 9。配置严格遵循设计文档 §3（目录结构）、§9.1（TS 严格配置）、§9.2（Biome 2）、§9.9（Husky + lint-staged）、§9.13（CodeGraph 同步）。

**Tech Stack:** Electron 40 / electron-vite 5 / Vite 8 / React 19.2 + React Compiler / TypeScript 6.0 / Biome 2 / Husky 9 / lint-staged 15 / commitlint latest / pnpm 10 / Node 24.13.0 / CodeGraph 0.9.8

**设计文档引用:** [novel-writer-agent-design.md](file:///f:/TraeProjects/1/docs/superpowers/specs/novel-writer-agent-design.md)

---

## 文件结构（Phase 1 产出）

```
f:\TraeProjects\1\
├─ .codegraph/                    # 已存在
├─ .editorconfig                  # 新建
├─ .gitignore                     # 新建
├─ .husky/                        # 新建
│  ├─ pre-commit                  # 跑 lint-staged + codegraph sync
│  └─ commit-msg                  # 跑 commitlint
├─ .nvmrc                         # 新建（24.13.0）
├─ biome.json                     # 新建（Biome 2 配置）
├─ commitlint.config.js           # 新建
├─ electron.vite.config.ts        # 新建（三入口 main/preload/renderer）
├─ package.json                   # 新建（根 + scripts + lint-staged）
├─ pnpm-lock.yaml                 # 自动生成
├─ pnpm-workspace.yaml            # 新建
├─ tsconfig.json                  # 新建（根 references）
├─ packages/
│  ├─ tsconfig/                   # 新建（共享 tsconfig 包）
│  │  ├─ package.json
│  │  ├─ base.json               # 通用严格配置
│  │  ├─ node.json               # Node.js（主进程 + preload）
│  │  └─ web.json                # Web（渲染层）
│  └─ shared/                     # 新建（占位，Phase 2 填充）
│     ├─ package.json
│     └─ src/index.ts
└─ src/
   ├─ main/
   │  ├─ index.ts                # Electron 主进程入口
   │  └─ tsconfig.json
   ├─ preload/
   │  ├─ index.ts                # contextBridge 暴露空 api
   │  └─ tsconfig.json
   └─ renderer/
      ├─ index.html
      ├─ main.tsx                # React 19.2 入口
      ├─ index.css               # Tailwind v4 入口（占位）
      └─ tsconfig.json
```

---

## Task 1: 初始化 pnpm workspace + 根 package.json + 基础配置文件

**Files:**
- Create: `f:\TraeProjects\1\pnpm-workspace.yaml`
- Create: `f:\TraeProjects\1\package.json`
- Create: `f:\TraeProjects\1\.nvmrc`
- Create: `f:\TraeProjects\1\.gitignore`
- Create: `f:\TraeProjects\1\.editorconfig`

- [ ] **Step 1: 创建 `pnpm-workspace.yaml`**

```yaml
# pnpm-workspace.yaml
# pnpm workspace 配置：声明 packages/ 下所有子目录为 workspace 包
packages:
  - 'packages/*'
```

- [ ] **Step 2: 创建 `.nvmrc` 锁定 Node 版本**

```text
24.13.0
```

- [ ] **Step 3: 创建 `.editorconfig` 统一编辑器行为**

```ini
# .editorconfig
# EditorConfig: https://editorconfig.org
# 跨编辑器统一缩进/换行/编码行为，与 Biome formatter 保持一致

root = true

[*]
charset = utf-8
end_of_line = lf
indent_style = space
indent_size = 2
insert_final_newline = true
trim_trailing_whitespace = true

[*.md]
# Markdown 允许尾部空格（换行用）
trim_trailing_whitespace = false
```

- [ ] **Step 4: 创建 `.gitignore`**

```gitignore
# .gitignore

# 依赖
node_modules/

# 构建产物
dist/
out/
release/
*.tsbuildinfo

# electron-vite 临时
.vite/

# IDE
.vscode/*
!.vscode/extensions.json
!.vscode/settings.json
.idea/

# 系统文件
.DS_Store
Thumbs.db
desktop.ini

# 环境变量
.env
.env.local
.env.*.local

# 日志
*.log
logs/

# CodeGraph 索引（已存在 .codegraph/.gitignore 自管）
# 测试覆盖率
coverage/

# Electron 打包
*.exe
*.appx
*.msi
```

- [ ] **Step 5: 创建根 `package.json`**

```json
{
  "name": "novel-writer-agent",
  "version": "0.1.0",
  "description": "网文写作 Agent - Windows 桌面端应用",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.0.0",
  "engines": {
    "node": ">=24.13.0",
    "pnpm": ">=10.0.0"
  },
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "preview": "electron-vite preview",
    "typecheck": "tsc --build",
    "lint": "biome check .",
    "lint:fix": "biome check --write .",
    "format": "biome format --write .",
    "test": "echo \"测试将在 Phase 9 引入\" && exit 0",
    "codegraph:sync": "codegraph sync",
    "prepare": "husky"
  },
  "lint-staged": {
    "*.{js,ts,cjs,mjs,d.cts,d.mts,jsx,tsx,json,jsonc,css}": [
      "biome check --write --no-errors-on-unmatched"
    ]
  },
  "devDependencies": {
    "@novel-writer/tsconfig": "workspace:*",
    "@novel-writer/shared": "workspace:*"
  }
}
```

> 注：`workspace:*` 是 pnpm workspace 协议，install 时会自动 symlink 到根 `node_modules`，
> 确保子项目 tsconfig 的 `extends: "@novel-writer/tsconfig/..."` 能被 TS 编译器解析。

- [ ] **Step 6: 验证 workspace 配置可识别（无包时也合法）**

Run: `pnpm install`
Expected: 输出 `Lockfile up to date` 或 `No packages matched` 警告，无错误

- [ ] **Step 7: Commit**

```bash
git add pnpm-workspace.yaml package.json .nvmrc .gitignore .editorconfig
git commit -m "feat: 初始化 pnpm workspace 与根配置文件

- pnpm-workspace.yaml 声明 packages/* workspace
- package.json 含 scripts/engines/packageManager/lint-staged
- .nvmrc 锁定 Node 24.13.0
- .gitignore 覆盖 node_modules/dist/.env 等
- .editorconfig 统一编辑器行为（2 空格、LF、UTF-8）"
```

---

## Task 2: TypeScript Project References 配置

设计文档 §9.1 严格配置 + Project References（三端共享 tsconfig）。

**Files:**
- Create: `f:\TraeProjects\1\packages\tsconfig\package.json`
- Create: `f:\TraeProjects\1\packages\tsconfig\base.json`
- Create: `f:\TraeProjects\1\packages\tsconfig\node.json`
- Create: `f:\TraeProjects\1\packages\tsconfig\web.json`
- Create: `f:\TraeProjects\1\tsconfig.json`（根，references）

- [ ] **Step 1: 创建 `packages/tsconfig/package.json`（作为 workspace 内部包）**

```json
{
  "name": "@novel-writer/tsconfig",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "files": [
    "base.json",
    "node.json",
    "web.json"
  ],
  "exports": {
    "./base.json": "./base.json",
    "./node.json": "./node.json",
    "./web.json": "./web.json"
  }
}
```

- [ ] **Step 2: 创建 `packages/tsconfig/base.json`（通用严格配置）**

> 严格遵循设计文档 §9.1。所有开关均为生产级，禁止放宽。

```jsonc
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "compilerOptions": {
    "target": "ES2024",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2024"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "isolatedDeclarations": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "useDefineForClassFields": true,
    "noEmit": true,
    "incremental": true,
    "composite": true
  }
}
```

- [ ] **Step 3: 创建 `packages/tsconfig/node.json`（主进程 + preload）**

```jsonc
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "./base.json",
  "compilerOptions": {
    "lib": ["ES2024"],
    "types": ["node"]
  }
}
```

- [ ] **Step 4: 创建 `packages/tsconfig/web.json`（渲染层）**

```jsonc
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "./base.json",
  "compilerOptions": {
    "lib": ["ES2024", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "types": ["vite/client"]
  }
}
```

- [ ] **Step 5: 创建根 `tsconfig.json`（Project References 入口）**

```jsonc
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "files": [],
  "references": [
    { "path": "./packages/tsconfig" },
    { "path": "./packages/shared" },
    { "path": "./src/main" },
    { "path": "./src/preload" },
    { "path": "./src/renderer" }
  ]
}
```

> 注：`packages/shared`、`src/main` 等子项目的 tsconfig.json 将在后续 Task 中创建。
> 此处 references 先声明，构建时若被引用项目缺失 tsconfig 会报错，Step 6 验证会暂时跳过 typecheck。

- [ ] **Step 6: Commit**

```bash
git add packages/tsconfig/ tsconfig.json
git commit -m "feat(tsconfig): 添加 TypeScript Project References 基础配置

- packages/tsconfig 作为 workspace 内部包
- base.json: 生产级严格配置（strict + noUncheckedIndexedAccess 等）
- node.json: 主进程/preload 用
- web.json: 渲染层用（DOM + jsx: react-jsx）
- 根 tsconfig.json 通过 references 编排所有子项目"
```

---

## Task 3: electron-vite 脚手架（Electron 40 + Vite 8 + React 19.2 + TS 6）

**Files:**
- Create: `f:\TraeProjects\1\electron.vite.config.ts`
- Create: `f:\TraeProjects\1\src\main\tsconfig.json`
- Create: `f:\TraeProjects\1\src\main\index.ts`
- Create: `f:\TraeProjects\1\src\preload\tsconfig.json`
- Create: `f:\TraeProjects\1\src\preload\index.ts`
- Create: `f:\TraeProjects\1\src\renderer\tsconfig.json`
- Create: `f:\TraeProjects\1\src\renderer\index.html`
- Create: `f:\TraeProjects\1\src\renderer\main.tsx`
- Create: `f:\TraeProjects\1\src\renderer\index.css`
- Create: `f:\TraeProjects\1\packages\shared\package.json`
- Create: `f:\TraeProjects\1\packages\shared\src\index.ts`
- Create: `f:\TraeProjects\1\packages\shared\tsconfig.json`

- [ ] **Step 1: 安装生产依赖**

Run:
```bash
pnpm add electron@^40 electron-vite@^5 vite@^8 react@^19.2 react-dom@^19.2
```

Expected: `pnpm-lock.yaml` 生成；无 peer dependency 警告。

- [ ] **Step 2: 安装开发依赖**

Run:
```bash
pnpm add -D @types/node@^24 @types/react@^19.2 @types/react-dom@^19.2 @vitejs/plugin-react@^5 typescript@^6 babel-plugin-react-compiler@latest
```

Expected: 类型包 + React Compiler 安装成功，无冲突。

> React Compiler 是 React 19.2 的官方推荐（设计文档 §2.3），通过 babel 插件自动 memoize，
> 减少手动 `useMemo`/`useCallback`。Vite 通过 `@vitejs/plugin-react` 的 babel 选项启用。

- [ ] **Step 3: 创建 `packages/shared/package.json`**

```json
{
  "name": "@novel-writer/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  }
}
```

- [ ] **Step 4: 创建 `packages/shared/src/index.ts` 占位**

```ts
// packages/shared/src/index.ts
// 跨进程共享类型入口
// Phase 2 将填充 IPC 类型契约、Zod schema、错误码等

export const SHARED_VERSION = '0.0.0' as const
```

- [ ] **Step 5: 创建 `packages/shared/tsconfig.json`**

```jsonc
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "@novel-writer/tsconfig/base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 6: 创建 `electron.vite.config.ts`**

```ts
// electron.vite.config.ts
// electron-vite 配置：定义 main / preload / renderer 三个构建入口
// 参考 electron-vite 官方文档 https://electron-vite.org/

import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // 主进程构建配置
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
        },
      },
    },
  },
  // Preload 脚本构建配置
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
        },
      },
    },
  },
  // 渲染层（React 19.2 + Vite 8 + React Compiler）配置
  renderer: {
    root: 'src/renderer',
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
        },
      },
    },
    plugins: [
      react({
        // 启用 React Compiler（React 19.2 官方推荐，自动 memoize）
        babel: {
          plugins: [['babel-plugin-react-compiler']],
        },
      }),
    ],
  },
})
```

- [ ] **Step 7: 创建 `src/main/tsconfig.json`**

```jsonc
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "@novel-writer/tsconfig/node.json",
  "compilerOptions": {
    "outDir": "./out",
    "rootDir": "./"
  },
  "include": ["**/*.ts"]
}
```

- [ ] **Step 8: 创建 `src/main/index.ts`（Electron 主进程入口）**

```ts
// src/main/index.ts
// Electron 主进程入口
// 职责：创建 BrowserWindow、加载渲染层、配置安全基线
// 设计文档 §1.1 进程拓扑 / §4.5 安全配置

import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 模块路径解析（ESM 环境下 __dirname 不可用，需用 import.meta.url）
const __dirname = fileURLToPath(new URL('.', import.meta.url))

/**
 * 创建主窗口
 * 安全配置遵循 Electron Security 官方推荐：
 * - contextIsolation: true（XSS → RCE 防护）
 * - nodeIntegration: false
 * - sandbox: true（渲染层沙箱）
 */
function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })

  // 限制导航（Security #13）：只允许应用内导航
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('http://localhost') && !url.startsWith('app://')) {
      event.preventDefault()
    }
  })

  // 限制新窗口（Security #14）：外链走系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) {
      shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  // 开发环境加载 dev server，生产环境加载构建产物
  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  win.once('ready-to-show', () => {
    win.show()
  })

  return win
}

// 应用就绪后创建窗口
app.whenReady().then(() => {
  createWindow()

  // macOS: 点击 dock 图标时若无窗口则重建
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

// 所有窗口关闭时退出（macOS 除外）
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
```

- [ ] **Step 9: 创建 `src/preload/tsconfig.json`**

```jsonc
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "@novel-writer/tsconfig/node.json",
  "compilerOptions": {
    "outDir": "./out",
    "rootDir": "./"
  },
  "include": ["**/*.ts"]
}
```

- [ ] **Step 10: 创建 `src/preload/index.ts`（contextBridge 占位）**

```ts
// src/preload/index.ts
// Preload 脚本：在隔离的 contextIsolation 环境中暴露受限 API 到渲染层
// 设计文档 §4.9 Preload unsubscribe 模式 / §4.7 traceId 注入
//
// Phase 1 仅暴露空 api 占位，后续 Phase 将填充 project/chapter/chat 等

import { contextBridge } from 'electron'

// 暴露到渲染层的 window.api 命名空间（当前为空对象）
const api = {
  // Phase 2 起将逐步填充：
  // project: { ... }
  // chapter: { ... }
  // chat: { ... }
  // rag: { ... }
} as const

// 通过 contextBridge 暴露（contextIsolation: true 下唯一安全方式）
contextBridge.exposeInMainWorld('api', api)
```

- [ ] **Step 11: 创建 `src/renderer/tsconfig.json`**

```jsonc
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "@novel-writer/tsconfig/web.json",
  "compilerOptions": {
    "outDir": "./out",
    "rootDir": "./",
    "paths": {
      "@/*": ["./*"]
    }
  },
  "include": ["**/*.ts", "**/*.tsx"],
  "references": [
    { "path": "../../packages/shared" }
  ]
}
```

- [ ] **Step 12: 创建 `src/renderer/index.html`**

```html
<!doctype html>
<!-- src/renderer/index.html
     Electron 渲染层入口 HTML
     CSP 严格定义见设计文档 §4.6 -->
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <!-- CSP：default-src 'self' + 限制 connect-src -->
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'self';
              script-src 'self';
              style-src 'self' 'unsafe-inline';
              connect-src 'self' http://localhost:11434 https://api.deepseek.com https://api.openai.com;
              img-src 'self' data: blob:;" />
    <title>网文写作 Agent</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 13: 创建 `src/renderer/App.tsx`**

```tsx
// src/renderer/App.tsx
// 渲染层根组件（Phase 1 仅占位，后续 Phase 填充路由）

export default function App() {
  return (
    <div style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <h1>网文写作 Agent</h1>
      <p>Phase 1 基础设施已就绪。</p>
    </div>
  )
}
```

> Biome 规则 `noDefaultExport: off` 已在 §9.2 中为 `src/renderer/**/*.tsx` 开启 override。

- [ ] **Step 14: 创建 `src/renderer/main.tsx`（React 19.2 入口）**

```tsx
// src/renderer/main.tsx
// React 19.2 渲染层入口
// 设计文档 §2.3 React 19.2 + React Compiler

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'

// React 19 createRoot API
const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('根节点 #root 未找到')
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
```

- [ ] **Step 15: 创建 `src/renderer/index.css`**

```css
/* src/renderer/index.css
   全局样式入口
   Phase 7 将替换为 Tailwind v4 入口（@import "tailwindcss"） */

html,
body,
#root {
  margin: 0;
  padding: 0;
  height: 100%;
}

body {
  font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
  -webkit-font-smoothing: antialiased;
  user-select: none;
}
```

- [ ] **Step 16: 验证 typecheck 通过**

Run: `pnpm typecheck`
Expected: 0 errors 0 warnings。若报错检查 paths 配置。

- [ ] **Step 17: 验证 build 通过**

Run: `pnpm build`
Expected: `out/main/index.js`、`out/preload/index.js`、`out/renderer/index.html` 生成；无 warning。

- [ ] **Step 18: Commit**

```bash
git add electron.vite.config.ts src/ packages/shared/
git commit -m "feat(scaffold): 搭建 electron-vite 三入口脚手架

- electron.vite.config.ts 配置 main/preload/renderer 三入口
- src/main/index.ts: BrowserWindow + contextIsolation + sandbox + 导航限制
- src/preload/index.ts: contextBridge 暴露空 api
- src/renderer: React 19.2 + StrictMode + CSP
- packages/shared 占位（Phase 2 填充 IPC 契约）
- packages/tsconfig Project References 编排"
```

---

## Task 4: Biome 2 配置

设计文档 §9.2 完整配置 + §10.3 验证项。

**Files:**
- Create: `f:\TraeProjects\1\biome.json`

- [ ] **Step 1: 安装 Biome 2**

Run: `pnpm add -D @biomejs/biome@^2`
Expected: 安装成功，`pnpm-lock.yaml` 更新。

- [ ] **Step 2: 创建 `biome.json`（严格遵循设计文档 §9.2）**

```jsonc
{
  "$schema": "https://biomejs.dev/schemas/2.0.0/schema.json",
  "vcs": {
    "enabled": true,
    "clientKind": "git",
    "useIgnoreFile": true
  },
  "files": {
    "ignore": ["resources/pg/**", "release/**", "coverage/**", "node_modules/**", "out/**", "dist/**", ".codegraph/**"]
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100,
    "lineEnding": "lf"
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "correctness": {
        "noUnusedVariables": "error",
        "noUnusedImports": "error",
        "useExhaustiveDependencies": "warn"
      },
      "suspicious": {
        "noExplicitAny": "error",
        "noConsoleLog": "warn"
      },
      "style": {
        "useImportType": "error",
        "useNamingConvention": "error",
        "useConst": "error",
        "noDefaultExport": "error"
      }
    }
  },
  "javascript": {
    "formatter": {
      "quoteStyle": "single",
      "semicolons": "always",
      "trailingCommas": "all",
      "arrowParentheses": "always"
    }
  },
  "overrides": [
    {
      "include": ["src/renderer/**/*.tsx"],
      "linter": {
        "rules": {
          "style": { "noDefaultExport": "off" }
        }
      }
    }
  ]
}
```

- [ ] **Step 3: 验证 lint 通过（含 fix）**

Run: `pnpm lint:fix`
Expected: 0 errors 0 warnings。若有自动修复项，再次 `pnpm lint` 确认干净。

- [ ] **Step 4: 再次验证 typecheck（Biome 可能改了 import type）**

Run: `pnpm typecheck`
Expected: 0 errors。

- [ ] **Step 5: Commit**

```bash
git add biome.json package.json pnpm-lock.yaml
git commit -m "feat(biome): 添加 Biome 2 配置（§9.2 生产级规则）

- formatter: 2 空格/LF/100 列
- linter: recommended + 严格规则（noExplicitAny=error 等）
- overrides: renderer tsx 关闭 noDefaultExport
- files.ignore: 覆盖 out/dist/.codegraph/resources 等"
```

---

## Task 5: Husky 9 + lint-staged + commitlint

设计文档 §9.8 + §9.9 + §10.3 验证项。

**Files:**
- Create: `f:\TraeProjects\1\.husky\pre-commit`
- Create: `f:\TraeProjects\1\.husky\commit-msg`
- Create: `f:\TraeProjects\1\commitlint.config.js`
- Modify: `f:\TraeProjects\1\package.json`（已在 Task 1 加 prepare + lint-staged）

- [ ] **Step 1: 安装依赖**

Run:
```bash
pnpm add -D husky@^9 lint-staged@^15 @commitlint/cli@latest @commitlint/config-conventional@latest
```

Expected: 安装成功。

- [ ] **Step 2: 初始化 Husky**

Run: `pnpm exec husky init`
Expected: `.husky/` 目录生成，`package.json` 已有 `prepare: "husky"` 脚本（Task 1 已配置），无需重复添加。

- [ ] **Step 3: 创建 `commitlint.config.js`（严格遵循设计文档 §9.8）**

```js
// commitlint.config.js
// Conventional Commits 1.0.0 + 官方默认规则
// 设计文档 §9.8

export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    typeEnum: [
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
    typeCase: [2, 'always', 'lowerCase'],
    typeEmpty: [2, 'never'],
    subjectCase: [
      2,
      'never',
      ['sentence-case', 'start-case', 'pascal-case', 'upper-case'],
    ],
    subjectEmpty: [2, 'never'],
    subjectFullStop: [2, 'never', '.'],
    headerMaxLength: [2, 'always', 100],
    bodyLeadingBlank: [1, 'always'],
    bodyMaxLineLength: [2, 'always', 100],
    footerLeadingBlank: [1, 'always'],
    footerMaxLineLength: [2, 'always', 100],
    // scope 降为 warning（Conventional Commits scope 是 optional）
    scopeEnum: [
      1,
      'always',
      [
        'main',
        'renderer',
        'preload',
        'shared',
        'ipc',
        'prisma',
        'ai',
        'rag',
        'pg',
        'e2e',
        'deps',
      ],
    ],
  },
}
```

> Biome 默认对 `.js` 文件也会检查 `noDefaultExport`，commitlint 配置使用 ESM `export default` 会触发规则。
> 需在 `biome.json` 的 `files.ignore` 中添加 `commitlint.config.js`，或保持当前 export 但加 override。
> 本 plan 采用 override 方式（保留 lint 覆盖）。

- [ ] **Step 4: 更新 `biome.json` 加入 commitlint 豁免**

修改 `f:\TraeProjects\1\biome.json`，在 `overrides` 数组追加：

```jsonc
,
{
  "include": ["commitlint.config.js"],
  "linter": {
    "rules": {
      "style": { "noDefaultExport": "off" }
    }
  }
}
```

完整 `overrides` 应为：

```jsonc
"overrides": [
  {
    "include": ["src/renderer/**/*.tsx"],
    "linter": {
      "rules": {
        "style": { "noDefaultExport": "off" }
      }
    }
  },
  {
    "include": ["commitlint.config.js"],
    "linter": {
      "rules": {
        "style": { "noDefaultExport": "off" }
      }
    }
  }
]
```

- [ ] **Step 5: 创建 `.husky/pre-commit`**

```bash
#!/usr/bin/env sh
# .husky/pre-commit
# 提交前钩子：跑 lint-staged（自动修复）+ codegraph sync
# 设计文档 §9.9 / §9.13

pnpm lint-staged
pnpm codegraph sync
git add .codegraph
```

- [ ] **Step 6: 创建 `.husky/commit-msg`**

```bash
#!/usr/bin/env sh
# .husky/commit-msg
# 提交信息钩子：校验 Conventional Commits
# 设计文档 §9.8 / §9.9

pnpm commitlint --edit "$1"
```

- [ ] **Step 7: 给 Husky hook 添加可执行权限（Windows 下 Git Bash 使用）**

Run: `git update-index --chmod=+x .husky/pre-commit .husky/commit-msg`
Expected: 无输出。

- [ ] **Step 8: 验证 commitlint 规则生效**

Run: `echo "bad message" | pnpm exec commitlint`
Expected: 报错 `type must be one of [build, chore, ...]`

Run: `echo "feat: 测试提交" | pnpm exec commitlint`
Expected: 退出码 0，无输出（校验通过）。

- [ ] **Step 9: Commit 所有 hook 配置**

```bash
git add .husky/ commitlint.config.js biome.json package.json pnpm-lock.yaml
git commit -m "build: 配置 Husky 9 + lint-staged + commitlint

- pre-commit: pnpm lint-staged + codegraph sync
- commit-msg: pnpm commitlint --edit
- commitlint.config.js: Conventional Commits 1.0.0 规则
- biome.json: 追加 commitlint.config.js override
- §9.8 / §9.9 / §10.3 全部核查项落实"
```

---

## Task 6: CodeGraph 集成验证

**Files:**
- 无新建，仅验证 Task 5 中 pre-commit 集成是否生效

- [ ] **Step 1: 验证 CodeGraph 已初始化**

Run: `codegraph status`
Expected: 输出 "CodeGraph is initialized" 或类似。

若未初始化：
```bash
codegraph init -i
```

- [ ] **Step 2: 手动跑一次 sync，确认能索引到 Phase 1 代码**

Run: `pnpm codegraph:sync`
Expected: 输出 `Syncing CodeGraph` → `Done`，无错误。

- [ ] **Step 3: 验证索引内容**

Run: `codegraph search "createWindow"`
Expected: 能查到 `src/main/index.ts` 中的 `createWindow` 函数。

- [ ] **Step 4: Commit（仅 .codegraph 索引更新）**

```bash
git add .codegraph/
git commit -m "chore: 同步 CodeGraph 索引（Phase 1 代码入库）"
```

---

## Task 7: 最终验证 + Phase 1 完成

- [ ] **Step 1: 全量验证 typecheck**

Run: `pnpm typecheck`
Expected: 0 errors 0 warnings。

- [ ] **Step 2: 全量验证 lint**

Run: `pnpm lint`
Expected: 0 errors 0 warnings。

- [ ] **Step 3: 全量验证 build**

Run: `pnpm build`
Expected:
- `out/main/index.js` 生成
- `out/preload/index.js` 生成
- `out/renderer/index.html` 生成
- 无 Vite 警告

- [ ] **Step 4: 启动 dev 验证 Electron 窗口能打开**

Run: `pnpm dev`
Expected:
- Electron 窗口弹出，显示 "网文写作 Agent / Phase 1 基础设施已就绪"
- DevTools 无报错
- Ctrl+C 退出

- [ ] **Step 5: 验证 git 工作区干净**

Run: `git status`
Expected: `nothing to commit, working tree clean`

- [ ] **Step 6: 验证 Husky hook 仍生效（模拟提交）**

修改 `src/renderer/App.tsx`，把 "Phase 1 基础设施已就绪" 改为 "Phase 1 基础设施验证完成"，然后：

Run:
```bash
git add src/renderer/App.tsx
git commit -m "feat(renderer): 更新 App 占位文案"
```

Expected: Husky 触发 lint-staged + codegraph sync + commitlint，全部通过后提交成功。

- [ ] **Step 7: 最终 Commit（如有未提交项）**

Run: `git status`
Expected: `nothing to commit, working tree clean`

---

## Phase 1 完成验收清单

- [ ] pnpm install 无错误无警告
- [ ] pnpm typecheck 0 errors 0 warnings
- [ ] pnpm lint 0 errors 0 warnings
- [ ] pnpm build 三入口产物全部生成
- [ ] pnpm dev Electron 窗口正常弹出
- [ ] Husky pre-commit hook 触发 lint-staged + codegraph sync
- [ ] Husky commit-msg hook 触发 commitlint
- [ ] CodeGraph 索引能搜到 Phase 1 代码符号
- [ ] git log 至少 6 个 commit（Task 1/2/3/4/5/6 各一个）
- [ ] 设计文档 §10.3 开发规范核查 8 项全部落实

---

## 后续 Phase 预告

- **Phase 2**: `packages/shared` IPC 类型契约 + Zod schema + 错误码
- **Phase 3**: 主进程 infra（logger / wrap / errors / Prisma / PG controller / Ollama controller / AI client）
- **Phase 4**: 数据库 schema + migrations + AGE + HNSW
- **Phase 5**: Service 层（9 个 service）
- **Phase 6**: IPC handlers + preload bridge
- **Phase 7**: Renderer 基础（路由 / providers / stores / TanStack Query）
- **Phase 8**: Renderer 业务页面
- **Phase 9**: 测试补全（单测 / 集成 / E2E）
- **Phase 10**: 打包发布（electron-builder / 签名 / 自动更新）
