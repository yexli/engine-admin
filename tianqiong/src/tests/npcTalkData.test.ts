/* ============================================================
   N-E · 话题卡数据契约的回归防线。
   守四件事（P2 的内容层 + P3 的深水区代价都靠它兜底）：

   ① schema：每张卡三层齐（say/inner/core）、facts ≥2、edge 非空、next ≤3、无残留占位符；
   ② 挂接：卡的标签必须出现在该 NPC 的 topics 索引里——
      索引缺失的卡在界面上**永远点不到**（凯尔曾有 6 张卡没挂上，就是这条抓出来的）；
   ③ 代价（用户 2026-09-27 裁决「深水区带代价」）：带 core 的卡必须有 gate，
      且代价字段若存在必须是合法类型；
   ④ 覆盖不回退：街头 5 位核心 NPC 必须有卡——他们是玩家最早遇到的人。
   ============================================================ */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WB } from '@/data/worldBook';
import { hasTalk, loadTalk } from '@/data/talk';
import type { NpcTopicCard } from '@/types/world';

const NPC_ROOT = 'src/data/npc';
const STREET_TALK = 'src/data/talk';

/** 两条路径 → id（与 src/data/talk.ts 的索引规则一致） */
function idOfTalk(p: string): string | null {
  const posix = p.replace(/\\/g, '/');
  const m = /\/talk\/([^/]+)\.json$/.exec(posix) ?? /\/([^/]+)\/talk\.json$/.exec(posix);
  return m ? m[1] : null;
}

/** 直接递归收集 talk.json——**不锚在 npc.json 上**：锚在 npc.json 会漏掉「写错目录的卡」。 */
function walkAll(dir: string, name: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walkAll(p, name));
    else if (e === name) out.push(p);
  }
  return out;
}

interface Row { id: string; file: string; cards: NpcTopicCard[] }
const ROWS: Row[] = [];
for (const talk of walkAll(NPC_ROOT, 'talk.json')) {
  const id = idOfTalk(talk)!;
  ROWS.push({ id, file: talk, cards: JSON.parse(readFileSync(talk, 'utf8')).topics ?? [] });
}
if (existsSync(STREET_TALK)) {
  for (const f of readdirSync(STREET_TALK)) {
    if (!f.endsWith('.json')) continue;
    const p = join(STREET_TALK, f);
    ROWS.push({ id: idOfTalk(p)!, file: p, cards: JSON.parse(readFileSync(p, 'utf8')).topics ?? [] });
  }
}

const CN = (s: string) => [...String(s)].length;

describe('N-E · 话题卡 · schema', () => {
  it('全员有卡：名册 124 人全部就位，扫描器没读空', () => {
    expect(ROWS.length, '话题卡总数应与名册一致').toBe(124);
    expect(new Set(ROWS.map((r) => r.id)).size, 'id 撞车会让加载器指向错误的卡').toBe(ROWS.length);
  });

  it('每人 ≥3 张卡，且每张卡三层齐全、facts ≥2、edge 非空', () => {
    for (const r of ROWS) {
      expect(r.cards.length, r.id + ' 的话题卡少于 3 张').toBeGreaterThanOrEqual(3);
      for (const c of r.cards) {
        const tag = r.id + ' / ' + c.l;
        expect(CN(c.say ?? ''), tag + ' 的 say 太短或缺失（无模型时它就是全部应答）').toBeGreaterThanOrEqual(4);
        expect(CN(c.say ?? ''), tag + ' 的 say 超过 80 字').toBeLessThanOrEqual(80);
        expect(c.inner, tag + ' 缺 inner（问到第二次就没得说）').toBeTruthy();
        expect(c.core, tag + ' 缺 core（说到第三层就断）').toBeTruthy();
        expect((c.facts ?? []).length, tag + ' 的 facts 少于 2 条（AI 没有展开范围就会编）').toBeGreaterThanOrEqual(2);
        expect(c.edge, tag + ' 缺 edge（没写边界 = 模型自由发挥）').toBeTruthy();
        expect((c.next ?? []).length, tag + ' 的 next 超过 3 条（chips 位不够）').toBeLessThanOrEqual(3);
        expect(/\{[a-zA-Z_][a-zA-Z0-9_.]*\}/.test(JSON.stringify(c)), tag + ' 残留占位符').toBe(false);
        expect(JSON.stringify(c).includes('_material') || JSON.stringify(c).includes('_draft'), tag + ' 正式卡里混进了草稿素材').toBe(false);
      }
    }
  });
});

