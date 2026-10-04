/* ============================================================
   卡 H3 · 命名生成器：13 族词根表 / 命名公式 / 稀有度权重 / 避雷校验
   确定性：rng.seed(n)（core/bus 统一随机源，可注入）+ 直连 @/core/naming，
   刻意不 import @/core 索引（避免拉起 engine.ts）。
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { rng } from '@/events/EventBus';
import {
  NAMING_BLOCKLIST,
  NAMING_LEXICON,
  NAMING_RULES,
  batchGenerate,
  generateName,
  isNamingRace,
  nameFromLore,
  namingRaces,
  resolveRace,
  rollTier,
  validateName,
  type NamingTier,
} from '@/systems/naming/Naming';
import tables from '@/data/world/tables.json';
import lore from '@/data/lore/lore.json';
import { PERSON_LORE, loadPersonLore } from '@/data/lore';

const RACES = Object.keys((tables as unknown as { races: Record<string, unknown> }).races);
const TABLES = ['male', 'female', 'clan', 'epithet', 'prefix', 'suffix'] as const;
const TIERS: NamingTier[] = ['common', 'rare', 'legend'];
const CJK = '\\u4e00-\\u9fa5';
const seg = (a: string, b: string, extra = '') => new RegExp(`^${a}(·${b})${extra}$`);

/** 族风结构签名（每条名字都必须匹配；跨族互不串味） */
const STYLE: Record<string, RegExp> = {
  human: seg(`[${CJK}]{2,6}`, `[${CJK}]{1,8}`, `(·[${CJK}]{1,8}){0,2}`),
  elf: seg(`[${CJK}]{3,6}`, `[${CJK}]{2,8}`, `(·[${CJK}]{2,8}){0,1}`),
  dwarf: seg(`[${CJK}]{2,5}`, `[${CJK}]{2,4}`, `(·[${CJK}]{2,4}){0,1}`),
  orc: seg(`[${CJK}]{2,6}`, `[${CJK}]{2,6}`, `(·[${CJK}]{2,6}){0,2}`),
  halforc: seg(`[${CJK}]{2,6}`, `[${CJK}]{2,6}`, `(·[${CJK}]{2,6}){0,2}`),
  gnome: seg(`[${CJK}]{2,5}`, `[${CJK}]{2,6}`, `(·[${CJK}]{2,6}){0,1}`),
  undead: new RegExp(`^[${CJK}]{2,5}(·[${CJK}]{2,6}){0,2}$`),
  vampire: new RegExp(`^[${CJK}]{2,6}(·[${CJK}]{1,6}){1,3}$`), // 中段「德」为一字贵族助词
  elemental: new RegExp(`^[${CJK}]{2}(·[${CJK}]{2,6}){0,2}$`),
  avariel: new RegExp(`^[${CJK}]{2,5}(·[${CJK}]{2,6}){1,2}$`),
  giant: new RegExp(`^[${CJK}]{1,2}(·[${CJK}]{2,6}){1,2}$`),
  dragon: new RegExp(`^[${CJK}]{2,6}(·[${CJK}]{2,6}){1,2}$`),
  demon: new RegExp(`^[${CJK}]{2,7}(·[${CJK}]{2,6}){1,2}$`),
};
/** 喉音池（兽人/半兽人专属；精灵绝不可沾） */
const GUTTURAL = /[格罗姆戈鲁什克扎古尔洛玛托布恩塔卡赫]/;
/** 风与云意象（翼族） */
const WIND = /[风云雨雪羽翼翔隼翎穹霄岚鸢]/;
/** 元素字（元素裔） */
const ELEM = /[焰霜雷风岩潮光暗云星雪泉烬尘冰炎汐曦曜岚熔硫砂月]/;

const segCount = (s: string) => s.split('·').length;
const expectedSegCounts = (race: string, tier: NamingTier): Set<number> =>
  new Set(NAMING_RULES.races[race].tierPatterns[tier].map((p) => p.split('·').length));

beforeEach(() => {
  rng.seed(11);
});

