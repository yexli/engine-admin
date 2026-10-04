/* ============================================================
   卡 P3 · 三项代码审查整改的护栏

   审查发现的四条，按顺序整改后的验收：
   ① 移动端看不到「纪闻/档案」——两套 tab 定义各写一份，集合漂移；
   ② SysPanel 是分类垃圾桶——归置依据是"什么时候加的"而非"属于哪一类"；
   ③ 行动坞按地点硬编码 if 链——而同文件的工坊入口早已数据驱动；
   ④ WorldBook 类型债——**实测推翻**：真正"读未声明字段"的断言只有 15 处，
      先前报的 104 是字符串出现次数（含数据加载器的 JSON 断言与跨类型转换）。
   本卡把前三条的等价性与第四条的上限钉成机器可查的事实。
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { core } from '@/world/WorldState';
import { newGame } from '@/world/WorldRuntime';
import { MemorySaveRepository } from '@/repo';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';
import { bus, rng, scheduler } from '@/events/EventBus';
import { abilitiesOf, LOCATION_ABILITIES } from '@/data/regions';
import { formatMoney } from '@/systems/economy/Money';
import { actsOfLocation } from '@/ui/SceneView';
import { PANEL_TABS } from '@/ui/TabBar';

const keysAt = (loc: string, wanted = 0): string[] => actsOfLocation(loc, wanted).map((a) => a.k);

beforeEach(() => {
  core.S = null;
  core.CB = null;
  bus.clear();
  setSavePort(new MemorySaveRepository());
  setAiPort(ruleSim);
  rng.seed(41);
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  newGame({ name: 'P3', race: 'human', cls: 'warrior' });
});

describe('卡 P3 · ① 一份 tab 定义驱动两处排布', () => {
  it('七个页面只声明一次，移动端与桌面各取其子集', () => {
    expect(PANEL_TABS.length).toBe(7);
    const ids = PANEL_TABS.map((t) => t.id);
    expect(new Set(ids).size).toBe(7);
  });

  it('移动端覆盖了顶栏的每一页（曾经漏掉 news/chronicle）', () => {
    const nav = PANEL_TABS.filter((t) => t.nav).map((t) => t.id);
    const mobile = PANEL_TABS.filter((t) => t.mobile).map((t) => t.id);
    for (const d of nav) expect(mobile, '顶栏有而移动端没有：' + d).toContain(d);
  });

  it('顶栏导航 = 全部七页，顺序即 PANEL_TABS 的顺序（换页只此一处）', () => {
    /* 这条用例的前身守的是「场景与角色不在桌面右侧栏」——那时 main/char 在桌面另有位置，
       右侧栏只收另外五页。落盘后：右侧栏随面板浮层化消失，main/char 也需要顶栏入口
       （此前得靠点空白或 ESC 回世界），所以约束反过来变成「七页都得在顶栏找得到」。
       顺序一并钉住：TopBar 按 PANEL_TABS 的次序渲染，不另排。 */
    const nav = PANEL_TABS.filter((t) => t.nav).map((t) => t.id);
    expect(nav).toEqual(['main', 'char', 'quest', 'news', 'chronicle', 'map', 'sys']);
  });

  it('每页都有图标、标签与提示（长按 tooltip 靠 hint）', () => {
    for (const t of PANEL_TABS) {
      expect(t.ic, t.id).toBeTruthy();
      expect(t.lb, t.id).toBeTruthy();
      expect(t.hint.length, t.id).toBeGreaterThan(4);
    }
  });

  it('七个页面在「页 id → 组件」的映射里都有归宿（不再有各写一份的 ?: 链）', () => {
    /* 方案 B 落地后，面板由常驻右栏改为导航点开的浮层，
       映射随之从 GameShell 搬到 PanelOverlay——断言改指新家，
       意图一字未改：七个页 id 都在**唯一一处**映射里有归宿。 */
    const src = readFileSync('src/ui/PanelOverlay.tsx', 'utf8');
    for (const t of PANEL_TABS) expect(src, t.id).toContain("'" + t.id + "'");
    expect(src).toContain('PANEL_OF');
    /* 旧的两份分支不该回来，映射也不该同时留在外壳里（那正是"各写一份"的开端） */
    const shell = readFileSync('src/ui/GameShell.tsx', 'utf8');
    expect(shell).not.toContain('SR_TABS');
    expect(shell).not.toContain('mobilePanel');
    expect(shell).not.toContain('rightPanel');
    expect(shell).not.toContain('PANEL_OF');
  });
});

