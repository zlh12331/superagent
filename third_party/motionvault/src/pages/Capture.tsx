import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { motion } from 'framer-motion';
import {
  ArrowRight,
  Check,
  Copy,
  Database,
  MousePointerClick,
  ScanSearch,
  Sparkles,
} from 'lucide-react';

const pipeline = [
  {
    icon: MousePointerClick,
    step: '01',
    title: '点选 Pick',
    desc: '鼠标指向页面上的任何元素，MotionLens 高亮并锁定目标。',
  },
  {
    icon: ScanSearch,
    step: '02',
    title: '提取 Extract',
    desc: 'getAnimations 读取 WAAPI / CSS 动画，样式采样回放兜底。',
  },
  {
    icon: Sparkles,
    step: '03',
    title: '分析 Analyze',
    desc: '用你自己的 API key，让 LLM 把参数变成可复现的 prompt。',
  },
  {
    icon: Database,
    step: '04',
    title: '入库 Collect',
    desc: '一键导出 MotionVault 格式 JSON，沉淀进你的灵感库。',
  },
];

const coverage = [
  { label: '文字 TEXT', covered: 4, total: 6 },
  { label: '卡片 CARDS', covered: 5, total: 6 },
  { label: '排列 LAYOUT', covered: 6, total: 6 },
  { label: '3D', covered: 0, total: 6 },
  { label: '粒子 PARTICLES', covered: 0, total: 6 },
  { label: '背景 BACKGROUNDS', covered: 4, total: 6 },
  { label: '按钮 BUTTONS', covered: 6, total: 6 },
  { label: '滚动 SCROLL', covered: 6, total: 6 },
  { label: 'SVG', covered: 4, total: 6 },
  { label: '加载 LOADERS', covered: 6, total: 6 },
  { label: '弹簧 SPRING', covered: 5, total: 6 },
];

const limits = [
  '严格 CSP 的站点（GitHub、X 等）bookmarklet 无法注入，请改用 Chrome 扩展。',
  '纯 CSS :hover 动效暂无法自动触发，需要手动悬停后再提取。',
  'canvas / WebGL 没有结构化参数可提取，只能录屏 + 视觉分析。',
  '循环周期超过 1.5s 的动画可能漏检。',
];

function SectionTitle({ label, title }: { label: string; title: string }) {
  return (
    <div>
      <span className="font-mono text-xs tracking-[0.04em] text-zinc-400">{label}</span>
      <h2 className="mt-1 text-xl font-semibold tracking-[-0.01em] text-zinc-950">{title}</h2>
    </div>
  );
}

