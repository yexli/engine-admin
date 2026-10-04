/* ============================================================
   卡 I2 · 技艺工坊（锻造 / 炼金 / 铭刻）
   —— 站点、配方、解锁门、文案全部落在 src/data/world/craft.json（data 层零逻辑）。
   —— 一次咬合六条线：地下城材料（供给侧）· 学院课程（解锁）· 命名生成器（专名走 equip）
      · 神殿祝圣（inscribe 站）· 经济物价（材料与产出都过 priceOf）· 法律违禁（illegalRecipes）。
   —— 唯一写入口 craft()：扣料 → advance 演出 → 掷实例 → 入包/记废品；
      UI 只提交 GameCommand（ui:a=craft_do），core 权威校验，不采信 UI 的 dis。
   ============================================================ */
import academyJson from '@/data/world/academy.json';
import craftJson from '@/data/world/craft.json';
import { STARHUB } from '@/data/starhub';
import { WB } from '@/data/worldBook';
import type { RecipeDef, StationDef, WorldState } from '@/types/world';
import { bus, clamp, rng, toast, worldBus } from '@/events/EventBus';
import { makeEvent } from '@/events/EventSchema';
import { addInstance, instName, rollInstance } from '@/systems/inventory/Equip';
import { addItem, gainGold, itemCount, log, removeItem } from '@/systems/character/Gains';
import { commitCrime } from '@/systems/law/Law';
import { closeSheet } from '@/systems/character/Sheet';
import { need, save, sync } from '@/world/WorldState';
import { advance, sceneTime } from '@/world/WorldClock';

/* ---------------- 数据固化 ---------------- */

interface AcademyCourse {
  courseId: string;
  name: string;
  recipes?: string[];
}
interface AcademyDef {
  id: string;
  name: string;
  focus: string;
  curriculum: AcademyCourse[];
}

const STATIONS = craftJson.stations as unknown as StationDef[];
const RECIPES = craftJson.recipes as unknown as RecipeDef[];
const ILLEGAL = new Set(craftJson.illegalRecipes as string[]);
const ACADEMIES = (academyJson as unknown as { academies: AcademyDef[] }).academies;

/** recipeId → 课程门（由 academy.json 的课程 recipes 字段反查，数据驱动、零硬编码） */
const RECIPE_GATE = new Map<string, { courseId: string; courseName: string; academyName: string }>();
for (const ac of ACADEMIES) {
  for (const c of ac.curriculum || []) {
    for (const rid of c.recipes || []) RECIPE_GATE.set(rid, { courseId: c.courseId, courseName: c.name, academyName: ac.name });
  }
}

export const craftStations = (): StationDef[] => STATIONS;
export const craftRecipes = (station?: string): RecipeDef[] => (station ? RECIPES.filter((r) => r.station === station) : RECIPES.slice());
export const isIllegalRecipe = (id: string): boolean => ILLEGAL.has(id);

/* ---------------- 站点 ---------------- */

export const stationOf = (id: string): StationDef | undefined => STATIONS.find((s) => s.id === id);
/** 站入口（按玩家所在地点推导；同一地点多站时取数据表首个） */
export const stationAt = (loc: string): StationDef | undefined => STATIONS.find((s) => s.loc === loc);
/** G10 契约：对话选项由 stations[].npcId 派生——不在 dialogue.ts 逐人加 case */
export const stationOfNpc = (npcId: string): StationDef | undefined => STATIONS.find((s) => s.npcId === npcId);

const towerOpen = (id: string): boolean => (STARHUB.towers.find((t) => t.id === id)?.status ?? 'locked') === 'open';

/** 站点是否开放（course/tower 两把门；缺失未定义的门视为通过） */
export function stationGate(st: StationDef | undefined, s: WorldState = need()): { open: boolean; why: string } {
  if (!st) return { open: false, why: '此处没有工坊。' };
  const u = st.unlock;
  if (!u) return { open: true, why: '' };
  if (u.course && !(s.academy?.completed || []).includes(u.course)) {
    const gate = RECIPE_GATE.size ? findCourse(u.course) : null;
    return { open: false, why: '先去' + (gate?.academyName ?? '学院') + '修完「' + (gate?.courseName ?? u.course) + '」。' };
  }
  if (u.tower && !towerOpen(u.tower)) return { open: false, why: '星枢「' + u.tower + '」尚未开放。' };
  return { open: true, why: '' };
}

function findCourse(courseId: string): { courseName: string; academyName: string } | null {
  for (const ac of ACADEMIES) for (const c of ac.curriculum || []) if (c.courseId === courseId) return { courseName: c.name, academyName: ac.name };
  return null;
}

/** 学院工艺课结业数（focus='craft' 的学院；工坊技艺等级公式的一项） */
function craftCourseCount(s: WorldState): number {
  const done = s.academy?.completed || [];
  let n = 0;
  for (const ac of ACADEMIES) {
    if (ac.focus !== 'craft') continue;
    for (const c of ac.curriculum || []) if (done.includes(c.courseId)) n++;
  }
  return n;
}

