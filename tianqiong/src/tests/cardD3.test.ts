/* ============================================================
   卡 D3 · 多维势力外交矩阵
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { bus, core, rng, scheduler, newGame, importState, addRep } from '@/world';
import { MemorySaveRepository } from '@/repo';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';
import { adjFactionRel, adjRepAxis, playerStanding, repAxis, standingBetween } from '@/systems/faction/Factions';

beforeEach(() => {
  core.S = null;
  bus.clear();
  setSavePort(new MemorySaveRepository());
  setAiPort(ruleSim);
  const r = rng.seed(21);
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  return r;
});
const start = () => newGame({ name: 'D3', race: 'human', cls: 'warrior' });

describe('卡 D3 · 玩家多维声望', () => {
  it('开局六轴 playerRep 归零、attitude 仍走 rep（向后兼容）', () => {
    start();
    const s = core.S!;
    expect(s.playerRep).toBeDefined();
    expect(Object.keys(s.playerRep!).length).toBe(14); // 神殿拆五：势力扩到十四
    expect(s.playerRep!.guild?.trust).toBe(0);
    addRep('guild', 10);
    expect(repAxis('guild', 'attitude')).toBe(10); // 与旧 s.rep 同步
    expect(s.rep.guild).toBe(10);
  });
  it('adjRepAxis 独立调整非态度轴、attitude 轴拒走此口', () => {
    start();
    adjRepAxis('empire', 'hostility', 30);
    expect(repAxis('empire', 'hostility')).toBe(30);
    expect(repAxis('empire', 'attitude')).toBe(0); // 未污染态度
    expect(() => adjRepAxis('empire', 'attitude', 5)).toThrow();
  });
});

describe('卡 D3 · 势力↔势力外交矩阵', () => {
  it('同一对势力可"通商友好 + 信任敌对"（§13 核心断言）', () => {
    start();
    const s = core.S!;
    const trade = standingBetween('shadow', 'guild', 'trade', s);
    const trust = standingBetween('shadow', 'guild', 'trust', s);
    expect(trade).toBeGreaterThan(0); // 暗影与公会做黑市生意
    expect(trust).toBeLessThan(0); // 但互不信任
  });
  it('adjFactionRel 写运行时层、不污染种子且可回落', () => {
    start();
    const s = core.S!;
    const before = standingBetween('temple_war', 'study', 'religion', s);
    adjFactionRel('temple_war', 'study', 'religion', 50, s);
    expect(standingBetween('temple_war', 'study', 'religion', s)).toBe(Math.min(100, before + 50));
    // 未定义的轴回落种子值（非 0），证明 live 覆盖是逐轴合并
    expect(standingBetween('temple_war', 'study', 'hostility', s)).toBeGreaterThan(0);
  });
  it('playerStanding 返回全 7 轴（attitude 取 rep）', () => {
    start();
    addRep('temple_life', 40);
    const st = playerStanding('temple_life');
    expect(st.attitude).toBe(40);
    expect(Object.keys(st).length).toBe(7);
  });
});

describe('卡 D3 · 旧档迁移', () => {
  it('旧档无 playerRep → hydrate 投影补全，attitude 从 rep 读取', () => {
    start();
    addRep('shadow', -20);
    const legacy = JSON.parse(JSON.stringify(core.S));
    delete legacy.playerRep;
    delete legacy.factionRel;
    legacy.ver = 1;
    expect(importState(JSON.stringify(legacy))).toBe(true);
    const s = core.S!;
    expect(s.playerRep).toBeDefined();
    expect(s.playerRep!.shadow?.trust).toBe(0); // 补零
    expect(repAxis('shadow', 'attitude')).toBe(-20); // 态度从旧 rep 还原
  });
});
