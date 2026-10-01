const Layout = () => import("@/layout/index.vue");

/** AI Gateway：Providers / Models / Router / Pipelines / API Keys / Usage */
export default {
  path: "/gateway",
  name: "Gateway",
  component: Layout,
  redirect: "/gateway/providers",
  meta: {
    icon: "ep/coin",
    title: "AI 网关",
    titleEn: "AI Gateway",
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
      path: "/gateway/providers",
      name: "GatewayProviders",
      component: () => import("@/views/gateway/providers/index.vue"),
      meta: {
        title: "提供方",
        titleEn: "Providers",
        icon: "ep/connection",
        roles: ["admin"]
      }
    },
    {
      path: "/gateway/models",
      name: "GatewayModels",
      component: () => import("@/views/gateway/models/index.vue"),
      meta: {
        title: "模型",
        titleEn: "Models",
        icon: "ep/cpu",
        roles: ["admin"]
      }
    },
    {
      path: "/gateway/router",
      name: "GatewayRouter",
      component: () => import("@/views/gateway/router/index.vue"),
      meta: {
        title: "模型路由",
        titleEn: "Router",
        icon: "ep/guide",
        roles: ["admin"]
      }
    },
    {
      path: "/gateway/pipelines",
      name: "GatewayPipelines",
      component: () => import("@/views/gateway/pipelines/index.vue"),
      meta: {
        title: "管线",
        titleEn: "Pipelines",
        icon: "ep/histogram",
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
    },
    {
      path: "/gateway/usage",
      name: "GatewayUsage",
      component: () => import("@/views/gateway/usage/index.vue"),
      meta: {
        title: "用量",
        titleEn: "Usage",
        icon: "ep/trend-charts",
        roles: ["admin"]
      }
    }
  ]
} satisfies RouteConfigsTable;
