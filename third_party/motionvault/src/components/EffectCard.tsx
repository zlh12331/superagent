import { Suspense, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, ChevronDown, Copy, RotateCcw } from 'lucide-react';
import type { Effect } from '@/types/effect';
import { categoryChipLabel, interactionHint } from '@/data/categories';
import { useInView } from '@/hooks/useInView';
import { cn } from '@/lib/utils';

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
}

function useCopied(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const trigger = (text: string) => {
    void copyText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };
  return [copied, trigger];
}

type EffectCardProps = {
  effect: Effect;
  /** 1-based display order; shown as mono number */
  index?: number;
  /** compact mode (home featured grid): hides description + prompt expander */
  compact?: boolean;
  /** optional link for the title (e.g. jump to the category page) */
  titleHref?: string;
  className?: string;
};

export default function EffectCard({ effect, index = 0, compact = false, titleHref, className }: EffectCardProps) {
  const { ref, inView } = useInView<HTMLDivElement>();
  // Latch: once a non-deep preview has been mounted it stays mounted, so
  // scrolling away and back never restarts CSS/DOM animations from frame zero
  // (which read as white flashes). deepPreview (3d/particle) keeps the
  // existing unmount-on-exit gating to save GPU/CPU.
  const [mountedOnce, setMountedOnce] = useState(false);
  useEffect(() => {
    if (inView) setMountedOnce(true);
  }, [inView]);
  const [replayTick, setReplayTick] = useState(0);
  const [promptOpen, setPromptOpen] = useState(false);
  const [copied, copy] = useCopied();
  const [copiedInline, copyInline] = useCopied();

  const Preview = effect.component;
  const deepPreview = effect.categories.some((c) => c === '3d' || c === 'particle');
  const number = String(index + 1).padStart(2, '0');

  return (
    <article
      className={cn(
        'group rounded-xl border border-zinc-200 bg-white transition-colors duration-200 hover:border-zinc-300',
        className,
      )}
    >
      {/* header row */}
      <div className="flex items-start justify-between gap-3 px-5 pt-5">
        <div className="flex min-w-0 items-baseline gap-3">
          <span className="font-mono text-xs text-zinc-400">{number}</span>
          <h3 className="truncate text-[15px] font-semibold text-zinc-950">
            {titleHref ? (
              <Link to={titleHref} className="transition-colors hover:text-zinc-500">
                {effect.title}
              </Link>
            ) : (
              effect.title
            )}
          </h3>
          <span className="hidden shrink-0 font-mono text-xs uppercase tracking-[0.04em] text-zinc-400 sm:inline">
            {effect.label}
          </span>
        </div>
        <span className="shrink-0 rounded-full border border-zinc-200 px-2.5 py-0.5 text-xs text-zinc-500">
          {categoryChipLabel[effect.categories[0]]}
        </span>
      </div>

      {/* description */}
      {!compact && (
        <p className="mt-2 px-5 text-sm leading-[1.7] text-zinc-600">{effect.description}</p>
      )}

      {/* preview window */}
      <div className="px-5 pt-4">
        <div
          ref={ref}
          className={cn(
            'relative aspect-[16/10] w-full min-w-0 overflow-hidden rounded-xl border border-zinc-200',
            deepPreview ? 'min-h-[320px]' : 'min-h-[280px]',
            effect.dark ? 'bg-zinc-950' : 'bg-zinc-50',
          )}
        >
          {(deepPreview ? inView : mountedOnce) && (
            <Suspense
              fallback={
                <div className="absolute inset-0 flex items-center justify-center">
                  <div
                    className={cn(
                      'h-5 w-5 animate-spin rounded-full border-2',
                      effect.dark ? 'border-white/15 border-t-white/50' : 'border-zinc-200 border-t-zinc-400',
                    )}
                  />
                </div>
              }
            >
              <Preview key={replayTick} />
            </Suspense>
          )}
          <button
            type="button"
            aria-label="重新播放"
            onClick={() => setReplayTick((t) => t + 1)}
            className={cn(
              'absolute right-3 top-3 z-10 flex h-7 w-7 items-center justify-center rounded-md border backdrop-blur transition-all active:scale-95',
              effect.dark
                ? 'border-white/15 bg-white/10 text-white/70 hover:text-white'
                : 'border-zinc-200 bg-white/80 text-zinc-400 hover:text-zinc-950',
            )}
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* bottom row */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
        <span className="text-xs text-zinc-400">{interactionHint[effect.interaction ?? 'auto']}</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => copy(effect.prompt)}
            className={cn(
              'flex h-8 items-center gap-1.5 rounded-lg px-3.5 text-[13px] font-medium text-white transition-all active:scale-[0.98]',
              copied ? 'bg-green-600' : 'bg-zinc-950 hover:bg-zinc-800',
            )}
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? 'Copied ✓' : 'Copy Prompt'}
          </button>
          {!compact && (
            <button
              type="button"
              onClick={() => setPromptOpen((o) => !o)}
              aria-expanded={promptOpen}
              className="flex h-8 items-center gap-1 rounded-lg border border-zinc-200 bg-white px-3 text-[13px] font-medium text-zinc-600 transition-all hover:border-zinc-300 hover:text-zinc-950 active:scale-[0.98]"
            >
              Prompt
              <ChevronDown
                className={cn('h-3.5 w-3.5 transition-transform duration-300', promptOpen && 'rotate-180')}
              />
            </button>
          )}
        </div>
      </div>

      {/* expandable prompt block */}
      <AnimatePresence initial={false}>
        {promptOpen && !compact && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: 'easeInOut' }}
            className="overflow-hidden"
          >
            <div className="relative mx-5 mb-5 rounded-lg bg-zinc-50 p-4">
              <button
                type="button"
                aria-label="复制 Prompt"
                onClick={() => copyInline(effect.prompt)}
                className={cn(
                  'absolute right-3 top-3 flex h-6 w-6 items-center justify-center rounded-md border border-zinc-200 bg-white transition-colors',
                  copiedInline ? 'text-green-600' : 'text-zinc-400 hover:text-zinc-950',
                )}
              >
                {copiedInline ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              </button>
              <pre className="whitespace-pre-wrap pr-10 font-mono text-[12.5px] leading-[1.6] text-zinc-600">
                {effect.prompt}
              </pre>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </article>
  );
}
