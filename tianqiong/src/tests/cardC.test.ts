/* 卡 C 回归：星枢入网禁入、经济闭环（寄售→星币 / 星晶→星币兑换）、只进不出、无伤比斗真身不动、hydrate */
import { beforeEach, describe, expect, it } from 'vitest';
import { bus, core, dispatch, importState, newGame, resetWorld, rng, scheduler } from '@/world';
import { MemorySaveRepository } from '@/repo';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';
import { cashOut, consign, duel, enterNet, exchangeCrystal, marketBuy } from '@/systems/starnet/StarNet';
import { playerAct } from '@/systems/combat/Combat';
import { STARHUB } from '@/data/starhub';
import type { NetState } from '@/types/world';

const net = () => core.S!.net as NetState;
const inNet = () => {
  newGame({ name: 'T', race: 'human', cls: 'warrior' });
  enterNet();
};

beforeEach(() => {
  core.S = null;
  core.CB = null;
  resetWorld();
  setSavePort(new MemorySaveRepository());
  setAiPort(ruleSim);
  bus.clear();
  const restore = rng.seed(42);
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  return restore;
});

describe('卡C · 入网禁入（判定进引擎，门槛 wanted>=2）', () => {
  it('清白者可入网', () => {
    newGame({ name: 'T', race: 'human', cls: 'warrior' });
    expect(enterNet()).toBe(true);
    expect(net().online).toBe(true);
  });
  it('通缉达门槛者禁入', () => {
    newGame({ name: 'T', race: 'human', cls: 'warrior' });
    core.S!.player.wanted = STARHUB.net_rules.banWantedMin;
    expect(enterNet()).toBe(false);
    expect(net().online).toBe(false);
  });
});

describe('卡C · 经济闭环', () => {
  it('寄售：物品离包、换得星币（收入源）', () => {
    inNet();
    core.S!.player.bag = [{ id: 'cloth', qty: 2 }];
    const before = net().starcoin;
    expect(consign('cloth')).toBe(true);
    expect(core.S!.player.bag[0].qty).toBe(1);
    expect(net().consign.find((x) => x.id === 'cloth')?.qty).toBe(1);
    expect(net().starcoin).toBeGreaterThan(before);
  });
  it('星币不足则买入失败；足则只耗星币、不动钱袋', () => {
    inNet();
    net().starcoin = 10;
    const gold = core.S!.player.gold;
    expect(marketBuy()).toBe(false);
    net().starcoin = 100;
    expect(marketBuy()).toBe(true);
    expect(net().starcoin).toBe(50);
    expect(core.S!.player.gold).toBe(gold);
  });
  it('星晶→星币兑换（sink），仍不可出网', () => {
    inNet();
    expect(exchangeCrystal()).toBe(false); // 无星晶
    net().starcrystal = 2;
    const coin = net().starcoin;
    expect(exchangeCrystal()).toBe(true);
    expect(net().starcrystal).toBe(1);
    expect(net().starcoin).toBe(coin + STARHUB.rates.crystalToCoin);
  });
  it('只进不出：星币不可兑换现实铜币', () => {
    inNet();
    net().starcoin = 100;
    const gold = core.S!.player.gold;
    expect(cashOut()).toBe(false);
    expect(net().starcoin).toBe(100);
    expect(core.S!.player.gold).toBe(gold);
  });
});

describe('卡C · 无伤比斗（进入 combat 演出，真身 hp·gold 恒定）', () => {
  it('比斗结束只落 net 战绩，真身无损', () => {
    inNet();
    const hp = core.S!.player.hp;
    const gold = core.S!.player.gold;
    duel();
    expect(core.CB?.ctx.net).toBe(true); // 已进入 net 战斗演出
    let guard = 0;
    while (core.CB && !core.CB.over && guard++ < 60) playerAct('atk');
    expect(core.S!.player.hp).toBe(hp); // 快照还原（胜/败皆无损）
    expect(core.S!.player.gold).toBe(gold);
    expect(net().duels.won + net().duels.lost).toBe(1);
    if (net().duels.lost === 1) {
      expect(net().online).toBe(false);
      expect(net().exitLockUntil).toBeGreaterThan(core.S!.t - 1);
    } else {
      expect(net().starcrystal).toBe(STARHUB.duel.winStarcrystal);
    }
  });
});

describe('卡C · 旧存档 hydrate 补 net', () => {
  it('无 net 的旧档导入后补默认，dispatch 星枢入口不崩', () => {
    const old = { ver: 1, player: { name: 'X', gold: 100, bag: [], flags: {}, wanted: 0 }, rep: {}, log: [] };
    expect(importState(JSON.stringify(old))).toBe(true);
    expect(core.S!.net).toBeDefined();
    expect(core.S!.net!.online).toBe(false);
    dispatch({ type: 'sceneAction', k: 'starnet' });
  });
});
