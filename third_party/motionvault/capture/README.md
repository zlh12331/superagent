# MotionLens

**Point at any web animation, get a reusable AI prompt.**

指着任何网页动效，结构化提取参数并生成可复用的 AI 复现 prompt。

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](../LICENSE)

## Why

You see a great animation on some website. To learn how it works you open DevTools,
hunt through stylesheets and keyframe rules, guess the easing curve by eye, and then
still have to write the whole thing from scratch.

MotionLens automates that loop: **extract the animation parameters → generate a
reproduction prompt with an LLM → file it into your MotionVault library.** One click
on the element, and you get durations, easings, keyframes — plus a ready-to-use prompt
you can paste into Cursor or Claude.

## How it works

Four extraction paths, tried in order of precision:

| Path | Target | Method |
| --- | --- | --- |
| Structural extraction | CSS animations, transitions, WAAPI | `document.getAnimations({subtree: true})` — exact keyframes and timing, no approximation |
| Sampling fallback | GSAP / rAF inline-style animations (invisible to `getAnimations`) | 60 fps computed-style sampling (3 s), transform decomposed into scalar channels, then segmented least-squares fit against 20 named easing curves |
| Trigger probing | hover / click / scroll-triggered animations | dispatches pointer/focus events, real hover & click, and observes `running` animations in time windows |
| Vision fallback | canvas / WebGL / particle effects with no CSS representation | tab capture (extension only), 6 JPEG frames over 3 s → vision LLM describes the motion |

```
        click an element on the page
                 │
                 ▼
        ┌────── Pick ──────┐
        │ element + DOM    │
        └────────┬─────────┘
                 ▼
        ┌─── Extract ────┐      getAnimations empty?
        │ structural      │ ────────────────┐
        └────────┬────────┘                 ▼
                 │                  ┌── Sample @60fps ──┐
                 │                  │ curve fit (bezier)│
                 │                  └─────────┬─────────┘
                 ▼                            ▼
        ┌──────────── CaptureReport ────────────┐
        │ keyframes · timing · trigger · DOM    │
        └──────────────────┬────────────────────┘
                           ▼
                 ┌── Analyze (BYOK LLM) ──┐
                 │ openai / anthropic /   │
                 │ openai-compatible      │
                 └───────────┬────────────┘
                             ▼
                 ┌─── MotionVault entry ───┐
                 │ EffectDraft JSON +      │
                 │ reproduction prompt     │
                 └─────────────────────────┘
```

## Benchmark

MotionLens is benchmarked against **MotionVault**, the animation gallery in this
repository: 11 category pages, **200 effects whose implementations are all known**
(211 across 12 categories at the time of the benchmark run below).
The library is the test suite — every miss has a known ground truth.

Latest run (2026-08-31, 72 cards = 6 per category, headless Chromium, 667.9 s):

- **Total coverage: 63.9%** (46/72 cards — ≥1 structured animation or non-empty sampled segments)
- 62 structured animations extracted: **waapi = 53, transition = 7, css = 2**
- Sampling fallback hit **23 cards** (27 fitted segments, **average fit error 0.114**)
- Trigger attribution: load = 45, hover = 9, click = 8, unknown = 0

Per-category coverage:

| Category | Cards | Covered | Coverage |
| --- | ---: | ---: | ---: |
| layout | 6 | 6 | 100% |
| buttons | 6 | 6 | 100% |
| scroll | 6 | 6 | 100% |
| loaders | 6 | 6 | 100% |
| cards | 6 | 5 | 83.3% |
| spring | 6 | 5 | 83.3% |
| text | 6 | 4 | 66.7% |
| backgrounds | 6 | 4 | 66.7% |
| svg | 6 | 4 | 66.7% |
| 3d | 6 | 0 | 0% |
| particles | 6 | 0 | 0% |
| lab | 6 | 0 | 0% |

The 0% rows are canvas/WebGL effects — expected misses for style-based extraction,
and the motivation for the vision fallback. Full data:
[`benchmark/results/report.md`](benchmark/results/report.md). Reproduce with:

```bash
npm install --no-save playwright
node capture/benchmark/run.mjs            # 6 cards per category (72 total)
node capture/benchmark/run.mjs --all      # full 200 cards
```

## Quick start

MotionLens ships in two shells. Both use the same core engine and analyzer.

### Bookmarklet (no install)

```bash
node capture/scripts/build-bookmarklet.mjs
```

