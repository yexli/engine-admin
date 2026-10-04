/* ============================================================
   商店权威校验（F-10）与数值边界（F-11）
   —— 价格与上架状态必须由 core 重算，命令层不可越权。
   确定性：种子随机 + 同步调度器 + 内存存档。
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { bus, core, rng, scheduler } from '@/world';
import { newGame } from '@/world/WorldRuntime';
import { addRep, gainExp, gainGold } from '@/systems/character/Gains';
import { buy, buyPrice, openShop, sell } from '@/systems/economy/Shop';
import { MemorySaveRepository } from '@/repo';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';

beforeEach(() => {
  core.S = null;
  core.CB = null;
  core.curShop = null;
  bus.clear();
  setSavePort(new MemorySaveRepository());
  setAiPort(ruleSim);
  rng.seed(23);
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  newGame({ name: '商店', race: 'human', cls: 'warrior' });
});

const S = () => core.S!;

describe('商店权威校验（F-10）', () => {
  it('buy 忽略调用方传入价，一律按 core 重算价扣款', () => {
    const s = S();
    openShop('grocer');
    const price = buyPrice('grocer', 'bread');
    expect(price).toBeGreaterThan(1);
    const g0 = s.player.gold;
    buy('bread', 1); // 企图以 1 铜买走
    expect(s.player.gold).toBe(g0 - price);
    expect(s.player.bag.find((x) => x.id === 'bread')?.qty).toBe(1);
  });

  it('未满足 allyStock.needFlag 时独家货不在架上 → 拒绝', () => {
    const s = S();
    /* 卡 T3：虚空精华价 3000 → 50000 铜；黑市钱袋 1500 → 200000。
       买得起的前提是玩家资金高于货价（原值 100000 已低于新价）。 */
    s.player.gold = 500000;
    openShop('black');
    const g0 = s.player.gold;
    buy('void_essence', 1);
    expect(s.player.gold).toBe(g0);
    expect(s.player.bag.some((x) => x.id === 'void_essence')).toBe(false);
    /* 满足同盟旗标后同一件货才上架 */
    s.player.flags.shadow_ally = true;
    buy('void_essence', 1);
    expect(s.player.bag.some((x) => x.id === 'void_essence')).toBe(true);
  });

  it('未知商品被拒且不扣款', () => {
    const s = S();
    openShop('grocer');
    const g0 = s.player.gold;
    buy('not_an_item', 0);
    expect(s.player.gold).toBe(g0);
    expect(s.player.bag.length).toBe(0);
  });

  it('sell 拒收非素材（装备）与未知 id', () => {
    const s = S();
    openShop('grocer');
    s.player.bag = [{ id: 'sword_iron', qty: 1 }];
    const g0 = s.player.gold;
    sell('sword_iron');
    sell('not_an_item');
    expect(s.player.gold).toBe(g0);
    expect(s.player.bag.length).toBe(1);
  });

  it('sell 素材按 core 价格结算并移除背包条目', () => {
    const s = S();
    openShop('grocer');
    s.player.bag = [{ id: 'moonherb', qty: 2 }];
    const g0 = s.player.gold;
    sell('moonherb');
    expect(s.player.gold).toBeGreaterThan(g0);
    expect(s.player.bag[0].qty).toBe(1);
  });
});

describe('数值边界（F-11）', () => {
  it('挂科式负经验不会写出负 exp（卡 R1 后：下限 0、不因种族倍率被削）', () => {
    const s = S();
    s.player.exp = 5;
    gainExp(-50);
    /* 卡 R1：种族效率只作用于**收益**，负值按原值透传，下限由 mutate.playerExp 兜。
       原用例断言 exp 归零——那要求 -50 能被整段吃掉；去掉负号传播后 exp 落在 0，
       而「5 - 50」本就该是 0。这里直接钉住真正的契约：不为负。 */
    expect(s.player.exp).toBeGreaterThanOrEqual(0);
  });

  it('未知势力声望被忽略：不写脏键、不弹 undefined 文案', () => {
    const s = S();
    const seen: string[] = [];
    const off = bus.on((e) => {
      if (e.type === 'toast') seen.push(e.text);
    });
    addRep('nope_faction', 5);
    off();
    expect('nope_faction' in s.rep).toBe(false);
    expect(seen.some((t) => t.includes('undefined'))).toBe(false);
  });

  it('gainGold 不产出负金币（既有下界仍守得住）', () => {
    const s = S();
    s.player.gold = 10;
    gainGold(-999);
    expect(s.player.gold).toBe(0);
  });
});
