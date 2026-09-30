// System Mock：Users / Roles / Permissions / Settings / Status
import { defineFakeRoute } from "vite-plugin-fake-server/client";
import { minutesAgo, paginate } from "./_utils";

const users = [
  { id: "usr-admin", username: "admin", nickname: "平台管理员", roles: ["admin"], status: "active", createdAt: minutesAgo(525600), lastLoginAt: minutesAgo(12), remark: "内置账号" },
  { id: "usr-operator", username: "operator", nickname: "世界运营", roles: ["operator"], status: "active", createdAt: minutesAgo(43200), lastLoginAt: minutesAgo(240), remark: "" },
  { id: "usr-viewer", username: "viewer", nickname: "只读观察员", roles: ["viewer"], status: "active", createdAt: minutesAgo(20160), lastLoginAt: minutesAgo(1440), remark: "" },
  { id: "usr-guest", username: "guest-demo", nickname: "演示来宾", roles: ["viewer"], status: "disabled", createdAt: minutesAgo(10080), lastLoginAt: minutesAgo(7200), remark: "演示用，已停用" }
];

const PERMISSION_CATALOG = [
  { code: "world:read", name: "World 读取", group: "World", description: "查看世界、状态、实体、事件" },
  { code: "world:write", name: "World 写入", group: "World", description: "创建世界、推进时间、变更天气、暂停/恢复" },
  { code: "command:execute", name: "命令执行", group: "World", description: "通过 Command 调试台执行命令（影响世界状态）" },
  { code: "gateway:manage", name: "Gateway 管理", group: "AI Gateway", description: "管理 Provider / Model / Router / Pipeline / API Key" },
  { code: "memory:read", name: "Memory 读取", group: "Memory", description: "查看记忆库与记录，执行检索测试" },
  { code: "memory:write", name: "Memory 写入", group: "Memory", description: "删除记忆记录" },
  { code: "observability:read", name: "监控读取", group: "Observability", description: "查看日志、AI 调用、错误" },
  { code: "system:manage", name: "系统管理", group: "System", description: "用户、角色、系统设置管理" }
];

const roles = [
  { name: "admin", nickname: "管理员", description: "拥有全部权限", permissions: ["*:*:*"], builtin: true },
  { name: "operator", nickname: "运营", description: "可操作世界与命令，可读写记忆，可查看监控", permissions: ["world:read", "world:write", "command:execute", "memory:read", "memory:write", "observability:read"], builtin: true },
  { name: "viewer", nickname: "观察员", description: "只读：世界、记忆、监控", permissions: ["world:read", "memory:read", "observability:read"], builtin: true }
];

const settings = [
  { key: "platform.name", name: "平台名称", value: "World Driving Engine Admin", type: "string", group: "general", description: "浏览器标题与界面展示名" },
  { key: "platform.language", name: "界面语言", value: "zh-CN", type: "string", group: "general", description: "管理后台语言" },
  { key: "world.maxWorlds", name: "最大世界数", value: 16, type: "number", group: "world", description: "注册表模式下允许并存的世界上限" },
  { key: "world.autoPause", name: "空闲自动暂停", value: false, type: "boolean", group: "world", description: "无命令与调度事件时自动暂停 tick" },
  { key: "gateway.requestTimeoutMs", name: "AI 请求超时", value: 10000, type: "number", group: "gateway", description: "AI Gateway 上游超时（毫秒）" },
  { key: "gateway.dailyBudgetUsd", name: "AI 日预算上限", value: 20, type: "number", group: "gateway", description: "全平台每日成本上限（USD）" },
  { key: "memory.retrievalTopK", name: "检索默认 Top-K", value: 5, type: "number", group: "memory", description: "记忆检索默认返回条数" },
  { key: "observability.logRetentionDays", name: "日志保留天数", value: 30, type: "number", group: "observability", description: "平台日志保留时长" }
];

export default defineFakeRoute([
  {
    url: "/admin-api/system/users",
    method: "get",
    response: ({ query }) => {
      let list = users;
      if (query.keyword) {
        const k = query.keyword as string;
        list = list.filter(u => u.username.includes(k) || u.nickname.includes(k));
      }
      if (query.role) list = list.filter(u => u.roles.includes(query.role as string));
      if (query.status) list = list.filter(u => u.status === query.status);
      return { success: true, data: paginate(list, query) };
    }
  },
  {
    url: "/admin-api/system/users",
    method: "post",
    response: ({ body }) => {
      if (users.some(u => u.username === body.username)) {
        return { success: false, msg: "用户名已存在" };
      }
      const user = {
        id: `usr-${Date.now()}`,
        username: body.username,
        nickname: body.nickname ?? body.username,
        roles: body.roles ?? ["viewer"],
        status: "active",
        createdAt: new Date().toISOString(),
        lastLoginAt: null,
        remark: body.remark ?? ""
      };
      users.push(user);
      return { success: true, data: user };
    }
  },
  {
    url: "/admin-api/system/users/:id",
    method: "put",
    response: ({ body, params }) => {
      const u = users.find(x => x.id === params.id);
      if (!u) return { success: false, msg: "用户不存在" };
      if (body.nickname !== undefined) u.nickname = body.nickname;
      if (body.roles !== undefined) u.roles = body.roles;
      if (body.status !== undefined) u.status = body.status;
      if (body.remark !== undefined) u.remark = body.remark;
      return { success: true, data: u };
    }
  },
  {
    url: "/admin-api/system/permissions",
    method: "get",
    response: () => ({ success: true, data: { catalog: PERMISSION_CATALOG, roles } })
  },
  {
    url: "/admin-api/system/roles/:name/permissions",
    method: "put",
    response: ({ body, params }) => {
      const r = roles.find(x => x.name === params.name);
      if (!r) return { success: false, msg: "角色不存在" };
      if (r.builtin) return { success: false, msg: "内置角色不可修改（第一版）" };
      r.permissions = body.permissions ?? [];
      return { success: true, data: r };
    }
  },
  {
    url: "/admin-api/system/settings",
    method: "get",
    response: ({ query }) => {
      let list = settings;
      if (query.group) list = list.filter(s => s.group === query.group);
      return { success: true, data: { list, total: list.length } };
    }
  },
  {
    url: "/admin-api/system/settings/:key",
    method: "put",
    response: ({ body, params }) => {
      const s = settings.find(x => x.key === params.key);
      if (!s) return { success: false, msg: "配置项不存在" };
      s.value = body.value;
      return { success: true, data: s };
    }
  },
  {
    url: "/admin-api/system/status",
    method: "get",
    response: () => ({
      success: true,
      data: {
        services: [
          { name: "world-engine", status: "up", version: "1.0.0", uptime: "6d 4h", detail: "http://127.0.0.1:8787" },
          { name: "ai-gateway", status: "up", version: "1.0.0", uptime: "6d 4h", detail: "http://127.0.0.1:8788" },
          { name: "memory", status: "degraded", version: "1.0.0", uptime: "6d 4h", detail: "store npc-personals 延迟升高" },
          { name: "admin-api(mock)", status: "up", version: "dev", uptime: "-", detail: "当前管理面数据为 Mock" }
        ],
        engine: { worlds: 3, running: 2, tickRate: "1 tick/s", lastErrorAt: minutesAgo(38) }
      }
    })
  }
]);
