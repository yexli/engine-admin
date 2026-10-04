/* ============================================================
   卡 D4 · 数据驱动动态事件引擎 + 因果链 + World Director
   《项目方案》§37 动态事件 / §38 因果链 / §39 历史 / §53 世界运行 / §40 World Director
   - 事件定义全在 data/world/events.json（触发条件 + 效果 + seed 兜底文本）
   - 触发判定 = 纯谓词；效果改写 WorldState 只在 core（AI 不碰状态）
   - 因果链：事件效果置 flag / 经 spreadRumor 让 NPC 发现并反应 /
     后续事件用 trigger.afterEvent 依赖前置 → 形成 A→世界改变→B
   - 幂等：同 id 只触发一次（复用 events 簿记）
   叙事：seed 直出（关 AI 成立）；loreRef 供 AI 通道取 canon 润色（约束§3）
   ============================================================ */
import raw from '@/data/world/events.json';
import rawTimeline from '@/data/world/timeline.json';
import { WB } from '@/data/worldBook';
import { cateLabel } from '@/data/entityNames';
import type { RepAxis, WorldState } from '@/types/world';
import { toast } from '@/events/EventBus';
import { adjFactionRel, adjRepAxis, repAxis } from '@/systems/faction/Factions';
import { addHistory } from '@/events/EventStore';
import { log } from '@/systems/character/Gains';
import { adjAtt } from '@/systems/npc/Npcs';
import { need } from '@/world/WorldState';
import { mutate } from '@/world/WorldMutate';
import { sceneTime, shichenOf } from '@/world/WorldClock';
import { spreadRumor } from '@/systems/relationship/Relations';

export interface EventTrigger {
  manual?: boolean; // 仅由代码主动触发（阶段推进 / 终局结算），World Director 不扫描
  dayMin?: number; // sceneTime().day >= dayMin
  shichen?: number; // 且当前时辰 === 此值（可选，精确到时段）
  afterEvent?: string; // 前置事件已触发（因果链）
  flag?: string; // 玩家 flag 为真
  notFlag?: string; // 玩家 flag 为假
  month?: number; // 卡 E4：历法月份序号（0–11，= sceneTime 月）
  date?: number; // 卡 E4：月内日（1–30）
  repAxis?: { faction: string; axis: RepAxis; min?: number; max?: number }; // 卡 F：玩家对该势力某维度达标才触发（剧情分支）

  /* ---- 卡 T4 · 通用触发扩展（新增机制一律先落这里，不另造扫描器） ----
     设计意图：事件表是**内容插槽**。以后加「季节限定事件 / 某年专属大典 /
     每隔 N 日的节律（议会例会、商队到港）/ 一辈子只发生一次的世界大事」，
     都只需要在这里多写一个字段 + 一条 JSON，不改事件引擎。 */
  months?: number[]; // 季节窗口：命中其中任一月即成立（与 month 并存时取交集）
  year?: number; // 指定纪年（sceneTime().year，如 613 年才发生的典礼）
  yearMin?: number; // 纪年下界（「从此年以后每年」这类长线）
  everyDays?: number; // 节律：每 N 日一次（1 周=10 日、月末=30 日都用它表达）
  everyOffset?: number; // 节律相位（配合 everyDays：第 offset + k×N 日触发）
  once?: boolean; // 一辈子只触发一次（recurring 的反面，用于世界大事）
}
export interface EventEffects {
  econ?: Record<string, number>; // 设置商品价格指数
  flags?: Record<string, boolean>; // 置玩家 flag（解锁任务/商店等）
  rep?: Record<string, number>; // 势力声望（态度轴，走 addRep 语义，直接改 rep）
  playerRep?: Record<string, Partial<Record<RepAxis, number>>>; // 玩家多维声望（非态度轴）
  npcAtt?: Record<string, number>; // 具名 NPC 好感变动
  spread?: { src: string; topic: string; imp: number }; // 消息沿关系网传播（NPC 发现）
  frel?: { a: string; b: string; axis: RepAxis; dv: number }[]; // 卡 H2：势力↔势力外交变动（走 adjFactionRel）
  toast?: { text: string; cls?: 'gain' | 'bad' | 'gold' | '' };
  history?: { result: string; imp: number }; // 沉淀进因果历史
}
export interface EventDef {
  id: string;
  name: string;
  trigger: EventTrigger;
  seed: string; // 关 AI 兜底文本（不得含未替换槽位）
  loreRef?: string; // 供 AI 组上下文（本卡仅记录，润色交 A 通道）
  effects?: EventEffects;
  recurring?: boolean; // 卡 E4：周期事件（节日等），每年/每周期可再触发
  /* ---- 卡 T4 · 内容元数据（引擎不读，供面板筛选 / 审计 / 未来的事件目录用）---- */
  tags?: string[]; // 分类标签：festival / period / political / crisis / calendar …
  weight?: number; // 事件密度权重（未来做「同月事件太多就降权」时的旋钮）
  scope?: 'world' | 'city' | 'region' | 'personal'; // 作用域（未来做区域化事件表的预留位）
}