This produces `capture/dist/motionlens.bookmarklet.js` (50.2 KB minified, single
file, zero runtime dependencies) and `capture/dist/bookmarklet-url.txt`.

1. Open `capture/dist/bookmarklet-url.txt` and copy its entire content.
2. Create a new browser bookmark and paste the content as the URL.
3. On any web page, click the bookmark → click the animated element.
4. The panel shows the extracted data, and (if an API key is configured) the
   generated EffectDraft with its reproduction prompt.

### Chrome extension (MV3)

```bash
node capture/scripts/build-extension.mjs
```

Then: `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
select `capture/dist/extension`.

The extension adds:

- a popup with BYOK settings and capture/record buttons,
- a **local library** (`library.html`, backed by `chrome.storage.local`) collecting
  every capture,
- a **record mode**: `tabCapture` grabs 6 frames over 3 s so canvas/WebGL
  animations can be analyzed by a vision-capable model.

### BYOK (bring your own key)

LLM analysis is optional — extraction works offline without any key. To enable
prompt generation, configure one of three providers:

| Provider | Notes | Default model |
| --- | --- | --- |
| `openai` | vision frames supported | `gpt-4o` |
| `anthropic` | vision frames supported | `claude-sonnet-4-5-20250929` |
| `openai-compatible` | DeepSeek, Qwen, local vLLM, … — `baseUrl` required | `deepseek-chat` |

Bookmarklet: the settings panel appears on first run (key stored in
`localStorage`; "skip" runs extraction only). Extension: popup → settings section
(key stored in `chrome.storage.local`; LLM requests run in the service worker,
bypassing page CSP/CORS).

### Programmatic API

The engine is plain TypeScript, importable in any page context:

```ts
import { capture, extractAnimations, pickElement, observeTriggers } from './capture/src/core/index';
import { sampleElement } from './capture/src/core/sample';
import { fitSegments } from './capture/src/core/fit';
import { analyzeCapture } from './capture/src/analyze/index';
```

| Function | Signature | Purpose |
| --- | --- | --- |
| `capture` | `(opts?: CaptureOptions) => Promise<CaptureReport \| null>` | Full pipeline: pick → observe triggers → extract → sampling fallback |
| `pickElement` | `(opts?: PickerOptions) => Promise<Element \| null>` | Click-to-pick an element (`null` = user cancelled) |
| `observeTriggers` | `(el: Element, observeMs = 2600) => Promise<ObserveResult>` | Watch hover/click/scroll-triggered animations |
| `extractAnimations` | `(animations: Animation[], root: Element, trigger?: TriggerKind) => CapturedAnimation[]` | Structural extraction from `getAnimations` results |
| `sampleElement` | `(el: Element, durationMs = 3000, options?: SampleOptions) => Promise<SampleCurve>` | 60 fps computed-style sampling (`{ deep: true }` also samples the first 6 descendants) |
| `fitSegments` | `(curve: SampleCurve) => FittedSegment[]` | Segment + easing fit with per-segment residual error |
| `analyzeCapture` | `(report: CaptureReport, opts: AnalyzerOptions) => Promise<EffectDraft>` | LLM analysis (BYOK); throws if the report has neither animations nor vision frames |

## Output format

`analyzeCapture` returns an `EffectDraft` — a JSON object designed to convert
directly into a MotionVault library entry:

| Field | Type | Description |
| --- | --- | --- |
| `title` | `string` | Chinese name, e.g. 「磁吸按钮」 |
| `titleEn` | `string` | kebab-case id suggestion, e.g. `magnetic-button` |
| `category` | `CategoryId` | one of `text / card / layout / 3d / particle / background / button / scroll / svg / loader / spring / lab` |
| `description` | `string` | one-line summary |
| `techTags` | `string[]` | e.g. `['css-keyframes', 'hover']`, `['gsap', 'scrolltrigger']` |
| `principle` | `string` | implementation breakdown (2–4 sentences) |
| `prompt` | `string` | Chinese reproduction prompt, ready for Cursor/Claude |
| `promptEn` | `string` | English reproduction prompt |
| `difficulty` | `'easy' \| 'medium' \| 'hard'` | estimated difficulty |
| `confidence` | `number` | 0–1 self-assessed confidence |
| `sourceUrl` | `string` | where it was captured |

The underlying `CaptureReport` (returned by `capture`) additionally carries exact
keyframes and timing per animation, the sampled curve with fitted segments, the
element's computed base styles, and a sanitized DOM snippet (depth ≤ 3,
scripts/styles stripped, truncated at 4 KB). See
[`src/core/types.ts`](src/core/types.ts) for the full contract.

## Legal & ethics

- MotionLens extracts **facts about animations** — durations, easings, keyframe
  values — and uses an LLM to write an **original** reproduction prompt. It does
  not copy the target site's source code, assets, or design files.
- Respect the target site's robots policy and Terms of Service. Do not run bulk
  captures against sites that prohibit automated access.
- Intended use is learning and inspiration: understand a technique, then build
  your own implementation.

## Limitations

- **Strict CSP pages**: the bookmarklet can be blocked by
  `Content-Security-Policy` on some sites. Use the extension instead (content
  scripts and the service worker are exempt).
- **Pure CSS `:hover` animations** cannot always be triggered synthetically in
  the bookmarklet; the extension's real-CDP input paths handle more cases, but
  some hover-only effects still need manual interaction during capture.
- **canvas / WebGL** have no structured representation to extract — the only
  fallback is tab-recording + vision model (extension only), which describes
  rather than measures.
- **3D matrix decomposition is approximate**: `DOMMatrix` decomposition of
  nested 3D transforms can lose skew/perspective fidelity.
- **Loop detection** caps at half the sampling window: with the default 3 s
  sample, loops with a period above ~1.5 s are not recognized as loops (they are
  still fitted as one-shot segments).
- **Sawtooth / back-and-forth loops** (rotate 0→360°, pulses) can have their
  fitted easing mislabeled as spring/overshoot — the phase wraps and the fit
  reads the jump as an elastic snap. `periodMs` stays accurate; treat `error >
  0.3` segments as approximate.
- **Pick the moving element itself**: when a wrapper is selected, its children
  may carry the actual motion and the default shallow sample misses them (deep
  descendant sampling is off by default).

## Roadmap

- `--all` full benchmark (200 cards) wired into CI
- More sampling channels: `strokeDashoffset`, `backgroundPosition`, `clip-path`
- Phase unwrapping for sampled curves, fixing easing fits on sawtooth loops
- Auto-select the moving descendant during sampling (moving probe; prototype
  already in the benchmark harness)
- Chrome Web Store release
- Firefox port (MV2/MV3)

## License

[MIT](../LICENSE)

---

# MotionLens（中文）

**指着任何网页动效，结构化提取参数并生成可复用的 AI 复现 prompt。**

## 它做什么

看到好动的网页动效，不用手动开 DevTools 逆向：点选元素 → 自动提取时长/缓动/关键帧
（`getAnimations` 精确还原；GSAP/rAF 动效走 60fps 样式采样 + 贝塞尔拟合）→ BYOK LLM
生成原创复现 prompt → 入库 MotionVault。canvas/WebGL 无结构可解，扩展版用 tabCapture
录屏抽帧交给视觉模型描述。

## 快速开始

```bash
# Bookmarklet（50.2KB 单文件，零依赖）
node capture/scripts/build-bookmarklet.mjs
# → capture/dist/bookmarklet-url.txt 内容整体存为书签 URL，任意网页点击后点选动效

