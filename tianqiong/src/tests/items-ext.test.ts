/* ============================================================
   卡 N1 · 道具扩展（批 1「地脉」）验收
   ------------------------------------------------------------
   这一批真正的风险不在数据量，而在四件事：
     1) 分表聚合会不会动到既有 id 顺序（Object.keys(WB.items)[0] 是全项目的取基准写法）
     2) 新材料会不会变成"没有配方的孤儿"（cardF2 用精确断言钉住过这条）
     3) 新装备配方会不会开出无限套利（balance 的成本护栏）
     4) 效果字段 eff 会不会只是数据里的装饰——战斗里点下去什么也不发生
   前三条是既有护栏的复现，第四条是这批唯一的机制新增，必须真的打一仗验证。
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { bus, core, rng, scheduler } from '@/world';
import { newGame } from '@/world/WorldRuntime';
import { combatUseItem, startCombat, useItem } from '@/systems/combat/Combat';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';
import { MemorySaveRepository } from '@/repo';
import { addItem, itemCount } from '@/systems/character/Gains';
import { atkB } from '@/systems/character/Derived';
import { negativeStatusIds, statusDef, statusIds } from '@/systems/character/Status';
import { instPrice, rollInstance } from '@/systems/inventory/Equip';
import { craftRecipes } from '@/systems/inventory/Craft';
import { priceOf } from '@/systems/economy/Economy';
import { TRAP_DC_CUT_MAX, TRAP_DC_PER_TAG, corruptionShield, toolTags, trapDcCut, trapOf } from '@/systems/dungeon/Dungeon';
import { readTome } from '@/systems/codex/Codex';
import { advance } from '@/world/WorldClock';
import { bagActionOf, bagCatOf, bagRowOf } from '@/ui/panels/inventoryView';
import { WB } from '@/data/worldBook';
import itemsExt from '@/data/world/items.json';
import tablesRaw from '@/data/world/tables.json';
import dungeonRaw from '@/data/world/dungeon.json';
import peopleRaw from '@/data/world/people.json';
import blocklistRaw from '@/data/naming/blocklist.json';
import type { ItemDef, StatusId } from '@/types/world';

const EXT = itemsExt.items as unknown as Record<string, ItemDef>;
const TABLES = tablesRaw as unknown as { items: Record<string, ItemDef> };
const FLOORS = (dungeonRaw as unknown as { floors: { id: number; loot: string[] }[] }).floors;
const EXT_IDS = new Set(Object.keys(EXT));
const POSITIVE = ['fervor', 'bastion', 'swift', 'oracle'] as StatusId[];

beforeEach(() => {
  core.S = null;
  core.CB = null;
  bus.clear();
  setSavePort(new MemorySaveRepository());
  setAiPort(ruleSim);
  rng.seed(77);
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  newGame({ name: '地脉', race: 'human', cls: 'warrior' });
});

describe('卡 N1 · 分表聚合', () => {
  it('既有 49 件的 id 顺序逐位不动，扩展件全部排在后面', () => {
    const base = Object.keys(TABLES.items);
    const all = Object.keys(WB.items);
    expect(all.slice(0, base.length)).toEqual(base);
    expect(all.length).toBe(base.length + Object.keys(EXT).length);
  });

  it('每件都有名称、像样的描述、合法 type 与非负价', () => {
    for (const [id, it] of Object.entries(EXT)) {
      expect(it.name.length, id + ' 没有名字').toBeGreaterThan(0);
      expect(it.desc.length, id + ' 的描述太短，等于没有').toBeGreaterThan(6);
      expect(['wpn', 'arm', 'use', 'mat'], id).toContain(it.type);
      expect(it.price, id).toBeGreaterThanOrEqual(0);
      if (it.type === 'wpn') {
        expect(it.dmg, id + ' 是武器却没有伤害骰').toBeTruthy();
        expect(it.atk, id).toBeGreaterThan(0);
        expect(it.tier, id).toBeGreaterThanOrEqual(1);
        expect(it.tier, id).toBeLessThanOrEqual(5);
      }
    }
  });
});

describe('卡 N1 · 效果字段的数据契约', () => {
  it('kind 合法，status 必须真实存在于状态表（防幽灵引用）', () => {
    const ids = new Set<string>(statusIds());
    for (const [id, it] of Object.entries(EXT)) {
      for (const e of it.eff ?? []) {
        expect(['heal', 'mp', 'cure', 'dot', 'buff'], id + ' 的 ' + e.kind).toContain(e.kind);
        if (e.status) expect(ids.has(e.status), id + ' 引用了不存在的状态 ' + e.status).toBe(true);
        if (e.chance !== undefined) expect(e.chance, id).toBeGreaterThan(0);
      }
    }
  });

  it('战斗专属道具必须有 eff——否则它在战斗里点下去什么也不会发生', () => {
    for (const [id, it] of Object.entries(EXT)) {
      if (it.combat) expect((it.eff ?? []).length, id + ' 标了 combat 却没有效果').toBeGreaterThan(0);
    }
  });

  it('四种正面态入表，且不被负面判定误收', () => {
    for (const id of POSITIVE) {
      expect(statusDef(id), id + ' 没进状态表').toBeTruthy();
      expect(negativeStatusIds(), id + ' 被当成负面态了').not.toContain(id);
    }
    for (const id of ['burn', 'bleed', 'freeze', 'stun', 'slow', 'vuln'] as StatusId[]) {
      expect(negativeStatusIds(), id + ' 从负面集里掉了').toContain(id);
    }
  });

  it('在行囊里有「使用」动作（有动作才是它存在的意义）', () => {
    for (const [id, it] of Object.entries(EXT)) {
      if (it.type !== 'use' || it.codexCat) continue;
      /* 工具是「带着它」不是「用它」——被动生效的东西在背包里没有动作，只有说明 */
      if (it.utility?.length) continue;
      expect(bagActionOf(it), id).toBe('使用');
    }
  });
});

