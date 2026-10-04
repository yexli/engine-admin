/* ============================================================
   卡 11 · 羁绊系统单元测试
   覆盖：五档反应 · 日/周 cap · 单礼封顶 · 仇怨门禁（拒礼/涨价/拒请求）
   赔罪化解 · 连带 propagateAtt · 亲密度升档仪式 · 回赠/衰减 tick
   入口（赠礼/赔罪 chip）· 聊天私密话题亲密度权益
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { bus, core, newGame, resetWorld, rng, scheduler } from '@/world';
import { MemorySaveRepository } from '@/repo';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';
import { WB } from '@/data/worldBook';
import { addItem, gainGold, itemCount } from '@/systems/character/Gains';
import { buyPrice } from '@/systems/economy/Shop';
import { dlgOpts, runReq } from '@/systems/dialogue/Dialogue';
import { chatChips } from '@/systems/npc/Chat';
import { apologize, bondDailyTick, bondOf, giveGift, propagateAtt, reactionOf, setGrudge } from '@/systems/relationship/Bond';
import type { SheetDesc } from '@/types/uispec';

let sheet: SheetDesc | null | 'unset' = 'unset';

beforeEach(() => {
  core.S = null;
  core.CB = null;
  resetWorld();
  setSavePort(new MemorySaveRepository());
  setAiPort(ruleSim);
  bus.clear();
  sheet = 'unset';
  bus.on((e) => {
    if (e.type === 'sheet') sheet = e.desc;
  });
  rng.seed(7);
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
});

const start = () => newGame({ name: '羁绊者', race: 'human', cls: 'mage' });

describe('赠礼·五档与封顶', () => {
  it('loved 命中 likes 标签：+8 入好感并发现偏好', () => {
    start();
    expect(reactionOf('mia', 'bread')).toBe('loved');
    addItem('bread');
    giveGift('mia', 'bread');
    expect(core.S!.npcs.mia.att).toBe(8);
    expect(core.S!.npcs.mia.giftKnown).toEqual(['food']);
    expect(core.S!.npcs.mia.bondProg!.gifts).toBe(1);
    expect(core.S!.log.some((l) => l.text === '你送上黑麦面包。')).toBe(true);
  });
  it('日限 2：第 3 件婉拒零收益且原物奉还', () => {
    start();
    addItem('bread', 4);
    giveGift('mia', 'bread');
    giveGift('mia', 'bread');
    expect(core.S!.npcs.mia.att).toBe(16);
    giveGift('mia', 'bread');
    expect(core.S!.npcs.mia.att).toBe(16);
    expect(itemCount('bread')).toBe(2); // 第 3 件被拒，分文不动
    expect(core.S!.log.some((l) => l.text.includes('收的礼够多了'))).toBe(true);
  });
  it('单礼封顶 +10：loved×传说倍率被钳制（R1）', () => {
    start();
    core.S!.t = 20; // 辰时：范德尔在市场
    core.S!.player.loc = 'market';
    addItem('void_essence');
    expect(reactionOf('vandel', 'void_essence')).toBe('loved');
    giveGift('vandel', 'void_essence');
    expect(core.S!.npcs.vandel.att).toBe(10); // 8×2=16 → clamp 10
  });
});

describe('仇怨·状态与化解', () => {
  it('有仇拒收礼', () => {
    start();
    setGrudge('mia', '你骗了她', 2);
    addItem('bread');
    giveGift('mia', 'bread');
    expect(core.S!.npcs.mia.att).toBe(0);
    expect(itemCount('bread')).toBe(1);
  });
  it('店主记仇 → 买价 +25%（buyPrice 钩子）', () => {
    start();
    const iid = WB.shops.black.stock[0];
    const p0 = buyPrice('black', iid);
    setGrudge('ash', '你向城卫告发', 3);
    expect(buyPrice('black', iid)).toBe(Math.round(p0 * 1.25));
  });
  it('记仇者不接请求（规则层门禁，不打扰 LLM）', () => {
    start();
    setGrudge('mia', '旧怨', 2);
    runReq('mia', 1);
    const d = sheet as Extract<SheetDesc, { kind: 'dialog' }>;
    expect(d.kind).toBe('dialog');
    expect(d.text.includes('不接你的话茬')).toBe(true);
  });
  it('赔罪成功（nat20）：付 100×sev、att+15、sev 清零释嫌', () => {
    start();
    setGrudge('mia', '小误会', 1);
    gainGold(1000);
    const g0 = core.S!.player.gold;
    const off = rng.inject(() => 0.999); // d20=20 → 大成功
    apologize('mia');
    off();
    expect(core.S!.npcs.mia.grudge).toBeUndefined();
    expect(core.S!.npcs.mia.att).toBe(15);
    expect(core.S!.player.gold).toBe(g0 - 100);
  });
  it('sev1 满 20 天自然衰减；sev3 长记忆不衰减（太吾式）', () => {
    start();
    core.S!.t = 48 * 25 + 16; // 第 26 日
    core.S!.npcs.galon = { att: 0, mem: [], met: true, grudge: { since: 1, why: '旧怨', sev: 1 } };
    core.S!.npcs.reno = { att: 0, mem: [], met: true, grudge: { since: 1, why: '血仇', sev: 3 } };
    const off = rng.inject(() => 0.5); // 关掉回赠概率干扰
    bondDailyTick(core.S!);
    off();
    expect(core.S!.npcs.galon.grudge).toBeUndefined();
    expect(core.S!.npcs.reno.grudge!.sev).toBe(3);
  });
});

describe('连带与亲密度', () => {
  it('propagateAtt：给莉安送礼，老乔（debtor -35）微降且 clamp ±2', () => {
    start();
    propagateAtt('lita', 8);
    expect(core.S!.npcs.joe!.att).toBe(-2); // round(8×-35/100)=-3 → clamp -2
  });
  it('好感满+gate 达标 → 升档「挚友」+必赠回礼', () => {
    start();
    core.S!.npcs.mia = { att: 85, mem: [], met: true, bondProg: { gifts: 2, chats: 8, quests: 0 } };
    core.S!.player.quests.q_letter = { stage: 'done' };
    addItem('bread');
    giveGift('mia', 'bread');
    const bv = bondOf('mia');
    expect(bv.intimacy).toBe(1);
    expect(bv.title).toBe('挚友');
    expect(itemCount('bread')).toBe(1); // 升档必赠回礼（送出 1 收 1）
    expect(core.S!.log.some((l) => l.text.includes('待你如挚友'))).toBe(true);
  });
  it('att 回落权益冻结不退档；私密话题仍随亲密度常在', () => {
    start();
    core.S!.npcs.mia = { att: 30, mem: [], met: true, intimacy: 1 };
    expect(bondOf('mia').title).toBe(''); // 权益徽章冻结
    expect(chatChips('mia').includes('弟弟的病')).toBe(true); // 私密话题保留（档在）
  });
  it('回赠 tick：亲密度≥2 小概率捎礼', () => {
    start();
    core.S!.npcs.mia = { att: 85, mem: [], met: true, intimacy: 2 };
    const off = rng.inject(() => 0.01); // chance(0.1) 命中
    bondDailyTick(core.S!);
    off();
    expect(itemCount('bread')).toBe(1);
  });
});

describe('羁绊入口', () => {
  it('dlgOpts 赠礼常在；有怨出现赔罪出口', () => {
    start();
    expect(dlgOpts('mia').some((o) => o.a === 'gift')).toBe(true);
    setGrudge('mia', 'x', 2);
    expect(dlgOpts('mia').some((o) => o.a === 'apologize')).toBe(true);
  });
});
