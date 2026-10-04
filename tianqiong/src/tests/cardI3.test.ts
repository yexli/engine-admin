/* ============================================================
   卡 I3 单测 · 五系 38 技能 · 六种状态 · 暴击/元素出口
   确定性：种子随机 + 同步调度器 + 内存存档。
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { bus, core, rng, scheduler } from '@/world';
import { playerAct, startCombat } from '@/systems/combat/Combat';
import {
  applyStatus,
  cureStatus,
  dotOf,
  elemMult,
  hasSkip,
  hasStatus,
  stMod,
  statusDef,
  statusIds,
  tickStatus,
} from '@/systems/character/Status';
import { newGame } from '@/world/WorldRuntime';
import { AC, atkB } from '@/systems/character/Derived';
import { WB } from '@/data/worldBook';
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
  newGame({ name: '武者', race: 'human', cls: 'warrior' });
});

const S = () => core.S!;
const CB = () => core.CB!;
const logText = () => CB().log.map((e) => e.text).join(' | ');

describe('卡 I3 · 数据完整性（38 技能 · 6 状态）', () => {
  it('技能池 8 → 38 → 59（卡 E1 补 19 条终极 + 逐日之弓），五系齐备', () => {
    expect(Object.keys(WB.skills).length).toBe(59);
    const lin = new Set(Object.values(WB.skills).map((s) => s.lineage));
    for (const l of ['物理', '法师', '召唤', '辅助', '生产', '敏捷']) expect(lin.has(l), l).toBe(true);
  });

  it('每个技能 kind 齐备、mp/cd 在合法域、文案非空（无占位符）', () => {
    const kinds = new Set(['atk', 'def', 'buff', 'debuff', 'heal']);
    for (const [id, s] of Object.entries(WB.skills)) {
      expect(kinds.has(s.kind || ''), id + '.kind').toBe(true);
      expect(Number.isInteger(s.mp) && s.mp >= 0, id + '.mp').toBe(true);
      expect(Number.isInteger(s.cd) && s.cd >= 0, id + '.cd').toBe(true);
      expect((s.desc || '').length, id + '.desc').toBeGreaterThan(3);
      expect(/\{[a-z]+\}|TODO|占位/.test(s.desc || ''), id).toBe(false);
    }
  });

  it('20 个职业的 skillPath 全部指向真技能且 6 阶不重复（防退化占位）', () => {
    for (const [cid, c] of Object.entries(WB.classes)) {
      const sp = c.skillPath || [];
      expect(sp.length, cid).toBe(6);
      expect(new Set(sp).size, cid + ' 有重复阶').toBe(6);
      for (const k of sp) expect(!!WB.skills[k], cid + '→' + k).toBe(true);
      expect(c.skill, cid).toBe(sp[0]);
    }
  });

  it('十种状态齐备且叠层/时长合法', () => {
    /* 卡 N1：六种旧负面态 + 消耗品授予的四种正面态。正面态与负面态同表同命
       （都只活在 CombatState 上，战斗结束一起丢），分表的代价大于收益。 */
    expect(statusIds().sort()).toEqual(['bastion', 'bleed', 'burn', 'fervor', 'freeze', 'oracle', 'slow', 'stun', 'swift', 'vuln']);
    for (const id of statusIds()) {
      const d = statusDef(id)!;
      expect(d.maxStack).toBeGreaterThanOrEqual(1);
      expect(d.dur).toBeGreaterThanOrEqual(1);
      expect(d.name.length).toBeGreaterThan(0);
    }
  });

  it('旧 8 技能的数值逐位未变（回归护栏）', () => {
    const base: Record<string, [number, number, number | undefined]> = {
      heavy_slash: [0, 2, 1.8],
      guard_break: [4, 3, 1.4],
      firebolt: [5, 1, 1.9],
      arcane_ward: [6, 4, undefined],
      aimed_shot: [3, 2, 1.6],
      wind_flurry: [5, 3, 0.95],
      holy_light: [4, 1, 1.7],
      blessing: [6, 4, undefined],
    };
    for (const [id, [mp, cd, mult]] of Object.entries(base)) {
      const s = WB.skills[id];
      expect(s.mp, id).toBe(mp);
      expect(s.cd, id).toBe(cd);
      if (mult !== undefined) expect(s.mult, id).toBe(mult);
    }
  });

  it('状态来源技能指向的状态 id 全部存在（防幽灵状态）', () => {
    for (const [id, s] of Object.entries(WB.skills)) {
      if (s.status) expect(statusIds().includes(s.status.id), id + '→' + s.status.id).toBe(true);
      for (const c of s.cure || []) expect(statusIds().includes(c), id + ' cure ' + c).toBe(true);
    }
  });
});