export default function Capture() {
  const [bookmarkletUrl, setBookmarkletUrl] = useState<string | null>(null);
  const [fetchFailed, setFetchFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showManualCopy, setShowManualCopy] = useState(false);
  const anchorRef = useRef<HTMLAnchorElement>(null);

  // React blocks javascript: URLs passed via JSX props — set it imperatively instead.
  useEffect(() => {
    if (anchorRef.current && bookmarkletUrl) {
      anchorRef.current.setAttribute('href', bookmarkletUrl);
    }
  }, [bookmarkletUrl]);

  useEffect(() => {
    let cancelled = false;
    fetch('/motionlens-url.txt')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then((text) => {
        if (!cancelled) setBookmarkletUrl(text.trim());
      })
      .catch(() => {
        if (!cancelled) setFetchFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const copyBookmarklet = async () => {
    if (!bookmarkletUrl) return;
    try {
      await navigator.clipboard.writeText(bookmarkletUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setShowManualCopy(true);
    }
  };

  return (
    <div className="mx-auto max-w-5xl px-4 py-16 sm:px-6">
      {/* header — same rhythm as CategoryHeader */}
      <motion.header
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: 'easeOut' }}
        className="border-b border-zinc-200 pb-6"
      >
        <div className="flex items-baseline gap-3">
          <span className="font-mono text-xs text-zinc-400">TOOL</span>
          <h1 className="text-[32px] font-semibold tracking-[-0.02em] text-zinc-950">
            MotionLens 动效透镜
          </h1>
        </div>
        <p className="mt-2 text-sm leading-[1.7] text-zinc-600">
          指着任何网页上的动效，拿到可复用的 AI prompt。
        </p>
      </motion.header>

      {/* pipeline */}
      <section className="mt-14">
        <SectionTitle label="PIPELINE" title="四步管线" />
        <div className="mt-6 grid gap-4 md:grid-cols-4">
          {pipeline.map((p) => (
            <div key={p.step} className="rounded-xl border border-zinc-200 bg-white p-5">
              <div className="flex items-center justify-between">
                <p.icon className="h-5 w-5 text-zinc-950" />
                <span className="font-mono text-xs text-zinc-400">{p.step}</span>
              </div>
              <h3 className="mt-4 text-sm font-semibold text-zinc-950">{p.title}</h3>
              <p className="mt-1.5 text-[13px] leading-[1.7] text-zinc-500">{p.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* quick start */}
      <section className="mt-14">
        <SectionTitle label="QUICK START" title="一分钟上手" />
        <div className="mt-6 grid gap-4 md:grid-cols-2">
          {/* bookmarklet */}
          <div className="rounded-xl border border-zinc-200 bg-white p-6">
            <h3 className="text-sm font-semibold text-zinc-950">Bookmarklet（零安装）</h3>
            <p className="mt-1.5 text-[13px] leading-[1.7] text-zinc-500">
              不用装任何东西，一个书签就是整个工具。
            </p>
            <div className="mt-5 flex flex-wrap items-center gap-3">
              <a
                ref={anchorRef}
                href="#"
                onClick={bookmarkletUrl ? undefined : (e) => e.preventDefault()}
                className="inline-flex items-center rounded-lg bg-zinc-950 px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-zinc-800"
              >
                ⌘ MotionLens
              </a>
              <button
                type="button"
                onClick={copyBookmarklet}
                disabled={!bookmarkletUrl}
                className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-2 text-[13px] font-medium text-zinc-600 transition-colors hover:border-zinc-400 hover:text-zinc-950 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? '已复制' : '复制书签代码'}
              </button>
            </div>
            <p className="mt-3 text-xs leading-[1.7] text-zinc-400">
              书签代码在拖动时就固化了——工具更新后需删掉旧书签重新拖一次。
            </p>
            {fetchFailed && (
              <p className="mt-3 text-xs text-red-500">
                书签代码加载失败，请刷新页面重试。
              </p>
            )}
            {showManualCopy && bookmarkletUrl && (
              <textarea
                readOnly
                value={bookmarkletUrl}
                onFocus={(e) => e.currentTarget.select()}
                className="mt-3 h-20 w-full rounded-lg border border-zinc-200 bg-zinc-50 p-2 font-mono text-[11px] text-zinc-600 focus:outline-none"
              />
            )}
            <ol className="mt-5 space-y-2 border-t border-zinc-100 pt-4">
              {[
                '把上面的「⌘ MotionLens」按钮拖进浏览器书签栏。',
                '打开任何想分析的网页，点击这个书签。首次会弹出 API Key 设置面板。',
                '点「跳过，仅提取数据」即可不配 Key、完全离线地提取参数；配了 Key 则会额外自动生成复现 prompt。',
                '页面进入点选模式：光标变十字、顶部出现提示条，此时点击正在动的元素。',
                '等待约 3–6 秒（面板会显示提取进度），完成后自动弹出结果面板。',
                '在「数据」标签页查看时长 / 缓动 / 关键帧；点「复制 CaptureReport JSON」粘贴给 Cursor / Claude，即可按精确参数复现动效。',
              ].map((s, i) => (
                <li key={i} className="flex gap-2.5 text-[13px] leading-[1.7] text-zinc-600">
                  <span className="shrink-0 font-mono text-xs text-zinc-400">{i + 1}.</span>
                  {s}
                </li>
              ))}
            </ol>
          </div>

          {/* extension */}
          <div className="rounded-xl border border-zinc-200 bg-white p-6">
            <h3 className="text-sm font-semibold text-zinc-950">Chrome 扩展（完整版）</h3>
            <p className="mt-1.5 text-[13px] leading-[1.7] text-zinc-500">
              在 bookmarklet 之上多出：本地灵感库管理、canvas / WebGL 录屏分析（tabCapture），
              并绕过严格 CSP 站点的注入限制。
            </p>
            <ol className="mt-5 space-y-2.5">
              <li className="flex gap-2.5 text-[13px] leading-[1.7] text-zinc-600">
                <span className="shrink-0 font-mono text-xs text-zinc-400">1.</span>
                克隆 MotionVault 仓库到本地。
              </li>
              <li className="flex gap-2.5 text-[13px] leading-[1.7] text-zinc-600">
                <span className="shrink-0 font-mono text-xs text-zinc-400">2.</span>
                <span>
                  构建扩展：
                  <code className="mt-1 block rounded-md bg-zinc-50 px-2.5 py-1.5 font-mono text-xs text-zinc-800">
                    cd capture && node scripts/build-extension.mjs
                  </code>
                </span>
              </li>
              <li className="flex gap-2.5 text-[13px] leading-[1.7] text-zinc-600">
                <span className="shrink-0 font-mono text-xs text-zinc-400">3.</span>
                <span>
                  打开 <code className="font-mono text-xs text-zinc-800">chrome://extensions</code>
                  ，开启「开发者模式」。
                </span>
              </li>
              <li className="flex gap-2.5 text-[13px] leading-[1.7] text-zinc-600">
                <span className="shrink-0 font-mono text-xs text-zinc-400">4.</span>
                <span>
                  点击「加载已解压的扩展程序」，选择
                  <code className="font-mono text-xs text-zinc-800"> capture/dist/extension</code>。
                </span>
              </li>
              <li className="flex gap-2.5 text-[13px] leading-[1.7] text-zinc-600">
                <span className="shrink-0 font-mono text-xs text-zinc-400">5.</span>
                <span>
                  点击工具栏的 MotionLens 图标，在设置区填入 API Key 后「保存设置」——Key
                  存在 chrome.storage，所有站点共用，不像书签那样每个网站要配一遍。
                </span>
              </li>
              <li className="flex gap-2.5 text-[13px] leading-[1.7] text-zinc-600">
                <span className="shrink-0 font-mono text-xs text-zinc-400">6.</span>
                <span>
                  点「捕捉动效」→ 回到页面，同样以十字光标点选正在动的元素，等待几秒出结果。
                </span>
              </li>
              <li className="flex gap-2.5 text-[13px] leading-[1.7] text-zinc-600">
                <span className="shrink-0 font-mono text-xs text-zinc-400">7.</span>
                <span>
                  canvas / WebGL 动效改用「录制捕捉」：先录 3 秒屏幕再点选元素，交给视觉模型分析。
                </span>
              </li>
              <li className="flex gap-2.5 text-[13px] leading-[1.7] text-zinc-600">
                <span className="shrink-0 font-mono text-xs text-zinc-400">8.</span>
                <span>
                  每次捕捉自动存入本地灵感库：popup 里点「打开灵感库」，可搜索、复制中英文
                  prompt、导出全部 JSON。
                </span>
              </li>
            </ol>
          </div>
        </div>
      </section>

      {/* BYOK */}
      <section className="mt-14 rounded-xl border border-zinc-200 bg-zinc-50 p-6">
        <SectionTitle label="BYOK" title="带上你自己的 Key" />
        <p className="mt-3 max-w-3xl text-[13px] leading-[1.8] text-zinc-600">
          分析环节支持 OpenAI、Anthropic 以及任何 OpenAI 兼容接口。API key
          只保存在你自己的浏览器里（localStorage / chrome.storage），所有请求从你的浏览器直达模型服务商，
          不经过任何第三方服务器——包括我们。
        </p>
      </section>

      {/* benchmark */}
      <section className="mt-14">
        <SectionTitle label="BENCHMARK" title="基准测试" />
        <p className="mt-3 text-[13px] leading-[1.7] text-zinc-500">
          本站 202 个效果（测试时为 211）同时是 MotionLens 的基准测试集——库即测试集。以下是对
          12 个分类各抽样 6 张卡片（共 72 张）自动提取的真实结果。
        </p>

        <div className="mt-6 overflow-hidden rounded-xl border border-zinc-200">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-zinc-200 bg-zinc-50">
                <th className="px-4 py-2.5 font-medium text-zinc-500">指标</th>
                <th className="px-4 py-2.5 text-right font-medium text-zinc-500">数值</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              <tr>
                <td className="px-4 py-2.5 text-zinc-600">总覆盖率</td>
                <td className="px-4 py-2.5 text-right font-mono text-zinc-950">63.9%（46/72）</td>
              </tr>
              <tr>
                <td className="px-4 py-2.5 text-zinc-600">结构化提取 · CSS 动画</td>
                <td className="px-4 py-2.5 text-right font-mono text-zinc-950">2 条</td>
              </tr>
              <tr>
                <td className="px-4 py-2.5 text-zinc-600">结构化提取 · Transition</td>
                <td className="px-4 py-2.5 text-right font-mono text-zinc-950">7 条</td>
              </tr>
              <tr>
                <td className="px-4 py-2.5 text-zinc-600">结构化提取 · WAAPI</td>
                <td className="px-4 py-2.5 text-right font-mono text-zinc-950">53 条</td>
              </tr>
              <tr>
                <td className="px-4 py-2.5 text-zinc-600">样式采样回放兜底</td>
                <td className="px-4 py-2.5 text-right font-mono text-zinc-950">23 张卡（27 段）</td>
              </tr>
              <tr>
                <td className="px-4 py-2.5 text-zinc-600">采样平均拟合残差</td>
                <td className="px-4 py-2.5 text-right font-mono text-zinc-950">0.114</td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* per-category bars */}
        <div className="mt-8 grid gap-x-8 gap-y-3 sm:grid-cols-2">
          {coverage.map((c) => {
            const pct = (c.covered / c.total) * 100;
            return (
              <div key={c.label}>
                <div className="flex items-baseline justify-between">
                  <span className="text-[13px] text-zinc-600">{c.label}</span>
                  <span className="font-mono text-xs text-zinc-400">
                    {c.covered}/{c.total}
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-zinc-100">
                  <div
                    className="h-full rounded-full bg-zinc-900"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* limits */}
      <section className="mt-14">
        <SectionTitle label="LIMITS" title="边界说明" />
        <ul className="mt-5 grid gap-x-8 gap-y-2.5 text-xs leading-[1.7] text-zinc-500 sm:grid-cols-2">
          {limits.map((l, i) => (
            <li key={i} className="flex gap-2">
              <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-zinc-300" />
              {l}
            </li>
          ))}
        </ul>
      </section>

      {/* legal */}
      <section className="mt-14 border-t border-zinc-200 pt-6">
        <p className="max-w-3xl text-xs leading-[1.8] text-zinc-400">
          MotionLens 只提取时长、缓动、关键帧等参数事实，并据此生成原创 prompt，不复制任何网站的源码。
          请尊重目标网站的服务条款，仅用于学习与灵感。
        </p>
      </section>

      {/* footer link */}
      <div className="mt-14">
        <Link
          to="/"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-zinc-950 transition-colors hover:text-zinc-600"
        >
          查看 200 个效果灵感库
          <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
    </div>
  );
}