describe('卡 H3 · 数据契约（13 族词根表 / 公式 / 权重）', () => {
  it('namingRaces() 与 tables.json.races 的 13 个 key 完全一致', () => {
    expect(RACES).toHaveLength(13);
    expect(namingRaces()).toEqual(RACES);
    expect(RACES.every((r) => isNamingRace(r))).toBe(true);
    expect(isNamingRace('外星人')).toBe(false);
  });
  it('每族 6 张词根表均在 20–40 条、无重复、无空串', () => {
    for (const race of RACES) {
      for (const t of TABLES) {
        const arr = NAMING_LEXICON[race][t];
        expect(arr.length, `${race}.${t}`).toBeGreaterThanOrEqual(20);
        expect(arr.length, `${race}.${t}`).toBeLessThanOrEqual(40);
        expect(new Set(arr).size, `${race}.${t} 去重`).toBe(arr.length);
        expect(arr.every((v) => v.length > 0 && !/\s/.test(v)), `${race}.${t} 无空白`).toBe(true);
      }
    }
  });
  it('公式与变体的占位符都能回落到 lexicon 表名', () => {
    for (const race of RACES) {
      const rule = NAMING_RULES.races[race];
      const pats = [...rule.patterns, ...TIERS.flatMap((t) => rule.tierPatterns[t])];
      expect(pats, race).toContain(rule.formula);
      for (const p of pats) {
        for (const m of p.matchAll(/\{([a-z]+)\}/g)) {
          const mapped = rule.slots[m[1]];
          expect(mapped, `${race} ${p} → {${m[1]}}`).toBeTruthy();
          for (const t of mapped) expect(NAMING_LEXICON[race][t], `${race}.${t}`).toBeTruthy();
        }
      }
    }
  });
  it('稀有度权重 = 普通 0.70 / 稀有 0.25 / 传说 0.05，各档变体已声明', () => {
    expect(NAMING_RULES.tiers).toEqual({ common: 0.7, rare: 0.25, legend: 0.05 });
    const sum = TIERS.reduce((a, t) => a + NAMING_RULES.tiers[t], 0);
    expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
    for (const race of RACES) {
      const rule = NAMING_RULES.races[race];
      for (const t of TIERS) {
        expect(rule.tierPatterns[t].length, `${race}.${t}`).toBeGreaterThan(0);
        for (const p of rule.tierPatterns[t]) expect(rule.patterns, `${race}.${t}`).toContain(p);
      }
      expect(rule.gender.optional).toBe(true); // 性别可选标记
      expect(rule.style.charset.length).toBeGreaterThan(10);
    }
  });
  it('每族字符集互不串味：精灵不沾喉音、兽人/半兽人沾喉音、元素裔含元素字', () => {
    expect(GUTTURAL.test(NAMING_RULES.races.elf.style.charset)).toBe(false);
    expect(GUTTURAL.test(NAMING_RULES.races.orc.style.charset)).toBe(true);
    expect(GUTTURAL.test(NAMING_RULES.races.halforc.style.charset)).toBe(true);
    expect(ELEM.test(NAMING_RULES.races.elemental.style.charset)).toBe(true);
  });
});

describe('卡 H3 · 确定性（同 seed 同输出 / 可注入 rng）', () => {
  it('同 seed 两次生成完全一致', () => {
    const run = () => {
      rng.seed(7);
      return RACES.flatMap((r) => [generateName(r), generateName(r, { tier: 'legend' }), ...batchGenerate(r, 3)]);
    };
    const a = run();
    const b = run();
    expect(a).toEqual(b);
    expect(a.every((n) => n.length > 0)).toBe(true);
  });
  it('不同 seed 产出不同名字', () => {
    rng.seed(1);
    const a = RACES.flatMap((r) => batchGenerate(r, 10));
    rng.seed(2);
    const b = RACES.flatMap((r) => batchGenerate(r, 10));
    expect(a).not.toEqual(b);
    expect(a.filter((n, i) => n !== b[i]).length).toBeGreaterThan(a.length / 2);
  });
  it('注入 rng 序列（LCG）可复现，且不依赖全局 rng', () => {
    const mk = () => {
      let x = 12345;
      return () => {
        x = (x * 1664525 + 1013904223) >>> 0;
        return x / 4294967296;
      };
    };
    const a = batchGenerate('elf', 20, { rng: mk() });
    rng.seed(999); // 全局源被换掉也不影响注入源
    const b = batchGenerate('elf', 20, { rng: mk() });
    expect(a).toEqual(b);
  });
});