describe('卡 I3 · 状态纯函数', () => {
  it('施加 → 叠层到上限后只刷新时长', () => {
    const arr: ReturnType<typeof applyStatus> extends never ? [] : Parameters<typeof tickStatus>[0] = [];
    const a = applyStatus(arr, 'burn', 3, 4);
    expect(a.ok).toBe(true);
    expect(arr[0].stack).toBe(1);
    applyStatus(arr, 'burn', 3, 4);
    applyStatus(arr, 'burn', 3, 4);
    expect(arr.length).toBe(1);
    expect(arr[0].stack).toBe(statusDef('burn')!.maxStack); // 3 层封顶
    const before = arr[0].dur;
    applyStatus(arr, 'burn', 9, 9);
    expect(arr[0].stack).toBe(statusDef('burn')!.maxStack);
    expect(arr[0].dur).toBeGreaterThanOrEqual(before);
  });

  it('首领免疫集：stun/freeze 对 boss 无效，burn 照常', () => {
    const arr: Parameters<typeof tickStatus>[0] = [];
    expect(applyStatus(arr, 'stun', 1, 0, true).ok).toBe(false);
    expect(applyStatus(arr, 'freeze', 2, 0, true).ok).toBe(false);
    expect(applyStatus(arr, 'burn', 3, 4, true).ok).toBe(true);
    expect(arr.length).toBe(1);
  });

  it('tickStatus：DoT = power × stack，时长递减，过期移除', () => {
    const arr: Parameters<typeof tickStatus>[0] = [];
    applyStatus(arr, 'burn', 2, 5);
    applyStatus(arr, 'burn', 2, 5); // 2 层
    expect(dotOf(arr)).toBe(10);
    const r1 = tickStatus(arr);
    expect(r1.dmg).toBe(10);
    expect(arr[0].dur).toBe(1);
    const r2 = tickStatus(arr);
    expect(r2.expired).toContain('burn');
    expect(arr.length).toBe(0);
  });

  it('stMod 按叠层累加；hasSkip 只认真实 skip 类', () => {
    const arr: Parameters<typeof tickStatus>[0] = [];
    applyStatus(arr, 'vuln', 3, 3);
    applyStatus(arr, 'vuln', 3, 3);
    expect(stMod(arr, 'acMod')).toBe(statusDef('vuln')!.acMod! * 2);
    expect(hasSkip(arr)).toBe(false);
    applyStatus(arr, 'stun', 1, 0);
    expect(hasSkip(arr)).toBe(true);
    expect(hasStatus(arr, 'stun')).toBe(true);
  });

  it('cureStatus 精确移除指定状态', () => {
    const arr: Parameters<typeof tickStatus>[0] = [];
    applyStatus(arr, 'burn', 3, 4);
    applyStatus(arr, 'bleed', 3, 3);
    expect(cureStatus(arr, ['burn', 'slow'])).toBe(1);
    expect(arr.map((s) => s.id)).toEqual(['bleed']);
  });

  it('元素修正：亡灵吃神圣 ×1.5、火 ×0.5；无标记族返回 1', () => {
    expect(elemMult({ undead: true }, '神圣')).toBe(1.5);
    expect(elemMult({ undead: true }, '火')).toBe(0.5);
    expect(elemMult({ undead: true }, '雷')).toBe(1);
    expect(elemMult({}, '火')).toBe(1);
    expect(elemMult({ undead: true }, undefined)).toBe(1);
  });
});