describe('卡 N1 · 效果真的落地（打一仗）', () => {
  it('buff：锋锐香挂上锋锐，攻击加值随之上升', () => {
    startCombat(['wolf']);
    addItem('incense_fervor');
    const before = atkB();
    combatUseItem('incense_fervor');
    expect(core.CB!.status?.some((x) => x.id === 'fervor'), '状态没挂上').toBe(true);
    expect(atkB(), '状态挂了但数值没动 = 只是装饰').toBeGreaterThan(before);
  });

  it('dot：引火油把燃烧按到敌人头上', () => {
    startCombat(['wolf']);
    addItem('oil_flame');
    combatUseItem('oil_flame');
    expect(core.CB!.foes[0].status?.some((x) => x.id === 'burn'), '敌人没中燃烧').toBe(true);
  });

  it('cure：净毒散洗掉自己身上的燃烧', () => {
    startCombat(['wolf']);
    core.CB!.status = [{ id: 'burn', dur: 3, power: 4, stack: 1 }];
    addItem('antidote_pure');
    combatUseItem('antidote_pure');
    expect(core.CB!.status.some((x) => x.id === 'burn')).toBe(false);
  });

  it('涤心盐：默认净化全部负面态，但不误伤自己的增益', () => {
    startCombat(['wolf']);
    core.CB!.status = [
      { id: 'burn', dur: 3, power: 4, stack: 1 },
      { id: 'bleed', dur: 3, power: 3, stack: 1 },
      { id: 'fervor', dur: 3, power: 0, stack: 1 },
    ];
    addItem('salt_clear');
    combatUseItem('salt_clear');
    const left = core.CB!.status.map((x) => x.id);
    expect(left, '负面态没洗掉').not.toContain('burn');
    expect(left).not.toContain('bleed');
    expect(left, '把玩家的增益一起洗了').toContain('fervor');
  });

  it('使用后扣一剂（战斗内的消耗由 core 记）', () => {
    const s = core.S!;
    startCombat(['wolf']);
    addItem('draught_bastion', 2);
    const have = itemCount('draught_bastion', s);
    combatUseItem('draught_bastion');
    expect(itemCount('draught_bastion', s)).toBe(have - 1);
    expect(core.CB!.status?.some((x) => x.id === 'bastion')).toBe(true);
  });

  it('没有这件东西时一律拒绝（core 权威，不信任 UI 的可用态）', () => {
    const s = core.S!;
    startCombat(['wolf']);
    s.player.hp = 1;
    combatUseItem('tonic_ironblood');
    expect(s.player.hp, '没有药也能凭空回血').toBe(1);
    expect(core.CB!.status?.length ?? 0).toBe(0);
  });

  it('战斗外使用战斗专属道具：不消耗、给明确指引', () => {
    const s = core.S!;
    addItem('incense_fervor');
    const have = itemCount('incense_fervor', s);
    useItem('incense_fervor');
    expect(itemCount('incense_fervor', s), '战斗外不该吃掉它').toBe(have);
  });

  it('旧药剂路径逐位不变：potion_moon 仍走 heal 单效果', () => {
    const s = core.S!;
    startCombat(['wolf']);
    s.player.hp = 1;
    addItem('potion_moon');
    combatUseItem('potion_moon');
    expect(s.player.hp).toBeGreaterThan(1);
    expect(core.CB!.status?.length ?? 0, '旧道具不该产生任何状态').toBe(0);
  });
});

