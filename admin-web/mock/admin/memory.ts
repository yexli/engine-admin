// Memory 管理 Mock
// 当前 memory/ 是纯库（无 HTTP API），以下为管理后台目标数据形状。
// 真实化接口见 docs/ADMIN-API-GAP.md
import { defineFakeRoute } from "vite-plugin-fake-server/client";
import { minutesAgo, paginate } from "./_utils";

const stores = [
  { id: "st-main", name: "main", provider: "pgvector", dimension: 1536, documentCount: 1284, status: "healthy", description: "主记忆库（长期记忆）" },
  { id: "st-events", name: "world-events", provider: "pgvector", dimension: 1536, documentCount: 8620, status: "healthy", description: "世界事实向量化存档" },
  { id: "st-npc", name: "npc-personas", provider: "chroma", dimension: 768, documentCount: 214, status: "degraded", description: "NPC 人格与偏好记忆" }
];

const CONTENTS = [
  "玩家在酒馆与铁匠交谈后，对玩家态度由冷淡转为中立，倾向于交易武器。",
  "黑松森林深处出现过狼嚎，村民警告日落后不要靠近东门。",
  "城主曾承诺三天内修复北桥，但材料尚未到位。",
  "玩家用 12 金币买下了一把旧短剑，铁匠记住了这笔交易。",
  "旅店老板娘提到，最近有个穿灰斗篷的外乡人打听矿洞的位置。",
  "矿洞在暴雨后暂时封闭，守卫只放行持通行证的人。",
  "药师欠了商会一笔债，正在低价出售草药回笼资金。",
  "玩家帮助卫兵抓住小偷后，卫兵队长允诺有事可以来找他。"
];

const memoryRecords = Array.from({ length: 63 }, (_, i) => ({
  id: `mem-${String(6300 - i)}`,
  store: stores[i % stores.length].name,
  entity: ["player", "npc-blacksmith", "npc-innkeeper", "npc-guard-captain", "npc-herbalist"][i % 5],
  type: ["observation", "conversation", "event", "preference"][i % 4],
  content: CONTENTS[i % CONTENTS.length],
  importance: Number((0.3 + ((i * 7) % 10) / 15).toFixed(2)),
  createdAt: minutesAgo((63 - i) * 47 + 5),
  updatedAt: minutesAgo((63 - i) * 47 + 2)
}));

export default defineFakeRoute([
  {
    url: "/admin-api/memory/stores",
    method: "get",
    response: () => ({ success: true, data: { list: stores, total: stores.length } })
  },
  {
    url: "/admin-api/memory/records",
    method: "get",
    response: ({ query }) => {
      let list = memoryRecords;
      if (query.entity) list = list.filter(r => r.entity.includes(query.entity as string));
      if (query.type) list = list.filter(r => r.type === query.type);
      if (query.store) list = list.filter(r => r.store === query.store);
      if (query.keyword) list = list.filter(r => r.content.includes(query.keyword as string));
      return { success: true, data: paginate(list, query) };
    }
  },
  {
    url: "/admin-api/memory/records/:id",
    method: "delete",
    response: ({ params }) => {
      const idx = memoryRecords.findIndex(r => r.id === params.id);
      if (idx >= 0) memoryRecords.splice(idx, 1);
      return { success: true, data: null };
    }
  },
  {
    url: "/admin-api/memory/retrieval",
    method: "post",
    response: ({ body }) => {
      // 伪向量检索：按关键词命中 + 确定性分数，形状与真实检索一致
      const q: string = body?.query ?? "";
      const topK = Math.min(20, Math.max(1, Number(body?.topK ?? 5)));
      const entity = body?.entity ?? "";
      let pool = memoryRecords.filter(r => !entity || r.entity === entity);
      const scored = pool
        .map(r => {
          const hit = q ? (r.content.includes(q) ? 0.95 : 0) : 0;
          const base = 0.35 + ((r.id.charCodeAt(4) + q.length) % 40) / 100;
          return { ...r, score: Number(Math.max(hit, base).toFixed(4)) };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
      return {
        success: true,
        data: {
          query: q,
          took: 12 + (q.length % 9),
          results: scored.map(r => ({
            id: r.id,
            content: r.content,
            score: r.score,
            source: r.store,
            metadata: { entity: r.entity, type: r.type, createdAt: r.createdAt }
          }))
        }
      };
    }
  },
  {
    url: "/admin-api/memory/embedding",
    method: "get",
    response: () => ({
      success: true,
      data: {
        models: [
          { name: "text-embedding-3-small", provider: "openai", dimension: 1536, status: "enabled" },
          { name: "nomic-embed-text", provider: "local-ollama", dimension: 768, status: "disabled" }
        ],
        stats: { totalEmbeddings: 10118, last24h: 412, avgLatencyMs: 86, failureRate: 0.4 }
      }
    })
  }
]);
