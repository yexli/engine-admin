/* ============================================================
   NPC 档案数据护栏（《天穹纪-人物》109 条）

   数据是**机器生成物**（scripts/gen-npcs-from-md.mjs 从 docs/设定源 的 md 转出），
   本文件守的是「生成物本身没坏」：字段齐备、id 唯一、台阶合法、分区与大陆表对齐。
   改了生成器就重跑它，这里是回执。

   为什么需要它：109 个人手改不现实，而一个字段缺失（比如整批丢了 realm）
   在 UI 上表现为「人物志某段空白」，不会报错——那种坏法没人查得出来。
   ============================================================ */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NPC_ARCHIVE, npcArchiveSize } from '@/data/npc';
import { WB } from '@/data/worldBook';
import { newState } from '@/world/WorldState';
import { mutate } from '@/world/WorldMutate';

const ROOT = 'src/data/npc';
/** 分区目录 = 大陆 id（geo.json 的 continent 属地的英文代号），异界三块单列。 */
const SECTORS = ['central', 'frost', 'wind', 'gold', 'blood', 'deep', 'sky', 'heavens', 'nether', 'past'];

interface Entry { dir: string; file: string; d: Record<string, unknown> }

/** 结构：<板块>/<id>/npc.json —— 一 NPC 一文件夹，内容多了各自往里面加文件。 */
function loadAll(): Entry[] {
  const out: Entry[] = [];
  for (const sector of readdirSync(ROOT)) {
    const sp = ROOT + '/' + sector;
    if (!statSync(sp).isDirectory()) continue;
    for (const id of readdirSync(sp)) {
      const fp = sp + '/' + id + '/npc.json';
      if (!existsSync(fp)) continue;
      out.push({ dir: sector, file: id + '/npc.json', d: JSON.parse(readFileSync(fp, 'utf8')) });
    }
  }
  return out;
}

const ALL = loadAll();

describe('NPC 档案 · 生成物完整性', () => {
  it('扫描器真的读到了文件（防空数组假绿）', () => {
    expect(ALL.length, '没读到任何档案文件 = 路径失效，不是「没有档案」').toBeGreaterThan(100);
  });

  it('109 条，id 全局唯一且与文件名一致', () => {
    const ids = ALL.map((e) => e.d.id as string);
    expect(ids.length).toBe(109);
    expect(new Set(ids).size, 'id 撞车会让存档索引指向错误的人').toBe(109);
    for (const e of ALL) expect(e.file, e.dir + '/' + e.file).toBe(e.d.id + '/npc.json');
  });

  it('分区目录都是已登记的板块', () => {
    for (const e of ALL) expect(SECTORS, e.file).toContain(e.dir);
  });

  it('每条的必填叙事字段齐备（name/title/race/realm/goal）', () => {
    for (const e of ALL) {
      for (const k of ['name', 'title', 'race', 'realm', 'goal']) {
        expect(e.d[k], e.d.id + ' 缺 ' + k).toBeTruthy();
      }
    }
  });

  it('人物志七项齐备（lore：关键词/身份/外貌/性格/能力/过往/把柄/持有物）', () => {
    for (const e of ALL) {
      const lore = e.d.lore as Record<string, unknown> | undefined;
      expect(lore, e.d.id + ' 无 lore').toBeTruthy();
      for (const k of ['identity', 'appearance', 'personality', 'abilities', 'past', 'flaw', 'belongings']) {
        expect(lore![k], e.d.id + ' 的 lore.' + k).toBeTruthy();
      }
      expect((lore!.keywords as string[])?.length, e.d.id + ' 无关键词').toBeGreaterThan(0);
    }
  });

  it('街头 15 人的人物志七项同样齐备（此前 0/15——P1 的人设注入对他们等于空）', () => {
    /* 档案 109 人一开始就有 lore；街头 15 人**一个都没有**。
       personaBlock 靠它拼身份/过往/弱点，缺了这三项，街头 NPC 在 AI 眼里只剩
       「姓名 + 头衔 + 说话习惯」——P1 的全部工作，在最先被玩家遇到的人身上等于零。
       2026-09-27 补齐，并在这里与档案侧对称地钉住。 */
    const people = JSON.parse(readFileSync('src/data/world/people.json', 'utf8')) as {
      npcs: Record<string, { lore?: Record<string, unknown> }>;
    };
    const ids = Object.keys(people.npcs);
    expect(ids.length, '街头名册读空了 = 路径或结构变了').toBe(15);
    for (const id of ids) {
      const lore = people.npcs[id].lore;
      expect(lore, id + ' 无 lore').toBeTruthy();
      for (const k of ['identity', 'appearance', 'personality', 'abilities', 'past', 'flaw', 'belongings']) {
        expect(lore![k], id + ' 的 lore.' + k).toBeTruthy();
      }
      expect((lore!.keywords as string[])?.length, id + ' 无关键词').toBeGreaterThan(0);
    }
  });
});

