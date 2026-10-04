import { useEffect, useState } from 'react';

/** ≥900px 桌面三栏（原型 isDesk()/resize 的 React 等价物） */
export function useDesk(): boolean {
  const [desk, setDesk] = useState(() => typeof matchMedia !== 'undefined' && matchMedia('(min-width:900px)').matches);
  useEffect(() => {
    const mq = matchMedia('(min-width:900px)');
    const h = (e: MediaQueryListEvent) => setDesk(e.matches);
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  }, []);
  return desk;
}
