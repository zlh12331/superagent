import { useState } from 'react';
import { Link, NavLink } from 'react-router';
import { AnimatePresence, motion } from 'framer-motion';
import { Github, Menu, X } from 'lucide-react';
import { categories } from '@/data/categories';
import { cn } from '@/lib/utils';

export default function Navbar() {
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 h-14 border-b border-zinc-200 bg-white/80 backdrop-blur">
      <div className="mx-auto flex h-full max-w-6xl items-center justify-between px-4 sm:px-6">
        <Link to="/" className="flex items-center gap-2.5" onClick={() => setOpen(false)}>
          {/* 站点部署在子路径（/<仓库名>/）下，public 资源需带 BASE_URL 前缀 */}
          <img src={`${import.meta.env.BASE_URL}logo.svg`} alt="MotionVault" className="h-6 w-6" />
          <span className="text-[15px] font-semibold text-zinc-950">
            灵感库 <span className="font-mono">MotionVault</span>
          </span>
        </Link>

        {/* desktop nav */}
        <nav className="hidden items-center gap-4 md:flex">
          {categories.map((c) => (
            <NavLink
              key={c.id}
              to={c.path}
              className={({ isActive }) =>
                cn(
                  'relative text-[13px] font-medium transition-colors',
                  isActive
                    ? 'text-zinc-950 after:absolute after:-bottom-[3px] after:left-0 after:h-px after:w-full after:bg-zinc-950'
                    : 'text-zinc-500 hover:text-zinc-950',
                )
              }
            >
              {c.title}
            </NavLink>
          ))}
        </nav>

        <div className="flex items-center gap-1">
          <NavLink
            to="/capture"
            className={({ isActive }) =>
              cn(
                'mr-1 hidden rounded-full border px-3 py-1 text-[12px] font-medium transition-colors sm:inline-flex',
                isActive
                  ? 'border-zinc-950 text-zinc-950'
                  : 'border-zinc-200 text-zinc-500 hover:border-zinc-400 hover:text-zinc-950',
              )
            }
          >
            捕捉工具
          </NavLink>
          <a
            href="https://github.com/xiyu519/MotionVault"
            target="_blank"
            rel="noreferrer"
            aria-label="GitHub"
            className="flex h-8 items-center gap-1.5 rounded-full border border-zinc-200 px-3 text-[12px] font-medium text-zinc-500 transition-colors hover:border-zinc-400 hover:text-zinc-950"
          >
            <Github className="h-4 w-4" />
            <span className="hidden sm:inline">GitHub</span>
          </a>
          <button
            type="button"
            aria-label={open ? '关闭菜单' : '打开菜单'}
            onClick={() => setOpen((o) => !o)}
            className="flex h-8 w-8 items-center justify-center rounded-md text-zinc-600 transition-colors hover:text-zinc-950 md:hidden"
          >
            {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>

      {/* mobile fullscreen drawer */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-x-0 top-14 z-40 h-[calc(100dvh-3.5rem)] overflow-y-auto bg-white md:hidden"
          >
            <nav className="flex flex-col px-6 py-6">
              {categories.map((c, i) => (
                <motion.div
                  key={c.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3, delay: i * 0.04 }}
                >
                  <NavLink
                    to={c.path}
                    onClick={() => setOpen(false)}
                    className={({ isActive }) =>
                      cn(
                        'flex items-baseline justify-between border-b border-zinc-100 py-4',
                        isActive ? 'text-zinc-950' : 'text-zinc-500',
                      )
                    }
                  >
                    <span className="text-lg font-semibold">{c.title}</span>
                    <span className="font-mono text-xs text-zinc-400">{c.plannedCount}</span>
                  </NavLink>
                </motion.div>
              ))}
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, delay: categories.length * 0.04 }}
              >
                <NavLink
                  to="/capture"
                  onClick={() => setOpen(false)}
                  className={({ isActive }) =>
                    cn(
                      'flex items-baseline justify-between border-b border-zinc-100 py-4',
                      isActive ? 'text-zinc-950' : 'text-zinc-500',
                    )
                  }
                >
                  <span className="text-lg font-semibold">捕捉工具</span>
                  <span className="font-mono text-xs text-zinc-400">TOOL</span>
                </NavLink>
              </motion.div>
            </nav>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );
}
