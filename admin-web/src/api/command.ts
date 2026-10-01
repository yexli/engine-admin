/** Command 调试客户端
 *  命令目录来自引擎内置规则的真实契约（world-engine/src/rules/*.ts 的 for 字段）。
 *  执行走真实引擎 POST /v1/worlds/{id}/commands。
 */
import { http } from "@/utils/http";
import type { CommandHistoryEntry, CommandResult, WorldCommand } from "./types";

export type { CommandResult, WorldCommand };
export type { CommandHistoryEntry } from "./types";

/** 命令参数说明（与引擎规则对齐，供调试台生成表单） */
export interface CommandSpec {
  type: string;
  label: string;
  extension: string;
  description: string;
  /** 参数槽位说明 */
  fields: Array<{
    key: "actorId" | "targetId" | "amount" | "text" | "payload";
    label: string;
    required?: boolean;
    /** payload 时给出建议键 */
    payloadKeys?: string[];
    placeholder?: string;
  }>;
}

/** 引擎内置命令目录（来源：coreRules.ts / rpgCompat.ts；custom 命令不在此列） */
export const COMMAND_SPECS: CommandSpec[] = [
  {
    type: "move",
    label: "玩家移动",
    extension: "core-rules",
    description: "把玩家移动到目的地（targetId = 地点 id）",
    fields: [
      {
        key: "targetId",
        label: "目的地",
        required: true,
        placeholder: "如 tavern"
      }
    ]
  },
  {
    type: "advance_time",
    label: "推进时间",
    extension: "core-rules",
    description: "推进世界时钟（amount = 刻数）",
    fields: [
      { key: "amount", label: "刻数", required: true, placeholder: "如 12" }
    ]
  },
  {
    type: "change_weather",
    label: "变更天气",
    extension: "core-rules",
    description: "改变世界天气（text = 天气名）",
    fields: [
      { key: "text", label: "天气", required: true, placeholder: "如 rain" }
    ]
  },
  {
    type: "create_entity",
    label: "创建实体",
    extension: "core-rules",
    description:
      "向世界创建实体（payload: id / type / name / location / attributes）",
    fields: [
      {
        key: "payload",
        label: "载荷",
        required: true,
        payloadKeys: ["id", "type", "name", "location"]
      }
    ]
  },
  {
    type: "remove_entity",
    label: "移除实体",
    extension: "core-rules",
    description: "从世界移除实体（targetId = 实体 id）",
    fields: [{ key: "targetId", label: "实体 ID", required: true }]
  },
  {
    type: "update_attribute",
    label: "更新属性",
    extension: "core-rules",
    description: "更新实体通用属性袋（targetId + payload: key / value）",
    fields: [
      { key: "targetId", label: "实体 ID", required: true },
      {
        key: "payload",
        label: "载荷",
        required: true,
        payloadKeys: ["key", "value"]
      }
    ]
  },
  {
    type: "set_relation",
    label: "设置关系",
    extension: "core-rules",
    description:
      "设置实体间有向关系（actorId = source；payload: target / type / value）",
    fields: [
      { key: "actorId", label: "Source（发起方）", required: true },
      {
        key: "payload",
        label: "载荷",
        required: true,
        payloadKeys: ["target", "type", "value"]
      }
    ]
  },
  {
    type: "move_entity",
    label: "移动实体",
    extension: "core-rules",
    description:
      "移动 NPC 实体（targetId + payload: location，或 text = 地点）",
    fields: [
      { key: "targetId", label: "实体 ID", required: true },
      {
        key: "payload",
        label: "载荷",
        required: true,
        payloadKeys: ["location"]
      }
    ]
  },
  {
    type: "attack",
    label: "攻击",
    extension: "rpg-compat",
    description: "对目标发起攻击（actorId + targetId + amount = 伤害）",
    fields: [
      { key: "actorId", label: "攻击方", required: true },
      { key: "targetId", label: "目标", required: true },
      { key: "amount", label: "伤害", placeholder: "如 8" }
    ]
  },
  {
    type: "talk",
    label: "交谈",
    extension: "rpg-compat",
    description: "与目标交谈（actorId + targetId + text = 台词）",
    fields: [
      { key: "actorId", label: "说话方", placeholder: "缺省 player" },
      { key: "targetId", label: "对象", required: true },
      { key: "text", label: "台词", required: true }
    ]
  },
  {
    type: "set_attitude",
    label: "调整态度",
    extension: "rpg-compat",
    description: "调整 NPC 对玩家态度（targetId + amount，范围 [-100, 100]）",
    fields: [
      { key: "targetId", label: "NPC ID", required: true },
      {
        key: "amount",
        label: "态度增量",
        required: true,
        placeholder: "如 5 或 -3"
      }
    ]
  },
  {
    type: "spawn_entity",
    label: "生成实体",
    extension: "rpg-compat",
    description: "生成 NPC/玩家实体（payload: id / name / kind / loc）",
    fields: [
      {
        key: "payload",
        label: "载荷",
        required: true,
        payloadKeys: ["id", "name", "kind", "loc"]
      }
    ]
  }
];

/** 执行命令（真实引擎） */
export const executeCommand = (worldId: string, cmd: WorldCommand) => {
  return http.request<CommandResult>(
    "post",
    `/world-api/v1/worlds/${encodeURIComponent(worldId)}/commands`,
    { data: cmd }
  );
};

/** 最近命令历史（新 → 旧；M1.4 起真实，Runtime 侧环形缓冲） */
export const getCommandHistory = (worldId: string, n = 20) => {
  return http.request<{ total: number; commands: CommandHistoryEntry[] }>(
    "get",
    `/world-api/v1/worlds/${encodeURIComponent(worldId)}/commands`,
    { params: { n } }
  );
};