describe('卡 N1 · 材料闭环（复用 cardF2 的孤儿口径）', () => {
  it('每一件有价材料都被至少一条配方消费', () => {
    const used = new Set<string>();
    for (const r of craftRecipes()) for (const [iid] of r.need.items) used.add(iid);
    /* price 0 的是剧情物（信物 / 文书 / 钥匙）——它们的去处是委托与门锁，不是工坊 */
    const orphan = Object.entries(EXT)
      .filter(([, v]) => v.type === 'mat' && v.price > 0)
      .map(([k]) => k)
      .filter((k) => !used.has(k));
    expect(orphan, '这些新材料没有任何配方要用它').toEqual([]);
  });

  it('每一件新材料都有来源（掉落 / 商路 / 委托报酬）', () => {
    const dropped = new Set<string>();
    for (const f of FLOORS) for (const x of f.loot) dropped.add(x);
    const onShelf = new Set(Object.values(WB.shops).flatMap((sh) => sh.stock));
    const quests = JSON.stringify((peopleRaw as unknown as { quests?: unknown }).quests ?? {});
    for (const [id, it] of Object.entries(EXT)) {
      if (it.type !== 'mat') continue;
      /* 三种活法都是活法：地下城材料刷得到、大陆特产商路买得到、
         剧情信物由委托交到手里。把它们压成一条口径，就是逼着剧情物去货架上站着。 */
      const ok = dropped.has(id) || onShelf.has(id) || quests.includes('"' + id + '"');
      expect(ok, id + ' 既不掉不卖，也不在任何委托里').toBe(true);
    }
  });

  it('没有重名（全库 254 件：名字是玩家唯一能抓住的识别符）', () => {
    const seen = new Map<string, string>();
    const dup: string[] = [];
    /* 注意 TABLES 是 { items } 包装对象——展开它本身会多出一个没有 name 的条目，
       于是每个 undefined 都"重名"。这里要展开的是它里面的那张表。 */
    for (const [id, it] of Object.entries({ ...TABLES.items, ...EXT })) {
      if (seen.has(it.name)) dup.push(it.name + '（' + seen.get(it.name) + ' / ' + id + '）');
      else seen.set(it.name, id);
    }
    expect(dup, '同名的两件东西，玩家分不清该带哪一件').toEqual([]);
  });

  it('没有踩到命名雷区（脏话与敏感词）', () => {
    const words = ((blocklistRaw as unknown as { words?: string[] }).words ?? []).filter((w) => typeof w === 'string' && w.length >= 2);
    expect(words.length, '避雷表空了，说明读错了文件').toBeGreaterThan(0);
    for (const [id, it] of Object.entries(EXT)) {
      const hay = it.name + '｜' + it.desc;
      for (const w of words) expect(hay.includes(w), id + ' 踩到禁词「' + w + '」').toBe(false);
    }
  });

  it('tier 全部落在 1–5（rollInstance 会夹取，越界就是白写）', () => {
    for (const [id, it] of Object.entries(EXT)) {
      if (it.tier === undefined) continue;
      expect(it.tier, id).toBeGreaterThanOrEqual(1);
      expect(it.tier, id).toBeLessThanOrEqual(5);
    }
  });

  it('剧情物不上货架', () => {
    /* price 0 的东西进 stock，玩家会以 1 铜把它买走——而它的价值本来在剧情里。
       这是负向守卫：以后谁手滑把信物补进货架，这里会先亮。 */
    const onShelf = new Set(Object.values(WB.shops).flatMap((sh) => sh.stock));
    const plot = Object.entries(EXT).filter(([, v]) => v.type === 'mat' && v.price === 0);
    expect(plot.length, '一件剧情物都没扫到，说明筛选写错了').toBeGreaterThan(0);
    for (const [id] of plot) expect(onShelf.has(id), id + ' 被摆上了货架').toBe(false);
  });

  it('新配方引用的材料与产出全部存在，数量为正整数', () => {
    for (const r of craftRecipes()) {
      for (const [iid, q] of r.need.items) {
        expect(WB.items[iid], r.id + ' 的材料 ' + iid).toBeTruthy();
        expect(Number.isInteger(q) && q > 0, r.id + ' 的 ' + iid).toBe(true);
      }
      if (r.out.base) expect(WB.items[r.out.base], r.id).toBeTruthy();
      if (r.out.item) expect(WB.items[r.out.item], r.id).toBeTruthy();
    }
  });
});