describe('N-E · 话题卡 · 目录规整', () => {
  it('每张卡都与它的档案同住（所在目录必须有 npc.json）', () => {
    /* 实测踩过：两张卡被写进了没有档案的目录（oser 落在 central、frey 落在 wind），
       运行时照样能加载（glob 只看路径），却是「一 NPC 一文件夹」这条约定的破洞。
       锚在 npc.json 上扫会整片漏掉它们——所以这里直接扫 talk.json 再回头校验。 */
    /* 街头 15 人的卡按设计就在 src/data/talk/（他们没有自己的档案文件夹），故只查 npc 侧。 */
    const orphan = ROWS.filter((r) => r.file.replace(/\\/g, '/').startsWith('src/data/npc/'))
      .filter((r) => !existsSync(join(r.file.slice(0, r.file.lastIndexOf('\\')), 'npc.json')))
      .map((r) => r.id);
    expect(orphan, '这些卡放错了地方：' + orphan.join('、')).toEqual([]);
  });
});

describe('N-E · 话题卡 · 挂接与代价', () => {
  it('每张卡的标签都必须在该 NPC 的 topics 索引里（否则界面上点不到）', () => {
    for (const r of ROWS) {
      const topics = new Set((WB.npcs[r.id]?.topics ?? []).map((t) => t.l));
      expect(topics.size, r.id + ' 在名册里没有 topics 索引').toBeGreaterThan(0);
      for (const c of r.cards) {
        expect(topics.has(c.l), r.id + ' 的卡「' + c.l + '」不在 topics 索引里——玩家永远点不到它').toBe(true);
      }
    }
  });

  it('深水区带代价：带 core 的卡必须有 gate，代价字段类型合法', () => {
    for (const r of ROWS) {
      for (const c of r.cards) {
        if (c.core) expect(c.gate, r.id + ' / ' + c.l + '：有话可说却没有门，深水区会白送').toBeTruthy();
        const g = c.gain;
        if (!g) continue;
        if (g.rumor !== undefined) expect(typeof g.rumor, r.id + ' / ' + c.l + '：rumor 应为字符串').toBe('string');
        if (g.grudge !== undefined) expect(typeof g.grudge, r.id + ' / ' + c.l + '：grudge 应为布尔').toBe('boolean');
        if (g.flag !== undefined) expect(typeof g.flag, r.id + ' / ' + c.l + '：flag 应为字符串').toBe('string');
      }
    }
  });
});

describe('N-E · 全员覆盖（124/124）', () => {
  it('名册里每一个人都有话题卡——包括背景市民', () => {
    /* 从 1/124 到 124/124：这条是「铺完」的终点断言。
       它按数据动态取集合：以后谁把某个人的卡删了、或新接一位 NPC 却没写卡，这里都会红。 */
    const lack = Object.entries(WB.npcs).filter(([id]) => !hasTalk(id)).map(([id]) => id);
    expect(lack, '这些人还没有话题卡：' + lack.join('、')).toEqual([]);
  });

  it('wi4 与 wi3 的每一个人都有话题卡', () => {
    /* wi≥3 = 世界结构核心：六主神、原初与初代、魔界七领主、帝王、七塔守塔人、五殿大祭司、
       三大陆王、公会与议会首脑……（共 56 人）。这条按数据动态取集合：
       以后谁把某个 wi≥3 的卡删了、或新接了一位却没写卡，这里都会红。 */
    const lack: string[] = [];
    for (const [id, n] of Object.entries(WB.npcs)) {
      const wi = (n as { worldImportance?: number }).worldImportance ?? 0;
      if (wi >= 3 && !hasTalk(id)) lack.push(id);
    }
    expect(lack, '这些世界结构核心还没有话题卡：' + lack.join('、')).toEqual([]);
  });
});

describe('N-E · 街头话题卡（新路径 src/data/talk/<id>.json）', () => {
  it('街头 15 人**全部**有卡，且加载器认得这条新路径', async () => {
    /* 街头是玩家最早遇到的人：他们没卡，P1/P2/P3 的全部工作对这个玩家来说就不存在。
       15 人是名册里唯一一个「能一次做完」的完整集合——所以这里钉的是全集，不是样本。 */
    const people = JSON.parse(readFileSync('src/data/world/people.json', 'utf8')) as { npcs: Record<string, unknown> };
    const ids = Object.keys(people.npcs);
    expect(ids.length, '街头名册读空了 = 路径或结构变了').toBe(15);
    const lack: string[] = [];
    for (const id of ids) if (!hasTalk(id)) lack.push(id);
    expect(lack, '这些街头 NPC 还没有话题卡：' + lack.join('、')).toEqual([]);
    /* 只真加载两个人：glob 的解析路径对所有人一致，而全量 await 15 份动态 import
       在并行跑测试时会拖到超时（实测），那是测试写法问题、不是数据问题。 */
    for (const id of ['lita', 'mia']) {
      const cards = await loadTalk(id);
      expect(cards.length, id + ' 的卡没加载出来（glob 路径可能写错）').toBeGreaterThanOrEqual(3);
    }
  });
});
