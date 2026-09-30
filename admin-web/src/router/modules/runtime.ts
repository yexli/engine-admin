const Layout = () => import("@/layout/index.vue");

/** 世界运行：State / Entities / Locations / Relations / Events / Commands / Scheduler / Monitor
 *  所有页面共享 worldStore 的当前世界上下文
 */
export default {
  path: "/runtime",
  name: "Runtime",
  component: Layout,
  redirect: "/runtime/state",
  meta: {
    icon: "ep/cpu",
    title: "世界运行",
    titleEn: "Runtime",
    rank: 2
  },
  children: [
    {
      path: "/runtime/state",
      name: "RuntimeState",
      component: () => import("@/views/runtime/state/index.vue"),
      meta: { title: "状态", titleEn: "State", icon: "ep/notebook" }
    },
    {
      path: "/runtime/entities",
      name: "RuntimeEntities",
      component: () => import("@/views/runtime/entities/index.vue"),
      meta: { title: "实体", titleEn: "Entities", icon: "ep/user" }
    },
    {
      path: "/runtime/locations",
      name: "RuntimeLocations",
      component: () => import("@/views/runtime/locations/index.vue"),
      meta: { title: "地点", titleEn: "Locations", icon: "ep/map-location" }
    },
    {
      path: "/runtime/relations",
      name: "RuntimeRelations",
      component: () => import("@/views/runtime/relations/index.vue"),
      meta: { title: "关系", titleEn: "Relations", icon: "ep/connection" }
    },
    {
      path: "/runtime/events",
      name: "RuntimeEvents",
      component: () => import("@/views/runtime/events/index.vue"),
      meta: { title: "事件", titleEn: "Events", icon: "ep/bell" }
    },
    {
      path: "/runtime/commands",
      name: "RuntimeCommands",
      component: () => import("@/views/runtime/commands/index.vue"),
      meta: {
        title: "命令调试台",
        titleEn: "Command Console",
        icon: "ep/position",
        roles: ["admin", "operator"]
      }
    },
    {
      path: "/runtime/scheduler",
      name: "RuntimeScheduler",
      component: () => import("@/views/runtime/scheduler/index.vue"),
      meta: { title: "调度器", titleEn: "Scheduler", icon: "ep/timer" }
    },
    {
      path: "/runtime/monitor",
      name: "RuntimeMonitor",
      component: () => import("@/views/runtime/monitor/index.vue"),
      meta: { title: "运行监视", titleEn: "Monitor", icon: "ep/monitor" }
    }
  ]
} satisfies RouteConfigsTable;
