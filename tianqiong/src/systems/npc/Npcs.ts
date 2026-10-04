/* ============================================================
   NPC 动态状态（作息出没 / 好感度 / 记忆 —— 原型 §三 NPC 基础）
   ============================================================ */
import { WB } from '@/data/worldBook';
import type { NpcDef, NpcDynamic, NpcMemory, NpcScheduleSeg, WorldState } from '@/types/world';
import { rng, toast, worldBus } from '@/events/EventBus';
import { makeEvent } from '@/events/EventSchema';
import { generateName, resolveRace } from '@/systems/naming/Naming';
import { importanceOfLegacyImp, memoryEngine, visibilityOfLegacyTier } from '@/memory';
import { need } from '@/world/WorldState';
import { mutate } from '@/world/WorldMutate';
import { sceneTime, shichenOf } from '@/world/WorldClock';

export function npcDyn(id: string, s: WorldState = need()): NpcDynamic {
  /* 卡 D2 + §4/§14：NPC↔NPC 关系边是世界书里的客观事实，**建档即投影**。
     此前投影挂在 Relations.relsOf 的惰性分支上，于是「谁能读到关系网」取决于哪个调用
     先发生——WorldAPI.get_relationship 直读运行时表，推演的一跳扩展与亲族判定因此
     常常读空（实测：5 个有种子 NPC 在首次投影前一律 0 条边）。单一投影点，读路径不再看顺序。
     建档实现已收进 world/mutate.npcEntry（写入原语唯一实现点）。 */
  return mutate.npcEntry(id, s);
}

/** 时辰序号是否落在日程段内（支持跨子夜环绕：from>to） */
function segHit(seg: NpcScheduleSeg, h: number): boolean {
  return seg.from <= seg.to ? h >= seg.from && h < seg.to : h >= seg.from || h < seg.to;
}
/** 命中的日程段（无 schedule 或无命中 → null） */
export function npcSeg(id: string, h: number): NpcScheduleSeg | null {
  const sc = WB.npcs[id]?.schedule;
  if (!sc) return null;
  return sc.find((g) => segHit(g, h)) ?? null;
}

/** 卡 D1 演出：此刻该 NPC 正在做什么（日程段 act），无则 undefined */
export function npcActNow(id: string, s: WorldState = need()): string | undefined {
  return npcSeg(id, shichenOf(s.t))?.act;
}

/** 此刻该 NPC 所在地点（不在世/未到作息返回 null，原型 npcAt）
 *  卡 D1：有 schedule 时按当前时辰命中日程段地点；否则回落旧 hours/loc 判定。 */
export function npcAt(id: string, s: WorldState = need()): string | null {
  const n = WB.npcs[id];
  if (n.needFlag && !s.player.flags[n.needFlag]) return null;
  const h = shichenOf(s.t);
  const seg = npcSeg(id, h);
  if (seg) return seg.loc;
  if (n.schedule) return null; // 有日程但当值空档：不在原 loc（自主离场）
  const [a, b] = n.hours;
  return (a <= b ? h >= a && h < b : h >= a || h < b) ? n.loc : null;
}

/**
 * 此刻该 NPC 所在地点（UI「人物志·此刻所在」与 AI 上下文的读取口）。
 * Phase 4.2 起它**就是** npcAt：位置本来是「世界书 + 时间 + 门禁位」的纯函数产物，
 * 原先那份 NpcDynamic.curLoc 物化缓存只会引入一个会过期的第二真相
 * （缓存过期 = AI 拿到他早就离开的地点），连同每天 13 次的全表 tick 一起撤掉了。
 * 名字留着是因为它表达的是领域语义（「此刻在哪」），npcAt 更像实现细节。
 */
export const npcCurLoc = (id: string, s: WorldState): string | null => npcAt(id, s);

export interface PresentNpc extends NpcDef {
  id: string;
}
/* ---------------- 位置索引（《NPC 规模化与事件通道方案》改进版 §7 / Phase 3） ----------------
   原实现每次调用都遍历全部 NPC 算日程；而 witnessesOf 对**每个事件**都要问一次
   「此刻此地有谁」，于是感知链路的成本是 O(事件 × NPC)。200 个 NPC 时这是第一热路径。

   索引是**缓存**，不是第二个事实来源：事实仍然是 npcAt（纯函数）。
   缓存键 = 「时辰 + 显隐门禁位」——这两样就是 npcAt 的全部输入，
   键变了自动重建，所以不存在手工失效漏掉某处的风险。 */
const GATED: { id: string; flag: string }[] = Object.keys(WB.npcs)
  .filter((id) => WB.npcs[id].needFlag)
  .map((id) => ({ id, flag: WB.npcs[id].needFlag as string }));

let idxKey = '';
let idxByLoc = new Map<string, PresentNpc[]>();

/** 门禁位通常只有个位数，所以这个函数是 O(门禁数)，与 NPC 总数无关 */
function indexKeyOf(s: WorldState): string {
  let gates = '';
  for (const g of GATED) gates += s.player.flags[g.flag] ? '1' : '0';
  return shichenOf(s.t) + '|' + gates;
}

