import { useEffect, useState } from 'react';

/* ============================================================
   ArtImage —— 原型 ART.img() 的 React 等价物
   约定命名：/assets/loc-|npc-|mob-{id}.webp
   缺图自动回退「字符符印」（fallback span），加载成功则淡入并移除符印。
   ============================================================ */

const BASE = import.meta.env.BASE_URL;

export function artPath(kind: 'loc' | 'npc' | 'mob', id: string): string {
  return `${BASE}assets/${kind}-${id}.webp`;
}

export function ArtImage({ src, fg, className }: { src: string; fg?: string; className?: string }) {
  const [state, setState] = useState<'load' | 'ok' | 'err'>('load');
  /* src 变化必须重置（审查 §ArtImage）：state 一旦锁进 'err'，下面的 {state !== 'err' && <img>}
     会把 img 节点摘掉，新 src 连请求都发不出、onLoad 永不到来——这个槽位此后所有图都不显示。
     组件实例在同一位置被复用（同一浮层换个 NPC）时 state 是保留的，所以重置只能显式做。 */
  useEffect(() => {
    setState('load');
  }, [src]);
  return (
    <>
      {state !== 'err' && (
        <img
          className={className}
          src={src}
          alt=""
          loading="lazy"
          onLoad={() => setState('ok')}
          onError={() => setState('err')}
          style={{ opacity: state === 'ok' ? 1 : 0, transition: 'opacity .5s' }}
        />
      )}
      {state !== 'ok' && fg && (
        <span className="fallback" style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {fg}
        </span>
      )}
    </>
  );
}