# Chrome MV3 扩展
node capture/scripts/build-extension.mjs
# → chrome://extensions 开发者模式 → Load unpacked 选 capture/dist/extension
```

BYOK：支持 openai / anthropic / openai-compatible（DeepSeek、通义、本地 vLLM 等，
需填 baseUrl）。不配 key 也能用——只提取数据，不调 LLM。

## Benchmark 数字

以本仓库 MotionVault 灵感库为基准测试集（11 分类、200 个实现方式已知的效果——
测试时为 12 分类、211 个——**库即测试集**）。最近一次运行（2026-08-31，每分类 6 卡共 72 卡）：

- **总覆盖率 63.9%**（46/72）
- 结构化提取 62 条动画：waapi=53、transition=7、css=2
- 采样兜底命中 23 卡（27 段，**平均拟合残差 0.114**）
- 分类：layout/buttons/scroll/loaders 100%，cards/spring 83.3%，
  text/backgrounds/svg 66.7%，3d/particles/lab 0%（canvas/WebGL，预期内，
  需 vision 兜底）

复现：`node capture/benchmark/run.mjs`（详见 [benchmark/README.md](benchmark/README.md)）。

## 法律与伦理

仅提取动画参数事实（时长/缓动/关键帧数值）并生成**原创** prompt；不复制目标站源码；
请尊重目标网站的 robots 与 ToS；仅供学习灵感之用。

## License

[MIT](../LICENSE)
