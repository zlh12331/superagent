import { Link } from 'react-router';
import { categories } from '@/data/categories';

export default function Footer() {
  return (
    <footer className="border-t border-zinc-200 bg-white">
      <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
        <div className="grid gap-10 md:grid-cols-3">
          <div>
            <Link to="/" className="flex items-center gap-2.5">
              <img src={`${import.meta.env.BASE_URL}logo.svg`} alt="MotionVault" className="h-6 w-6" />
              <span className="text-[15px] font-semibold text-zinc-950">
                灵感库 <span className="font-mono">MotionVault</span>
              </span>
            </Link>
            <p className="mt-3 text-[13px] text-zinc-500">个人动效灵感库 · 持续收录中</p>
          </div>
          <nav className="grid grid-cols-2 gap-x-6 gap-y-2 md:justify-items-center">
            {categories.map((c) => (
              <Link
                key={c.id}
                to={c.path}
                className="text-[13px] text-zinc-500 transition-colors hover:text-zinc-950"
              >
                {c.title}
              </Link>
            ))}
          </nav>
          <p className="text-[13px] text-zinc-400 md:text-right">Built with React · R3F · Framer Motion</p>
        </div>
        <div className="mt-10 border-t border-zinc-100 pt-6 text-xs text-zinc-400">
          © 2025 MotionVault · Inspired by Motion Primitives
        </div>
      </div>
    </footer>
  );
}