describe('卡 N1 · 经济护栏（复现 balance 的算法，只跑扩展装备）', () => {
  it('新装备配方的期望产出价 ≤ 材料成本 × 8', () => {
    const S = () => core.S!;
    let checked = 0;
    for (const r of craftRecipes()) {
      if (!r.out.base || !EXT_IDS.has(r.out.base)) continue;
      checked++;
      let cost = r.need.gold;
      for (const [iid, q] of r.need.items) cost += priceOf(iid, 'plaza', S()) * q;
      const tier = r.out.tier || r.tier;
      const back = rng.seed(31 + r.tier);
      let sum = 0;
      for (let i = 0; i < 60; i++) sum += instPrice(rollInstance(r.out.base, tier, 0), S());
      back();
      const avg = sum / 60;
      expect(avg, r.id + ' 成本' + cost + ' 期望产出价' + Math.round(avg)).toBeLessThanOrEqual(cost * 8);
    }
    expect(checked, '一条扩展装备配方都没跑到，说明筛选写错了').toBeGreaterThan(0);
  });

  it('武器价目随 tier 单调不降（防手滑写错量级）', () => {
    const wpns = Object.entries(EXT)
      .filter(([, v]) => v.type === 'wpn')
      .sort((a, b) => (a[1].tier ?? 1) - (b[1].tier ?? 1));
    for (let i = 1; i < wpns.length; i++) {
      const prev = wpns[i - 1][1];
      const cur = wpns[i][1];
      if ((cur.tier ?? 1) === (prev.tier ?? 1)) continue;
      expect(cur.price, cur.name + ' 比低一档的 ' + prev.name + ' 还便宜').toBeGreaterThan(prev.price);
    }
  });
});

/* ============================================================
   批 2「行装」：探索工具与陷阱的咬合
   ------------------------------------------------------------
   工具的机制只有一条——持有对应标签的工具时，陷阱判定难度下降。
   这条链最容易断的地方不是算法，是**数据**：标签拼错、陷阱没有对应工具、
   工具有标签却没有出处。三者都不会让测试变红，只会让玩家带着一盏灯走进
   一条永远不生效的走廊。所以这里逐条钉住。
   ============================================================ */