function rebuildIndex(s: WorldState): void {
  idxKey = indexKeyOf(s);
  const next = new Map<string, PresentNpc[]>();
  for (const id of Object.keys(WB.npcs)) {
    const at = npcAt(id, s);
    if (!at) continue;
    const row = next.get(at);
    if (row) row.push({ id, ...WB.npcs[id] });
    else next.set(at, [{ id, ...WB.npcs[id] }]);
  }
  idxByLoc = next;
}

export function presentNPCs(loc: string, s: WorldState = need()): PresentNpc[] {
  const k = indexKeyOf(s);
  if (k !== idxKey) rebuildIndex(s);
  return idxByLoc.get(loc) ?? [];
}

/** 供测试与审计：索引是否与直算一致（只读，不重建） */
export function presentByBruteForce(loc: string, s: WorldState): PresentNpc[] {
  return Object.keys(WB.npcs)
    .filter((id) => npcAt(id, s) === loc)
    .map((id) => ({ id, ...WB.npcs[id] }));
}

export const attOf = (id: string, s: WorldState = need()) => (s.npcs[id] ? s.npcs[id].att : 0);
export const attWord = (a: number) => (a >= 45 ? '亲近' : a >= 20 ? '友好' : a > -20 ? '普通' : a > -45 ? '冷淡' : '敌意');
/** 颜色是呈现细节：返回 CSS 变量串，与原型 attColor 一致 */
export const attColor = (a: number) => (a >= 20 ? 'var(--jade)' : a > -20 ? 'var(--gold)' : 'var(--crimson)');

export function adjAtt(id: string, dl: number, why?: string) {
  const s = need();
  const { from: before, to } = mutate.npcAtt(id, dl);
  if (dl) addMem(id, (dl > 0 ? '好感' : '恶感') + '·' + (why || ''), Math.min(3, ((Math.abs(dl) / 10) | 0) + 1));
  if (dl >= 5) toast('♪ ' + WB.npcs[id].name + ' 对你的态度改善', 'gain');
  if (dl <= -5) toast('✖ ' + WB.npcs[id].name + ' 对你起了戒心', 'bad');
  /* 试点接入（方案 §22/§34）：好感实际变化才成为世界事实。
     感知口径：**当事人必然知情**（被改态度的那个 NPC 写在 witnesses 里），
     旁人不可见（显眼度 0）——好感是私事，但不该连当事人自己都不知道。 */
  if (to !== before) {
    worldBus.emit(
      makeEvent({
        type: 'relationship_changed',
        day: sceneTime(s).day,
        tick: s.t,
        actor: 'player',
        target: id,
        location: s.player.loc,
        cause: why || (dl > 0 ? '好感上升' : '好感下降'),
        witnesses: [id],
        data: { npc: id, from: before, to, delta: dl },
      }),
    );
  }
}

/* ---------------- 卡 H3 调用点：路人署名 ---------------- */

/** 城中常见的路人种族（高阶族不入街头，与 §27 种族分布一致） */
const PASSERBY_RACES = ['human', 'human', 'human', 'elf', 'dwarf', 'halforc', 'gnome', 'orc'];

export interface Passerby {
  name: string;
  race: string; // 中文族名（展示用）
}

/**
 * 生成一名路人（命名生成器署名，规律进词库）。
 * 刻意**不建 NpcDynamic**：路人只在叙事里出现一次，进存档只会污染 NPC 表；
 * 需要可交互的路人时，应作为 NpcDef 落 people.json（G10 零代码契约）。
 */
export function passerby(raceKey?: string): Passerby {
  /* 卡 H3：race 同时接受 lexicon key（'elf'）与中文族名（'精灵'），未知族回落人类 */
  const race = raceKey ? resolveRace(raceKey) : rng.pick(PASSERBY_RACES);
  const key = WB.races[race] ? race : 'human';
  return { name: generateName(key), race: WB.races[key].name };
}

/**
 * NPC 记忆写入（唯一入口）。
 * 审计整改：此前写的是卡 D2 的老表（文本 + 粗档 imp，无衰减、无可见性、无校验），
 * 与新记忆表并存成两套真相。现在统一落进 MemoryEngine——
 * 容量、衰减、遗忘、私密边界都只有一套规则。读取走 memory 的 memOf 投影。
 */
export function addMem(id: string, event: string, imp: number, tier?: NpcMemory['tier']) {
  const s = need();
  npcDyn(id, s); // 惰性建表：与旧实现一致（调用方依赖「这句之后该 NPC 有条目」）
  memoryEngine.create(
    {
      ownerId: id,
      type: tier === 'rel' ? 'personal_event' : 'observation',
      content: event,
      source: 'system_generated',
      importance: importanceOfLegacyImp(imp || 1),
      visibility: visibilityOfLegacyTier(tier),
    },
    s,
    sceneTime(s).day,
  );
}
