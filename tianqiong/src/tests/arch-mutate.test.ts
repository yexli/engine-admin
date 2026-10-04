/* ============================================================
   受控写入原语测试（《天穹纪元2.0 · 架构收口修复方案》G-04）
   —— world/mutate 是世界状态的**唯一**写入实现点：
   夹取边界、未开局行为、日志序号单调性、关系种子投影都钉在这里。
   确定性：种子随机 + 同步调度器 + 内存存档（与 arch-infra 同一套装配）。
   ============================================================ */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bus, core, newGame, resetWorld, rng, scheduler } from '@/world';
import { MemorySaveRepository } from '@/repo';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';
import { mutate } from '@/world/WorldMutate';
import { itemCount, removeItem } from '@/systems/character/Gains';

const start = () => newGame({ name: '测试者', race: 'dwarf', cls: 'warrior' });

beforeEach(() => {
  core.S = null;
  core.CB = null;
  resetWorld();
  setSavePort(new MemorySaveRepository());
  setAiPort(ruleSim);
  bus.clear();
  rng.seed(42);
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
});

afterEach(() => {
  core.S = null;
  resetWorld();
});

describe('§4.2 · 受控写入原语', () => {
  it('未开局时抛错，行为与 need() 一致（不静默丢弃）', () => {
    expect(() => mutate.playerGold(10)).toThrow();
    expect(() => mutate.playerHp(10)).toThrow();
    expect(() => mutate.playerBag('moonherb', 1)).toThrow();
    expect(() => mutate.rep('empire', 1)).toThrow();
    expect(() => mutate.npcEntry('lita')).toThrow();
    expect(() => mutate.pushLog('x')).toThrow();
  });

  it('生命 / 法力：下界 0，cap 缺省时不设上界', () => {
    start();
    mutate.playerHp(-5);
    expect(core.S!.player.hp).toBe(0);
    mutate.playerMp(-1);
    expect(core.S!.player.mp).toBe(0);
    mutate.playerHp(50, 40);
    expect(core.S!.player.hp).toBe(40);
    mutate.playerHp(30);
    expect(core.S!.player.hp).toBe(30);
  });

  it('金钱 / 经验：增量为负时夹取到 0，不产生负值', () => {
    start();
    const g0 = core.S!.player.gold;
    mutate.playerGold(100);
    expect(core.S!.player.gold).toBe(g0 + 100);
    mutate.playerGold(-999999);
    expect(core.S!.player.gold).toBe(0);
    mutate.playerExp(-10);
    expect(core.S!.player.exp).toBe(0);
  });

  it('背包：入包堆叠、出包清零、库存不足返回 false', () => {
    start();
    expect(mutate.playerBag('moonherb', 2)).toBe(true);
    expect(mutate.playerBag('moonherb', 3)).toBe(true);
    expect(core.S!.player.bag.find((x) => x.id === 'moonherb')!.qty).toBe(5);
    expect(mutate.playerBag('moonherb', -5)).toBe(true);
    expect(core.S!.player.bag.find((x) => x.id === 'moonherb')).toBeUndefined();
    expect(mutate.playerBag('moonherb', -1)).toBe(false);
    expect(mutate.playerBag('moonherb', 0)).toBe(false);
  });

  it('背包：实例槽（有 uid）不参与堆叠行合并', () => {
    start();
    const s = core.S!;
    s.player.bag.push({ id: 'moonherb', qty: 1, uid: 'e7' });
    mutate.playerBag('moonherb', 2);
    const rows = s.player.bag.filter((x) => x.id === 'moonherb');
    expect(rows.length).toBe(2);
    expect(rows.find((x) => x.uid === 'e7')!.qty).toBe(1);
    expect(rows.find((x) => !x.uid)!.qty).toBe(2);
  });

  it('removeItem(id, 0)：显式「无动作」返回 false（返回值契约在收口时收紧）', () => {
    start();
    mutate.playerBag('moonherb', 1);
    /* 原实现 qty -= 0 后仍返回 true（声称改动过）；收口后 0 与 NaN 都是显式的无动作。
       现存调用点全部传正数（Quests 的 count、craft.json 的 items 均 >= 1），故不可触发；
       这条断言是把新口径写下来，避免以后有人依赖旧的「无动作也成功」。 */
    expect(removeItem('moonherb', 0)).toBe(false);
    expect(itemCount('moonherb')).toBe(1);
    expect(removeItem('moonherb', 1)).toBe(true);
    expect(itemCount('moonherb')).toBe(0);
  });

  it('声望：夹取 ±100，未知势力键不创建脏键', () => {
    start();
    expect(mutate.rep('empire', 500)).toBe(100);
    expect(mutate.rep('empire', -500)).toBe(-100);
    expect(mutate.rep('no_such_faction', 10)).toBe(0);
    expect(core.S!.rep.no_such_faction).toBeUndefined();
  });

  it('NPC 条目：惰性建档即投影关系种子（单一投影点）', () => {
    start();
    const dy = mutate.npcEntry('lita');
    expect(dy.att).toBe(0);
    expect(dy.met).toBe(false);
    expect(dy.rels).toBeDefined();
    expect(core.S!.npcs.lita).toBe(dy);
    expect(mutate.npcEntry('lita')).toBe(dy);
  });

  it('好感：返回前后值且夹取 ±100', () => {
    start();
    expect(mutate.npcAtt('lita', 6)).toEqual({ from: 0, to: 6 });
    expect(mutate.npcAtt('lita', 999).to).toBe(100);
    expect(mutate.npcAtt('lita', -999).to).toBe(-100);
  });

  it('见闻录：seq 单调递增 + 70 条上限', () => {
    start();
    const s = core.S!;
    const before = s.logSeq ?? 0;
    mutate.pushLog('第一条');
    mutate.pushLog('第二条', 'sys');
    expect(s.logSeq).toBe(before + 2);
    for (let i = 0; i < 80; i++) mutate.pushLog('刷屏 ' + i);
    expect(s.log.length).toBe(70);
    expect(s.logSeq).toBe(before + 82);
    expect(s.log[s.log.length - 1].text).toBe('刷屏 79');
  });

  it('地点 / 天气 / 标量字段 / 钱包：各有唯一入口', () => {
    start();
    mutate.playerLoc('tavern');
    expect(core.S!.player.loc).toBe('tavern');
    mutate.weather('雨');
    expect(core.S!.weather).toBe('雨');
    mutate.playerNum('wanted', (v) => Math.min(3, v + 2));
    expect(core.S!.player.wanted).toBe(2);
    mutate.playerSet('wanted', 0);
    expect(core.S!.player.wanted).toBe(0);
    mutate.playerWallet('soulCrystal', 3);
    expect(core.S!.player.wallet!.soulCrystal).toBe(3);
    mutate.playerWallet('soulCrystal', -10);
    expect(core.S!.player.wallet!.soulCrystal).toBe(0);
  });
});
