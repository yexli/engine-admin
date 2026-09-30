const Layout = () => import("@/layout/index.vue");

export default {
  path: "/",
  name: "Home",
  component: Layout,
  redirect: "/dashboard",
  meta: {
    icon: "ep/odometer",
    title: "总览",
    titleEn: "Dashboard",
    rank: 0
  },
  children: [
    {
      path: "/dashboard",
      name: "Dashboard",
      component: () => import("@/views/dashboard/index.vue"),
      meta: {
        title: "总览",
        titleEn: "Dashboard"
      }
    }
  ]
} satisfies RouteConfigsTable;
