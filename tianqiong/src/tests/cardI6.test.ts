/* ============================================================
   卡 I6 单测 · 头衔 · 声名（条件判定 · 授予幂等 · 隐藏 · 世界回应）
   确定性：种子随机 + 同步调度器 + 内存存档。
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { bus, core, importState, rng, scheduler } from '@/world';
import {
  condMet,
  evalTitles,
  fameDiscount,
  marshalGuardMul,
  primaryTitle,
  suppressCost,
  suppressTitle,
  titleById,
  titleDefs,
  titleScore,
  titleView,
  titleWord,
  titlesOf,
  visibleTitles,
} from '@/systems/reputation/Title';
import { newGame } from '@/world/WorldRuntime';
import { addItem, gainGold } from '@/systems/character/Gains';
import { buyPrice, openShop } from '@/systems/economy/Shop';
import { allLore } from '@/systems/codex/Codex';
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
  newGame({ name: '无名', race: 'human', cls: 'warrior' });
});

const S = () => core.S!;
const grant = (id: string) => {
  if (!S().titles!.includes(id)) S().titles!.push(id);
};

describe('卡 I6 · 称号数据与条件判定', () => {
  it('称号表 18 条（15 正 + 3 负），字段齐备', () => {
    const defs = titleDefs();
    expect(defs.length).toBe(18);
    expect(defs.filter((t) => t.negative).length).toBe(3);
    for (const t of defs) {
      expect(t.name.length, t.id).toBeGreaterThan(1);
      expect(t.desc.length, t.id).toBeGreaterThan(3);
      expect(t.react.length, t.id).toBeGreaterThan(3);
      expect(t.tier).toBeGreaterThanOrEqual(1);
    }
  });

  it('cond 判定：kills / level / gold / wanted / exiled 各一例', () => {
    const s = S();
    expect(condMet({ kind: 'kills', key: 'dragon', min: 1 }, s)).toBe(false);
    s.killed.dragon = 1;
    expect(condMet({ kind: 'kills', key: 'dragon', min: 1 }, s)).toBe(true);

    expect(condMet({ kind: 'level', min: 5 }, s)).toBe(false);
    s.player.level = 5;
    expect(condMet({ kind: 'level', min: 5 }, s)).toBe(true);

    expect(condMet({ kind: 'gold', min: 10000 }, s)).toBe(false);
    s.player.gold = 10000;
    expect(condMet({ kind: 'gold', min: 10000 }, s)).toBe(true);

    expect(condMet({ kind: 'wanted', min: 3 }, s)).toBe(false);
    s.player.wanted = 3;
    expect(condMet({ kind: 'wanted', min: 3 }, s)).toBe(true);

    expect(condMet({ kind: 'exiled' }, s)).toBe(false);
    s.legal!.exiledTo = 'wild';
    expect(condMet({ kind: 'exiled' }, s)).toBe(true);
  });

  it('cond 判定：flag / crime / abyss / dungeonBest / codexCount / craftLv / axis / academy', () => {
    const s = S();
    s.player.flags['shadow_ally'] = true;
    expect(condMet({ kind: 'flag', key: 'shadow_ally' }, s)).toBe(true);
    s.legal!.charges.push('heresy');
    expect(condMet({ kind: 'crime', key: 'heresy' }, s)).toBe(true);
    s.abyss!.sealed = 1;
    expect(condMet({ kind: 'abyss', key: 'sealed', min: 1 }, s)).toBe(true);
    s.dungeon!.best = 51;
    expect(condMet({ kind: 'dungeonBest', min: 50 }, s)).toBe(true);
    s.codex!.unlocked = allLore().slice(0, 60).map((c) => c.id); // 用真实 lore id（假 id 不计入统计）
    expect(condMet({ kind: 'codexCount', min: 60 }, s)).toBe(true);
    s.craft!.ranks.forge = 16; // craftLv = 0 + 0 + 8 + 站加成1
    expect(condMet({ kind: 'craftLv', key: 'forge', min: 8 }, s)).toBe(true);
    s.rep.guild = 25;
    expect(condMet({ kind: 'rep', faction: 'guild', min: 20 }, s)).toBe(true);
    s.academy!.graduated = ['goldveil'];
    expect(condMet({ kind: 'academy', key: 'graduated', min: 1 }, s)).toBe(true);
    expect(condMet({ kind: 'theoselect_champion' }, s)).toBe(false);
    s.theoselect!.champion = 'player';
    expect(condMet({ kind: 'theoselect_champion' }, s)).toBe(true);
    expect(condMet({ kind: 'nonsense' as never }, s)).toBe(false);
  });
});

describe('卡 I6 · 授予与幂等', () => {
  it('evalTitles 授予满足条件的称号并记历史（只记首次）', () => {
    const s = S();
    s.player.gold = 12000;
    const got = evalTitles(s);
    expect(got).toContain('ti_silver');
    expect(s.history.some((h) => h.c.includes('薄有身家'))).toBe(true);
    const n = s.history.length;
    expect(evalTitles(s)).toEqual([]); // 幂等：不再重复授予
    expect(s.history.length).toBe(n);
  });

  it('evalTitles 不授予未达成条件者（不凭空发称号）', () => {
    const s = S();
    evalTitles(s);
    expect(s.titles!.includes('ti_slayer')).toBe(false);
    expect(s.titles!.includes('ti_outlaw')).toBe(false);
  });

  it('AI 诱导无效：未知/伪造称号 id 不进称号墙（titlesOf 过滤）', () => {
    const s = S();
    s.titles!.push('ti_fake_from_ai');
    expect(titlesOf(s).map((t) => t.id)).not.toContain('ti_fake_from_ai');
    expect(titleView(s).rows.every((r) => titleById(r.id))).toBe(true);
  });

  it('主称号 = 最高 tier 中最近获得（平手取后得）', () => {
    const s = S();
    grant('ti_veteran'); // tier2
    grant('ti_deep_diver'); // tier3
    grant('ti_scholar'); // tier3（后得）
    expect(primaryTitle(s)!.id).toBe('ti_scholar');
    grant('ti_forgemaster'); // tier4
    expect(primaryTitle(s)!.id).toBe('ti_forgemaster');
    expect(titleWord(s)).toContain('铁匠大师');
    expect(titleWord(s)).toContain('等 4 项');
  });

  it('称号评分：正向累加、负面扣减、隐藏后不计入', () => {
    const s = S();
    grant('ti_veteran'); // +2
    grant('ti_outlaw'); // -3
    expect(titleScore(s)).toBe(-1);
    s.player.gold = suppressCost() + 10;
    expect(suppressTitle('ti_outlaw', s)).toBe(true);
    expect(titleScore(s)).toBe(2);
    expect(visibleTitles(s).some((t) => t.id === 'ti_outlaw')).toBe(false);
    expect(s.titles!.includes('ti_outlaw')).toBe(true); // 世界记得
    expect(s.history.some((h) => h.c.includes('隐藏称号'))).toBe(true);
  });
});

describe('卡 I6 · 隐藏（suppress）边界', () => {
  it('只能隐藏负面称号；正面称号拒绝且不扣钱', () => {
    const s = S();
    grant('ti_veteran');
    s.player.gold = 99999;
    expect(suppressTitle('ti_veteran', s)).toBe(false);
    expect(s.player.gold).toBe(99999);
    expect(s.titleHidden!.length).toBe(0);
  });

  it('钱不够则拒绝（隐藏是花钱的事，不能白洗）', () => {
    const s = S();
    grant('ti_outlaw');
    s.player.gold = suppressCost() - 1;
    expect(suppressTitle('ti_outlaw', s)).toBe(false);
    expect(s.titleHidden!.length).toBe(0);
    expect(s.player.gold).toBe(suppressCost() - 1);
  });

  it('未获得的称号无法隐藏；重复隐藏幂等', () => {
    const s = S();
    s.player.gold = 99999;
    expect(suppressTitle('ti_outlaw', s)).toBe(false);
    grant('ti_outlaw');
    expect(suppressTitle('ti_outlaw', s)).toBe(true);
    const gold = s.player.gold;
    expect(suppressTitle('ti_outlaw', s)).toBe(false);
    expect(s.player.gold).toBe(gold);
  });
});

describe('卡 I6 · 世界回应（折扣 / 盘查 / 视图）', () => {
  it('名望折让：主称号 tier ≥ 3 时买价 ×0.97', () => {
    const s = S();
    openShop('grocer');
    const p0 = buyPrice('grocer', 'bread');
    grant('ti_veteran'); // tier2：不折
    expect(buyPrice('grocer', 'bread')).toBe(p0);
    grant('ti_forgemaster'); // tier4：折
    const p1 = buyPrice('grocer', 'bread');
    expect(p1).toBeLessThanOrEqual(p0);
    expect(fameDiscount(s)).toBe(0.97);
  });

  it('军团长特权：盘查概率 ×0.5（称号被隐藏时同样生效——隐藏只抹称呼）', () => {
    const s = S();
    expect(marshalGuardMul(s)).toBe(1);
    grant('ti_field_marshal');
    expect(marshalGuardMul(s)).toBe(0.5);
  });

  it('titleView：18 行、已获得优先、主称号与分数自洽', () => {
    const s = S();
    grant('ti_veteran');
    const v = titleView(s);
    expect(v.rows.length).toBe(18);
    expect(v.rows[0].got).toBe(true);
    expect(v.primary).toBe('老练冒险者');
    expect(v.score).toBe(2);
    expect(v.hiddenCount).toBe(0);
  });

  it('旧档无 titles：hydrate 补空数组，首次跨日自动评估并回填', () => {
    const old = { ver: 1, player: { name: '旧人', gold: 20000 }, rep: {}, log: [] };
    expect(importState(JSON.stringify(old))).toBe(true);
    const s = S();
    expect(s.titles).toEqual([]);
    expect(s.titleHidden).toEqual([]);
    /* 跨日（time.newDay 钩子）：条件已满足 → 自动授予。
       直接走与 newDay 相同的评估出口（避免触发天气/事件噪声）。 */
    s.t = 47;
    s.t++;
    expect(s.t % 48).toBe(0);
    evalTitles(s);
    expect(s.titles!.includes('ti_silver')).toBe(true);
  });

  it('gainGold 到阈值后跨日评估能拿到称号（端到端口子）', () => {
    const s = S();
    gainGold(15000);
    addItem('bread', 1);
    evalTitles(s);
    expect(s.titles!.includes('ti_silver')).toBe(true);
  });
});
