import { motion } from 'framer-motion';

type CategoryHeaderProps = {
  /** e.g. '01' */
  number: string;
  /** 中文大标题 */
  title: string;
  /** 一句话说明 */
  description: string;
  /** 效果计数 */
  count: number;
};

export default function CategoryHeader({ number, title, description, count }: CategoryHeaderProps) {
  return (
    <motion.header
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: 'easeOut' }}
      className="border-b border-zinc-200 pb-6"
    >
      <div className="flex items-baseline gap-3">
        <span className="font-mono text-xs text-zinc-400">{number}</span>
        <h1 className="text-[32px] font-semibold tracking-[-0.02em] text-zinc-950">{title}</h1>
      </div>
      <div className="mt-2 flex items-center justify-between gap-4">
        <p className="text-sm leading-[1.7] text-zinc-600">{description}</p>
        <span className="shrink-0 font-mono text-xs tracking-[0.04em] text-zinc-400">
          {count} EFFECT{count === 1 ? '' : 'S'}
        </span>
      </div>
    </motion.header>
  );
}