describe('卡 N1 · 批 2 探索工具', () => {
  const TAG_SET = ['light', 'rope', 'breathe', 'ward', 'detect', 'blade', 'warm'];
  const TOOLS = () => Object.entries(EXT).filter(([, v]) => (v.utility ?? []).length > 0);

  it('工具标签都在允许集合内（拼错一个字母就是永远不生效的装饰）', () => {
    let n = 0;
    for (const [id, it] of TOOLS()) {
      n++;
      for (const t of it.utility ?? []) expect(TAG_SET, id + ' 的标签 ' + t).toContain(t);
    }
    expect(n, '一件工具都没扫到，说明筛选写错了').toBeGreaterThan(0);
  });

  it('每一种陷阱都至少有一种工具能化解（不留无解的坑）', () => {
    const owned = new Set<string>();
    for (const [, it] of TOOLS()) for (const t of it.utility ?? []) owned.add(t);
    const traps = (dungeonRaw as unknown as { traps: { id: string; tags?: string[] }[] }).traps;
    expect(traps.length).toBeGreaterThan(0);
    for (const t of traps) {
      expect((t.tags ?? []).length, t.id + ' 没有任何应对标签').toBeGreaterThan(0);
      expect(
        (t.tags ?? []).some((x) => owned.has(x)),
        t.id + ' 的应对标签 [' + (t.tags ?? []).join(',') + '] 没有任何一件工具带着',
      ).toBe(true);
    }
  });

  it('每一件工具都有出处（配方产出或商店上架）', () => {
    const crafted = new Set(craftRecipes().map((r) => r.out.item).filter(Boolean) as string[]);
    const onShelf = new Set(Object.values(WB.shops).flatMap((sh) => sh.stock));
    for (const [id] of TOOLS()) {
      expect(crafted.has(id) || onShelf.has(id), id + ' 无处可得').toBe(true);
    }
  });

  it('工具落在行囊「补给」类，且背包里的说明是「探索时自动生效」', () => {
    const s = core.S!;
    for (const [id, it] of TOOLS()) {
      expect(bagCatOf(it), id).toBe('补给');
      const row = bagRowOf({ id, qty: 1 }, s);
      expect(row.act, id + ' 是工具，不该有背包动作').toBeNull();
      expect(row.hint, id + ' 的说明没告诉玩家它怎么用').toContain('自动生效');
    }
  });

  it('持有工具真的降低陷阱 DC，且同标签不叠加、最多两道', () => {
    const s = core.S!;
    const pit = trapOf('pit')!;
    expect(trapDcCut(pit, s), '空手不该有减免').toBe(0);

    addItem('lamp_moss'); // light
    expect(trapDcCut(pit, s)).toBe(TRAP_DC_PER_TAG);
    addItem('jar_glow'); // 还是 light
    expect(trapDcCut(pit, s), '同标签不叠加').toBe(TRAP_DC_PER_TAG);
    addItem('piton_iron'); // rope
    expect(trapDcCut(pit, s, ), '两道标签到顶').toBe(TRAP_DC_CUT_MAX);
    addItem('rope_wormsilk'); // 又是 rope
    expect(trapDcCut(pit, s), '超出上限不再涨').toBe(TRAP_DC_CUT_MAX);
  });

  it('无关工具不降 DC——蛛网只认刀', () => {
    const s = core.S!;
    const web = trapOf('webbing')!;
    addItem('lamp_moss');
    expect(trapDcCut(web, s), '照明照不出粘丝').toBe(0);
    addItem('knife_web');
    expect(trapDcCut(web, s)).toBe(TRAP_DC_PER_TAG);
  });

  it('护符与暖具挡住深层魔气（侵蚀减半的判定）', () => {
    const s = core.S!;
    expect(corruptionShield(s), '空手进深层该被侵蚀').toBe(false);
    addItem('lamp_moss');
    expect(corruptionShield(s), '一盏灯挡不住魔气').toBe(false);
    addItem('charm_ward'); // ward
    expect(corruptionShield(s)).toBe(true);
  });

  it('标签集是去重的（带三盏灯不比带一盏灯更亮）', () => {
    const s = core.S!;
    addItem('lamp_moss');
    addItem('jar_glow');
    addItem('lantern_star'); // light + detect
    const tags = [...toolTags(s)];
    expect(tags.filter((x) => x === 'light').length).toBe(1);
    expect(tags).toContain('detect');
  });
});