describe('卡 H3 · 13 族 × 100 个名字（无重复 / 过校验 / 合族风）', () => {
  for (const race of RACES) {
    it(`${race}：100 个名字无重复、通过 validateName、匹配族风正则`, () => {
      rng.seed(2026);
      const names = batchGenerate(race, 100);
      expect(names, race).toHaveLength(100);
      expect(new Set(names).size, `${race} 去重`).toBe(100);
      expect(names.filter((n) => !validateName(n, race)), `${race} 未过校验`).toEqual([]);
      expect(names.filter((n) => !STYLE[race].test(n)), `${race} 不合族风`).toEqual([]);
    });
  }
  it('三档稀有度各自只落该档 pattern 的段数签名', () => {
    for (const race of RACES) {
      for (const tier of TIERS) {
        rng.seed(88);
        const expectSegs = expectedSegCounts(race, tier);
        for (let i = 0; i < 25; i++) {
          const n = generateName(race, { tier });
          expect(expectSegs.has(segCount(n)), `${race}/${tier} → ${n}`).toBe(true);
          expect(validateName(n, race), `${race}/${tier} → ${n}`).toBe(true);
        }
      }
    }
  });
  it('样例扫读（13 族 × default / legend）', () => {
    const rows: string[] = [];
    for (const race of RACES) {
      rng.seed(314 + race.length);
      const normal = Array.from({ length: 5 }, () => generateName(race));
      rng.seed(271 + race.length);
      const legend = Array.from({ length: 3 }, () => generateName(race, { tier: 'legend', gender: 'male' }));
      rows.push(`${race.padEnd(10)} ${normal.join('、')}  ‖ ${legend.join('、')}`);
    }
    console.log('卡 H3 命名样例：\n' + rows.join('\n'));
    expect(rows).toHaveLength(13);
  });
});

describe('卡 H3 · 跨族风格差异（兽人喉音 vs 精灵流音 vs 巨人单音）', () => {
  it('兽人/半兽人必含喉音，精灵一个都不沾', () => {
    rng.seed(5);
    const orc = batchGenerate('orc', 60);
    const half = batchGenerate('halforc', 60);
    const elf = batchGenerate('elf', 60, { rng: rng.next });
    expect(orc.filter((n) => !GUTTURAL.test(n))).toEqual([]);
    expect(half.filter((n) => !GUTTURAL.test(n))).toEqual([]);
    expect(elf.filter((n) => GUTTURAL.test(n))).toEqual([]);
  });
  it('精灵首段多音节（≥3 字）、巨人单音（1–2 字）、翼族含风云意象', () => {
    rng.seed(6);
    const elf = batchGenerate('elf', 40);
    const giant = batchGenerate('giant', 40, { rng: rng.next });
    const avariel = batchGenerate('avariel', 40, { rng: rng.next });
    expect(elf.every((n) => n.split('·')[0].length >= 3)).toBe(true);
    expect(giant.every((n) => n.split('·')[0].length <= 2)).toBe(true);
    expect(avariel.filter((n) => !WIND.test(n.split('·')[0]))).toEqual([]);
    const avg = (a: string[]) => a.reduce((s, n) => s + n.length, 0) / a.length;
    expect(avg(elf)).toBeGreaterThan(avg(giant));
  });
  it('血族名带贵族助词「德」，不死族以代号行世（有 0 分隔符的短代号）', () => {
    rng.seed(9);
    const vamp = batchGenerate('vampire', 60);
    const undead = batchGenerate('undead', 60, { rng: rng.next });
    expect(vamp.some((n) => n.includes('·德·'))).toBe(true);
    expect(undead.some((n) => !n.includes('·'))).toBe(true);
    expect(vamp.filter((n) => !STYLE.vampire.test(n))).toEqual([]);
  });
});

describe('卡 H3 · 稀有度权重分布（1000 次采样）', () => {
  it('common 占比落在 0.6–0.8，legend 落在 0.02–0.10', () => {
    const counts: Record<NamingTier, number> = { common: 0, rare: 0, legend: 0 };
    rng.seed(2026);
    for (let i = 0; i < 1000; i++) counts[rollTier(rng.next)]++;
    expect(counts.common / 1000).toBeGreaterThanOrEqual(0.6);
    expect(counts.common / 1000).toBeLessThanOrEqual(0.8);
    expect(counts.legend / 1000).toBeGreaterThanOrEqual(0.02);
    expect(counts.legend / 1000).toBeLessThanOrEqual(0.1);
    expect(counts.common + counts.rare + counts.legend).toBe(1000);
    expect(counts.rare / 1000).toBeGreaterThanOrEqual(0.15);
    expect(counts.rare / 1000).toBeLessThanOrEqual(0.35);
    // 生成侧同源：默认档位掷点走同一 rollTier 路径，1000 个名字全部可产出
    rng.seed(4242);
    const names = Array.from({ length: 1000 }, () => generateName('human'));
    expect(names.filter((n) => !validateName(n, 'human'))).toEqual([]);
  });
  it('rollTier 边界：0 → common，0.99 → legend，NaN 不崩', () => {
    expect(rollTier(() => 0)).toBe('common');
    expect(rollTier(() => 0.99)).toBe('legend');
    expect(rollTier(() => Number.NaN)).toBe('common');
    expect(rollTier(() => 1)).toBe('legend');
  });
});