const EVENTS = [...(raw.events as unknown as EventDef[]), ...(rawTimeline.events as unknown as EventDef[])];

/** 历法读数（月序号 0–11 / 月内日 1–30 / 绝对日）：直接复用 sceneTime，消除双实现 */
function calendar(s: WorldState) {
  const t = sceneTime(s);
  return { month: t.monthIndex, date: t.date, day: t.day };
}

/** 触发判定（纯函数，无副作用；确定性） */
export function evalTrigger(t: EventTrigger, s: WorldState): boolean {
  /* F-05：manual 事件只认代码主动触发——否则"flag 一置就每天命中"会变成每日白送声望 */
  if (t.manual) return false;
  if (t.dayMin !== undefined && sceneTime(s).day < t.dayMin) return false;
  if (t.shichen !== undefined && shichenOf(s.t) !== t.shichen) return false;
  if (t.afterEvent !== undefined && !s.events.some((e) => e.id === t.afterEvent || e.id.startsWith(t.afterEvent + ':'))) return false;
  if (t.flag !== undefined && !s.player.flags[t.flag]) return false;
  if (t.notFlag !== undefined && s.player.flags[t.notFlag]) return false;
  if (t.month !== undefined || t.date !== undefined) {
    const c = calendar(s);
    if (t.month !== undefined && c.month !== t.month) return false;
    if (t.date !== undefined && c.date !== t.date) return false;
  }
  /* 卡 T4：纪年条件（指定年 / 下界）——「613 年建国日」「从此年以后每年」都用它 */
  if (t.year !== undefined || t.yearMin !== undefined) {
    const y = sceneTime(s).year;
    if (t.year !== undefined && y !== t.year) return false;
    if (t.yearMin !== undefined && y < t.yearMin) return false;
  }
  /* 卡 T4：季节窗口——命中其中任一月即成立（跨年窗口用月份列表表达，如 [11,0,1]） */
  if (t.months && t.months.length && !t.months.includes(calendar(s).month)) return false;
  /* 卡 T4：日节律——「每 N 日的第 offset 天」（1 周 = 10 日、月末 = 30 日） */
  if (t.everyDays && t.everyDays > 0) {
    const d = calendar(s).day;
    if ((d - (t.everyOffset ?? 0)) % t.everyDays !== 0) return false;
  }
  /* 卡 T4：once（一辈子只一次）不在这里判——「是否已发生过」是实例 id 的语义，
     由下方 instId 用「裸 id vs 带日后缀」表达，避免在纯函数里做状态推断。 */
  if (t.repAxis) {
    const v = repAxis(t.repAxis.faction, t.repAxis.axis, s);
    if (t.repAxis.min !== undefined && v < t.repAxis.min) return false;
    if (t.repAxis.max !== undefined && v > t.repAxis.max) return false;
  }
  return true;
}

/**
 * 事件实例 id：周期事件按日加后缀（每年/每周期可再触发），一次性用裸 id。
 * 卡 T4：`trigger.once` 显式声明「一辈子只一次」——它与 recurring 互斥，
 * 但语义上比「不写 recurring」更强（后者在数据里看不出是"只一次"还是"忘了写"）。
 */
const instId = (ev: EventDef, s: WorldState) =>
  ev.trigger.once ? ev.id : ev.recurring ? ev.id + ':' + calendar(s).day : ev.id;

