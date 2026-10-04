/* ============================================================
   卡 F · 六维关系 → 剧情走向（引擎侧确定性修正器）
   让 playerRep 的六个维度真正产生后果（AI 只叙述，判定全在这里）：
   - trade 通商   → 该势力商店买价折扣 / 卖价加成；买卖累积通商
   - religion 信仰 → 神殿治疗/祈祷是否受理 + 费用浮动；行善累积信仰
   - hostility 敌意→ 城卫盘查概率上升；犯罪累积帝国敌意
   - trust 信任   → 委托/招募的准入门槛；完成任务累积信任
   - intelligence 情报 → 观察揭示额外线索（卡 I4：四档特权）
   - military 军事 → 审判从轻（以罚金代监禁/流放）（卡 I4：四档特权）
   纯 core：只读 WorldState 派生修正值，或经 gains/factions 写回累积。
   卡 I4：两轴的**累积来源**与日上限也收在此文件（见文件末段）——
   轴定义与既有出口一律不动，只追加"写入口 + 出口"。
   ============================================================ */
import { WB } from '@/data/worldBook';
import { LORE } from '@/data/lore';
import type { WorldState } from '@/types/world';
import { clamp, toast } from '@/events/EventBus';
import { ALL_EVENTS } from '@/events/EventProcessor';
import { HOME_TEMPLE, adjRepAxis, repAxis } from '@/systems/faction/Factions';
import { log } from '@/systems/character/Gains';
import { mutate } from '@/world/WorldMutate';
import { need } from '@/world/WorldState';
import { sceneTime } from '@/world/WorldClock';

/** 通商 → 买价系数（trade 越高越便宜）：[0.7, 1.15] */
export function tradeBuyMod(faction: string, s: WorldState = need()): number {
  const t = repAxis(faction, 'trade', s);
  return Math.round(clamp(1 - t / 250, 0.7, 1.15) * 100) / 100;
}
/** 通商 → 卖价系数（trade 越高收得越贵）：[0.9, 1.3] */
export function tradeSellMod(faction: string, s: WorldState = need()): number {
  const t = repAxis(faction, 'trade', s);
  return Math.round(clamp(1 + t / 300, 0.9, 1.3) * 100) / 100;
}
/** 信仰 → 神殿是否愿意为你服务（信仰过低/亵渎者被拒）
 *  神殿拆五后按殿判定：缺省读圣辉城的主事殿（HOME_TEMPLE），签名不变故调用方零改动。 */
export function templeServiceOk(s: WorldState = need()): boolean {
  return repAxis(HOME_TEMPLE, 'religion', s) > -25;
}
/** 信仰 → 神殿服务费用浮动（虔诚信徒打折，亵渎者加价）：[0.5, 1.4] */
export function templeFee(base: number, s: WorldState = need()): number {
  const r = repAxis(HOME_TEMPLE, 'religion', s);
  return Math.max(0, Math.round(base * clamp(1 - r / 200, 0.5, 1.4)));
}
/** 敌意(帝国) + 通缉 → 城卫盘查概率：[0, 0.85]；卡 F 下游：全城海捕时逼近上限
 *  卡 I4：军职（≥70）→ ×0.5（接 actions.go:45 既有调用点，调用方零改动；
 *  未达该档时逐位等于旧公式 → 回归安全）。 */
export function guardChance(s: WorldState = need()): number {
  const base = 0.18 + s.player.wanted * 0.15 + Math.max(0, repAxis('empire', 'hostility', s)) / 220;
  const v = clamp(s.player.flags.manhunt ? Math.max(base, 0.75) : base, 0, 0.92);
  return gateTaxFree(s) ? Math.round(v * 50) / 100 : v;
}
/** 情报 → 观察是否揭示额外线索（与某势力情报网达标） */
export function infoReveal(faction: string, s: WorldState = need()): boolean {
  return repAxis(faction, 'intelligence', s) >= 25;
}
/** 信任 → 委托/招募准入门槛 */
export function trustOk(faction: string, min: number, s: WorldState = need()): boolean {
  return repAxis(faction, 'trust', s) >= min;
}
/** 军事(帝国) → 审判从轻（军功者可罚金代刑） */
export function militaryLeniency(s: WorldState = need()): boolean {
  return repAxis('empire', 'military', s) >= 30;
}

