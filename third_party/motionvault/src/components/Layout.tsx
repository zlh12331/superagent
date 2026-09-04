import { useEffect } from 'react';
import { Outlet } from 'react-router';
import Navbar from './Navbar';
import Footer from './Footer';

/**
 * Nested-route layout: renders <Outlet/>, so App.tsx must use
 * <Route element={<Layout/>}> with child routes (never children).
 * The sticky navbar stays in document flow — pages must NOT add nav-height offsets.
 */
export default function Layout() {
  // Warm the heavy R3F vendor chunk on idle so scrolling to a 3D/particle card
  // never shows a blank preview while its ~900KB chunk downloads (perceived 闪屏).
  useEffect(() => {
    const warm = () => {
      void import('@/components/effects/threeD/WaveGrid');
    };
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(warm, { timeout: 4000 });
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(warm, 2500);
    return () => window.clearTimeout(id);
  }, []);

  return (
    <div className="flex min-h-[100dvh] flex-col bg-white">
      <Navbar />
      <main className="flex-1">
        <Outlet />
      </main>
      <Footer />
    </div>
  );
}
