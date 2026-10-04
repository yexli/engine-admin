/* ============================================================
   卡 D4 · 转职（世界书 §31 十九分支的解锁路径）
   before：13 条 locked 分支只有数据标记，玩家没有任何路径走进去。
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { WB } from '@/data/worldBook';
import { core, newState } from '@/world/WorldState';
import { bus, rng, scheduler } from '@/events/EventBus';
import { blockersOf, TRANSFER_RULES, transfer, transferCandidates, transferPreview, transferView } from '@/systems/character/Transfer';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';
import { MemorySaveRepository } from '@/repo';

const pathOf = (cls: string): string[] => (WB.classes[cls].skillPath ?? []) as string[];

beforeEach(() => {
  core.S = null;
  core.CB = null;
  bus.clear();
  setSavePort(new MemorySaveRepository());
  setAiPort(ruleSim);
  rng.seed(43);
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  core.S = newState({ name: 'D4', race: 'human', cls: 'warrior' });
});

describe('卡 D4 · 转职门槛', () => {
  it('四级以下转不了，原因写明缺什么', () => {
    const s = core.S!;
    s.player.level = 1;
    expect(blockersOf('ranger', s).some((x) => x.includes('境界不足'))).toBe(true);
  });

  it('钱不够也转不了', () => {
    const s = core.S!;
    s.player.level = 4;
    s.player.gold = 0;
    expect(blockersOf('ranger', s).some((x) => x.includes('转职费'))).toBe(true);
  });

  it('条件齐备时可转（等级 + 钱够 + 非 locked + 非本线）', () => {
    const s = core.S!;
    s.player.level = 4;
    s.player.gold = 999999;
    expect(blockersOf('ranger', s)).toEqual([]);
  });

  it('种族专属线仍受 R1 把关：人类转不进矮人生产线', () => {
    const s = core.S!;
    s.player.level = 6;
    s.player.gold = 999999;
    expect(blockersOf('pr_forge', s).some((x) => x.includes('种族专属'))).toBe(true);
  });

  it('locked 分支在未开放时被列明（数据驱动的门）', () => {
    const s = core.S!;
    s.player.level = 6;
    s.player.gold = 999999;
    const lockedOnes = transferCandidates(s).filter((r) => r.locked);
    if (lockedOnes.length) expect(lockedOnes[0].blockers.some((x) => x.includes('尚未开放'))).toBe(true);
  });
});

describe('卡 D4 · 转职执行', () => {
  it('试炼通过后：换职业、清旧线技能、授新线同阶技能、扣费', () => {
    const s = core.S!;
    s.player.level = 4;
    s.player.gold = 100000;
    const pre = transferPreview('ranger', s);
    expect(pre.lose.length).toBeGreaterThan(0);
    s.player.stats['敏捷'] = 40; // 新线主属性拉满，试炼必过
    transfer('ranger', s);
    expect(s.player.cls, '试炼应已通过并换职业').toBe('ranger');
    expect(s.player.gold).toBe(100000 - TRANSFER_RULES.fee);
    for (const name of pre.lose) expect(s.player.transferLog ?? [], name).toContain(name);
    expect(s.player.skills).toContain(pathOf('ranger')[0]);
  });

  it('转职后 skills 不含旧线技能（职业的约束力成立）', () => {
    const s = core.S!;
    s.player.level = 4;
    s.player.gold = 100000;
    s.player.stats['敏捷'] = 40;
    transfer('ranger', s);
    for (const id of pathOf('warrior')) expect(s.player.skills, id).not.toContain(id);
  });

  it('缺条件时 transfer 不改变职业', () => {
    const s = core.S!;
    s.player.level = 1;
    s.player.gold = 0;
    transfer('ranger', s);
    expect(s.player.cls).toBe('warrior');
  });

  it('transferPreview 提前列出得失（让玩家看清代价）', () => {
    const s = core.S!;
    s.player.level = 4;
    const p = transferPreview('ranger', s);
    expect(p.lose.length).toBeGreaterThan(0);
    expect(p.gain.length).toBeGreaterThan(0);
  });

  it('transferView 汇总当前职业、门槛与候选清单', () => {
    const s = core.S!;
    s.player.level = 4;
    s.player.gold = 999999;
    const v = transferView(s);
    expect(v.cur.id).toBe('warrior');
    expect(v.minLevel).toBe(TRANSFER_RULES.minLevel);
    expect(v.rows.length).toBeGreaterThan(10);
    expect(v.rows.some((r) => r.ok)).toBe(true);
  });
});
