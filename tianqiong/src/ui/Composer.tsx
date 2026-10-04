import { useState } from 'react';
import { useGame } from '@/store/useGame';

/* ============================================================
   输入条（方案 B 定稿 · DOM 对齐原型 #composer）
   ------------------------------------------------------------
   固定在最下、不随叙事滚动；与叙事列共用同一条对齐线，
   读起来像「对这条叙事说话」。

   G4 契约（UI 文案 = 能力承诺）：placeholder 的示例必须真能解析。

   三条手感补充（都不是新机制，只是把已有状态如实说出来）：
   · 解析中：输入框禁用，placeholder 换成一句进度话。原先只有提交键变成「…」，
     玩家看到的是"字没了、框灰了"，不知道系统在干什么。
   · ↑ / ↓：召回最近提交过的自由行动（最多 20 条）。提交即清空，写错一个字
     就要整段重打——这是本栏最贵的重复劳动。
   · 字数：40 字是硬上限（maxLength），原先直到打不进去都没有提示，
     所以只在临近上限时出现计数，不占常驻视觉。
   ============================================================ */
const MAX_LEN = 40;
const NEAR_LEN = 30;
const HIST_MAX = 20;

const IDLE_PH = '自由行动：走进酒馆、观察四周，或跟在场的人攀谈……';
const BUSY_PH = '正在解析你的意图……';

export function Composer() {
  const cmd = useGame((s) => s.cmd);
  const freeBusy = useGame((s) => s.freeBusy);
  const musing = useGame((s) => s.npcMusing);
  const [free, setFree] = useState('');
  const [hist, setHist] = useState<string[]>([]);
  const [hIdx, setHIdx] = useState(-1); // -1 = 没在翻历史
  const [draft, setDraft] = useState(''); // 翻历史之前那一刻的草稿

  const submit = () => {
    const v = free.trim();
    if (!v || freeBusy) return; // F-14：解析中不再受理（core 另有权威去重）
    setHist((h) => [...h.filter((x) => x !== v), v].slice(-HIST_MAX));
    setHIdx(-1);
    setFree('');
    cmd({ type: 'freeText', text: v });
  };

  /* ↑/↓ 翻历史：翻过最早一条再按 ↓，回到翻之前打了一半的草稿（不清空玩家的输入） */
  const recall = (dir: -1 | 1) => {
    if (!hist.length) return;
    if (hIdx === -1) {
      if (dir === 1) return;
      setDraft(free);
      setHIdx(hist.length - 1);
      setFree(hist[hist.length - 1]);
      return;
    }
    const next = hIdx + dir;
    if (next >= hist.length) {
      setHIdx(-1);
      setFree(draft);
      return;
    }
    setHIdx(next < 0 ? 0 : next);
    setFree(hist[next < 0 ? 0 : next]);
  };

  return (
    <div id="composer">
      <div className="composer-in">
        <input
          id="free-input"
          value={free}
          maxLength={MAX_LEN}
          disabled={freeBusy}
          autoComplete="off"
          placeholder={freeBusy ? BUSY_PH : musing ? musing + '沉吟着……' : IDLE_PH}
          onChange={(e) => setFree(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
            else if (e.key === 'ArrowUp') {
              e.preventDefault();
              recall(-1);
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              recall(1);
            } else if (e.key === 'Escape') {
              setFree('');
              setDraft('');
              setHIdx(-1);
            }
          }}
          aria-label="自由行动输入"
          aria-busy={freeBusy}
        />
        {free.length >= NEAR_LEN && (
          <span className="cnt" aria-hidden="true">
            {free.length}/{MAX_LEN}
          </span>
        )}
        <button
          className="free-go"
          onClick={submit}
          disabled={freeBusy || !free.trim()}
          title="执行（回车）"
          aria-label="执行自由行动"
        >
          {freeBusy ? '…' : '→'}
        </button>
      </div>
    </div>
  );
}
