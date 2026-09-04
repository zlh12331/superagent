import { Link } from 'react-router';
import { motion } from 'framer-motion';
import { ArrowDown, ArrowRight, Copy } from 'lucide-react';
import EffectCard from '@/components/EffectCard';
import BlurFadeIn from '@/components/effects/text/BlurFadeIn';
import GradientShine from '@/components/effects/text/GradientShine';
import DotGrid from '@/components/effects/background/DotGrid';
import { effects, getEffectsByCategory } from '@/data/effects';
import { categories } from '@/data/categories';

/** 首页精选：每类挑一件"作品级"效果，两行两列的宽松排布 */
const FEATURED_IDS = [
  'hover-expand-cards',
  'sparkles-text',
  'holo-card',
  'orbiting-spheres',
  'meteors',
  'spotlight-grid',
  'aurora-flow',
  'rising-tide',
];
const featuredEffects = FEATURED_IDS.map((id) => effects.find((e) => e.id === id)!).filter(Boolean);
import { scrollToTarget } from '@/lib/lenis';

const easeOut = [0.16, 1, 0.3, 1] as [number, number, number, number];

/* ------------------------------- Section 1 — Hero ------------------------------ */

function Hero() {
  return (
    <section className="relative flex min-h-[calc(100dvh-56px)] items-center justify-center overflow-hidden">
      <DotGrid />
      <div className="relative mx-auto flex w-full max-w-[960px] flex-col items-center px-4 py-24 text-center sm:px-6">
        {/* eyebrow chip */}
        <motion.span
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.1, ease: 'easeOut' }}
          className="rounded-full border border-zinc-200 px-3 py-1 font-mono text-[11px] uppercase tracking-[0.04em] text-zinc-500"
        >
          Motion Inspiration Library · {effects.length} Effects
        </motion.span>

        {/* display heading — Blur Fade In */}
        <h1 className="mt-8 text-[40px] font-semibold leading-[1.15] tracking-[-0.03em] text-zinc-950 sm:text-[56px] lg:text-[64px]">
          <BlurFadeIn text="收集所有" split="char" delay={0.3} stagger={0.12} className="block" />
          <BlurFadeIn text="会动的灵感。" split="char" delay={0.3 + 4 * 0.12} stagger={0.12} className="block" />
        </h1>

        {/* subtitle */}
        <motion.p
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 1.2, ease: 'easeOut' }}
          className="mt-6 max-w-[520px] text-base leading-[1.7] text-zinc-600"
        >
          一个极简的个人动效灵感库——文字、卡片、3D、粒子、背景与按钮。每个效果都能实时预览，并附带一键复制的 AI
          Prompt。
        </motion.p>

        {/* buttons */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 1.5, ease: 'easeOut' }}
          className="mt-8 flex items-center gap-3"
        >
          <motion.button
            type="button"
            onClick={() => scrollToTarget('#featured', -80)}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 1.5, ease: 'easeOut' }}
            className="flex h-11 items-center gap-1.5 rounded-lg bg-zinc-950 px-6 text-sm font-medium text-white transition-all hover:bg-zinc-800 active:scale-[0.98]"
          >
            浏览效果 <ArrowRight className="h-4 w-4" />
          </motion.button>
          <motion.button
            type="button"
            onClick={() => scrollToTarget('#how', -80)}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 1.6, ease: 'easeOut' }}
            className="flex h-11 items-center rounded-lg border border-zinc-200 bg-white px-6 text-sm font-medium text-zinc-950 transition-all hover:border-zinc-300 active:scale-[0.98]"
          >
            如何使用 Prompt
          </motion.button>
        </motion.div>

        {/* scroll hint */}
        <motion.div
          className="absolute bottom-10 flex flex-col items-center gap-1.5 text-zinc-400"
          animate={{ y: [0, 6, 0] }}
          transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
        >
          <span className="font-mono text-xs">Scroll</span>
          <ArrowDown className="h-3.5 w-3.5" />
        </motion.div>
      </div>
    </section>
  );
}

/* ---------------------------- Section 2 — Featured ----------------------------- */