/** 技艺等级 = 生产系职业 +2 + 学院工艺课结业数 + 站点熟练度/2 + 站点加成 */
export function craftLv(station: string, s: WorldState = need()): number {
  const cls = WB.classes[s.player.cls];
  const st = stationOf(station);
  const job = cls?.lineage === '生产' ? 2 : 0;
  const ranks = s.craft?.ranks?.[station] || 0;
  return job + craftCourseCount(s) + Math.floor(ranks / 2) + (st?.bonus || 0);
}

/* ---------------- 判定 ---------------- */

export interface CraftNeedRow {
  id: string;
  name: string;
  have: number;
  need: number;
  ok: boolean;
}
export interface CraftRow {
  id: string;
  name: string;
  tier: number;
  need: CraftNeedRow[];
  gold: number;
  outText: string;
  ticks: number;
  pct: number; // 成功率（百分比整数）
  illegal: boolean;
  ok: boolean;
  why: string;
  seed: string;
}
export interface CraftView {
  id: string;
  name: string;
  desc: string;
  loc: string;
  locName: string;
  lv: number;
  open: boolean;
  why: string;
  rows: CraftRow[];
}

/** 配方产出的人类可读描述（UI 纯文本；装备类由 I1 的掷档决定实际品质，此处只给 base） */
function outTextOf(r: RecipeDef): string {
  const o = r.out;
  if (o.item) return (WB.items[o.item]?.name ?? o.item) + ' ×' + (o.qty || 1);
  const base = WB.items[o.base || '']?.name ?? (o.base || '');
  return base + '（品质档 ' + (o.tier || r.tier) + '，词缀随炉火掷定）';
}

/** 权威校验：任一门不过即拒（UI 的 dis 只是体验层） */
export function canCraft(r: RecipeDef, s: WorldState = need()): { ok: boolean; why: string } {
  const st = stationOf(r.station);
  const gate = stationGate(st, s);
  if (!gate.open) return { ok: false, why: gate.why };
  const lv = craftLv(r.station, s);
  if (lv < r.skillMin) return { ok: false, why: '技艺不足（需 ' + r.skillMin + '，当前 ' + lv + '）。' };
  const g = RECIPE_GATE.get(r.id);
  if (g && !(s.academy?.completed || []).includes(g.courseId))
    return { ok: false, why: '先去' + g.academyName + '修完「' + g.courseName + '」。' };
  if (r.needCodex && !(s.codex?.unlocked || []).includes(r.needCodex))
    return { ok: false, why: '这门手艺还差一份文献（图鉴未解）。' };
  const lack: string[] = [];
  for (const [iid, q] of r.need.items) {
    const have = itemCount(iid, s);
    if (have < q) lack.push((WB.items[iid]?.name ?? iid) + ' ×' + (q - have));
  }
  if (lack.length) return { ok: false, why: '缺材料：' + lack.join('、') + '。' };
  if (r.need.gold > s.player.gold) return { ok: false, why: '铜钱不足（需 ' + r.need.gold + '）。' };
  return { ok: true, why: '' };
}

/** 成功率 = clamp(0.95 − failRate + craftLv×0.03, 0.35, 0.98) */
export function successRate(r: RecipeDef, s: WorldState = need()): number {
  return clamp(0.95 - r.failRate + craftLv(r.station, s) * 0.03, 0.35, 0.98);
}

/** 工坊视图（core → UI 的纯数据；React 不摸 core.S） */
export function craftView(station: string, s: WorldState = need()): CraftView {
  const st = stationOf(station);
  const gate = stationGate(st, s);
  return {
    id: station,
    name: st?.name ?? station,
    desc: st?.desc ?? '',
    loc: st?.loc ?? '',
    locName: st ? WB.locations[st.loc]?.name ?? st.loc : '',
    lv: craftLv(station, s),
    open: gate.open,
    why: gate.why,
    rows: craftRecipes(station).map((r) => {
      const chk = canCraft(r, s);
      return {
        id: r.id,
        name: r.name,
        tier: r.tier,
        need: r.need.items.map(([iid, q]) => {
          const have = itemCount(iid, s);
          return { id: iid, name: WB.items[iid]?.name ?? iid, have, need: q, ok: have >= q };
        }),
        gold: r.need.gold,
        outText: outTextOf(r),
        ticks: r.ticks,
        pct: Math.round(successRate(r, s) * 100),
        illegal: ILLEGAL.has(r.id),
        ok: chk.ok,
        why: chk.why,
        seed: r.seed,
      };
    }),
  };
}