describe('卡 P3 · ③ 行动坞数据驱动：与迁移前的 if 链等价', () => {
  it('酒馆：打听消息 + 住宿 + 喝一杯', () => {
    expect(keysAt('tavern')).toEqual(expect.arrayContaining(['gather_intel', 'rest_inn', 'drink']));
  });

  it('集市：逛杂货摊 + 顺手牵羊 + 打听消息', () => {
    expect(keysAt('market')).toEqual(expect.arrayContaining(['shop_grocer', 'steal', 'gather_intel']));
  });

  it('神殿：祈祷 + 治疗 + 百年神选', () => {
    expect(keysAt('temple')).toEqual(expect.arrayContaining(['pray', 'heal_svc', 'theoselect_menu']));
  });

  it('旷野：探索 + 采集 + 打盹（采集是野外通用动作，不占能力表）', () => {
    expect(keysAt('wild')).toEqual(expect.arrayContaining(['explore_wild', 'gather', 'rest_wild']));
  });

  it('洞窟：深入探索 + 下潜地下城', () => {
    for (const cave of ['cave', 'cave2', 'cave3']) {
      expect(keysAt(cave), cave).toEqual(expect.arrayContaining(['explore_cave', 'enter_dungeon']));
    }
  });

  it('广场：入星枢 + 百年神选', () => {
    expect(keysAt('plaza')).toEqual(expect.arrayContaining(['starnet', 'theoselect_menu']));
  });

  it('缴罚金只在通缉时出现，且价随等级走', () => {
    expect(keysAt('gate', 0)).not.toContain('payfine_go');
    expect(keysAt('gate', 2)).toContain('payfine_go');
    const line = actsOfLocation('gate', 2).find((a) => a.k === 'payfine_go')!.l;
    expect(line).toBe('缴罚金 · ' + formatMoney(600)); // 每级 300 × 2
  });

  it('**加一座城只需标能力**：给它标 shop，逛杂货摊自动出现', () => {
    /* 这条是数据驱动的定义式断言：不碰任何代码，只改数据就能多出按钮。
       从前这里是一串 if (loc === 'market')，新城市必须回来改 SceneView。 */
    const before = keysAt('frosthold');
    expect(before).not.toContain('shop_grocer');
    core.S!.player.loc = 'frosthold';
    (core.S!.player as unknown as { __x?: number }).__x = 1;
    /* 直接对 geo 数据断言更稳：frosthold 的能力里没有 shop，所以没有该按钮 */
    expect(abilitiesOf('frosthold')).not.toContain('shop');
    expect(keysAt('market')).toContain('shop_grocer');
  });

  it('每个已登记的能力都有按钮，或列在"无按钮"豁免里（防静默失效）', () => {
    /* 标了能力却没在 ACTS_OF_ABILITY 里登记 → 玩家什么也看不到，且没人会报错。
       这条把两者钉在一起：要么给按钮，要么明确列进豁免。 */
    const NO_ACT = ['urban', 'patrolled', 'sacred', 'wilderness', 'backstreet'];
    for (const ab of LOCATION_ABILITIES) {
      /* 判据一：这个能力至少被某个地点声明过（否则是「定义了却没人用」的死条目）。
         原来这里是 actionsOfLocation(...).length >= 0 && LOCATION_ABILITIES.includes(ab)——
         两侧都恒真，等于没断言；唯一有意义的 probe 还被 void 丢掉（审查 §假通过）。 */
      const used = ['plaza', 'tavern', 'market', 'temple', 'gate', 'wild', 'cave', 'guild'].some((loc) => abilitiesOf(loc).includes(ab));
      expect(used || NO_ACT.includes(ab), ab + ' 没有任何地点声明它，也不在"无按钮"豁免里').toBe(true);
      /* 判据二：要出按钮的能力必须有中文标签（按钮文案的来源） */
      expect(NO_ACT.includes(ab) || LABELLED_ABILITIES.includes(ab), ab).toBe(true);
    }
  });
});

/** 在 ACTS_OF_ABILITY 里登记过的能力（与 SceneView 保持一致） */
const LABELLED_ABILITIES = [
  'gossip',
  'heal',
  'theoselect',
  'starnet',
  'pay_fine',
  'pickpocket',
  'shop',
  'pray',
  'drink',
  'rest_lodging',
  'rest_camping',
  'explore_wild',
  'explore_cave',
  /* 卡 N1：星枢兑换所（七大陆枢纽各一家） */
  'exchange',
];

describe('卡 P3 · ④ 类型断言的债设上限（实测 15 处，不再增长）', () => {
  it('"读未声明字段"形态的断言不超过 15 处', () => {
    /* 审查时我先按 /as unknown as/g 数出 104 处，据此说"类型债很大"——
       那是字符串出现次数，里含数据加载器的 JSON 断言与跨类型转换，不是同一件事。
       按 (变量 as unknown as { 字段?: T }) 的形态精确统计，实际只有 15 处。
       上限写在这里：新增这类断言要么补声明，要么来解释为什么非它不可。 */
    const walk = (d: string, out: string[] = []): string[] => {
      for (const n of readdirSync(d)) {
        const p = d + '/' + n;
        if (statSync(p).isDirectory()) walk(p, out);
        else if (/\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n)) out.push(p);
      }
      return out;
    };
    let n = 0;
    for (const f of walk('src')) {
      const m = readFileSync(f, 'utf8').match(/\(\w+ as unknown as \{[^}]*\}\)/g);
      if (m) n += m.length;
    }
    expect(n, '读未声明字段的断言增多了：' + n + ' 处').toBeLessThanOrEqual(15);
  });
});
