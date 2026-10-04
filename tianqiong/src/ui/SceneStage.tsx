import { useEffect, useState } from 'react';
import { WB } from '@/data/worldBook';
import { sceneTime, timeOfDayOf, world } from '@/world';
import { artPath } from './art/ArtImage';
import { silhouetteFor } from './art/silhouette';

/* ============================================================
   全幅绘卷舞台（沉静式 · 定稿见 outputs/叙事窗口-沉静式-完整版.html）
   ------------------------------------------------------------
   「画就是世界」：场景插画铺满整屏，所有内容浮在它上面。

   背景是**三级**（2026-09 视觉优化：二级半剪影为新增）：
     一级    绘卷    —— 63 个地点只有 2 张，缺图是常态
     二级半  剪影    —— 按地点类型生成的地平线轮廓（art/silhouette.ts），
                       缺绘卷的 61 个地点靠它获得「地方感」；
                       有绘卷时垫在画下，交叉淡入的空档不再闪黑
     二级    光场    —— 用地点自己的 color 生成，缺绘卷的地方不会塌成一片黑
   缺图判定走 <img> 的 onError（ArtImage 的同一套思路），但这里不用它——
   交叉淡入需要两层同时在场，而那要求自己控制 opacity。

   换景是**交叉淡入**（800ms），不是"暗下去再换"：后者会让屏幕先黑一下，
   这一下就够把沉浸戳破。

   时段光线与地点背景正交：data-time 上挂 CSS 变量，JS 只改这一个属性。
   ============================================================ */

/**
 * 程序化光场：天顶冷色 + 地点色环境光 + 地平线光带。三段都是背景，不是实体。
 *
 * 2026-09 重排：旧版只有一个 34% 高度的径向色斑（42% 浓度），再被时段 filter、
 * 径向暗场压过之后，酒馆的 #b4695f 实机几乎读不出——背景看着就是一片黑。
 * 现在把地点色拆成两条：一条贴着剪影的地平线光带（日落余光的位置语言），
 * 一团更大的环境色晕垫在中下部，浓度整体提过一档；天顶独立成冷色渐变，
 * 与地面的暖色拉开「天冷地暖」的纵深。剪影（.sil）盖在它上面，轮廓与色同时成立。
 * 有绘卷的地点不看它（被绘卷盖住），所以加强只影响缺图的那 61 个。
 */
export const fieldGradient = (c: string): string =>
  'linear-gradient(180deg, transparent 40%, ' + c + '6b 58%, ' + c + '33 74%, transparent 90%),' +
  'radial-gradient(78% 62% at 50% 62%, ' + c + '73 0%, ' + c + '2b 46%, transparent 74%),' +
  'linear-gradient(180deg,#1c2846 0%,#101a30 46%,#0b1222 100%)';

export function SceneStage() {
  const S = world.query.get_world_state()!;
  const loc = S.player.loc;
  const L = WB.locations[loc];
  const src = artPath('loc', loc);
  const tod = timeOfDayOf(sceneTime(S).h);

  const [shown, setShown] = useState(src);
  const [fading, setFading] = useState(false);
  /* 剪影一次算好（内部有缓存）；地点查不到时给 hills 兜底，别让舞台组件抛错 */
  const sil = silhouetteFor(loc, L?.name ?? '', L?.area ?? '', L?.color ?? '#233046');
  /* 缺图标记跟着地点走：换到有图的地方要重新给一次机会 */
  const [artOk, setArtOk] = useState(true);
  useEffect(() => {
    setArtOk(true);
  }, [src]);

  useEffect(() => {
    if (src === shown) return;
    /* 先让新图淡入（fading 期间两层都在场），过渡结束再换 src */
    setFading(true);
    const timer = setTimeout(() => {
      setShown(src);
      setFading(false);
    }, 360);
    return () => clearTimeout(timer);
  }, [src, shown]);

  return (
    <div id="stage" data-time={tod} aria-hidden="true">
      {/* 二级：程序化光场，永远垫在最底下 */}
      {/* 兜底色：位置表里查不到（旧档 / 手改档 / 未来删掉的地区）时只是一层暮蓝，
          而不是让整个舞台组件抛在 "reading 'color'" 上。 */}
      <div className="layer field" style={{ background: fieldGradient(L?.color ?? '#233046') }} />
      {/* 二级半：剪影地平线 */}
      <div className="sil" style={{ backgroundImage: sil.image, height: sil.height }} />
      {/* 一级：绘卷。加载失败就只剩光场——那也是一种「知道自己在哪」。
          onError 只认**当前** src：交叉淡入的 360ms 里 img 还挂着旧地点的地址，
          旧图的 404 若也生效，从缺图地点走回有图地点时 artOk 会被打掉且不再恢复，
          绘卷从此消失（实测踩到）。 */}
      {artOk && (
        <img
          className={'layer art' + (fading ? ' fading' : '')}
          src={shown}
          alt=""
          onError={() => {
            if (shown === src) setArtOk(false);
          }}
        />
      )}
      {/* 时段光线：色层与背景 filter 都由 [data-time] 决定 */}
      <div className="light" />
      <div className="vign" />
      <div className="mist">
        <i />
        <i />
        <i />
      </div>
      <div className="grain" />
      {/* 径向暗场：让正文所在处沉下去、四周透出背景。
          它不是卡片——没有边界、没有底，只是一处更暗的地方。 */}
      <div className="halo" />
    </div>
  );
}
