// 平台账号 Mock（真实部署时替换为 System 模块的用户服务）
// 角色模型见 docs/ADMIN-PERMISSION.md：Admin / Operator / Viewer
import { defineFakeRoute } from "vite-plugin-fake-server/client";

/** 三种平台角色的统一权限集合（与前端权限码一一对应） */
const ROLE_PERMISSIONS: Record<string, string[]> = {
  admin: ["*:*:*"],
  operator: [
    "world:read",
    "world:write",
    "command:execute",
    "memory:read",
    "memory:write",
    "observability:read"
  ],
  viewer: ["world:read", "memory:read", "observability:read"]
};

const ROLE_NICKNAME: Record<string, string> = {
  admin: "平台管理员",
  operator: "世界运营",
  viewer: "只读观察员"
};

interface Account {
  username: string;
  password: string;
  role: string;
}

/** 第一版内置账号；真实化时由 /admin-api/system/users 承接 */
const ACCOUNTS: Account[] = [
  { username: "admin", password: "admin123", role: "admin" },
  { username: "operator", password: "operator123", role: "operator" },
  { username: "viewer", password: "viewer123", role: "viewer" }
];

export default defineFakeRoute([
  {
    url: "/login",
    method: "post",
    response: ({ body }) => {
      const { username, password } = body ?? {};
      const account = ACCOUNTS.find(a => a.username === username);
      if (!account || account.password !== password) {
        return {
          success: false,
          msg: "账号或密码错误（内置账号：admin/admin123、operator/operator123、viewer/viewer123）"
        };
      }
      return {
        success: true,
        data: {
          avatar: "https://avatars.githubusercontent.com/u/44761321",
          username: account.username,
          nickname: ROLE_NICKNAME[account.role],
          roles: [account.role],
          permissions: ROLE_PERMISSIONS[account.role],
          accessToken: `eyJhbGciOiJIUzUxMiJ9.${account.username}`,
          refreshToken: `eyJhbGciOiJIUzUxMiJ9.${account.username}Refresh`,
          expires: "2030/10/30 00:00:00"
        }
      };
    }
  }
]);