describe('卡 H3 · blocklist（避雷词 / canonical 专名）', () => {
  it('空串、纯符号、纯空白一律拒绝', () => {
    expect(validateName('', 'human')).toBe(false);
    expect(validateName('   ', 'human')).toBe(false);
    expect(validateName('···', 'human')).toBe(false);
    expect(validateName('!!!', 'human')).toBe(false);
    expect(validateName('ABCD', 'human')).toBe(false);
  });
  it('canon 专名（整名）命中即拒：神名 / NPC / 命名范例', () => {
    expect(NAMING_BLOCKLIST.reserved).toContain('阿尔卡斯');
    expect(validateName('阿尔卡斯', 'human')).toBe(false);
    expect(validateName('维罗妮卡', 'elf')).toBe(false);
    expect(validateName('灰烬', 'undead')).toBe(false);
    expect(validateName('焰心', 'elemental')).toBe(false);
    expect(validateName('奥兰多·铁手', 'human')).toBe(false);
    expect(validateName('布伦丹·铁砧', 'dwarf')).toBe(false);
    // 生成器永不产出被保留的范例全名
    rng.seed(31);
    expect(batchGenerate('human', 300)).not.toContain('奥兰多·铁手');
    expect(batchGenerate('dwarf', 300)).not.toContain('布伦丹·铁砧');
    expect(batchGenerate('elemental', 200)).not.toContain('焰心');
  });
  it('canon 词根（子串）命中即拒', () => {
    for (const root of NAMING_BLOCKLIST.reservedRoots) {
      expect(validateName(`前缀${root}后缀`, 'human'), root).toBe(false);
    }
    expect(NAMING_BLOCKLIST.reservedRoots).toContain('龙神');
  });
  it('脏话/敏感/政治雷区：词表非空且子串命中即拒', () => {
    expect(NAMING_BLOCKLIST.words.length).toBeGreaterThanOrEqual(20);
    for (const w of NAMING_BLOCKLIST.words) {
      expect(validateName(w, 'human'), w).toBe(false);
      // 生成结果永不包含避雷词（13 族全量抽查）
      for (const race of RACES) {
        rng.seed(77);
        expect(batchGenerate(race, 20).filter((n) => n.includes(w)), `${race}/${w}`).toEqual([]);
      }
    }
  });
});

describe('卡 H3 · 批量生成去重与边界', () => {
  it('13 族各 120 个：批内无重复且不含 reserved', () => {
    for (const race of RACES) {
      rng.seed(303);
      const names = batchGenerate(race, 120);
      expect(names.length, race).toBe(120);
      expect(new Set(names).size, race).toBe(120);
      expect(names.filter((n) => NAMING_BLOCKLIST.reserved.includes(n)), race).toEqual([]);
      expect(names.filter((n) => !validateName(n, race)), race).toEqual([]);
    }
  });
  it('count ≤ 0 返回空数组；未知种族不崩', () => {
    expect(batchGenerate('human', 0)).toEqual([]);
    expect(batchGenerate('human', -5)).toEqual([]);
    rng.seed(4);
    const alien = batchGenerate('外星人', 10);
    expect(alien).toHaveLength(10);
    expect(new Set(alien).size).toBe(10);
  });
});

