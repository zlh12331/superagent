import CategoryHeader from '@/components/CategoryHeader';
import type { CategoryMeta } from '@/data/categories';

/** Temporary stub for category pages — replaced by page agents. */
export default function CategoryStub({ meta, index }: { meta: CategoryMeta; index: number }) {
  return (
    <div className="mx-auto max-w-[860px] px-4 py-16 sm:px-6">
      <CategoryHeader
        number={String(index + 1).padStart(2, '0')}
        title={meta.title}
        description={meta.description}
        count={meta.plannedCount}
      />
      <p className="mt-12 text-sm text-zinc-400">效果收录中…</p>
    </div>
  );
}
