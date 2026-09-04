import { motion } from 'framer-motion';
import CategoryHeader from '@/components/CategoryHeader';
import EffectCard from '@/components/EffectCard';
import { getEffectsByCategory } from '@/data/effects';

const easeOut = [0.16, 1, 0.3, 1] as [number, number, number, number];

/** 卡片动效 — /cards */
export default function Cards() {
  const effects = getEffectsByCategory('card');

  return (
    <div className="mx-auto max-w-[860px] px-4 py-16 sm:px-6">
      <CategoryHeader
        number="02"
        title="卡片动效"
        description="一张普通卡片的七种性格：倾斜、聚光、发光、磁吸、翻转、堆叠与巡游。"
        count={effects.length}
      />
      <div className="mt-10 flex flex-col gap-10">
        {effects.map((effect, i) => (
          <motion.div
            key={effect.id}
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '0px 0px -15% 0px' }}
            transition={{ duration: 0.6, delay: (i % 3) * 0.08, ease: easeOut }}
          >
            <EffectCard effect={effect} index={i} />
          </motion.div>
        ))}
      </div>
    </div>
  );
}
