const Layout = () => import("@/layout/index.vue");

/** 扩展管理：Extensions / Rules / 扩展命令（第一版只读 + 启停） */
export default {
  path: "/extensions",
  name: "Extensions",
  component: Layout,
  redirect: "/extensions/list",
  meta: {
    icon: "ep/magic-stick",
    title: "扩展管理",
    titleEn: "Extensions",
    rank: 3
  },
  children: [
    {
      path: "/extensions/list",
      name: "ExtensionList",
      component: () => import("@/views/extensions/list/index.vue"),
      meta: {
        title: "扩展列表",
        titleEn: "Extensions",
        icon: "ep/box",
        roles: ["admin", "operator"]
      }
    },
    {
      path: "/extensions/rules",
      name: "ExtensionRules",
      component: () => import("@/views/extensions/rules/index.vue"),
      meta: {
        title: "规则",
        titleEn: "Rules",
        icon: "ep/document",
        roles: ["admin", "operator"]
      }
    },
    {
      path: "/extensions/commands",
      name: "ExtensionCommands",
      component: () => import("@/views/extensions/commands/index.vue"),
      meta: {
        title: "扩展命令",
        titleEn: "Commands",
        icon: "ep/position",
        roles: ["admin", "operator"]
      }
    }
  ]
} satisfies RouteConfigsTable;
