/* ============================================================
   卡 H2 · 星渊暗线：leak 分级爬升 / star6 开启 / 封印拉锯 / D4 阴谋链级联
   确定性：种子随机 + 同步调度器 + 内存存档。
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { bus, core, newGame, rng, scheduler } from '@/world';
import { MemorySaveRepository } from '@/repo';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';
import { abyssMenu, isOpen, leakLevel, leakName, probeAbyss, sealAbyss } from '@/systems/dungeon/Abyss';
import { abyssTick } from '@/systems/dungeon/Abyss';
import { addItem } from '@/systems/character/Gains';
import { directorTick, ALL_EVENTS } from '@/events/EventProcessor';
import { standingBetween } from '@/systems/faction/Factions';
import { hydrate } from '@/world/WorldState';

beforeEach(() => {
  core.S = null;
  bus.clear();
  setSavePort(new MemorySaveRepository());
  setAiPort(ruleSim);
  rng.seed(23);
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  newGame({ name: 'H2', race: 'human', cls: 'warrior' });
});

describe('卡 H2 · leak 分级与入口开启', () => {
  it('初始 leak=0：入口锁定、菜单拒绝', () => {
    const s = core.S!;
    expect(leakLevel(s)).toBe(0);
    expect(isOpen(s)).toBe(false);
    expect(() => abyssMenu()).not.toThrow(); // toast 拒绝
  });
  it('leak=1 → 入口开启，菜单可开', () => {
    const s = core.S!;
    s.abyss!.leak = 1;
    expect(isOpen(s)).toBe(true);
    expect(() => abyssMenu()).not.toThrow();
  });
  it('leakName 五级覆盖：0-5 有名，越界不崩', () => {
    expect(leakName(0)).toBe('封印完好');
    expect(leakName(5)).toBe('裂隙');
    expect(leakName(99)).toBeTruthy();
  });
});

describe('卡 H2 · 每日 tick 爬升（seed 确定性）', () => {
  it('leak 0→1→…：多数日子不动，长期必涨；爬升至 crisis 门自动置 leak_3 flag', () => {
    let rose = false;
    for (let i = 0; i < 400 && !rose; i++) {
      rng.seed(i * 17 + 2);
      core.S!.abyss!.leak = 0;
      abyssTick(core.S!);
      rose = core.S!.abyss!.leak === 1;
    }
    expect(rose).toBe(true);
    // 从 2 级爬到 3 级的那一次 tick 必置 leak_3（D4 crisis 触发门）
    let gated = false;
    for (let i = 0; i < 600 && !gated; i++) {
      rng.seed(i * 41 + 9);
      core.S!.abyss!.leak = 2;
      core.S!.player.flags.leak_3 = false;
      abyssTick(core.S!);
      const flagged: boolean = core.S!.player.flags.leak_3;
      gated = core.S!.abyss!.leak === 3 && flagged;
    }
    expect(gated).toBe(true);
  });
  it('leak=5 封顶：tick 不再涨', () => {
    const s = core.S!;
    s.abyss!.leak = 5;
    abyssTick(s);
    expect(s.abyss!.leak).toBe(5);
  });
});

describe('卡 H2 · 探查与封印', () => {
  it('探查消耗时辰；遭遇战或拾获皆不崩（combat 经 core）', () => {
    const s = core.S!;
    s.abyss!.leak = 2;
    const t0 = s.t;
    for (let i = 0; i < 10; i++) {
      rng.seed(i * 31 + 7);
      core.CB = null;
      probeAbyss();
      expect(s.t - t0).toBeGreaterThanOrEqual(8);
      const cb = core.CB as { over: boolean } | null; // 收束战斗分支（probeAbyss 可能新开战斗）
      if (cb) cb.over = true;
      core.CB = null;
    }
  });
  it('封印：leak≥3 + 封魔符 → leak 回落、声望上升、历史入档', () => {
    const s = core.S!;
    s.abyss!.leak = 3;
    addItem('seal_rune');
    const temple0 = s.rep.temple_life;
    const study0 = s.rep.study;
    sealAbyss();
    expect(s.abyss!.leak).toBe(2);
    expect(s.abyss!.sealed).toBe(1);
    expect(s.rep.temple_life).toBeGreaterThan(temple0);
    expect(s.rep.study).toBeGreaterThan(study0);
    expect(s.history.some((h) => h.c.includes('封印星渊'))).toBe(true);
  });
  it('无封魔符拒封', () => {
    const s = core.S!;
    s.abyss!.leak = 3;
    const lv0 = s.abyss!.leak;
    sealAbyss();
    expect(s.abyss!.leak).toBe(lv0);
  });
  it('leak<3 拒封（不浪费符）', () => {
    const s = core.S!;
    s.abyss!.leak = 2;
    addItem('seal_rune');
    sealAbyss();
    expect(s.abyss!.leak).toBe(2);
  });
});

describe('卡 H2 · D4 阴谋链级联（leak_1 → probe → crisis）', () => {
  it('abyss_leak_1(day30) → abyss_probe（study 情报≥1 自动满足）→ leak_3 门开 crisis；study↔shadow 敌意激化', () => {
    const s = core.S!;
    s.t = 30 * 48 + 4; // 第 31 日
    directorTick(s); // 先触发 leak_1
    expect(s.events.some((e) => e.id === 'abyss_leak_1')).toBe(true);
    // abyss_probe 需要 study.intelligence ≥1：leak_1 效果给了 +3 → 级联
    expect(s.events.some((e) => e.id === 'abyss_probe')).toBe(true);
    expect(standingBetween('study', 'shadow', 'hostility', s)).toBeGreaterThanOrEqual(20);
    // 置 leak_3 门 → crisis 级联
    s.player.flags.leak_3 = true;
    directorTick(s);
    expect(s.events.some((e) => e.id === 'abyss_crisis')).toBe(true);
    expect(s.player.flags.star6_unlocked).toBe(true);
  });
  it('事件定义齐备（数据驱动，不含未替换槽位）', () => {
    for (const id of ['abyss_leak_1', 'abyss_probe', 'abyss_crisis']) {
      const ev = ALL_EVENTS.find((e) => e.id === id);
      expect(ev, id).toBeTruthy();
      expect(ev!.seed).not.toMatch(/\{[^}]+\}/);
    }
  });
});

describe('卡 H2 · 迁移与铁律', () => {
  it('旧档（无 abyss 字段）hydrate 兜底不崩', () => {
    const s = core.S!;
    const legacy = JSON.parse(JSON.stringify(s)) as typeof s;
    delete (legacy as unknown as Record<string, unknown>).abyss;
    const h = hydrate(legacy);
    expect(h.abyss!.leak).toBe(0);
    expect(h.abyss!.sealed).toBe(0);
  });
  it('AI 不触星渊后果：abyss.ts 静态审计——不 import 任何 AI 层模块（叙事走 seed）', () => {
    const src = readFileSync(new URL('../systems/dungeon/Abyss.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/from '@\/ai/);
    expect(src).not.toMatch(/from '@\/plugins/);
  });
});