/* ============================================================
   卡 I4 · 军事与情报双轴落地（2/7 死轴 → 可玩轴）
   ------------------------------------------------------------
   七维矩阵填得很满，玩家此前却只能推动 5 个轴：military 累积来源 0 处、
   intelligence 仅 2 处事件，而 CharPanel 早已把两者并列展示
   （UI 承诺了，玩法没给）。本段只"加来源与出口"，不动轴定义：
     ① 累积来源（全部经 adjRepAxis 单一写入口落地）
        军功 = 剿匪击杀×1 + 军务委托×3 + 守城之功×5　日上限 +6
        情报 = 打听成功×1（日上限 3）+ 观察成功×1（日上限 2）+ 深聊×2（每人一次）
     ② 日累积计数器（{day,n} 结构，跨日自动重置）
     ③ 四档特权出口（纯判定，UI/AI 只读）
   轴定义、既有出口 militaryLeniency / infoReveal 一律不动（回归护栏）。
   容器：types/world.ts 属并线冲突区，故以局部载体类型（as unknown as）
   挂可选键——旧档缺这些键时一律按 0 处理，天然兼容。
   触发点：战斗结算（combat.ts）与委托复命（quests.ts）均不在本卡可改范围，
   故用「怠惰结算」settleAxes：在场景行动边界比对既有事实
   （s.killed / 委托 fin / 守城旗标 / 深聊轮次），把应得的增量一次性落地。
   ============================================================ */

/* ---------------- 旋钮（方案卡 I4 调优表：日累积 2–10 / 四档阈值 / 泄漏度） ---------------- */

/** 军功四档门槛：30 军功抵罪 · 50 征召 · 70 军职 · 90 私兵 */
export const MIL_TIERS = [30, 50, 70, 90] as const;
/** 情报四档门槛：25 观察揭示 · 40 预知 · 60 识破 · 80 情报网 */
export const INTEL_TIERS = [25, 40, 60, 80] as const;
export const MIL_DAY_CAP = 6; // 军功日累积上限
export const INTEL_GATHER_CAP = 3; // 打听日上限
export const INTEL_OBSERVE_CAP = 2; // 观察日上限

export const MIL_QUEST_GAIN = 3; // 每件军务
export const MIL_SIEGE_GAIN = 5; // 守城之功
export const SIEGE_REPEL_KILLS = 3; // 守城：告急期间须击退的匪类数
export const INTEL_DEEP_TURNS = 3; // 深聊轮次门（每人 1 次）
export const INTEL_DEEP_GAIN = 2;

/** 军功档位 0..3：0 无 / 1 ≥30 军功抵罪 / 2 ≥50 征召 / 3 ≥70 军职
 *  （≥90 私兵是 tier 3 之上的授予态，由 privateArmy 判定——该档方案上即"置 flag + 文案"） */
export function militaryTier(s: WorldState = need()): number {
  const v = repAxis('empire', 'military', s);
  let t = 0;
  for (let i = 0; i < 3; i++) if (v >= MIL_TIERS[i]) t++;
  return t;
}
/** 情报档位 0..3：0 无 / 1 ≥25 观察揭示 / 2 ≥40 预知 / 3 ≥60 识破（≥80 情报网见 intelNetwork） */
export function intelTier(s: WorldState = need()): number {
  const v = repAxis('guild', 'intelligence', s);
  let t = 0;
  for (let i = 0; i < 3; i++) if (v >= INTEL_TIERS[i]) t++;
  return t;
}

/* 特权出口：纯判定（UI 只读；AI 不得写轴，红队用例见 cardI4.test.ts） */
/** ≥50 征召：战时可召两名城卫随行（战斗内友方单位扩展在 combat.ts，本卡先给名分与文案） */
export const militaryCallable = (s: WorldState = need()): boolean => militaryTier(s) >= 2;
/** ≥70 军职：城门税免 + 盘查概率 ×0.5（后者已接进 guardChance） */
export const gateTaxFree = (s: WorldState = need()): boolean => militaryTier(s) >= 3;
/** ≥90 私兵：据点/护卫的后置入口，本卡先置 flag 与文案 */
export const privateArmy = (s: WorldState = need()): boolean => repAxis('empire', 'military', s) >= MIL_TIERS[3];
/** ≥40 预知：可提前一日闻知日历事件（只泄漏标题） */
export const intelForesight = (s: WorldState = need()): boolean => intelTier(s) >= 2;
/** ≥60 识破：街谈与 lore 事实相悖时能听出破绽 */
export const intelDoubt = (s: WorldState = need()): boolean => intelTier(s) >= 3;
/** ≥80 情报网：不必亲至也能问到人与价 */
export const intelNetwork = (s: WorldState = need()): boolean => repAxis('guild', 'intelligence', s) >= INTEL_TIERS[3];

/* ---------------- 日累积载体（types/world.ts 属并线冲突区，用局部类型挂可选键） ---------------- */

