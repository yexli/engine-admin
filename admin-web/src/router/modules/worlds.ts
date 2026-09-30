const Layout = () => import("@/layout/index.vue");

/** 世界管理：列表 / 详情 */
export default {
  path: "/worlds",
  name: "Worlds",
  component: Layout,
  redirect: "/worlds/list",
  meta: {
    icon: "ep/compass",
    title: "世界管理",
    titleEn: "Worlds",
    rank: 1
  },
  children: [
    {
      path: "/worlds/list",
      name: "WorldList",
      component: () => import("@/views/worlds/list/index.vue"),
      meta: {
        title: "世界列表",
        titleEn: "World List",
        icon: "ep/list"
      }
    },
    {
      path: "/worlds/detail/:id",
      name: "WorldDetail",
      component: () => import("@/views/worlds/detail/index.vue"),
      meta: {
        title: "世界详情",
        titleEn: "World Detail",
        showLink: false,
        showParent: true,
        activePath: "/worlds/list"
      }
    }
  ]
} satisfies RouteConfigsTable;
