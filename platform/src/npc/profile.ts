/* ============================================================
   NPC Runtime · Profile（P5 · 方案 §八：NPC 状态清单 → 引擎既有事实）
   ------------------------------------------------------------
   方案 §八的 NPC 状态清单逐项映射——只组装引擎/宿主已有的事实，
   缺的事实如实标注（缺不编造）：

     Identity        → 实体 id + type + attributes.name
     Location        → attributes.location（宿主约定）
     Attributes      → attributes 全量（mood / money / attention / goal …）
     Mood            → attributes.mood
     Attention       → attributes.attention（P2 起宿主约定、AI 可维护）
     Relationship    → 世界关系表涉及该 NPC 的边 + att（对玩家态度）+ met
     Schedule        → 宿主日程表数据（平台 npc/schedule 的 NpcScheduleTable 切片；
                       日程是游戏数据、机制不含游戏语义）
     Goals           → attributes.goal（P5 起宿主约定、AI 可维护；驱动器
                       个体决策时经 context.goal 送达模型）
     Knowledge       → P7（引擎 mem 槽位与 MemoryEngine 的桥，本阶段如实标注未接）
     Memory          → P7（同上）
     CurrentContext  → 最近一次聚焦该 NPC 的演化 run id（调用方传入或经 Journal 查询）

   只读：本模块不发命令、不改状态——「NPC 档案」是观测面，
   变化永远走 Command → Rules → Mutation → Event。
   ============================================================ */
import type { EngineClient } from '../types.ts';

/** 宿主日程表切片（与 npc/schedule 的 ScheduleSlot 同形状，避免跨模块耦合） */
export interface ProfileScheduleSlot {
  from: number;
  to: number;
  location: string;
}

export interface NpcProfileOptions {
  /** 宿主持有的该 NPC 日程（游戏数据） */
  schedule?: ProfileScheduleSlot[];
  /** 最近一次聚焦该 NPC 的演化 run id（调用方从 Journal/管理面取得） */
  lastRunId?: string;
}

/** 方案 §八状态清单的组装结果：每项都有事实来源；没有的为 undefined（不编造） */
export interface NpcProfile {
  identity: { id: string; type?: string; name?: string };
  location?: string;
  mood?: string;
  attention?: string;
  goal?: string;
  /** 全量属性袋（含上述约定字段的原始值） */
  attributes?: Record<string, unknown>;
  /** 对玩家态度（-100..100）与是否见过玩家 */
  attitudeToPlayer: number;
  metPlayer: boolean;
  /** 世界关系表中涉及该 NPC 的边（source/target/type/value） */
  relationships: { source: string; target: string; type: string; value?: number }[];
  schedule?: ProfileScheduleSlot[];
  /** P7 接入位：Knowledge / Memory 当前未桥接（如实标注，不假装有） */
  knowledgeWired: false;
  memoryWired: false;
  currentContext?: { lastRunId?: string };
}

interface StateView {
  player?: { loc?: string };
  npcs?: Record<string, { att?: number; met?: boolean; type?: string; attributes?: Record<string, unknown> }>;
  relations?: { source: string; target: string; type: string; value?: number }[];
}

/** 组装一个 NPC 的完整档案；实体不存在返回 null */
export async function buildNpcProfile(
  engine: EngineClient,
  worldId: string,
  npcId: string,
  opts: NpcProfileOptions = {},
): Promise<NpcProfile | null> {
  const res = await engine.getState(worldId);
  if (!res.ok) throw new Error(`读取状态失败：${res.error}`);
  const s = (res.state ?? {}) as StateView;
  const n = s.npcs?.[npcId];
  if (!n) return null;
  const attr = n.attributes ?? {};
  const str = (k: string): string | undefined => (typeof attr[k] === 'string' ? (attr[k] as string) : undefined);

  const relationships = (s.relations ?? [])
    .filter((r) => r.source === npcId || r.target === npcId)
    .map((r) => ({ source: r.source, target: r.target, type: r.type, ...(r.value !== undefined ? { value: r.value } : {}) }));

  return {
    identity: {
      id: npcId,
      ...(n.type !== undefined ? { type: n.type } : {}),
      ...(str('name') !== undefined ? { name: str('name') } : {}),
    },
    ...(str('location') !== undefined ? { location: str('location') } : {}),
    ...(str('mood') !== undefined ? { mood: str('mood') } : {}),
    ...(str('attention') !== undefined ? { attention: str('attention') } : {}),
    ...(str('goal') !== undefined ? { goal: str('goal') } : {}),
    ...(n.attributes !== undefined ? { attributes: n.attributes } : {}),
    attitudeToPlayer: typeof n.att === 'number' ? n.att : 0,
    metPlayer: n.met === true,
    relationships,
    ...(opts.schedule?.length ? { schedule: opts.schedule.map((slot) => ({ ...slot })) } : {}),
    knowledgeWired: false,
    memoryWired: false,
    ...(opts.lastRunId !== undefined ? { currentContext: { lastRunId: opts.lastRunId } } : {}),
  };
}
