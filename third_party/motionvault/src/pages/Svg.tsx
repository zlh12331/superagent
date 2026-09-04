import { motion } from 'framer-motion';
import CategoryHeader from '@/components/CategoryHeader';
import EffectCard from '@/components/EffectCard';
import { getEffectsByCategory } from '@/data/effects';

const easeOut = [0.16, 1, 0.3, 1] as [number, number, number, number];

export default function Svg() {
  const list = getEffectsByCategory('svg');

  return (
    <div className="mx-auto max-w-[860px] px-4 py-16 sm:px-6">
      <CategoryHeader
        number="09"
        title="SVG 描边"
        description="让线条自己作画：签名描绘、路径变形与描边编排。共 6 个效果。"
        count={list.length}
      />
      <div className="mt-12 space-y-12">
        {list.map((effect, i) => (
          <motion.div
            key={effect.id}
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '0px 0px -15% 0px' }}
            transition={{ duration: 0.6, delay: i * 0.08, ease: easeOut }}
          >
            <EffectCard effect={effect} index={i} />
          </motion.div>
        ))}
      </div>
    </div>
  );
}