/* ============================================================
   批 3「风土」：食物、特产与卷册
   ------------------------------------------------------------
   这一批第一次让玩家身上有了**持久状态**（player.effects）。链路是三段：
   吃下去 → 写进世界级状态（按刻）→ 开战时被 carryOverStatus 接住（按回合）。
   每一段都必须有断言：断在中间任意一段，食物就退化回「回一点血」。
   ============================================================ */
describe('卡 N1 · 批 3 食物与持续效果', () => {
  const FOODS = () => Object.entries(EXT).filter(([, v]) => v.type === 'use' && !v.codexCat && !v.combat && !v.utility && (v.eff ?? []).length > 0);

  it('食物与饮品都是战斗外可用的（没有 combat 标记）', () => {
    const list = FOODS();
    expect(list.length, '一件食物都没扫到').toBeGreaterThan(0);
    for (const [id, it] of list) {
      expect(it.combat, id + ' 标成了战斗专属').toBeFalsy();
      expect(bagActionOf(it), id).toBe('使用');
    }
  });

  it('喝一杯麦酒：魔力真的涨了（mp 效果是这一批新开的通道）', () => {
    const s = core.S!;
    s.player.mp = 0;
    addItem('drink_ale');
    useItem('drink_ale');
    expect(s.player.mp, '魔力没涨').toBeGreaterThan(0);
  });

  it('吃一碗菌汤：世界级状态落在 player.effects 上，并按刻计时', () => {
    const s = core.S!;
    addItem('food_mushroom_soup');
    useItem('food_mushroom_soup');
    const got = s.player.effects?.find((e) => e.id === 'bastion');
    expect(got, '食物没有写进世界级状态').toBeTruthy();
    expect(got!.left, '没有记时长就是永远不会过期').toBe(20);
  });

  it('时钟每走一刻，身上的状态就少一刻；走完自动消失', () => {
    const s = core.S!;
    addItem('food_mushroom_soup');
    useItem('food_mushroom_soup');
    advance(5);
    expect(s.player.effects?.find((e) => e.id === 'bastion')?.left, '时钟没有递减世界级状态').toBe(15);
    advance(20);
    expect(s.player.effects?.some((e) => e.id === 'bastion'), '过期了还挂在身上').toBe(false);
  });

  it('吃一顿好的再下地：开战时身上的状态被接住', () => {
    const s = core.S!;
    addItem('food_spice_roast'); // 香料烤肉 → 锋锐
    useItem('food_spice_roast');
    expect(s.player.effects?.some((e) => e.id === 'fervor'), '前置：烤肉没留下状态').toBe(true);
    startCombat(['wolf']);
    expect(core.CB!.status?.some((x) => x.id === 'fervor'), '世界级状态没有带进战斗').toBe(true);
  });

  it('没吃东西时开战不会凭空多出状态', () => {
    startCombat(['wolf']);
    expect(core.CB!.status?.length ?? 0).toBe(0);
  });
});

describe('卡 N1 · 批 3 卷册补上的两个空类目', () => {
  const TOMES = () => Object.entries(EXT).filter(([, v]) => !!v.codexCat);

  it('新卷册只落在「地理」与「典籍」两类——这两类此前没有任何卷册读得到', () => {
    let n = 0;
    for (const [id, it] of TOMES()) {
      n++;
      expect(['地理', '典籍'], id + ' 落在了 ' + it.codexCat).toContain(it.codexCat);
    }
    expect(n).toBeGreaterThanOrEqual(16);
  });

  it('每一本卷册都能真的读到一条未读藏书（不空转）', () => {
    const s = core.S!;
    for (const [id] of TOMES()) {
      addItem(id);
      expect(readTome(id, s), id + ' 读出来是空的——类目里已经没有未读条目了').toBe(true);
    }
  });

  it('卷册在行囊里的动作是「研读」而不是「使用」', () => {
    for (const [id, it] of TOMES()) expect(bagActionOf(it), id).toBe('研读');
  });
});
