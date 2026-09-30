const Layout = () => import("@/layout/index.vue");

/** 系统：Users / Permissions / Settings / System Status（第一版仅 Admin） */
export default {
  path: "/system",
  name: "System",
  component: Layout,
  redirect: "/system/users",
  meta: {
    icon: "ep/setting",
    title: "系统管理",
    titleEn: "System",
    rank: 7
  },
  children: [
    {
      path: "/system/users",
      name: "SystemUsers",
      component: () => import("@/views/system/users/index.vue"),
      meta: {
        title: "用户管理",
        titleEn: "Users",
        icon: "ep/user",
        roles: ["admin"]
      }
    },
    {
      path: "/system/permissions",
      name: "SystemPermissions",
      component: () => import("@/views/system/permissions/index.vue"),
      meta: {
        title: "权限管理",
        titleEn: "Permissions",
        icon: "ep/lock",
        roles: ["admin"]
      }
    },
    {
      path: "/system/settings",
      name: "SystemSettings",
      component: () => import("@/views/system/settings/index.vue"),
      meta: {
        title: "系统设置",
        titleEn: "Settings",
        icon: "ep/setting",
        roles: ["admin"]
      }
    },
    {
      path: "/system/status",
      name: "SystemStatus",
      component: () => import("@/views/system/status/index.vue"),
      meta: {
        title: "系统状态",
        titleEn: "Status",
        icon: "ep/monitor",
        roles: ["admin"]
      }
    }
  ]
} satisfies RouteConfigsTable;
