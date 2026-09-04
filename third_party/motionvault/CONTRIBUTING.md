# Contributing to MotionVault

Thanks for helping grow the library. This document covers local development, how to submit a new effect, how to report MotionLens bugs, and the PR conventions.

## Local development

```bash
nvm use          # Node 22 (.nvmrc); Node >= 20 works too
npm install
npm run dev      # http://localhost:5173
```

Useful checks before opening a PR:

```bash
npm run lint     # eslint (warnings tolerated, errors are not)
npm run build    # tsc -b && vite build
cd capture && npm install && npm test   # MotionLens unit tests (Node 20+)
```

## Project structure

```
src/components/effects/<category>/   # effect components, one file per effect
src/data/effects/<category>.ts       # the category's effect entries (metadata + prompt)
src/data/effects/index.ts            # aggregates all categories
src/data/categories.ts               # category metadata
src/pages/                           # one page per category + home + /capture
capture/                             # MotionLens (core engine, shells, benchmark, tests)
```

## Submitting a new effect

1. **Pick a category.** One of: `text`, `card`, `layout`, `3d`, `particle`,
   `background`, `button`, `scroll`, `svg`, `loader`, `spring`.
2. **Create the component** at `src/components/effects/<category>/MyEffect.tsx`.
   Conventions:
   - Self-contained, zero props; render inside the preview card it's given.
   - Pause or cheapen work when off-screen where practical (the grid mounts many previews).
   - Use the library's stack: Tailwind or plain CSS, Framer Motion / GSAP / WAAPI / CSS keyframes, Three.js via R3F for 3D. No new UI component libraries.
3. **Register it** in `src/data/effects/<category>.ts`:

   ```ts
   import MyEffect from '@/components/effects/<category>/MyEffect';

   {
     id: 'my-effect',               // kebab-case, unique
     title: '我的效果',              // Chinese title
     label: 'MY EFFECT',            // mono uppercase English label
     description: '一句话说明这个效果在做什么。', // 1–2 Chinese sentences
     category: '<category>',
     interaction: 'hover',          // hover | click | move | scroll | auto
     dark: true,                    // optional: preview on dark background
     component: MyEffect,
     prompt: `...`,                 // see below
   },
   ```

4. **Write the prompt** in English, aimed at AI coding tools. It must be
   complete enough to reproduce the effect standalone:
   - state the stack constraint (React + TypeScript, Tailwind or plain CSS, framer-motion or pure CSS),
   - give exact numbers: durations, delays, easings (cubic-bezier values), distances, colors, sizes,
   - name the trigger and the element structure,
   - look at neighboring entries in the same file for tone and density.
5. **Self-check**: run `npm run dev`, open the category page, and confirm the
   preview renders, loops cleanly, and doesn't jank neighboring cards. Include
   a screenshot or short clip in the PR.

## Reporting MotionLens bugs

Open an issue with the bug report template. For capture-quality problems
(wrong easing, missing animation, bad prompt), the single most useful
attachment is the **CaptureReport JSON**:

1. Run MotionLens on the target page (bookmarklet or extension).
2. In the data view, copy/export the CaptureReport JSON.
3. Redact anything sensitive (URLs, DOM snippets) and paste it into the issue
   along with the target URL and what you expected vs. what was extracted.

Please do not file bugs against sites whose ToS prohibits automated access.

## Code style

- TypeScript strict; `npm run lint` and `tsc -b` must pass (lint warnings are
  acceptable in demo-style animation code, errors are not).
- Match the surrounding style: 2-space indent, single quotes in the site code.
- MotionLens core (`capture/src/core`) is dependency-free TypeScript that must
  run inside a page context — keep it that way.

## Pull requests

- One effect or one fix per PR. Fill out the PR template (description, testing, screenshots).
- Commits: short imperative summary, optional scope prefix — e.g.
  `effects: add magnetic-button to button category`,
  `capture: fix easing fit for sawtooth loops`, `docs: ...`.
- CI runs lint, typecheck, build, and the MotionLens unit tests; keep it green.
