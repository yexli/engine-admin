/* ============================================================
   World Schema 符合性测试（P13 · 方案 §十六）
   ------------------------------------------------------------
   Schema 从双游戏实践提炼（非前瞻设计）——本测试把两款游戏的真实
   种子形状逐一过 inspectWorldSchema：
     · 天穹（RPG）：米露/老周/商人 + mood/attention/goal/money
     · 商路（商贸）：阿卜杜/沈万 + goal/money/spice_stock/silk_stock/item_*
   并验证：契约违规可查（类型错/命名违纪）、缺省如实提示、
   引擎事件类型全集与 Schema 归类一致。
   ============================================================ */
import { describe, expect, it } from 'vitest';
import {
  ALL_EVENT_TYPES,
  CANONICAL_ATTRIBUTES,
  GAME_KEY_PATTERN,
  SCHEMA_VERSION,
  inspectWorldSchema,
} from '../src/index.ts';

/* 天穹宿主播种后的真实形状（scripts/run-tianqiong-host.mjs） */
const TIANQIONG_STATE = {
  worldId: 'tianqiong-village',
  t: 33,
  locations: { village: { id: 'village' }, tavern: { id: 'tavern' }, shop: { id: 'shop' } },
  player: { loc: 'tavern', attributes: { money: 47, item_ale: 1, item_rice: 1 } },
  npcs: {
    milu: { att: 0, met: true, type: 'npc', attributes: { name: '米露', location: 'tavern', mood: '平静', attention: 'player', money: 20, goal: '把酒馆经营好，弄清常客们的来历' } },
    keeper: { att: 0, met: true, type: 'npc', attributes: { name: '酒馆老板老周', location: 'village', mood: '平静', attention: '无人', money: 205, ale_stock: 10 } },
    trader: { att: 0, met: false, type: 'npc', attributes: { name: '商人老葛', location: 'shop', mood: '平静', attention: '无人', money: 100, goods_rice: 49 } },
  },
  relations: [{ source: 'milu', target: 'player', type: 'noticed', value: 10 }],
};

/* 商路宿主播种后的真实形状（scripts/run-trade-host.mjs） */
const TRADE_STATE = {
  worldId: 'trade-road',
  t: 20,
  locations: { quanzhou: { id: 'quanzhou' }, hangzhou: { id: 'hangzhou' }, guangzhou: { id: 'guangzhou' } },
  player: { loc: 'quanzhou', attributes: { money: 104, item_spice: 1, item_silk: 0 } },
  npcs: {
    abdul: { att: 0, met: true, type: 'npc', attributes: { name: '胡商阿卜杜', location: 'quanzhou', mood: '平和', attention: 'player', money: 288, spice_stock: 20, silk_stock: 1, goal: '把香料卖个好价钱，收满一船丝绸' } },
    shen: { att: 0, met: false, type: 'npc', attributes: { name: '浙商沈万', location: 'hangzhou', mood: '精明', attention: '无人', money: 308, silk_stock: 19, spice_stock: 0, goal: '低买高卖，做三城最大的丝绸商' } },
  },
  relations: [{ source: 'abdul', target: 'player', type: 'noticed', value: 10 }],
};

describe('P13 双游戏符合性（Schema 从实践提炼）', () => {
  it('天穹世界（RPG）符合 Schema；规范键/游戏键如实统计', () => {
    const report = inspectWorldSchema(TIANQIONG_STATE);
    expect(report.conforming).toBe(true);
    expect(report.schemaVersion).toBe(SCHEMA_VERSION);
    expect(report.stats.entities).toBe(4); /* player + 3 npc */
    expect(report.stats.locations).toBe(3);
    expect(report.stats.relations).toBe(1);
    /* 规范键覆盖（真实形状：宿主只给米露种了 goal——keeper/trader 缺 goal 属合法缺省；
       玩家位置是引擎原生 player.loc，计入 location 覆盖） */
    expect(report.stats.canonicalKeys).toMatchObject({ location: 4, mood: 3, attention: 3, goal: 1, money: 4 });
    /* 游戏自有键：天穹的酒/粮（平台不解释，透出） */
    expect(report.stats.gameKeys).toEqual(['ale_stock', 'goods_rice', 'item_ale', 'item_rice']);
  });

  it('商路世界（商贸）符合 Schema；同款规范键 + 商贸自有键', () => {
    const report = inspectWorldSchema(TRADE_STATE);
    expect(report.conforming).toBe(true);
    expect(report.stats.canonicalKeys).toMatchObject({ attention: 2, goal: 2, money: 3 });
    expect(report.stats.gameKeys).toEqual(['item_silk', 'item_spice', 'silk_stock', 'spice_stock']);
  });

  it('契约违规可查：money 类型错 / 游戏键命名违纪', () => {
    const report = inspectWorldSchema({
      player: { loc: 'village', attributes: { money: '很多' } },
      npcs: { x: { attributes: { location: 'tavern', 'Bad-Key!': 1 } } },
    });
    expect(report.conforming).toBe(false);
    expect(report.errors.some((e) => e.includes('money 应为 number'))).toBe(true);
    expect(report.errors.some((e) => e.includes('Bad-Key!') && e.includes('命名纪律'))).toBe(true);
  });

  it('缺省如实提示（不阻断）：无 location 的实体不被唤醒面考虑', () => {
    const report = inspectWorldSchema({
      player: { loc: 'village', attributes: { money: 10 } },
      npcs: { sleeper: { attributes: { name: '睡客' } } },
    });
    expect(report.conforming).toBe(true); /* 缺规范键是合法选择 */
    expect(report.warnings.some((w) => w.includes('sleeper') && w.includes('location'))).toBe(true);
    expect(report.warnings.some((w) => w.includes('goal'))).toBe(true);
  });
});

describe('P13 引擎事件类型全集（Schema 事件面 ↔ 引擎事实一致）', () => {
  it('归类无重叠、平铺无重复', () => {
    const flat = ALL_EVENT_TYPES;
    expect(new Set(flat).size).toBe(flat.length);
  });

  it('触发分级表的键：精确类型在事件面内；前缀键有匹配；前瞻声明仅 quest', async () => {
    const { DEFAULT_TRIGGER_GRADES } = await import('../src/index.ts');
    const forward: string[] = [];
    for (const type of Object.keys(DEFAULT_TRIGGER_GRADES)) {
      if (type === '*') continue;
      if (ALL_EVENT_TYPES.includes(type)) continue; /* 精确事件类型 */
      if (ALL_EVENT_TYPES.some((x) => x.startsWith(type))) continue; /* 前缀键（如 talk → talk_started） */
      forward.push(type);
    }
    expect(forward).toEqual(['quest', 'schedule_changed']); /* 前瞻声明：Quest（P14）/ 日程变更事件（P6 机制已备，事件未定义） */
  });

  it('规范属性键的定义完备（type/appliesTo/writtenBy/description）', () => {
    for (const [key, attr] of Object.entries(CANONICAL_ATTRIBUTES)) {
      expect(['string', 'number', 'boolean']).toContain(attr.type);
      expect(['entity', 'player', 'both']).toContain(attr.appliesTo);
      expect(['host', 'ai', 'both']).toContain(attr.writtenBy);
      expect(attr.description.length).toBeGreaterThan(4);
      expect(GAME_KEY_PATTERN.test(key)).toBe(true); /* 规范键自身也守命名纪律 */
    }
  });
});