/** 日累积计数（同 favorDay 的 {day,n} 结构：跨日自动重置） */
interface AxDay {
  day: number;
  n: number;
}
/** I4 结算基线：只记"已计入"的事实，避免重复给分 */
interface AxSeen {
  kill: Record<string, number>; // 上次已计入的匪类击杀数（增量计功）
  quest: string[]; // 已计入的军务委托 id
  mark: string[]; // 一次性标记（守城基准/守城完成/深聊人/特权授予）
  siegeBase: Record<string, number>; // 城防告急时刻的击杀基线
}
interface AxCarrier {
  milDay?: AxDay;
  gatherDay?: AxDay;
  obsDay?: AxDay;
  axSeen?: AxSeen;
}
const axOf = (s: WorldState) => s as unknown as WorldState & AxCarrier;
const seenOf = (s: WorldState): AxSeen => {
  const c = axOf(s);
  if (!c.axSeen) c.axSeen = { kill: {}, quest: [], mark: [], siegeBase: {} };
  if (!c.axSeen.kill) c.axSeen.kill = {};
  if (!c.axSeen.quest) c.axSeen.quest = [];
  if (!c.axSeen.mark) c.axSeen.mark = [];
  if (!c.axSeen.siegeBase) c.axSeen.siegeBase = {};
  return c.axSeen;
};
const dayRoom = (s: WorldState, key: 'milDay' | 'gatherDay' | 'obsDay'): AxDay => {
  const c = axOf(s);
  const d = sceneTime(s).day;
  if (!c[key] || c[key]!.day !== d) c[key] = { day: d, n: 0 };
  return c[key]!;
};

/** 匪类判定（数据驱动：荒野劫掠者 / 血系）——新怪物改数据即生效，零代码 */
export function isMilitiaFoe(mid: string): boolean {
  const nm = WB.monsters[mid]?.name || '';
  return mid.startsWith('bandit') || mid.startsWith('blood') || nm.includes('劫掠') || nm.includes('血');
}

/* ---------------- 写入口（全部经 adjRepAxis，单一出口） ---------------- */

/** 军功入账内部件：allOrNothing=true 时不足额即不落地（大额功勋留待次日，不作废） */
function pushMil(n: number, allOrNothing: boolean, why: string, s: WorldState): number {
  const d = dayRoom(s, 'milDay');
  const want = Math.max(0, Math.trunc(n));
  const k = Math.min(want, Math.max(0, MIL_DAY_CAP - d.n));
  if (k <= 0 || (allOrNothing && k < want)) return 0;
  d.n += k;
  adjRepAxis('empire', 'military', k, s);
  log('（' + why + ' +' + k + '　军功 ' + repAxis('empire', 'military', s) + '/100）', 'gain', s);
  return k;
}
/** 军功累积（唯一写入口）：先过日上限，再经 adjRepAxis 落地；返回实际入账值 */
export function addMilitary(n: number, why = '军功', s: WorldState = need()): number {
  return pushMil(n, false, why, s);
}

/** 情报入账内部件：打听与观察各有一条日上限 */
function pushIntel(n: number, kind: 'gather' | 'observe', why: string, s: WorldState): number {
  const cap = kind === 'gather' ? INTEL_GATHER_CAP : INTEL_OBSERVE_CAP;
  const d = dayRoom(s, kind === 'gather' ? 'gatherDay' : 'obsDay');
  const k = Math.min(Math.max(0, Math.trunc(n)), Math.max(0, cap - d.n));
  if (k <= 0) return 0;
  d.n += k;
  adjRepAxis('guild', 'intelligence', k, s);
  log('（' + why + ' +' + k + '　情报 ' + repAxis('guild', 'intelligence', s) + '/100）', 'gain', s);
  return k;
}
/** 打听成功 +1（日上限 3） */
export const addIntelGather = (s: WorldState = need()): number => pushIntel(1, 'gather', '打听到消息', s);
/** 观察成功 +1（日上限 2） */
export const addIntelObserve = (s: WorldState = need()): number => pushIntel(1, 'observe', '看出门道', s);
/** 深聊 +2（每人一次，不计日上限） */
export function addIntelDeep(npcId: string, s: WorldState = need()): number {
  const seen = seenOf(s);
  const key = 'deep:' + npcId;
  if (seen.mark.includes(key)) return 0;
  seen.mark.push(key);
  adjRepAxis('guild', 'intelligence', INTEL_DEEP_GAIN, s);
  log('（与' + (WB.npcs[npcId]?.name || npcId) + '深聊 +' + INTEL_DEEP_GAIN + '　情报 ' + repAxis('guild', 'intelligence', s) + '/100）', 'gain', s);
  return INTEL_DEEP_GAIN;
}

