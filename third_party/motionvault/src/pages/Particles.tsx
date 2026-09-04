import { motion } from 'framer-motion';
import CategoryHeader from '@/components/CategoryHeader';
import EffectCard from '@/components/EffectCard';
import { getEffectsByCategory } from '@/data/effects';

const easeOut = [0.16, 1, 0.3, 1] as [number, number, number, number];

export default function Particles() {
  const effects = getEffectsByCategory('particle');
  return (
    <div className="mx-auto max-w-[860px] px-4 py-16 sm:px-6">
      <CategoryHeader
        number="05"
        title="粒子效果"
        description="用 Canvas 手写的一千种小东西：连成星座、聚成文字、炸成彩带。"
        count={effects.length}
      />
      <div className="mt-12 flex flex-col gap-10">
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
