// Extensions / Rules / 扩展命令 Mock
// 说明：引擎 V1.0 的规则经代码注册（src/rules），无运行时查询 API。
// 这里 mock 的是「管理视角」的数据形状；真实化接口见 docs/ADMIN-API-GAP.md
import { defineFakeRoute } from "vite-plugin-fake-server/client";
import { minutesAgo, paginate } from "./_utils";

const extensions = [
  {
    id: "ext-core-rules",
    name: "core-rules",
    version: "1.0.0",
    status: "enabled",
    description: "内核通用规则：实体增删改、关系、移动、时间与天气",
    capabilities: ["entity.create", "entity.remove", "entity.update", "relation.set", "entity.move", "time.advance", "weather.change"],
    loadedAt: minutesAgo(600)
  },
  {
    id: "ext-rpg-compat",
    name: "rpg-compat",
    version: "1.0.0",
    status: "enabled",
    description: "RPG 兼容规则：攻击 / 交谈 / 态度 / 生成实体",
    capabilities: ["combat.attack", "social.talk", "social.attitude", "entity.spawn"],
    loadedAt: minutesAgo(600)
  },
  {
    id: "ext-scheduler",
    name: "scheduler",
    version: "1.0.0",
    status: "enabled",
    description: "事件调度器：延迟事件入队与到期分发",
    capabilities: ["event.schedule", "event.defer"],
    loadedAt: minutesAgo(600)
  },
  {
    id: "ext-narrative",
    name: "narrative-bridge",
    version: "0.3.1",
    status: "disabled",
    description: "叙事桥接扩展（预留）：把世界事实推给 AI Gateway 生成叙事",
    capabilities: ["narrate.event"],
    loadedAt: null
  }
];

const rules = [
  { id: "rule-create-entity", name: "create_entity", command: "create_entity", extension: "core-rules", status: "enabled", priority: 10, updatedAt: minutesAgo(600) },
  { id: "rule-remove-entity", name: "remove_entity", command: "remove_entity", extension: "core-rules", status: "enabled", priority: 10, updatedAt: minutesAgo(600) },
  { id: "rule-update-attribute", name: "update_attribute", command: "update_attribute", extension: "core-rules", status: "enabled", priority: 10, updatedAt: minutesAgo(600) },
  { id: "rule-set-relation", name: "set_relation", command: "set_relation", extension: "core-rules", status: "enabled", priority: 10, updatedAt: minutesAgo(600) },
  { id: "rule-move-entity", name: "move_entity", command: "move_entity", extension: "core-rules", status: "enabled", priority: 10, updatedAt: minutesAgo(600) },
  { id: "rule-move", name: "move", command: "move", extension: "core-rules", status: "enabled", priority: 20, updatedAt: minutesAgo(600) },
  { id: "rule-advance-time", name: "advance_time", command: "advance_time", extension: "core-rules", status: "enabled", priority: 5, updatedAt: minutesAgo(600) },
  { id: "rule-change-weather", name: "change_weather", command: "change_weather", extension: "core-rules", status: "enabled", priority: 5, updatedAt: minutesAgo(600) },
  { id: "rule-attack", name: "attack", command: "attack", extension: "rpg-compat", status: "enabled", priority: 10, updatedAt: minutesAgo(600) },
  { id: "rule-talk", name: "talk", command: "talk", extension: "rpg-compat", status: "enabled", priority: 10, updatedAt: minutesAgo(600) },
  { id: "rule-set-attitude", name: "set_attitude", command: "set_attitude", extension: "rpg-compat", status: "enabled", priority: 10, updatedAt: minutesAgo(600) },
  { id: "rule-spawn-entity", name: "spawn_entity", command: "spawn_entity", extension: "rpg-compat", status: "enabled", priority: 10, updatedAt: minutesAgo(600) }
];

const extensionCommands = [
  { id: "cmd-create-entity", type: "create_entity", extension: "core-rules", status: "enabled", description: "创建实体（payload: id/type/name/location/attributes）" },
  { id: "cmd-remove-entity", type: "remove_entity", extension: "core-rules", status: "enabled", description: "移除实体（targetId）" },
  { id: "cmd-update-attribute", type: "update_attribute", extension: "core-rules", status: "enabled", description: "更新实体属性（targetId + payload.key/value）" },
  { id: "cmd-set-relation", type: "set_relation", extension: "core-rules", status: "enabled", description: "设置关系（actorId=source + payload.target/type/value）" },
  { id: "cmd-move-entity", type: "move_entity", extension: "core-rules", status: "enabled", description: "移动实体（targetId + payload.location）" },
  { id: "cmd-move", type: "move", extension: "core-rules", status: "enabled", description: "玩家移动（targetId=目的地）" },
  { id: "cmd-advance-time", type: "advance_time", extension: "core-rules", status: "enabled", description: "推进时间（amount=刻数）" },
  { id: "cmd-change-weather", type: "change_weather", extension: "core-rules", status: "enabled", description: "变更天气（text=天气名）" },
  { id: "cmd-attack", type: "attack", extension: "rpg-compat", status: "enabled", description: "攻击（actorId + targetId + amount）" },
  { id: "cmd-talk", type: "talk", extension: "rpg-compat", status: "enabled", description: "交谈（actorId + targetId + text）" },
  { id: "cmd-set-attitude", type: "set_attitude", extension: "rpg-compat", status: "enabled", description: "调整态度（targetId + amount）" },
  { id: "cmd-spawn-entity", type: "spawn_entity", extension: "rpg-compat", status: "enabled", description: "生成实体（payload: id/name/kind/loc）" }
];

export default defineFakeRoute([
  {
    url: "/admin-api/extensions",
    method: "get",
    response: ({ query }) => {
      let list = extensions;
      if (query.name) list = list.filter(e => e.name.includes(query.name as string));
      if (query.status) list = list.filter(e => e.status === query.status);
      return { success: true, data: paginate(list, query) };
    }
  },
  {
    url: "/admin-api/extensions/:id/status",
    method: "put",
    response: ({ body, params }) => {
      const ext = extensions.find(e => e.id === params.id);
      if (ext) ext.status = body.status;
      return { success: true, data: ext };
    }
  },
  {
    url: "/admin-api/rules",
    method: "get",
    response: ({ query }) => {
      let list = rules;
      if (query.name) list = list.filter(r => r.name.includes(query.name as string));
      if (query.extension) list = list.filter(r => r.extension === query.extension);
      if (query.status) list = list.filter(r => r.status === query.status);
      return { success: true, data: paginate(list, query) };
    }
  },
  {
    url: "/admin-api/rules/:id/status",
    method: "put",
    response: ({ body, params }) => {
      const rule = rules.find(r => r.id === params.id);
      if (rule) rule.status = body.status;
      return { success: true, data: rule };
    }
  },
  {
    url: "/admin-api/extension-commands",
    method: "get",
    response: ({ query }) => {
      let list = extensionCommands;
      if (query.type) list = list.filter(c => c.type.includes(query.type as string));
      if (query.extension) list = list.filter(c => c.extension === query.extension);
      return { success: true, data: paginate(list, query) };
    }
  }
]);
