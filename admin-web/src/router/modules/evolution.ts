const Layout = () => import("@/layout/index.vue");

/** AI 世界演化：Evolution Console（观察 → 上下文 → 提案 → Rules → 落地 → 因果链） */
export default {
  path: "/evolution",
  name: "Evolution",
  component: Layout,
  redirect: "/evolution/console",
  meta: {
    icon: "ep/magic-stick",
    title: "AI 演化",
    titleEn: "Evolution",
    rank: 7
  },
  children: [
    {
      path: "/evolution/console",
      name: "EvolutionConsole",
      component: () => import("@/views/evolution/index.vue"),
      meta: {
        title: "演化控制台",
        titleEn: "Evolution Console",
        icon: "ep/magic-stick",
        roles: ["admin", "operator"]
      }
    }
  ]
} satisfies RouteConfigsTable;
