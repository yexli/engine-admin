import { useMemo } from 'react';

/* 星空背景（原型启动时注入 40 颗随机星点，useMemo 保证只生成一次） */
export function StarField() {
  const stars = useMemo(
    () =>
      Array.from({ length: 40 }, (_, i) => ({
        key: i,
        left: Math.random() * 100 + '%',
        top: Math.random() * 100 + '%',
        animationDelay: Math.random() * 4 + 's',
        animationDuration: 2.5 + Math.random() * 3 + 's',
      })),
    [],
  );
  return (
    <div id="stars">
      {stars.map((s) => (
        <i key={s.key} style={{ left: s.left, top: s.top, animationDelay: s.animationDelay, animationDuration: s.animationDuration }} />
      ))}
    </div>
  );
}