/** 效果落地（全部经 core 写 WorldState） */
export function applyEffect(ev: EventDef, s: WorldState): void {
  const f = ev.effects;
  if (!f) return;
  if (f.econ) for (const k in f.econ) (s.econ as Record<string, number>)[k] = f.econ[k];
  if (f.flags) for (const k in f.flags) mutate.playerFlag(k, f.flags[k]);
  if (f.rep) for (const k in f.rep) mutate.rep(k, f.rep[k]);
  if (f.playerRep)
    for (const fac in f.playerRep) for (const ax in f.playerRep[fac]) adjRepAxis(fac, ax as RepAxis, f.playerRep[fac][ax as RepAxis]!, s);
  if (f.npcAtt) for (const id in f.npcAtt) adjAtt(id, f.npcAtt[id], ev.name);
  // 卡 H2：势力↔势力外交变动（运行时层，不污染种子）
  if (f.frel) for (const e of f.frel) adjFactionRel(e.a, e.b, e.axis, e.dv, s);
  // 因果链的"发现→反应"：消息沿关系网扩散（D2）
  if (f.spread) spreadRumor(f.spread.src, f.spread.topic, f.spread.imp, s);
  if (f.toast) toast(f.toast.text, f.toast.cls || '');
  addHistory(ev.name, f.history?.result || '', f.history?.imp || 2);
}

/** 触发一个事件（幂等）：簿记 + 效果 + seed 叙事。返回是否本次触发。 */
export function fireEvent(ev: EventDef, s: WorldState): boolean {
  const id = instId(ev, s);
  if (s.events.some((e) => e.id === id)) return false;
  s.events.push({ id, name: ev.name, day: sceneTime(s).day });
  applyEffect(ev, s);
  log(ev.seed, 'sys', s); // 关 AI 兜底直出；AI 开时上层可据 loreRef 润色
  return true;
}

/** World Director：每次时间推进扫描全部事件，触发满足条件者。
 *  多轮迭代至收敛（让 afterEvent 因果链在同一 tick 内可级联，深度受事件数上限天然约束）。 */
export function directorTick(s: WorldState = need()): string[] {
  const fired: string[] = [];
  let progressed = true;
  let guard = 0;
  while (progressed && guard++ <= EVENTS.length) {
    progressed = false;
    for (const ev of EVENTS) {
      if (s.events.some((e) => e.id === instId(ev, s))) continue;
      if (evalTrigger(ev.trigger, s)) {
        fireEvent(ev, s);
        fired.push(ev.id);
        progressed = true;
      }
    }
  }
  // 缉查事件对高通缉玩家的附加氛围（表现层，不改数值）
  if (s.player.wanted > 0 && s.events.some((e) => e.id === 'sweep') && !s.player.flags.sweep_warned) {
    mutate.playerFlag('sweep_warned');
    log('你的通缉画像被钉上了岗哨木柱。在城里走动要小心了。', 'bad', s);
  }
  return fired;
}

/** 供测试/检索：全事件定义（只读） */
export const ALL_EVENTS = EVENTS;

/** 卡 D4 演出：按 id 取事件定义（供纪闻面板标注因果/后果，只读） */
export const eventMeta = (id: string): EventDef | undefined => EVENTS.find((e) => e.id === id);

/** 把事件效果摘要成一句「余波」文案（只读，供 UI；无效果返回空串）。
 *  品类与 flag 此前直接落内部 id（「herb物价」「theoselect_announced」）——
 *  品类走 cateLabel 翻译；flag 是世界册上的记账标记，对玩家没有阅读价值，
 *  只报「留痕 n 项」不逐个倒 id。 */
export function eventAftermath(ev: EventDef): string {
  const f = ev.effects;
  if (!f) return '';
  const parts: string[] = [];
  if (f.econ) for (const k in f.econ) parts.push(`${cateLabel(k)}物价×${f.econ[k]}`);
  if (f.rep) for (const k in f.rep) parts.push(`${WB.factions[k] || k}声望${f.rep[k] > 0 ? '+' : ''}${f.rep[k]}`);
  if (f.npcAtt) for (const k in f.npcAtt) parts.push(`${WB.npcs[k]?.name || k}态度${f.npcAtt[k] > 0 ? '+' : ''}${f.npcAtt[k]}`);
  if (f.spread) parts.push('消息扩散');
  if (f.flags) {
    const n = Object.keys(f.flags).length;
    if (n) parts.push(`世界留痕 ${n} 项`);
  }
  return parts.join(' · ');
}
