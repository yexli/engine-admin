import { useEffect, useState } from 'react';
import { useGame } from '@/store/useGame';

/* 检定演出卡（原型 #chk .cc 1:1：骰子翻滚→延迟亮结果）
   卡 P1 增强全部落在 styles/fx.css，本文件不改原型结构、类名与文案：
   · fxDieRoll3d        骰子 3D 旋转（.cc 上的 perspective + die 的 rotateX/rotateY）
   · fxFlashOk/No/Crit  成功绿光 / 失败红光 / 大成功金光的 radial-gradient 覆层
   · fxDiePop/fxNumPop  关键数字 scale 1→1.4→1 + text-shadow 弹出
   以上动画在 prefers-reduced-motion:reduce 下全部降级为静态（见 fx.css §5）。 */
export function CheckOverlay() {
  const chk = useGame((s) => s.check);
  const [reveal, setReveal] = useState(false);
  useEffect(() => {
    if (!chk) return;
    setReveal(false);
    const t = setTimeout(() => setReveal(true), 60);
    return () => clearTimeout(t);
  }, [chk]);
  if (!chk) return <div id="chk" />;
  const verdict = chk.crit ? '大成功' : chk.ok ? '成功' : '失败';
  const flash = chk.crit ? ' crit' : chk.ok ? ' ok' : ' no';
  return (
    <div id="chk" className="on">
      {reveal && <div className={'chk-flash' + flash} />}
      <div className="cc">
        <div className="lb">{chk.label}</div>
        {/* 窄屏一行放不下会把骰子难度挤到第二行（实测 430px 断行），
            故省掉「调整」二字、全角斜杠换中点，并配 shell.css 的窄屏 nowrap 保护。 */}
        <div className="st">
          {chk.statName} {chk.mod >= 0 ? '+' : ''}
          {chk.mod} · 难度 {chk.dc}
        </div>
        <div className={'die' + (reveal ? flash : '')}>
          <span className={'dv' + (reveal ? ' pop' : '')}>{chk.roll}</span>
        </div>
        <div className={'rs ' + (chk.ok ? 'ok' : 'no') + (reveal ? ' pop' : '')} style={{ opacity: reveal ? 1 : 0 }}>
          {verdict}（{chk.total}）
        </div>
        {chk.note && <div className="cx">{chk.note}</div>}
      </div>
    </div>
  );
}
