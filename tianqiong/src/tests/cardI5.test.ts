/* ============================================================
   卡 I5 单测 · 文献图鉴（三条解锁途径 · 幂等 · 日限 · 反噬链条 · 跨卡咬合）
   确定性：种子随机 + 同步调度器 + 内存存档。
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { bus, core, rng, scheduler, importState } from '@/world';
import {
  CODEX_CATS,
  OBS_CAP,
  allLore,
  catOf,
  codexStats,
  codexView,
  codexUnlocked,
  deepTalkUnlock,
  loreById,
  matchByText,
  observeUnlock,
  readTome,
  tomeWeight,
  tryUnlock,
} from '@/systems/codex/Codex';
import { canCraft, craftRecipes } from '@/systems/inventory/Craft';
import { newGame } from '@/world/WorldRuntime';
import { addItem, itemCount } from '@/systems/character/Gains';
import { loadPersonLore, PERSON_LORE } from '@/data/lore';
import { WB } from '@/data/worldBook';
import { MemorySaveRepository } from '@/repo';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';

beforeEach(async () => {
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
  await loadPersonLore(); // 人物条目走懒加载：图鉴断言前先就位
  newGame({ name: '读者', race: 'human', cls: 'warrior' });
});

const S = () => core.S!;

describe('卡 I5 · 藏书数据与分类', () => {
  it('全量藏书 = setting + person，且分类表覆盖全部条目', () => {
    const all = allLore();
    expect(all.length).toBeGreaterThan(200);
    expect(PERSON_LORE.length).toBeGreaterThan(100);
    for (const c of all) expect(CODEX_CATS.includes(catOf(c)), c.id + '→' + catOf(c)).toBe(true);
  });

  it('catOf：人物卡片归"人物"，星枢/位面/技艺主题各自归位', () => {
    const person = PERSON_LORE[0];
    expect(catOf(person)).toBe('人物');
    expect(catOf(loreById('s1')!)).toBe('位面');
    expect(catOf(loreById('s36')!)).toBe('技艺');
    expect(catOf(loreById('s71')!)).toBe('地理');
  });

  it('codexStats 计数与实际解锁一致（防图鉴数虚高）', () => {
    const st0 = codexStats();
    expect(st0.total).toBe(allLore().length);
    expect(st0.unlocked).toBe(0);
    tryUnlock('s1', '测试');
    const st1 = codexStats();
    expect(st1.unlocked).toBe(1);
    expect(st1.pct).toBeCloseTo(1 / st0.total, 6);
  });

  it('matchByText：命中关键词返回相关条目，空文本返回空', () => {
    expect(matchByText('')).toEqual([]);
    expect(matchByText('完全没有的词')).toEqual([]);
    const hit = matchByText('星髓与星枢残片');
    expect(hit.length).toBeGreaterThan(0);
    expect(hit.every((c) => c.keywords.some((k) => '星髓与星枢残片'.includes(k)))).toBe(true);
  });
});

describe('卡 I5 · 解锁（幂等 · 日限 · 三条途径）', () => {
  it('tryUnlock 幂等：同 id 不重复发奖、不重复记 found', () => {
    expect(tryUnlock('s1', '首次')).toBe(true);
    expect(tryUnlock('s1', '再次')).toBe(false);
    expect(S().codex!.found.s1).toBe(1);
    expect(S().codex!.unlocked.filter((x) => x === 's1').length).toBe(1);
    expect(tryUnlock('不存在的条目', '测试')).toBe(false);
  });

  it('observeUnlock：命中即解锁，且每地点每日上限 ' + OBS_CAP + ' 条', () => {
    const text = allLore().slice(0, 12).map((c) => c.keywords[0]).join(' ');
    const n = observeUnlock(text, 'plaza');
    expect(n).toBeLessThanOrEqual(OBS_CAP);
    /* 同日同地再观察：配额已满 → 0 */
    expect(observeUnlock(text, 'plaza')).toBe(0);
    /* 换地点：配额重新计（不同地点各自计数） */
    S().codex!.unlocked = [];
    expect(observeUnlock(text, 'market')).toBeGreaterThan(0);
  });

  it('observeUnlock：跨日后配额重置', () => {
    const text = allLore().slice(0, 12).map((c) => c.keywords[0]).join(' ');
    observeUnlock(text, 'plaza');
    S().t += 48 * 2; // 两天后
    S().codex!.unlocked = [];
    expect(observeUnlock(text, 'plaza')).toBeGreaterThan(0);
  });

  it('readTome：解锁该类目序号最小的未读，并消耗一册', () => {
    addItem('tome_abyss', 2);
    expect(readTome('tome_abyss')).toBe(true);
    expect(itemCount('tome_abyss', S())).toBe(1);
    const first = S().codex!.unlocked[0];
    expect(catOf(loreById(first)!)).toBe('星渊');
    /* 第二册：同类目下一条（序号更大） */
    expect(readTome('tome_abyss')).toBe(true);
    expect(itemCount('tome_abyss', S())).toBe(0);
    expect(S().codex!.unlocked.length).toBe(2);
  });

  it('readTome：类目读尽时不消耗、不崩', () => {
    /* 先读完"星渊"全类目 */
    let guard = 0;
    while (readTome('tome_abyss') && guard++ < 80) addItem('tome_abyss', 1);
    const before = itemCount('tome_abyss', S());
    expect(readTome('tome_abyss')).toBe(false);
    expect(itemCount('tome_abyss', S())).toBe(before);
  });

  it('readTome：非文献物品直接拒', () => {
    expect(readTome('bread')).toBe(false);
  });

  it('deepTalkUnlock：与 NPC 深谈解锁其人条目（幂等）', () => {
    /* 2026-09 · NPC 规模化改名：街头三人（莉塔→莉安／加隆→戈林／米娅→米露）让名给
       档案人物之后，本用例原先依赖的「酒馆老板娘与翠冠议会首领重名」这层巧合断开了。
       那本就是错配——名字撞上的是几百年前的另一个人。canon 人物（lore 109 人）尚未
       全部作为可交互 NPC 接入 WB.npcs，故此处注入一名同名探针，
       只验证「名字命中 canon → 解锁」这条链路本身，不依赖任何街头 NPC 的取名。 */
    const target = PERSON_LORE.find((c) => c.name === '莉塔');
    expect(target, '莉塔的人物条目应存在').toBeTruthy();
    const probe = '__lore_probe';
    const npcs = WB.npcs as unknown as Record<string, typeof WB.npcs.lita>;
    npcs[probe] = { ...npcs.lita, name: '莉塔' };
    try {
      expect(deepTalkUnlock(probe)).toBe(true);
      expect(codexUnlocked(target!.id)).toBe(true);
      expect(deepTalkUnlock(probe)).toBe(false);
    } finally {
      delete npcs[probe];
    }
    expect(deepTalkUnlock('不存在的人')).toBe(false);
  });
});

