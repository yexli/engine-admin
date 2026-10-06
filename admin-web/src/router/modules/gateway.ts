const Layout = () => import("@/layout/index.vue");

/** 接入管理（Access）：游戏方（租户） / API 密钥
 *  Engine Control Plane 收束（docs/ENGINE-CORE-SCOPE.md §3.5）：
 *  AI 网关类页面（providers/models/router/pipelines/usage）已随 AI 功能冻结移除。
 */
export default {
  path: "/gateway",
  name: "Gateway",
  component: Layout,
  redirect: "/gateway/keys",
  meta: {
    icon: "ep/key",
    title: "接入管理",
    titleEn: "Access",
    rank: 4
  },
  children: [
    {
      path: "/gateway/games",
      name: "GatewayGames",
      component: () => import("@/views/gateway/games/index.vue"),
      meta: {
        title: "游戏方",
        titleEn: "Game Studios",
        icon: "ep/avatar",
        roles: ["admin"]
      }
    },
    {
      path: "/gateway/keys",
      name: "GatewayKeys",
      component: () => import("@/views/gateway/keys/index.vue"),
      meta: {
        title: "API 密钥",
        titleEn: "Keys",
        icon: "ep/key",
        roles: ["admin"]
      }
    }
  ]
} satisfies RouteConfigsTable;
