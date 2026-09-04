import { motion } from 'framer-motion';
import CategoryHeader from '@/components/CategoryHeader';
import EffectCard from '@/components/EffectCard';
import { getEffectsByCategory } from '@/data/effects';

const easeOut = [0.16, 1, 0.3, 1] as [number, number, number, number];

/** 滚动叙事 — /scroll */
export default function Scroll() {
  const effects = getEffectsByCategory('scroll');

  return (
    <div className="mx-auto max-w-[860px] px-4 py-16 sm:px-6">
      <CategoryHeader
        number="08"
        title="滚动叙事"
        description="七个自包含在预览窗内的滚动故事：缩放封面、横向画廊、聚焦文字、钉住步骤、视差山谷、穿越卡片与时间线——每个都在自己的滚动容器里运行，绝不劫持页面滚动。"
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