describe('卡 I5 · 视图契约与跨卡咬合', () => {
  it('codexView：未解锁只给线索、已解锁给正文，分类计数自洽', () => {
    const v0 = codexView('', S());
    expect(v0.rows.length).toBe(allLore().length);
    expect(v0.rows.every((r) => !r.unlocked && r.text === '')).toBe(true);
    expect(v0.rows.every((r) => r.hint.length > 0)).toBe(true); // 无关键词条目回落"尚无线索"
    tryUnlock('s1', '测试');
    const v1 = codexView('位面', S());
    expect(v1.rows.every((r) => r.cat === '位面')).toBe(true);
    const row = v1.rows.find((r) => r.id === 's1')!;
    expect(row.unlocked).toBe(true);
    expect(row.text.length).toBeGreaterThan(0);
    const sum = v1.cats.reduce((a, c) => a + c.total, 0);
    expect(sum).toBeGreaterThan(0);
    expect(v1.cats.every((c) => c.have <= c.total)).toBe(true);
  });

  it('缺口文案：canon 与 seed 都为空的条目回落"残卷"标记', () => {
    /* 不等数据里正好出现空条目：121 条 lore 全都有内容，原来那句 `if (!empty) return`
       让这条用例永远绿灯零覆盖（审查 §假通过）——而它瞄准的分支在生产代码里是活的
       （Codex.ts 的 c.canon || c.seed || '（残卷，字迹已不可辨）'）。
       改成临时把一条真实条目清空再验，finally 恢复，避免污染同进程的其他用例。 */
    const card = allLore()[0];
    const saved = { canon: card.canon, seed: card.seed };
    card.canon = '';
    card.seed = '';
    try {
      tryUnlock(card.id, '测试');
      const row = codexView('', S()).rows.find((r) => r.id === card.id)!;
      expect(row.text, 'canon 与 seed 都空时必须回落残卷文案').toContain('残卷');
    } finally {
      card.canon = saved.canon;
      card.seed = saved.seed;
    }
  });

  it('I2 咬合：needCodex 未解锁 → 配方被拒；解锁后 → 放行', () => {
    const s = S();
    addItem('star_marrow', 2);
    addItem('blade_blank', 1);
    addItem('platinum', 1);
    s.player.gold = 99999;
    s.craft!.ranks.forge = 20;
    const r = craftRecipes().find((x) => x.needCodex)!;
    expect(r.id).toBe('rc_star_blade');
    expect(canCraft(r, s).ok).toBe(false);
    expect(canCraft(r, s).why).toContain('文献');
    tryUnlock(r.needCodex!, '测试');
    expect(canCraft(r, s).ok).toBe(true);
  });

  it('tomeWeight：完成度 <30% ×0.6；>80% ×1.5；区间内 ×1', () => {
    expect(tomeWeight()).toBeCloseTo(0.6, 6);
    const all = allLore();
    S().codex!.unlocked = all.slice(0, Math.ceil(all.length * 0.31)).map((c) => c.id);
    expect(tomeWeight()).toBe(1);
    S().codex!.unlocked = all.slice(0, Math.ceil(all.length * 0.81)).map((c) => c.id);
    expect(tomeWeight()).toBe(1.5);
  });

  it('旧档无 codex 字段：导入后 hydrate 补默认、全站不崩', () => {
    const old = { ver: 1, player: { name: '旧人', gold: 100 }, rep: {}, log: [] };
    expect(importState(JSON.stringify(old))).toBe(true);
    expect(S().codex).toEqual({ unlocked: [], found: {} });
    expect(codexStats().unlocked).toBe(0);
    expect(codexView('', S()).rows.length).toBe(allLore().length);
  });
});
