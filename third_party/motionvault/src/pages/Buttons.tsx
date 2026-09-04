import { motion } from 'framer-motion';
import CategoryHeader from '@/components/CategoryHeader';
import EffectCard from '@/components/EffectCard';
import { getEffectsByCategory } from '@/data/effects';

export default function Buttons() {
  const effects = getEffectsByCategory('button');

  return (
    <div className="mx-auto max-w-[860px] px-4 py-16 sm:px-6">
      <CategoryHeader
        number="07"
        title="按钮动效"
        description="让每一次点击都有回应：光束、扫光、波纹、磁吸与液体填充。共 5 个效果。"
        count={effects.length}
      />
      <div className="mt-10 flex flex-col gap-10">
        {effects.map((effect, i) => (
          <motion.div
            key={effect.id}
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '0px 0px -15% 0px' }}
            transition={{ duration: 0.6, delay: i * 0.08, ease: 'easeOut' }}
          >
            <EffectCard effect={effect} index={i} />
          </motion.div>
        ))}
      </div>
    </div>
  );
}