/** 打开工坊浮层 */
export function craftMenu(station: string): void {
  const st = stationOf(station);
  if (!st) {
    toast('此处没有工坊。', 'bad');
    return;
  }
  const gate = stationGate(st);
  if (!gate.open) {
    toast('✖ ' + gate.why, 'bad');
    return;
  }
  bus.emit({ type: 'sheet', desc: { kind: 'craft', station } });
}

/** 站在地上开站（行动坞入口）：按当前位置找站 */
export function craftHere(loc: string = need().player.loc): void {
  const st = stationAt(loc);
  if (!st) {
    toast('这里没有可用的工坊。', 'bad');
    return;
  }
  craftMenu(st.id);
}

/* ---------------- 写入口 ---------------- */

/** 制作（唯一写入口）。幂等键 = craft_<recipeId>_<tick>，同刻重复提交只算一次。 */
export function craft(rid: string): void {
  const s = need();
  const r = RECIPES.find((x) => x.id === rid);
  if (!r) return;
  if (!s.craft) s.craft = { ranks: {}, made: {} };
  const chk = canCraft(r, s);
  if (!chk.ok) {
    toast('✖ ' + chk.why, 'bad');
    return;
  }
  /* 幂等键取**推进后的目标刻**：advance(r.ticks) 必然改动 s.t，用推进前的刻记键，
     等于每次提交都算出一个新键，闸门永不命中（审查 §工坊）。ticks=0 的配方仍按同刻去重。 */
  const key = 'craft_' + r.id + '_' + (s.t + r.ticks);
  if (s.craft.recent && s.craft.recent[key]) {
    toast('这一炉刚刚起过火了。', 'bad');
    return;
  }
  const lv0 = craftLv(r.station, s);
  const p = successRate(r, s);
  /* 扣料（core 权威：UI 只提交 id） */
  for (const [iid, q] of r.need.items) removeItem(iid, q);
  if (r.need.gold > 0) gainGold(-r.need.gold);
  log(r.seed, 'nar', s);
  closeSheet();
  advance(r.ticks); // 耗时推进：天气/时段/事件/NPC 日程照常结算，世界不冻结
  s.craft.recent = s.craft.recent || {};
  s.craft.recent[key] = s.t;
  s.craft.ranks[r.station] = (s.craft.ranks[r.station] || 0) + 1;

  const ok = rng.chance(p);
  if (ok) {
    if (r.out.base) {
      const luck = (r.out.luckBias || 0) + lv0;
      const tier = r.out.tier || r.tier;
      const inst = rollInstance(r.out.base, tier, luck, { allowGod: tier >= 5 });
      inst.af = inst.af || [];
      addInstance(inst);
      s.craft.made[r.id] = (s.craft.made[r.id] || 0) + 1;
      log('出炉——' + instName(inst) + '。', 'gain', s);
      toast('✦ ' + instName(inst), 'gain');
    } else if (r.out.item) {
      const qty = r.out.qty || 1;
      addItem(r.out.item, qty);
      s.craft.made[r.id] = (s.craft.made[r.id] || 0) + 1;
      log('成品收好：' + (WB.items[r.out.item]?.name ?? r.out.item) + ' ×' + qty + '。', 'gain', s);
    }
    /* 违禁配方：成功即立案（复用既有罪名，不新增分级；法外之地由 commitCrime 自行放过） */
    if (ILLEGAL.has(r.id)) commitCrime('smuggling', s.player.loc);
    /* §22/§34：出炉是已发生的事实（L1 局部事件）——产物、工坊与品阶一并记入世界史 */
    worldBus.emit(
      makeEvent({
        type: 'item_crafted',
        day: sceneTime(s).day,
        tick: s.t,
        actor: 'player',
        target: r.out.item ?? r.out.base,
        location: s.player.loc,
        cause: r.id,
        data: { recipe: r.id, station: r.station, tier: r.out.tier ?? r.tier },
      }),
    );
  } else {
    /* 失败代价：返还 50% 材料（向下取整）+ 装备配方产出一件普通品质废品（可自用/可卖） */
    const back: string[] = [];
    for (const [iid, q] of r.need.items) {
      const n = Math.floor(q * 0.5);
      if (n > 0) {
        addItem(iid, n);
        back.push((WB.items[iid]?.name ?? iid) + ' ×' + n);
      }
    }
    if (r.out.base) addInstance({ id: r.out.base, qty: 1, q: 0, af: [] });
    log(
      '炉火没照看你这一回——' + (r.out.base ? '胚料塌成了一块废件，' : '') + (back.length ? '好歹抢回了' + back.join('、') + '。' : '料全废了。'),
      'bad',
      s,
    );
    toast('✖ ' + r.name + '失败', 'bad');
  }
  save();
  sync();
  craftMenu(r.station); // 回到工坊界面（世界已推进，配方可用性随之刷新）
}

/** 站名（UI 标题用） */
export const stationName = (id: string): string => stationOf(id)?.name ?? id;
