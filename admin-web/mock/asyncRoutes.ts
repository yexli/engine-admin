// 动态路由预留：管理后台菜单全部使用前端静态路由（src/router/modules）。
// 接入真实后端权限服务后，可在此返回服务端下发的路由。
import { defineFakeRoute } from "vite-plugin-fake-server/client";

export default defineFakeRoute([
  {
    url: "/get-async-routes",
    method: "get",
    response: () => {
      return {
        success: true,
        data: []
      };
    }
  }
]);