describe('卡 I3 · 战斗集成（状态 · 暴击 · 控制）', () => {
  it('开战初始化玩家状态数组（战斗期字段，不落档）', () => {
    startCombat(['goblin']);
    expect(CB().status).toEqual([]);
    expect(CB().foes[0].status).toBeUndefined();
    /* 全文搜 "status" 会被记忆对象的 status: 'active' 误伤，所以把记忆表摘掉再搜——
       这样嵌套位置漏进的战斗状态（cb / player.cb 之类）仍会被抓到。 */
    expect(JSON.stringify({ ...S(), memories: {} }).includes('"status"')).toBe(false); // 战斗状态不进存档
  });

  it('火焰箭命中 → 敌人挂上燃烧（一次 d20，命中后判状态）', () => {
    startCombat(['goblin']);
    S().player.skills.push('firebolt');
    const restore = rng.inject(() => 0.4); // d20=9（可命中）· chance(0.5)=true · 不暴击
    for (let i = 0; i < 4 && !hasStatus(CB().foes[0].status, 'burn'); i++) playerAct('skill', 'firebolt');
    restore();
    expect(hasStatus(CB().foes[0].status, 'burn')).toBe(true);
    expect(logText()).toContain('燃烧');
  });

  it('燃烧 tick：敌方回合前扣血（DoT 出口）', () => {
    startCombat(['goblin']);
    const foe = CB().foes[0];
    foe.status = [];
    applyStatus(foe.status, 'burn', 3, 6);
    const hp0 = foe.hp;
    const restore = rng.inject(() => 0.4);
    playerAct('atk');
    restore();
    const burnLog = CB().log.some((e) => e.text.includes('持续伤害'));
    expect(burnLog || foe.hp < hp0).toBe(true);
  });

  it('被眩晕的敌手跳过回合（控制出口）', () => {
    startCombat(['goblin']);
    const foe = CB().foes[0];
    foe.status = [];
    applyStatus(foe.status, 'stun', 1, 0); // 上一行已初始化
    const restore = rng.inject(() => 0.4);
    playerAct('atk');
    restore();
    expect(logText()).toContain('僵在原地');
  });

  it('玩家被眩晕 → 本回合无法行动', () => {
    startCombat(['goblin']);
    const foe = CB().foes[0];
    const hp0 = foe.hp;
    const me = CB();
    me.status = [];
    applyStatus(me.status, 'stun', 1, 0);
    const restore = rng.inject(() => 0.99);
    playerAct('atk');
    restore();
    expect(CB().log.some((e) => e.text.includes('没能动'))).toBe(true);
    expect(foe.hp).toBe(hp0);
  });

  it('自然 20 必中且 cbLog 写入 crit 字段（补 H 缺口 3）', () => {
    startCombat(['goblin']);
    const restore = rng.inject(() => 0.999); // d20 = 20
    playerAct('atk');
    restore();
    const crits = CB().log.filter((e) => e.crit);
    expect(crits.length).toBeGreaterThan(0);
    expect(crits[0].text).toContain('会心一击');
  });

  it('自然 1 必失（即使命中加值够高）', () => {
    startCombat(['goblin']);
    const foe = CB().foes[0];
    const hp0 = foe.hp;
    const restore = rng.inject(() => 0); // d20 = 1
    playerAct('atk');
    restore();
    expect(foe.hp).toBe(hp0);
    expect(logText()).toContain('格开了');
    expect(CB().log.some((e) => e.crit)).toBe(false);
  });

  it('破甲状态降低目标有效防御（AC 修正出口）', () => {
    startCombat(['goblin']);
    const foe = CB().foes[0];
    foe.status = [];
    applyStatus(foe.status, 'vuln', 3, 3);
    const restore = rng.inject(() => 0.4);
    playerAct('atk');
    restore();
    expect(logText()).toContain('vs 防御 ' + (foe.ac + stMod(foe.status, 'acMod')));
  });

  it('玩家自身状态经 derived 出口影响 AC/命中', () => {
    startCombat(['goblin']);
    const ac0 = AC();
    const atk0 = atkB();
    CB().status = [];
    applyStatus(CB().status!, 'vuln', 3, 3);
    applyStatus(CB().status!, 'slow', 3, 0);
    expect(AC()).toBeLessThan(ac0);
    expect(atkB()).toBeLessThan(atk0);
  });

  it('战斗结束（逃跑）后状态随 CB 一并清空，不带出战斗', () => {
    startCombat(['goblin']);
    CB().status = [];
    applyStatus(CB().status!, 'burn', 3, 4);
    /* 直接走败北路径：玩家血量为 0 时结算终局 */
    S().player.hp = 0;
    const restore = rng.inject(() => 0.4);
    playerAct('atk');
    restore();
    expect(core.CB).toBeNull();
    expect(JSON.stringify({ ...S(), memories: {} }).includes('"status"')).toBe(false); // 战斗状态不带出战斗
  });

  it('技能冷却与 MP 仍由 core 权威校验（F-18 口径不破）', () => {
    startCombat(['goblin']);
    S().player.mp = 0;
    const foe = CB().foes[0];
    const hp0 = foe.hp;
    const restore = rng.inject(() => 0.99);
    playerAct('skill', 'firebolt');
    restore();
    expect(foe.hp).toBe(hp0); // 没蓝：技能不生效（日志也不产生技能行）
  });
});
