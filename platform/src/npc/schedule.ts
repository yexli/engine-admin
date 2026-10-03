/* ============================================================
   NPC Schedule Runtime（方案 V2.1 §九：World Time / Schedule）
   ------------------------------------------------------------
   确定性行为归 World Time + Schedule + Rules，AI 只管异常与临时
   行为——本模块是「Schedule」那一环的通用机制：

     · 输入 = 每实体的每日日程表（按世界刻度，1 日 = 48 刻）。
       日程表是**游戏数据**，由宿主提供；本模块不含任何具体游戏语义。
     · apply = 对每个实体比较「当前时段日程地点」与「世界权威状态里的
       现处地点」，不一致才发 move_entity 命令——命令进引擎 Rules 链，
       放行才产生 npc_moved 事实。日程从不直接写状态。
     · 幂等：地点已对齐 → 跳过；重复调用同一时刻 → 零命令。
     · 无日程覆盖的时段 / 无日程的实体 → 不动（schedule 之外仍归
       AI 演化与游戏逻辑）。

   纪律：只通过 EngineClient 读状态、发命令，与任何游戏客户端同权，
   零特权；不知道 Tianqiong，不知道任何 NPC 名字。
   ============================================================ */
import type { EngineClient } from '../types.ts';
import { tickOfDay as calendarTickOfDay } from './calendar.ts';

/** 一段日程：[from, to) 刻区间（按日内刻度 0..47）实体应在 location */
export interface ScheduleSlot {
  /** 起始刻（含） */
  from: number;
  /** 结束刻（不含） */
  to: number;
  location: string;
}

/** 每实体每日日程表：tickOfDay = world.t % 48 落进哪个 slot 就归哪 */
export type NpcScheduleTable = Record<string, ScheduleSlot[]>;

export interface ScheduleApplyResult {
  tickOfDay: number;
  /** 已对齐（日程地点 = 当前地点）的实体 */
  settled: string[];
  /** 发出并放行的移动命令（ Rules 放行才在此） */
  moved: { id: string; from: string; to: string; eventIds: string[] }[];
  /** 引擎拒绝的移动（含实体不存在等；逐条带原因） */
  rejected: { id: string; to: string; reason: string }[];
}


function slotAt(slots: ScheduleSlot[] | undefined, tickOfDay: number): ScheduleSlot | null {
  if (!slots || slots.length === 0) return null;
  for (const s of slots) {
    const from = Math.floor(s.from);
    const to = Math.ceil(s.to);
    if (tickOfDay >= from && tickOfDay < to) return s;
  }
  return null;
}

export interface ApplyNpcScheduleOptions {
  /** 引擎 GET /state 的最小读取面（与 evolution/context 同纪律：缺字段即跳过） */
  state?: unknown;
}

/** 把日程表对齐到世界当前时刻：读权威状态 → 逐实体比对 → 发命令。
 *  state 缺省时自行读取；调用方已有 state 快照时可传入避免重复请求。 */
export async function applyNpcSchedule(
  engine: EngineClient,
  worldId: string,
  table: NpcScheduleTable,
  opts: ApplyNpcScheduleOptions = {},
): Promise<ScheduleApplyResult> {
  let state = opts.state;
  if (state === undefined) {
    const res = await engine.getState(worldId);
    if (!res.ok) throw new Error(`日程对齐失败：${res.error}`);
    state = res.state;
  }
  const s = (state ?? {}) as {
    t?: number;
    npcs?: Record<string, { att?: number; met?: boolean; type?: string; attributes?: Record<string, unknown> }>;
  };
  const t = typeof s.t === 'number' ? s.t : 0;
  const tickOfDay = calendarTickOfDay(t); /* P6：历法唯一口径（npc/calendar） */

  const result: ScheduleApplyResult = { tickOfDay, settled: [], moved: [], rejected: [] };
  for (const [id, slots] of Object.entries(table)) {
    const slot = slotAt(slots, tickOfDay);
    if (!slot) continue; // 该时段无日程：不归 schedule 管
    const current = s.npcs?.[id]?.attributes?.['location'];
    if (current === undefined) continue; // 世界里没有该实体的位置事实：不动
    if (current === slot.location) {
      result.settled.push(id);
      continue; // 已对齐：幂等跳过
    }
    /* 注意：不带 actorId——引擎 move_entity 规则里 targetId === actorId
       会被解释为「玩家移动」（actor 即当事人）；日程移动的是 NPC 实体，
       actor 语义由规则侧的 emit（actor=targetId）携带。 */
    const res = await engine.executeCommand(worldId, {
      type: 'move_entity',
      targetId: id,
      payload: { location: slot.location },
    });
    if (res.ok && res.result.ok) {
      result.moved.push({ id, from: String(current), to: slot.location, eventIds: res.result.events });
    } else {
      result.rejected.push({ id, to: slot.location, reason: res.ok ? (res.result.reason ?? '被规则拒绝') : res.error });
    }
  }
  return result;
}