/* ---------------- 特权授予（置 flag + 文案，一次性） ---------------- */

/** 新达成的档位 → 置 flag + 一次性文案（返回本次新授予的档位名，供测试） */
export function grantPrivileges(s: WorldState = need()): string[] {
  const seen = seenOf(s);
  const got: string[] = [];
  const pay = (key: string, flag: string, text: string) => {
    const mark = 'priv:' + key;
    if (seen.mark.includes(mark)) return;
    seen.mark.push(mark);
    mutate.playerFlag(flag);
    log('❖ 特权解锁（' + key + '）：' + text, 'gain', s);
    toast('❖ ' + text, 'gain');
    got.push(key);
  };
  if (militaryCallable(s)) pay('征召', 'priv_levy', '军中给你留了名分——战时你可召两名城卫随行。');
  if (gateTaxFree(s)) pay('军职', 'priv_gate', '城门校尉认了你的军职：盘查从简，入城例钱免了。');
  if (privateArmy(s)) pay('私兵', 'priv_retinue', '一名老卒带着两名弓手投到你门下——私兵已成。');
  if (intelForesight(s)) pay('预知', 'priv_foresight', '你的耳目先于告示：明日将起之事，你已听说了。');
  if (intelDoubt(s)) pay('识破', 'priv_insight', '街谈与旧档对不上时，你能听出哪句是假的。');
  if (intelNetwork(s)) pay('情报网', 'priv_net', '线人网络铺开：不必亲至，也能问到人与价。');
  return got;
}

/* ---------------- 识破：与 lore 事实卡比对（判定全在 core，AI 只产文本） ---------------- */

const CN_NUM: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const FACT_TERMS = ['塔', '殿', '主神', '位面', '大陆', '纪元', '大罪'];
const numOf = (t: string): number => (/^\d+$/.test(t) ? Number(t) : CN_NUM[t] || 0);
/** 数字+名物（允许"层/块/位"等量词插在中间）：提取与判定共用同一张网 */
const countRe = () => new RegExp('([一二三四五六七八九十两]|\\d{1,2})(?:位|名|座|个|层|块|大|种)?(' + FACT_TERMS.join('|') + ')', 'g');

let factCache: Record<string, number> | null = null;
/** lore 事实表：从常驻设定卡提取"数量+名物"；同一条目出现多个取值即视为 lore 自身多义（如五塔/六塔），不设事实 */
export function loreFacts(): Record<string, number> {
  if (factCache) return factCache;
  const votes: Record<string, Record<number, number>> = {};
  for (const c of LORE) {
    const txt = (c.canon || '') + '\u3000' + (c.seed || '');
    const re = countRe();
    let m: RegExpExecArray | null;
    while ((m = re.exec(txt))) {
      const v = numOf(m[1]);
      if (!v) continue;
      votes[m[2]] = votes[m[2]] || {};
      votes[m[2]][v] = (votes[m[2]][v] || 0) + 1;
    }
  }
  const out: Record<string, number> = {};
  for (const term in votes) {
    const vs = Object.keys(votes[term]);
    if (vs.length === 1) out[term] = Number(vs[0]);
  }
  factCache = out;
  return out;
}
/** 识破（≥60）：文本与 lore canon 冲突 → 追加「·存疑」；无冲突或未达标一律原样返回 */
export function doubtMark(text: string, s: WorldState = need()): string {
  if (!intelDoubt(s) || !text || text.includes('·存疑')) return text;
  const facts = loreFacts();
  const re = countRe();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const claim = numOf(m[1]);
    const canon = facts[m[2]];
    if (canon !== undefined && claim !== canon) return text + ' ·存疑';
  }
  return text;
}
/** 识破落点：把近期与 lore 相悖的 AI 回包原文标「·存疑」（只动文本，不动数值；幂等） */
function doubtSweep(s: WorldState): number {
  let n = 0;
  for (const id of Object.keys(s.chats || {})) {
    const turns = s.chats![id] || [];
    for (let i = turns.length - 1; i >= 0 && i >= turns.length - 3; i--) {
      const t = turns[i];
      if (t.who !== 'n' || t.text.includes('·存疑')) continue;
      const marked = doubtMark(t.text, s);
      if (marked !== t.text) {
        t.text = marked;
        n++;
      }
    }
  }
  return n;
}

/* ---------------- 预知：明日将命中的日历事件标题（只泄漏标题，不泄漏效果） ---------------- */

