# GitHub Setup Checklist

One-time steps after pushing this repository to GitHub. Delete this file once done.

## 1. Create the repository

- Suggested name: **motionvault**
- Public, no template, MIT license is already in `LICENSE` — don't let GitHub overwrite it.
- Push: `git remote add origin git@github.com:<you>/motionvault.git && git push -u origin master`

## 2. Replace placeholders

- In `README.md`, replace every `YOUR-NAME` with your GitHub username/org
  (CI badge, clone URL, Star History chart). Search: `grep -n YOUR-NAME README.md`.

## 3. About section

Description (paste as-is):

> 200 web animation examples with copy-ready AI prompts + MotionLens: turn any site's animation into a prompt. React, TypeScript, Framer Motion, Three.js

Website: your deployed URL (e.g. GitHub Pages), if any.

Topics (20):

```
react, typescript, animation, css-animation, framer-motion, threejs,
web-animations, micro-interactions, ai-prompts, cursor-rules,
design-engineering, vite, ui-design, animation-library, prompt-engineering,
frontend, motion-design, web-design, inspiration, developer-tools
```

## 4. Social preview

Settings → General → Social preview → upload `docs/assets/social-preview.png`.

## 5. GitHub Pages（已配好）

`.github/workflows/deploy.yml` 会在 push 到 main/master 时自动构建并发布 `dist/`，
且会自动开启仓库的 Pages（Source 为 GitHub Actions）。SPA 路径路由的 404 回退
也已内置（`public/404.html` + `index.html` 头部的路径恢复脚本），直接访问
`/text` 等二级路径、刷新、分享链接都能正常恢复路由。

首次 push 后到 Settings → Pages 确认 Source 是 **GitHub Actions** 即可
（`configure-pages` 一般会自动设置）。

## 6. Verify CI

Open the Actions tab — the `CI` workflow should be green on the first push.
Then the README CI badge will render correctly (after step 2).
