const Layout = () => import("@/layout/index.vue");

/** 运行监控：Logs / Events / AI Calls / Errors */
export default {
  path: "/observability",
  name: "Observability",
  component: Layout,
  redirect: "/observability/logs",
  meta: {
    icon: "ep/warning",
    title: "运行监控",
    titleEn: "Observability",
    rank: 6
  },
  children: [
    {
      path: "/observability/logs",
      name: "ObsLogs",
      component: () => import("@/views/observability/logs/index.vue"),
      meta: { title: "日志", titleEn: "Logs", icon: "ep/document" }
    },
    {
      path: "/observability/events",
      name: "ObsEvents",
      component: () => import("@/views/observability/events/index.vue"),
      meta: { title: "事件流", titleEn: "Events", icon: "ep/bell" }
    },
    {
      path: "/observability/ai-calls",
      name: "ObsAiCalls",
      component: () => import("@/views/observability/ai-calls/index.vue"),
      meta: { title: "AI 调用", titleEn: "AI Calls", icon: "ep/coin" }
    },
    {
      path: "/observability/errors",
      name: "ObsErrors",
      component: () => import("@/views/observability/errors/index.vue"),
      meta: { title: "错误", titleEn: "Errors", icon: "ep/circle-close" }
    }
  ]
} satisfies RouteConfigsTable;