/** 情报 ≥40 时返回明日将命中的事件标题；未达标返回空数组 */
export function foresightTitles(s: WorldState = need()): { id: string; name: string }[] {
  if (!intelForesight(s)) return [];
  const tomorrow = sceneTime(s).day + 1;
  const fired = (id: string) => s.events.some((e) => e.id === id || e.id.startsWith(id + ':'));
  return ALL_EVENTS.filter((ev) => {
    if (ev.trigger.manual || fired(ev.id)) return false;
    const t = ev.trigger;
    /* 只预报"日历可推"的事件：旗标/声望/月内日期/时辰条件的事件不属于可预知范围 */
    if (t.flag !== undefined || t.notFlag !== undefined || t.repAxis || t.month !== undefined || t.date !== undefined || t.shichen !== undefined) return false;
    if (t.afterEvent !== undefined) return fired(t.afterEvent) && (t.dayMin === undefined || t.dayMin <= tomorrow);
    return t.dayMin === tomorrow;
  }).map((ev) => ({ id: ev.id, name: ev.name }));
}

/* ---------------- 怠惰结算（场景行动边界调用） ---------------- */

export interface SettleResult {
  mil: number;
  intel: number;
}
const foeSnapshot = (s: WorldState): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const mid of Object.keys(s.killed || {})) if (isMilitiaFoe(mid)) out[mid] = s.killed[mid] || 0;
  return out;
};

/** 把"已发生但未计入轴"的事实一次性落地（幂等）。
 *  顺序：大额优先（守城·军务，不足额留待次日）→ 小额剿匪（当日超额作废）。 */
export function settleAxes(s: WorldState = need()): SettleResult {
  const seen = seenOf(s);
  let mil = 0;
  let intel = 0;

  /* ① 守城之功：城防告急旗标存在期间击退 ≥3 名匪类 → +5（一次性） */
  if (s.player.flags.city_siege) {
    if (!seen.mark.includes('siege_base')) {
      seen.mark.push('siege_base');
      seen.siegeBase = foeSnapshot(s);
    }
    if (!seen.mark.includes('siege_done')) {
      let repelled = 0;
      /* 基线须与"当前全部匪类键"求并集：告急后才首次出现的怪物 id 不在快照里 */
      const ids = new Set([...Object.keys(seen.siegeBase), ...Object.keys(s.killed || {}).filter(isMilitiaFoe)]);
      for (const mid of ids) repelled += Math.max(0, (s.killed[mid] || 0) - (seen.siegeBase[mid] || 0));
      if (repelled >= SIEGE_REPEL_KILLS) {
        const k = pushMil(MIL_SIEGE_GAIN, true, '守城之功', s);
        if (k > 0) {
          seen.mark.push('siege_done');
          mutate.playerFlag('city_defended');
          mil += k;
        }
      }
    }
  }

  /* ② 军务委托：判定取自数据——reward.rep.empire 的委托就是给帝国办的军务 */
  for (const qid of Object.keys(s.player.quests || {})) {
    if (seen.quest.includes(qid)) continue;
    const st = s.player.quests[qid];
    const q = WB.quests[qid];
    if (!st || st.stage !== 'fin' || !q?.reward?.rep?.empire) continue;
    const k = pushMil(MIL_QUEST_GAIN, true, '军务·' + q.name, s);
    if (k > 0) {
      seen.quest.push(qid);
      mil += k;
    }
  }

  /* ③ 剿匪：bandit/blood 系击杀增量 ×1（当日超额作废，不结转） */
  for (const mid of Object.keys(s.killed || {})) {
    if (!isMilitiaFoe(mid)) continue;
    const cur = s.killed[mid] || 0;
    const prev = seen.kill[mid] || 0;
    if (cur <= prev) continue;
    seen.kill[mid] = cur;
    mil += pushMil(cur - prev, false, '剿匪·' + (WB.monsters[mid]?.name || mid), s);
  }

  /* ④ 深聊：与 study/guild 系深谈 ≥3 轮 → 每人一次 +2 */
  for (const id of Object.keys(s.chats || {})) {
    const n = WB.npcs[id];
    if (!n || (n.faction !== 'study' && n.faction !== 'guild')) continue;
    if ((s.chats![id] || []).filter((t) => t.who === 'p').length < INTEL_DEEP_TURNS) continue;
    intel += addIntelDeep(id, s);
  }

  /* ⑤ 识破：把与 lore 相悖的 AI 回包标·存疑（判定在此，AI 只产文本） */
  if (intelDoubt(s)) doubtSweep(s);

  grantPrivileges(s);
  return { mil, intel };
}