describe('卡 H3 · nameFromLore（canon 提取）', () => {
  it('s2 → 「阿尔卡斯」，且必是 canon 原文里的专名', () => {
    const n = nameFromLore('s2');
    expect(n).toBe('阿尔卡斯');
    const card = lore.find((c) => c.id === 's2');
    expect(card!.canon).toContain(n);
  });
  it('全域扫描：凡返回 canon 专名者必出现在该卡 canon 中，且绝不返回地名', () => {
    const canon = new Set([...NAMING_BLOCKLIST.reserved, ...NAMING_BLOCKLIST.reservedRoots]);
    let hit = 0;
    for (const card of lore) {
      const n = nameFromLore(card.id);
      expect(NAMING_BLOCKLIST.places, `${card.id} 取到地名`).not.toContain(n);
      if (canon.has(n)) {
        expect(card.canon, `${card.id} → ${n}`).toContain(n);
        hit++;
      } else {
        expect(validateName(n, 'human'), `${card.id} 回落名 ${n}`).toBe(true); // 提取不到 → 回落生成
      }
    }
    expect(hit).toBeGreaterThan(0);
  });
  it('s9（地点卡）回落生成人类名；未知 id 不崩', () => {
    expect(validateName(nameFromLore('s9'), 'human')).toBe(true);
    expect(validateName(nameFromLore('s999'), 'human')).toBe(true);
    expect(validateName(nameFromLore(''), 'human')).toBe(true);
  });
  it('人物卡（lore-person）返回其 canon 名', async () => {
    await loadPersonLore();
    expect(PERSON_LORE.length).toBeGreaterThan(0);
    for (const p of PERSON_LORE.slice(0, 8)) expect(nameFromLore(p.id)).toBe(p.name);
  });
});

