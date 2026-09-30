const Layout = () => import("@/layout/index.vue");

/** Memory：Stores / Records / Retrieval / Embedding */
export default {
  path: "/memory",
  name: "Memory",
  component: Layout,
  redirect: "/memory/stores",
  meta: {
    icon: "ep/collection",
    title: "记忆库",
    titleEn: "Memory",
    rank: 5
  },
  children: [
    {
      path: "/memory/stores",
      name: "MemoryStores",
      component: () => import("@/views/memory/stores/index.vue"),
      meta: {
        title: "记忆库列表",
        titleEn: "Stores",
        icon: "ep/box"
      }
    },
    {
      path: "/memory/records",
      name: "MemoryRecords",
      component: () => import("@/views/memory/records/index.vue"),
      meta: {
        title: "记忆记录",
        titleEn: "Memories",
        icon: "ep/collection"
      }
    },
    {
      path: "/memory/retrieval",
      name: "MemoryRetrieval",
      component: () => import("@/views/memory/retrieval/index.vue"),
      meta: {
        title: "检索调试",
        titleEn: "Retrieval",
        icon: "ep/search",
        roles: ["admin", "operator"]
      }
    },
    {
      path: "/memory/embedding",
      name: "MemoryEmbedding",
      component: () => import("@/views/memory/embedding/index.vue"),
      meta: {
        title: "向量嵌入",
        titleEn: "Embedding",
        icon: "ep/data-line"
      }
    }
  ]
} satisfies RouteConfigsTable;