function Featured() {
  return (
    <section id="featured" className="bg-white py-24">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="mb-8 flex items-baseline justify-between">
          <h2 className="text-xl font-semibold text-zinc-950">精选效果</h2>
          <Link
            to="/text"
            className="group flex items-center gap-1 text-[13px] text-zinc-500 transition-colors hover:text-zinc-950"
          >
            查看全部
            <ArrowRight className="h-3.5 w-3.5 transition-transform duration-200 group-hover:translate-x-1" />
          </Link>
        </div>
        <div className="grid gap-8 md:grid-cols-2">
          {featuredEffects.map((effect, i) => {
            const meta = categories.find((c) => c.id === effect.categories[0]);
            return (
              <motion.div
                key={effect.id}
                initial={{ opacity: 0, y: 24 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, amount: 0.15 }}
                transition={{ duration: 0.6, delay: (i % 3) * 0.08, ease: easeOut }}
              >
                <EffectCard effect={effect} index={i} compact titleHref={meta?.path} />
              </motion.div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/* ---------------------------- Section 3 — Categories --------------------------- */

function Categories() {
  return (
    <section className="border-y border-zinc-200 bg-zinc-50 py-24">
      <div className="mx-auto max-w-[1080px] px-4 sm:px-6">
        <h2 className="mb-10 text-xl font-semibold text-zinc-950">
          {categories.length} 个分类 · {effects.length} 个效果
        </h2>
        <div>
          {categories.map((c, i) => (
            <motion.div
              key={c.id}
              initial={{ opacity: 0, x: -16 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true, amount: 0.4 }}
              transition={{ duration: 0.5, delay: i * 0.07, ease: 'easeOut' }}
            >
              <Link
                to={c.path}
                className="group flex h-[88px] items-center justify-between border-b border-zinc-200 px-2 transition-colors duration-200 hover:bg-white"
              >
                <div className="flex min-w-0 items-baseline gap-4">
                  <span className="font-mono text-xs text-zinc-400">{String(i + 1).padStart(2, '0')}</span>
                  <span className="relative text-xl font-semibold text-zinc-950">
                    {c.title}
                    <span className="absolute -bottom-1 left-0 h-px w-full origin-left scale-x-0 bg-zinc-950 transition-transform duration-[250ms] group-hover:scale-x-100" />
                  </span>
                  <span className="hidden truncate text-sm text-zinc-500 md:inline">{c.description}</span>
                </div>
                <div className="flex shrink-0 items-center gap-4">
                  <span className="font-mono text-xs tracking-[0.04em] text-zinc-400">
                    {getEffectsByCategory(c.id).length} EFFECTS
                  </span>
                  <ArrowRight className="h-4 w-4 text-zinc-400 transition-all duration-200 group-hover:translate-x-1.5 group-hover:text-zinc-950" />
                </div>
              </Link>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* --------------------------- Section 4 — How it works -------------------------- */

function HowItWorks() {
  const steps = ['浏览并实时预览效果', '点击 Copy Prompt 复制提示词', '粘贴给 AI 工具，生成你自己的版本'];
  return (
    <section id="how" className="bg-white py-24">
      <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 sm:px-6 lg:grid-cols-2">
        <div className="max-w-[420px]">
          <motion.h2
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.5 }}
            transition={{ duration: 0.5, ease: 'easeOut' }}
            className="text-xl font-semibold text-zinc-950"
          >
            每个效果，都附带一段 Prompt
          </motion.h2>
          <motion.p
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.5 }}
            transition={{ duration: 0.5, delay: 0.08, ease: 'easeOut' }}
            className="mt-4 text-sm leading-[1.7] text-zinc-600"
          >
            看到喜欢的动效，点击 Copy Prompt，把英文提示词粘贴给 Cursor、Claude、v0 或任何 AI
            编程工具，就能在自己的项目里复现它。所有效果基于 React + Tailwind + Framer Motion / React Three
            Fiber 实现。
          </motion.p>
          <ol className="mt-8 space-y-4">
            {steps.map((s, i) => (
              <motion.li
                key={s}
                initial={{ opacity: 0, y: 16 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, amount: 0.5 }}
                transition={{ duration: 0.5, delay: 0.16 + i * 0.08, ease: 'easeOut' }}
                className="flex items-baseline gap-3"
              >
                <span className="font-mono text-xs text-zinc-400">{String(i + 1).padStart(2, '0')}</span>
                <span className="text-sm text-zinc-950">{s}</span>
              </motion.li>
            ))}
          </ol>
          <motion.button
            type="button"
            onClick={() => scrollToTarget('#featured', -80)}
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.5 }}
            transition={{ duration: 0.5, delay: 0.4, ease: 'easeOut' }}
            className="mt-8 flex h-11 items-center gap-1.5 rounded-lg bg-zinc-950 px-6 text-sm font-medium text-white transition-all hover:bg-zinc-800 active:scale-[0.98]"
          >
            开始浏览 <ArrowRight className="h-4 w-4" />
          </motion.button>
        </div>

        {/* static demo card (non-interactive) */}
        <motion.div
          initial={{ opacity: 0, y: 24, scale: 0.97 }}
          whileInView={{ opacity: 1, y: 0, scale: 1 }}
          viewport={{ once: true, amount: 0.2 }}
          transition={{ duration: 0.7, ease: easeOut }}
          className="rounded-xl border border-zinc-200 bg-white"
        >
          <div className="flex items-center justify-between px-5 pt-5">
            <div className="flex items-baseline gap-3">
              <span className="font-mono text-xs text-zinc-400">01</span>
              <span className="text-[15px] font-semibold text-zinc-950">模糊浮现</span>
              <span className="font-mono text-xs uppercase tracking-[0.04em] text-zinc-400">Blur Fade In</span>
            </div>
            <span className="rounded-full border border-zinc-200 px-2.5 py-0.5 text-xs text-zinc-500">文字</span>
          </div>
          <div className="px-5 pt-4">
            <div className="flex aspect-[16/10] min-h-[180px] items-center justify-center rounded-xl border border-zinc-200 bg-zinc-50">
              <BlurFadeIn text="让文字像雾一样散开" split="char" loop stagger={0.08} className="text-lg text-zinc-950" />
            </div>
          </div>
          <div className="flex items-center justify-between px-5 py-4">
            <span className="text-xs text-zinc-400">自动播放</span>
            <span className="flex h-8 items-center gap-1.5 rounded-lg bg-zinc-950 px-3.5 text-[13px] font-medium text-white">
              <Copy className="h-3.5 w-3.5" /> Copy Prompt
            </span>
          </div>
          <div className="mx-5 mb-5 rounded-lg bg-zinc-50 p-4">
            <pre className="whitespace-pre-wrap font-mono text-[12.5px] leading-[1.6] text-zinc-600">
              {'Create a React component called BlurFadeIn using React + Tailwind + Framer Motion…'}
            </pre>
          </div>
        </motion.div>
      </div>
    </section>
  );
}

/* -------------------------------- Section 5 — CTA ------------------------------ */

function Cta() {
  return (
    <section className="bg-white py-32 text-center">
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, amount: 0.5 }}
        transition={{ duration: 0.5, ease: 'easeOut' }}
        className="mx-auto max-w-6xl px-4 sm:px-6"
      >
        <h2 className="text-[32px] font-semibold tracking-[-0.02em] text-zinc-950 sm:text-[40px]">
          <GradientShine text="从文字动效开始。" />
        </h2>
        <Link
          to="/text"
          className="mt-8 inline-flex h-12 items-center gap-1.5 rounded-lg bg-zinc-950 px-8 text-sm font-medium text-white transition-all hover:bg-zinc-800 active:scale-[0.98]"
        >
          浏览文字动效 <ArrowRight className="h-4 w-4" />
        </Link>
      </motion.div>
    </section>
  );
}

export default function Home() {
  return (
    <>
      <Hero />
      <Featured />
      <Categories />
      <HowItWorks />
      <Cta />
    </>
  );
}
