import { useEffect } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router';
import Lenis from 'lenis';
import Layout from '@/components/Layout';
import Home from '@/pages/Home';
import Text from '@/pages/Text';
import Cards from '@/pages/Cards';
import ThreeD from '@/pages/ThreeD';
import Particles from '@/pages/Particles';
import Backgrounds from '@/pages/Backgrounds';
import Buttons from '@/pages/Buttons';
import Scroll from '@/pages/Scroll';
import Svg from '@/pages/Svg';
import Loaders from '@/pages/Loaders';
import Spring from '@/pages/Spring';
import Capture from '@/pages/Capture';
import { setLenis } from '@/lib/lenis';

export default function App() {
  const location = useLocation();

  // Lenis smooth scrolling (site-wide)
  useEffect(() => {
    const lenis = new Lenis({ lerp: 0.1 });
    setLenis(lenis);
    let raf = requestAnimationFrame(function loop(time) {
      lenis.raf(time);
      raf = requestAnimationFrame(loop);
    });
    return () => {
      cancelAnimationFrame(raf);
      lenis.destroy();
      setLenis(null);
    };
  }, []);

  // reset scroll on route change
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location.pathname]);

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="text" element={<Text />} />
        <Route path="cards" element={<Cards />} />
        <Route path="3d" element={<ThreeD />} />
        <Route path="particles" element={<Particles />} />
        <Route path="backgrounds" element={<Backgrounds />} />
        <Route path="buttons" element={<Buttons />} />
        <Route path="scroll" element={<Scroll />} />
        <Route path="svg" element={<Svg />} />
        <Route path="loaders" element={<Loaders />} />
        <Route path="spring" element={<Spring />} />
        <Route path="capture" element={<Capture />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
