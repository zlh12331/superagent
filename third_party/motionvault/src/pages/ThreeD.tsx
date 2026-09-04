import { motion } from 'framer-motion';
import CategoryHeader from '@/components/CategoryHeader';
import EffectCard from '@/components/EffectCard';
import { getEffectsByCategory } from '@/data/effects';

const easeOut = [0.16, 1, 0.3, 1] as [number, number, number, number];

export default function ThreeD() {
  const effects = getEffectsByCategory('3d');

  return (
    <div className="mx-auto max-w-[860px] px-4 py-16 sm:px-6">
      <CategoryHeader
        number="04"
        title="3D 动效"
        description="用 React Three Fiber 搭建的空间场景——从粒子球体、波浪方块到可交互的 3D 小玩具。"
        count={effects.length}
      />

      {/* page-level hint bar */}
      <motion.p
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.15, ease: easeOut }}
        className="mt-6 rounded-lg bg-zinc-50 px-4 py-2.5 text-xs text-zinc-500"
      >
        3D 场景基于 React Three Fiber · 离屏自动暂停渲染
      </motion.p>

      <div className="mt-8 flex flex-col gap-6">
        {effects.map((effect, i) => (
          <motion.div
            key={effect.id}
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.15 }}
            transition={{ duration: 0.6, delay: i * 0.08, ease: easeOut }}
          >
            <EffectCard effect={effect} index={i} />
          </motion.div>
        ))}
      </div>
    </div>
  );
}