describe('NPC 档案 · 境界台阶', () => {
  it('realmTier 落在 1–6，或**刻意缺失**（神格层面）', () => {
    for (const e of ALL) {
      const t = e.d.realmTier;
      if (t === undefined) continue;
      expect([1, 2, 3, 4, 5, 6], e.d.id + ' 的台阶越界').toContain(t);
    }
  });

  it('神格层面正好 8 人（六主神 + 原初之光 + 初代主神）', () => {
    /* 这八位没有「修行到的阶」——他们是神格本身。混进六级台阶会让
       「圣阶·极」和「冥府之主」看起来只差一级，所以刻意留空，此处钉死这个数量。 */
    const godlike = ALL.filter((e) => e.d.realmTier === undefined).map((e) => e.d.id);
    expect(godlike.length).toBe(8);
    for (const id of ['alkas', 'veronika', 'elena', 'nox', 'loki', 'dragon_god', 'chuyao', 'oris']) {
      expect(godlike, id + ' 应属神格层面').toContain(id);
    }
  });

  it('台阶与原文自洽：标了台阶的，原文标题里必含对应档位词', () => {
    /* 反向校验推导规则本身：改了 realmTierOf 的正则又没对齐档案写法时，
       这条会先炸，而不是让一批人的境界静默错档。 */
    const WORDS: Record<number, RegExp> = {
      1: /信徒/, 2: /见习/, 3: /正式/, 4: /主教/,
      5: /圣阶|圣徒|法圣|战圣|匠圣|剑圣/, 6: /神阶|神官级|神将级|神王级/,
    };
    for (const e of ALL) {
      const t = e.d.realmTier as number | undefined;
      if (!t) continue;
      const head = String(e.d.realm).split('（')[0];
      expect(WORDS[t].test(head), e.d.id + ' 台阶 ' + t + ' 与原文「' + head + '」不符').toBe(true);
    }
  });
});

