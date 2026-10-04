import { useState } from 'react';
import { savePort } from '@/world';
import { artPath, ArtImage } from './art/ArtImage';
import { useGame } from '@/store/useGame';

/* ============================================================
   标题屏（方案 B 定稿 · DOM 与类名逐字对齐原型 #scr-title）
   ------------------------------------------------------------
   与原原型标题屏的差别只有两处，都是因为这里是落地版：

   ① 眉标与引言换成世界书里的句子。原型写的是"星枢坠落在塔的北面"，
      那是演示文案；落地版沿用项目自己的定位语（世界书为骨/规则为律/星枢为脉），
      并配英文眉标与副标。
   ② 「继续旅程」不再是永远可点的样子——无档时压暗并禁用，
      同时在桌面壳（SQLite）无档而浏览器介质尚有旧档时，额外给出显式导入。

   背景是真实地点插画（loc-plaza），与游戏内共用 ArtImage 的缺图回退。
   ============================================================ */
const MEDIUM_LABEL: Record<string, string> = {
  sqlite: 'SQLite 存档（桌面壳）',
  localStorage: '浏览器本地存档',
  memory: '内存存档（临时）',
};

export function TitleScreen() {
  const setScreen = useGame((s) => s.setScreen);
  const cmd = useGame((s) => s.cmd);
  /* 经 SavePort 探测存档（Tauri 壳内=SQLite 预载镜像；直查 localStorage 会误判无档）。
     F-24：一次性求值——原实现写在渲染体内，每次重渲染都整份 JSON.parse。 */
  const [hasSave] = useState(() => savePort()?.load() != null);
  const medium = MEDIUM_LABEL[savePort()?.medium ?? 'memory'] ?? '未知介质';
  /* F-21：桌面壳（SQLite）无档、而浏览器介质里还留着旧档时给出显式选择——
     否则两份介质各存一份，玩家只会体感"存档消失"。 */
  const [browserSave] = useState<string | null>(() => {
    if (savePort()?.medium !== 'sqlite') return null;
    try {
      /* 两种格式都算「浏览器里有档」：旧整档写在 tq2_world_v1，分片档的主档在 tq2_main_v1。 */
      return localStorage.getItem('tq2_world_v1') ?? localStorage.getItem('tq2_main_v1');
    } catch {
      return null;
    }
  });

  return (
    <>
      <div className="layer">
        <ArtImage src={artPath('loc', 'plaza')} />
      </div>
      <div className="fm">
        <i />
        <i />
        <i />
      </div>
      <div className="inner">
        <div className="k">E R A &nbsp;O F &nbsp;F I R M A M E N T</div>
        <h1>天穹纪元</h1>
        <div className="en">T H E &nbsp;S E C O N D &nbsp;A G E &nbsp;· &nbsp;2 . 0</div>
        <p className="tag">
          世界书为骨，规则为律，星枢为脉。
          <br />
          你不是世界的中心——
          <br />
          你只是这个世界里，活着的一个。
        </p>
        <div className="btns">
          <button className="btn-b" onClick={() => setScreen('create')}>
            开启新的旅程
          </button>
          <button
            className={'btn-b ghost' + (hasSave ? '' : ' dim')}
            disabled={!hasSave}
            title={hasSave ? '读取存档' : '还没有存档'}
            onClick={() => cmd({ type: 'continueSave' })}
          >
            继续旅程
          </button>
          {browserSave && !hasSave && (
            <button className="btn-b ghost" onClick={() => cmd({ type: 'importState', json: browserSave })}>
              导入浏览器旧档
            </button>
          )}
        </div>
      </div>
      <div className="foot">世界书驱动 · AI 叙事 · {medium}</div>
    </>
  );
}
