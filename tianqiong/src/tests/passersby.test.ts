/* ============================================================
   当日路人（方案 B 的三条契约）

   修的是这一条：观察时看见「姆戈拉·撕喉，一个兽人」报上名，去搭话却被告知
   「周围没有可以搭话的人」——叙事许诺了机制兑现不了的东西。

   这里钉住三件事：
     ① 名单稳定：同一天同一地点反复观察，看到的是同一批人；
     ② 每日上限：观察是高频动作，不设限会刷成走马灯；
     ③ 搭话兜底：当日见过的名字搭得上话，且不再落入「周围没人」。
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { bus, core, newGame, resetWorld, rng, scheduler, sceneTime } from '@/world';
import { MemorySaveRepository } from '@/repo';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';
import { executeIntent } from '@/actions/ActionParser';
import {
  MEET_CAP,
  canMeet,
  firstPasserby,
  markMet,
  passersbyAt,
  resetPassersby,
  seenHere,
} from '@/systems/npc/Passersby';

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
  resetPassersby();
});

describe('当日路人名单', () => {
  it('同一天同一地点：两次拿到的名单完全一致（街道有记忆）', () => {
    const a = passersbyAt('plaza', 3).map((p) => p.name);
    const b = passersbyAt('plaza', 3).map((p) => p.name);
    expect(b).toEqual(a);
    expect(a.length).toBeGreaterThanOrEqual(3);
  });

  it('换天即失效：第二天是另一批人', () => {
    const a = passersbyAt('plaza', 3).map((p) => p.name);
    const b = passersbyAt('plaza', 4).map((p) => p.name);
    expect(b).not.toEqual(a);
  });

  it('不同地点各有各的名单', () => {
    const a = passersbyAt('plaza', 3).map((p) => p.name);
    const b = passersbyAt('tavern', 3).map((p) => p.name);
    expect(b).not.toEqual(a);
  });

  it('每人都由命名生成器署名（名字与族名都不是空）', () => {
    for (const p of passersbyAt('market', 1)) {
      expect(p.name.length).toBeGreaterThan(1);
      expect(p.race.length).toBeGreaterThan(0);
    }
  });

  it('每地点每日有上限', () => {
    const day = 5;
    expect(canMeet('plaza', day)).toBe(true);
    for (let i = 0; i < MEET_CAP; i++) markMet('plaza', day);
    expect(canMeet('plaza', day), '到上限后就该停下').toBe(false);
    expect(canMeet('tavern', day), '上限按地点各算各的').toBe(true);
  });

  it('当天见过的人找得到，没见过的不在名单里', () => {
    const list = passersbyAt('gate', 7);
    expect(seenHere(list[0].name, 'gate', 7)).toBe(true);
    expect(seenHere('并不存在的人', 'gate', 7)).toBe(false);
  });

  it('没观察过就没人可搭话；观察过之后 firstPasserby 稳定给出第一位', () => {
    expect(firstPasserby('plaza', 2), '没观察过就不该凭空冒出一个人').toBeNull();
    const roster = passersbyAt('plaza', 2);
    const p = firstPasserby('plaza', 2);
    expect(p).not.toBeNull();
    expect(p!.name).toBe(roster[0].name);
  });
});

describe('闭环：看见的人搭得上话', () => {
  it('指名当日见过的路人 → 有回应，且不再报「周围没有可以搭话的人」', () => {
    start();
    const day = sceneTime(core.S!).day;
    const p = passersbyAt('plaza', day)[0];

    executeIntent({ intent: 'askinfo', target: p.name }, '向' + p.name + '打听');

    const texts = core.S!.log.map((l) => l.text);
    expect(
      texts.some((t) => t.includes('找到「' + p.name + '」')),
      '当日见过的路人应该搭得上话——这条红了说明闭环又断了',
    ).toBe(true);
    expect(
      texts.some((t) => t.includes('周围没有可以搭话的人')),
      '这里不该再说「没人」',
    ).toBe(false);
  });

  it('路人只给一句敷衍话，不写关系、不给情报', () => {
    start();
    const s = core.S!;
    const day = sceneTime(s).day;
    const p = passersbyAt('plaza', day)[0];
    const before = s.player.gold;
    const npcCount = Object.keys(s.npcs).length;

    executeIntent({ intent: 'askinfo', target: p.name }, '向' + p.name + '打听');

    /* 不建 NpcDynamic、不给钱、不增 NPC 表——他只是街上的人，不是可经营的对象 */
    expect(Object.keys(core.S!.npcs).length, '路人进 NPC 表就等于污染存档').toBe(npcCount);
    expect(core.S!.player.gold).toBe(before);
  });

  it('指名一个根本不存在的人：仍然如实报「不在这里」', () => {
    start();
    executeIntent({ intent: 'askinfo', target: '并不存在的人' }, '向并不存在的人打听');
    const texts = core.S!.log.map((l) => l.text);
    expect(texts.some((t) => t.includes('不在这里'))).toBe(true);
  });
});
