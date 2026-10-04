/* ============================================================
   卡 D1 · NPC 独立人生（多时段日程 + 自主行动 tick + 目标字段）
   确定性：种子随机 + 同步调度器 + 内存存档
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { bus, core, rng, scheduler, newGame } from '@/world';
import { MemorySaveRepository } from '@/repo';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';
import { WB } from '@/data/worldBook';
import { npcAt, npcCurLoc } from '@/systems/npc/Npcs';
import { shichenOf } from '@/world/WorldClock';

beforeEach(() => {
  core.S = null;
  bus.clear();
  setSavePort(new MemorySaveRepository());
  setAiPort(ruleSim);
  const r = rng.seed(7);
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  return r;
});

const start = () => newGame({ name: 'D1测试者', race: 'human', cls: 'warrior' });

describe('卡 D1 · 多时段日程', () => {
  it('有 schedule 的 NPC：按当前时辰命中日程段地点', () => {
    start();
    const s = core.S!;
    // 莉安日程：0–3 集市采买 / 4–11 酒馆操持。设到 h=5 → tavern
    s.t = 5 * 4 + 2; // 辰巳之间，h=5
    expect(shichenOf(s.t)).toBe(5);
    expect(npcAt('lita', s)).toBe('tavern');
    // 设到 h=1 → market（清早采买，自主离场）
    s.t = 1 * 4 + 2;
    expect(npcAt('lita', s)).toBe('market');
  });
  it('保留原作息：原出没时段仍在原地点（旧行为不破）', () => {
    start();
    const s = core.S!;
    // 赛琳娜原 hours [10,15]（h10、11 在酒馆），schedule 覆盖 10–15
    s.t = 10 * 4; // h=10
    expect(npcAt('selina', s)).toBe('tavern');
  });
  it('needFlag 门优先：奥托在商队事件前不现身（即便有日程）', () => {
    start();
    const s = core.S!;
    s.t = 6 * 4; // 白天、有日程段
    expect(npcAt('otto', s)).toBeNull(); // flags.caravan_evt 未置 → null
    s.player.flags.caravan_evt = true;
    expect(npcAt('otto', s)).toBe('market');
  });
});

describe('卡 D1 · 位置查询（Phase 4.2：物化缓存已撤，位置是纯函数产物）', () => {
  it('npcCurLoc 与 npcAt 同源：时辰一变立刻反映，不存在过期缓存', () => {
    start();
    const s = core.S!;
    s.t = 4 * 4; // h=4，多数 NPC 在工作位
    expect(npcCurLoc('lita', s)).toBe('tavern');
    expect(npcCurLoc('reno', s)).toBe('gate');
    s.t = 1 * 4; // h=1 → 清早采买
    expect(npcCurLoc('lita', s), '没有任何 tick，也不会读到旧地点').toBe('market');
    expect(npcCurLoc('lita', s)).toBe(npcAt('lita', s));
  });

  it('查询是只读的：位置算多少次都不落进存档', () => {
    start();
    const s = core.S!;
    s.t = 4 * 4;
    const before = JSON.stringify(s.npcs);
    npcCurLoc('lita', s);
    npcCurLoc('reno', s);
    npcAt('selina', s);
    expect(JSON.stringify(s.npcs), '去物化的收益就在这里：读不问写').toBe(before);
  });
});

describe('卡 D1 · 目标字段（叙事，不进规则）', () => {
  it('具名 NPC 携带 goal/interest/bottomLine，且不影响 npcAt 判定', () => {
    start();
    const s = core.S!;
    s.t = 4 * 4;
    /* 2026-09 作息修复前，灰烬在 h=4 是「空档」（10–16 段越界 + 0–2 段之外），
       npcAt 返回 null——本用例当时拿它当「不在场」的样本。修复后他 2–10 在巷底，
       位置仍然只由作息决定（与本用例要守的「目标字段不进规则」一致）。 */
    expect(npcAt('ash', s), '位置只看日程/作息').toBe('alley');
    const d = WB.npcs.ash as { goal?: string; interest?: string; bottomLine?: string };
    expect(d.goal && d.interest && d.bottomLine, '目标字段应当齐备（供叙事与人设使用）').toBeTruthy();
  });
});
