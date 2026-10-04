/* ============================================================
   话题内容卡加载器（P2 · 《NPC 立体化与深入对话方案》§4.2）
   ------------------------------------------------------------
   一 NPC 一文件：<板块>/<id>/talk.json，**懒加载**。

   为什么不并进 npc.json：那份走 import.meta.glob(..., { eager: true })
   被打进主包（109 人约 300KB），而话题卡只在开对话时用得到——
   人均 1.5–2KB，全铺开再加约 200KB 首包。这里用非 eager 的 glob，
   每个文件切一个独立 chunk，开谁的对话才拉谁的卡。

   与 data/lore.ts 的 loadPersonLore 同策略（幂等 + 失败退化空表）。
   ============================================================ */
import type { NpcTopicCard } from '@/types/world';

/* 两条路径都要扫：
     · ./npc/<板块>/<id>/talk.json —— 档案人物（文件夹里与 npc.json 同住）
     · ./talk/<id>.json —— **街头 NPC**：他们的档案在 people.json 里，没有自己的文件夹，
       而 data/npc/index.ts 的聚合器会把任何新目录装订进名册（npcArchive 断言目录白名单与 109 条），
       所以街头的话题卡另起一目录，不动档案结构。 */
const FILES = {
  ...import.meta.glob<{ default?: { topics?: NpcTopicCard[] } }>('./npc/*/*/talk.json'),
  ...import.meta.glob<{ default?: { topics?: NpcTopicCard[] } }>('./talk/*.json'),
};

/** 路径 → id 的索引（目录名即 id，见 data/npc/index.ts 的约定），首次访问时建一次 */
let index: Record<string, () => Promise<{ default?: { topics?: NpcTopicCard[] } }>> | null = null;
const cache: Record<string, NpcTopicCard[] | undefined> = {};
const pending: Record<string, Promise<NpcTopicCard[]> | undefined> = {};

function idx() {
  if (!index) {
    index = {};
    for (const [p, load] of Object.entries(FILES)) {
      /* 先认「./talk/<id>.json」，再认「…/<id>/talk.json」——两条路径都归到同一个 id 键 */
      const m = /\/talk\/([^/]+)\.json$/.exec(p) ?? /\/([^/]+)\/talk\.json$/.exec(p);
      if (m) index[m[1]] = load;
    }
  }
  return index;
}

/** 这个人有没有话题卡（不触发加载） */
export const hasTalk = (id: string): boolean => !!idx()[id];

/** 已加载的卡片；未加载返回空表——调用方应先 ensure */
export const talkOf = (id: string): NpcTopicCard[] => cache[id] ?? [];

/** 幂等加载：同一 id 并发调用只拉一次；失败退化为空表而不是抛错 */
export function loadTalk(id: string): Promise<NpcTopicCard[]> {
  const done = cache[id];
  if (done) return Promise.resolve(done);
  const inflight = pending[id];
  if (inflight) return inflight;
  const load = idx()[id];
  if (!load) return Promise.resolve([]);
  const task = load()
    .then((m) => {
      const cards = m.default?.topics ?? [];
      cache[id] = cards;
      return cards;
    })
    .catch(() => {
      cache[id] = [];
      return [] as NpcTopicCard[];
    })
    .finally(() => {
      delete pending[id];
    });
  pending[id] = task;
  return task;
}