describe('卡 H3 · 未知种族兜底与分层铁律', () => {
  it('未知种族回落人类公式，不抛错、不产出脏名', () => {
    rng.seed(12);
    for (const race of ['外星人', '', 'HUMAN', 'dragonborn', '__proto__', 'toString']) {
      const n = generateName(race);
      expect(validateName(n, 'human'), race).toBe(true);
      expect(STYLE.human.test(n), race).toBe(true);
    }
    expect(namingRaces()).not.toContain('外星人');
    expect(validateName('随便', 'unknown-race')).toBe(true); // 未知种族跳过字符集校验
  });
  it('中文族名别名与 tables.json.races[*].name 一一对应，且按别名生成合族风', () => {
    const named = (tables as unknown as { races: Record<string, { name: string }> }).races;
    expect(NAMING_RULES.alias).toEqual(Object.fromEntries(RACES.map((r) => [named[r].name, r])));
    expect(resolveRace('精灵')).toBe('elf');
    expect(resolveRace('不死族')).toBe('undead');
    expect(resolveRace('人类')).toBe('human');
    expect(resolveRace('unknown-race')).toBe('human');
    expect(resolveRace('')).toBe('human');
    rng.seed(21);
    const elf = batchGenerate('精灵', 30);
    expect(elf.filter((n) => !STYLE.elf.test(n))).toEqual([]);
    expect(elf.filter((n) => !validateName(n, '精灵'))).toEqual([]);
    expect(validateName('格罗姆·碎颅', '精灵')).toBe(false); // 跨族字符集串味 → 拒
    expect(validateName('格罗姆·碎骨', '兽人')).toBe(true); // 同族（中文别名）→ 过（范例全名另被 reserved 拒）
    expect(validateName('格罗姆·碎颅', '兽人')).toBe(false); // 命名范例属 reserved
  });
  it('naming.ts 不依赖 UI/AI/store/DOM，且不用 Math.random', () => {
    const src = readFileSync(new URL('../systems/naming/Naming.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/from '@\/ai/);
    expect(src).not.toMatch(/from '@\/ui/);
    expect(src).not.toMatch(/from '@\/store/);
    expect(src).not.toMatch(/from 'react/);
    expect(src).not.toMatch(/zustand/);
    expect(src).not.toMatch(/Math\.random/);
    expect(src).not.toMatch(/from '@\/core'/);
  });
  it('导出面：五个主函数 + 三份只读加载器齐备', () => {
    expect(typeof generateName).toBe('function');
    expect(typeof validateName).toBe('function');
    expect(typeof batchGenerate).toBe('function');
    expect(typeof nameFromLore).toBe('function');
    expect(typeof namingRaces).toBe('function');
    /* 卡 G1：lexicon 顶层除 13 个种族外，还挂了六维词表（place/org/item/monster/floor/skill），
       所以这里改为断言「种族词表恰为 13」而不是「顶层恰为 13」。 */
    const raceTables = Object.keys(NAMING_LEXICON).filter((k) => {
      const t = NAMING_LEXICON[k] as unknown as Record<string, unknown>;
      return Array.isArray(t?.male) && Array.isArray(t?.female);
    });
    expect(raceTables).toHaveLength(13);
    expect(NAMING_RULES.races.human.formula).toBe('{given}·{patronym}');
    expect(NAMING_RULES.races.elf.formula).toBe('{prefix}{suffix}·{clan}');
    expect(NAMING_RULES.races.dwarf.formula).toBe('{given}·{clan}{epithet}');
  });
});

/* ============================================================
   卡 H3 集成 · 调用点（主线接线验收）
   1. core/npcs.ts passerby() —— 路人署名（纯叙事，不建 NpcDynamic）
   2. core/theoselect.ts 候选池补位 —— 10 名生成名 + 世界书 15 名 NPC
   ============================================================ */
describe('卡 H3 集成 · 路人署名（core/npcs.passerby）', () => {
  it('生成的路人有族名与名号，且不写入 WorldState.npcs（路人无存档副作用）', async () => {
    const { passerby } = await import('@/systems/npc/Npcs');
    const { core, newState } = await import('@/world/WorldState');
    core.S = newState({ name: '路测', race: 'human', cls: 'warrior' });
    rng.seed(31);
    const seen = new Set<string>();
    for (let i = 0; i < 60; i++) {
      const p = passerby();
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.race.length).toBeGreaterThan(0);
      expect(p.name).not.toContain('{');
      seen.add(p.name);
    }
    expect(seen.size).toBeGreaterThan(40); // 命名生成器产出足够分散
    expect(Object.keys(core.S.npcs)).toHaveLength(0); // 路人绝不进 NPC 表
  });
  it('指定种族时按该族风格出（中文族名与 lexicon key 均可）', async () => {
    const { passerby } = await import('@/systems/npc/Npcs');
    rng.seed(7);
    for (let i = 0; i < 20; i++) {
      expect(passerby('elf').race).toBe('精灵');
      expect(validateName(passerby('elf').name, 'elf')).toBe(true);
      expect(passerby('矮人').race).toBe('矮人');
    }
    expect(passerby('不存在的族').race.length).toBeGreaterThan(0); // 未知族回落不崩
  });
});

describe('卡 H3 集成 · 神选候选补位（core/theoselect.seedField）', () => {
  it('候选池 = 世界书 NPC（canon 名）+ 10 名生成名，且展示名全池无重复', async () => {
    const { core, newState } = await import('@/world/WorldState');
    const { ensureTheoselect, rivalName } = await import('@/systems/religion/Theoselect');
    const { WB } = await import('@/data/worldBook');
    core.S = newState({ name: '神选测', race: 'human', cls: 'warrior' });
    rng.seed(53);
    const t = ensureTheoselect(core.S);
    const roster = Object.keys(WB.npcs).length;
    expect(t.candidates!.length).toBe(roster + 10);
    const gen = t.candidates!.filter((c) => c.npcId.startsWith('rival_'));
    expect(gen).toHaveLength(10);
    /* 世界书 NPC 用 canon 名；补位用生成名；不得出现「查不到展示名」的候选 */
    const names = t.candidates!.map((c) => rivalName(c.npcId));
    expect(names).toContain(WB.npcs.lita.name);
    expect(names).toContain(WB.npcs.tutor_camp.name); // 卡 H6 播种的学院导师也在名册上
    for (const c of gen) expect(rivalName(c.npcId)).not.toBe(c.npcId);
    expect(new Set(names).size).toBe(names.length); // 全池无重名
  });
});

describe('卡 H3 · 避雷表按子串拦截（F-28）', () => {
  it('reserved 单段名同样按子串拦截：500 次生成不撞任一 canonical 专名', () => {
    rng.seed(1229);
    const names = [
      ...batchGenerate('矮人', 250, { rng: () => rng.next() }),
      ...batchGenerate('侏儒', 250, { rng: () => rng.next() }),
    ].map((n) => (typeof n === 'string' ? n : (n as { name: string }).name));
    expect(names.length).toBe(500);
    for (const n of names) {
      for (const r of NAMING_BLOCKLIST.reserved) {
        expect(n.includes(r), n + ' 撞 canonical 专名 ' + r).toBe(false);
      }
      for (const r of NAMING_BLOCKLIST.reservedRoots) {
        expect(n.includes(r), n + ' 撞 canon 词根 ' + r).toBe(false);
      }
    }
  });

  it('两类字段语义在 meta 中显式声明（reserved 与 reservedRoots 均子串命中）', () => {
    expect(NAMING_BLOCKLIST.meta?.note ?? '').toMatch(/reserved/);
    expect(NAMING_BLOCKLIST.meta?.note ?? '').toMatch(/子串/);
    expect(NAMING_BLOCKLIST.reserved.length).toBeGreaterThan(100);
  });
});