describe('NPC 档案 · 与既有世界无冲突', () => {
  it('机制字段齐备（sv/color/hours/loc/greet/topics/faction 可选）', () => {
    /* 叙事字段再漂亮，缺了 loc 就放不进场景、缺了 greet 就开不了口。
       这几项是 NpcDef 的必填项，档案原文里一个都没有——全靠补全脚本派生。 */
    for (const e of ALL) {
      const d = e.d as Record<string, unknown>;
      for (const k of ['sv', 'color', 'hours', 'loc', 'greet']) {
        expect(d[k], e.d.id + ' 缺机制字段 ' + k).toBeTruthy();
      }
      const g = d.greet as { cold?: string; neutral?: string; warm?: string };
      for (const k of ['cold', 'neutral', 'warm'] as const) {
        expect(g[k], e.d.id + ' 的 greet.' + k).toBeTruthy();
      }
      expect((d.topics as unknown[])?.length, e.d.id + ' 无话题').toBeGreaterThan(0);
      /* loc 必须是真实地点——写错了在地图上是「孤儿地点」，在场景里是查不到的人 */
      expect(WB.locations[d.loc as string], e.d.id + ' 的 loc「' + d.loc + '」不是已登记地点').toBeTruthy();
    }
  });

  it('任何时辰都找得到人（作息不留空档）', () => {
    /* 这条是补写作息时踩出来的：夜间去处误写成 null 的 27 位守殿/守塔者，
       夜里 loc 变成 null —— npcAt 返回 null，人从世界里凭空消失。
       UI 上看不出来（那个地点本来就没人），只有按时辰逐个走一遍才抓得到。 */
    for (const e of ALL) {
      const sch = (e.d as { schedule?: { from: number; to: number; loc: string }[] }).schedule;
      if (!sch) continue;
      for (let h = 0; h < 12; h++) {
        const hit = sch.some((s) => (s.from <= s.to ? h >= s.from && h < s.to : h >= s.from || h < s.to));
        expect(hit, e.d.id + ' 在时辰 ' + h + ' 无处可寻').toBe(true);
        expect(sch.every((s) => !!s.loc), e.d.id + ' 的作息段缺 loc').toBe(true);
      }
    }
  });

  it('街头 15 人的作息同样不留空档、段不越界（此前只守档案侧，街头 15/15 全有空档）', () => {
    /* 2026-09-27 实测：街头 15 人**每一个**都有空档——赛琳娜 / 灰烬 / 科兹·幽鸣一天只有
       2 个时辰在场，莉安则是「0-3 采买 / 4-12 看店」中间漏了 3 时。根因两条：
       ① to 写到 12 以上（时辰只有 0..11，那些段永不命中）；② 段与段之间漏交界时辰。
       而 npcAt 对「有日程却落空档」的人**不回落 hours**，直接返回 null = 人从世界里消失。
       前一条用例只扫了 src/data/npc 的 109 份档案，街头这支队伍在覆盖之外——本条补上，
       并额外钉住 to ≤ 12（越界段看起来「有排班」，实际永远不生效）。 */
    const people = JSON.parse(readFileSync('src/data/world/people.json', 'utf8')) as {
      npcs: Record<string, { schedule?: { from: number; to: number; loc: string }[] }>;
    };
    const ids = Object.keys(people.npcs);
    expect(ids.length, '街头名册读空了 = 路径或结构变了').toBe(15);
    for (const [id, v] of Object.entries(people.npcs)) {
      const sch = v.schedule ?? [];
      for (const sg of sch) {
        expect(sg.to, id + ' 的作息段 to=' + sg.to + ' 越界（时辰取值域 0..12）').toBeLessThanOrEqual(12);
        expect(sg.loc, id + ' 的作息段缺 loc').toBeTruthy();
      }
      /* 与 npcAt/segHit 同一判据：有 schedule 就只看 schedule */
      for (let h = 0; h < 12; h++) {
        const hit = sch.some((sg) => (sg.from <= sg.to ? h >= sg.from && h < sg.to : h >= sg.from || h < sg.to));
        expect(hit, id + ' 在时辰 ' + h + ' 无处可寻（npcAt 会返回 null，玩家看到的是空城）').toBe(true);
      }
    }
  });

  it('聚合器把散装文件夹装订成了名册', () => {
    /* 这条守的是「装订工序」本身：文件夹再多，聚合器读不到就等于没有。
       同时钉住人数——glob 路径写错时它会静默返回 0 条。 */
    expect(npcArchiveSize()).toBe(109);
    expect(Object.keys(NPC_ARCHIVE).sort()).toEqual(ALL.map((e) => e.d.id as string).sort());
  });

  it('关系边不悬空（指向的每个人都真的存在）', () => {
    /* 关系边是好几条机制链的地基：一跳扩展、送礼传播、谣言扩散。
       指向一个不存在的人 = 那条边永远匹配不上，而且不会报错。
       注意不用只查档案内部——瞄向街头 15 人（莉安、戈林…）同样合法。 */
    for (const e of ALL) {
      const rels = (e.d as { rels?: Record<string, { type: string; val: number }> }).rels;
      if (!rels) continue;
      for (const [other, edge] of Object.entries(rels)) {
        expect(WB.npcs[other], e.d.id + ' 的关系边指向不存在的人：' + other).toBeTruthy();
        expect(typeof edge.val, e.d.id + '→' + other + ' 的强度不是数字').toBe('number');
        expect(edge.type, e.d.id + '→' + other + ' 缺类型').toBeTruthy();
      }
    }
  });

  it('关系网没有孤岛（109 人全部至少有一条边）', () => {
    /* 这条守的是「世界变大了，也要变厚」：109 个互不相识的人是 109 个孤岛，
       谣言传不出五个人，送礼也不会影响到谁。 */
    const lonely = ALL.filter((e) => {
      const r = (e.d as { rels?: Record<string, unknown> }).rels;
      return !r || !Object.keys(r).length;
    }).map((e) => e.d.id);
    expect(lonely, '这些人和谁都没关系：' + lonely.join(', ')).toEqual([]);
  });

  it('关系边随建档投影进运行时（不是只躺在数据里）', () => {
    /* 数据里有边 ≠ 引擎读得到。投影点在 WorldMutate.npcEntry（唯一实现），
       `stripTies` 只做浅拷贝不过滤——这条用例钉住那条链是通的。 */
    const s = newState({ name: '测试者', race: 'human', cls: 'warrior' });
    const dy = mutate.npcEntry('herman', s);
    expect(Object.keys(dy.rels ?? {}).length, '赫尔曼建档后应带着关系网').toBeGreaterThan(0);
    const kael = mutate.npcEntry('kael', s);
    expect(kael.rels?.herman?.type, '凯尔与皇帝之间应有「亲族」边').toBe('kin');
  });

  it('档案人物不占用街头 NPC 的 id', () => {
    /* 重名冲突的实质是 id 冲突——莉塔/加隆/米娅已由街头方改名让位，
       档案方取 lita_verdant / galon_ii / mia_elder。这条守住那个决定。 */
    const archiveIds = new Set(ALL.map((e) => e.d.id as string));
    for (const f of ['lita', 'galon', 'mia']) {
      expect(archiveIds.has(f), '档案不该占用街头 NPC 的 id：' + f).toBe(false);
    }
  });
});
