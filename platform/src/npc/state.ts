/* ============================================================
   NPC State Machine（V2.4-04 · 方案 §八：确定性状态，AI 管意图）
   ------------------------------------------------------------
   避免 NPC Runtime 退化成「每 Tick 问一次 AI」：状态由**世界事实
   确定性推导**（位置 + 日程档期 + 注意力），不建第二份状态副本——
   与「Memory ≠ 第二世界状态」同一纪律。AI 想做什么经提案 → Rules
   落地为事实（attention/goal/location），状态视图随之更新。

   首批规范状态（V2.4-04；方案 8 态中无双游戏实践的 TALKING /
   PURSUING / WAITING 为前瞻，不做）：

     attending   注意力已被占用（attention 指向某实体）——优先级最高
     working     在日程档期地点（档期语义缺省 = 在岗）
     resting     在日程档期地点且档期声明为休息（游戏数据声明）
     traveling   日程要求在某地但当前不在（对齐在途/待对齐）
     idle        无日程覆盖（自由活动）

   同步（syncNpcStates）：读权威状态 → 逐实体推导 → 与 attributes.state
   不同才发 update_attribute（幂等：同态零命令；每步走命令链 → Rules）。
   状态事实随后进入上下文（P4 attributes 面与 P13 Schema），AI 可读、
   可经提案维护——但确定性推导每轮都会校正随手乱写。

   归属：机制在平台（本模块 + 调度循环驱动），语义在游戏数据
   （档期 state 声明）——与日程对齐同构。
   ============================================================ */
import type { EngineClient } from '../types.ts';
import { tickOfDay as calendarTickOfDay } from './calendar.ts';
import type { NpcScheduleTable } from './schedule.ts';

/** 首批规范状态（方案 §八 子集；TALKING/PURSUING/WAITING 前瞻不做） */
export type NpcStateName = 'idle' | 'traveling' | 'attending' | 'working' | 'resting';

export const NPC_STATES: readonly NpcStateName[] = ['idle', 'traveling', 'attending', 'working', 'resting'];

export function isNpcStateName(v: unknown): v is NpcStateName {
  return typeof v === 'string' && (NPC_STATES as readonly string[]).includes(v);
}

/** 事件档期（来自日程表；state 为游戏声明的档期语义） */
export interface NpcStateSlot {
  location: string;
  state?: NpcStateName;
}

export interface NpcStateInput {
  /** 当前所在地点（attributes.location） */
  location?: string;
  /** 当前注意力（attributes.attention；非「无人」= 被占用） */
  attention?: string;
  /** 当前时刻命中的日程档期（无日程覆盖 = null） */
  slot?: NpcStateSlot | null;
}

/**
 * 状态推导（纯函数、确定性）：
 *   1. attention 被占用 → attending（正在与人互动，优先于一切日程）
 *   2. 无日程档期 → idle（自由活动）
 *   3. 不在档期地点 → traveling（待对齐/在途）
 *   4. 在档期地点 → 档期声明语义（缺省 working）
 */
export function deriveNpcState(input: NpcStateInput): NpcStateName {
  const attention = input.attention?.trim();
  if (attention && attention !== '无人' && attention !== '') return 'attending';
  if (!input.slot) return 'idle';
  if (input.location !== input.slot.location) return 'traveling';
  return input.slot.state ?? 'working';
}

export interface NpcStateSyncResult {
  tickOfDay: number;
  /** 发生状态迁移的实体（经 update_attribute 命令链落地） */
  transitions: { id: string; from: string | null; to: NpcStateName; eventIds: string[] }[];
  /** 状态未变化的实体数（幂等：同态零命令） */
  unchanged: number;
  rejected: { id: string; to: string; reason: string }[];
}

export interface NpcStateSyncOptions {
  /** 引擎 GET /state 最小读取面（允许缺字段） */
  state?: unknown;
}

interface StateView {
  t?: number;
  player?: { loc?: string };
  npcs?: Record<string, { attributes?: Record<string, unknown> }>;
}

/**
 * 把状态视图对齐到推导状态：读权威状态 → 逐实体推导 → 与
 * attributes.state 不同才发 update_attribute（进 Rules 链，放行才产生事实）。
 * 幂等：同态零命令。
 */
export async function syncNpcStates(
  engine: EngineClient,
  worldId: string,
  table: NpcScheduleTable,
  opts: NpcStateSyncOptions = {},
): Promise<NpcStateSyncResult> {
  const s: StateView = await (async () => {
    if (opts.state !== undefined) return opts.state as StateView;
    const res = await engine.getState(worldId);
    if (!res.ok) throw new Error(`读取状态失败：${res.error}`);
    return res.state as StateView;
  })();
  const tod = calendarTickOfDay(typeof s.t === 'number' ? s.t : 0);
  const result: NpcStateSyncResult = { tickOfDay: tod, transitions: [], unchanged: 0, rejected: [] };

  for (const [id, slots] of Object.entries(table)) {
    const npc = s.npcs?.[id];
    if (!npc) continue; /* 不存在的实体不推导（V2.4-02 存在性纪律） */
    const attrs = npc.attributes ?? {};
    const loc = typeof attrs['location'] === 'string' ? (attrs['location'] as string) : undefined;
    const attention = typeof attrs['attention'] === 'string' ? (attrs['attention'] as string) : undefined;
    const slotRow = (slots ?? []).find((sl) => tod >= sl.from && tod < sl.to);
    const slot: NpcStateSlot | null = slotRow ? { location: slotRow.location, ...(slotRow.state !== undefined ? { state: normState(slotRow.state) } : {}) } : null;

    const derived = deriveNpcState({ ...(loc !== undefined ? { location: loc } : {}), ...(attention !== undefined ? { attention } : {}), slot });
    const current = typeof attrs['state'] === 'string' ? (attrs['state'] as string) : null;
    if (current === derived) {
      result.unchanged++;
      continue;
    }
    const r = await engine.executeCommand(worldId, {
      type: 'update_attribute',
      targetId: id,
      payload: { key: 'state', value: derived },
    });
    if (r.ok && r.result.ok) {
      result.transitions.push({ id, from: current, to: derived, eventIds: r.result.events });
    } else {
      result.rejected.push({ id, to: derived, reason: r.ok ? r.result.reason ?? '未知' : r.error });
    }
  }
  return result;
}

function normState(v: string): NpcStateName {
  return (NPC_STATES as readonly string[]).includes(v) ? (v as NpcStateName) : 'working';
}
