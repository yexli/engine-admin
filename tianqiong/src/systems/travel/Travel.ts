/* ============================================================
   卡 E3 · 跨大陆交通系统（《项目方案》§10）
   远行不是「点 A→B」：受距离(天数)/交通方式/费用/天气季节/危险/通行证约束，
   途中按危险度触发随机遭遇。全部状态改写只在 core，经引擎命令进入。
   ============================================================ */
import raw from '@/data/world/routes.json';
import { WB } from '@/data/worldBook';
import type { WorldState } from '@/types/world';
import { rng, toast, worldBus } from '@/events/EventBus';
import { makeEvent } from '@/events/EventSchema';
import { startCombat } from '@/systems/combat/Combat';
import { gainGold, log } from '@/systems/character/Gains';
import { formatMoney } from '@/systems/economy/Money';
import { addHistory } from '@/events/EventStore';
import { need, sync } from '@/world/WorldState';
import { mutate } from '@/world/WorldMutate';
import { advance, CHEN_PER_DAY, sceneTime } from '@/world/WorldClock';

export interface RouteDef {
  id: string;
  from: string;
  to: string;
  name: string;
  mode: string;
  days: number;
  cost: number; // 铜
  danger: number; // 1–5
  needPass?: string; // 通行证 flag
  flavor?: string;

  /* ---- 卡 T4 · 路线扩展插槽（一律数据驱动，加航线不改代码） ----
     seasonal：季节封锁窗口（months 为 0–11 的月序号；跨年窗口写成 [11,0,1]）。
     tags / unlock / minLevel / hub / loreRef 为预留位：分别供面板筛选、
     条件解锁（未来做"需先完成某任务"）、准入等级、枢纽设施展示、canon 引用。 */
  seasonal?: { months: number[]; reason: string; until?: string };
  /* 卡 S1：险区穿越的扩展位（世界书 §73/§74）——路线可声明途中经过哪些险区 */
  zones?: string[];
  tags?: string[];
  unlock?: { kind: 'flag' | 'rep' | 'quest'; key: string; min?: number };
  minLevel?: number;
  hub?: string[];
  loreRef?: string;
}

const ROUTES: Record<string, RouteDef> = Object.fromEntries((raw.routes as RouteDef[]).map((r) => [r.id, r]));

/* ============================================================
   卡 J5 · 大陆可达性（《后续开发方案-阶段J》）
   —— 阶段 J 审计实测的三重死锁，全在这一段解开：
     ① locked 是死锁：ActionExecutor.go():29 是它唯一的消费点，永远拦截，
        没有任何解除路径（注释写着「E3 跨大陆交通后再解锁」，而 E3 早已做完）；
     ② 通行证无来源：pass_sea / pass_war / pass_deep / pass_sky 在生产代码里
        零写入，唯一赋值点是 cardE3.test.ts —— 玩家永远拿不到；
     ③ 回不去：外大陆不在 WB.travel 表里，而路线是单向的
        （routeTo(id) 找 to===loc，canDepart 又要求 player.loc === from）。
   修法是把「能不能去」从**布尔常量**改成**数据驱动的条件计算**：
   大陆定义在 data/world/continents.json，locked 的位置语义变成
   「这是需要解锁的大陆枢纽」，判定交给 continentUnlocked()。
   ============================================================ */

/** 取地点所属的大陆名（地点上的 continent 字段是权威） */
export const continentOf = (loc: string): string | undefined => WB.locations[loc]?.continent;

/**
 * 大陆首访 flag 的键。
 * 优先用数据里的英文 id（存档 diff、调试输出与将来的外部编辑器都不必处理中文键），
 * 缺定义时回落到大陆名——一个漏登记的数据条目不该让记账整个丢掉。
 */
export const continentFlagKey = (name: string): string => 'continent_' + (WB.continents.items[name]?.id ?? name);

/**
 * 大陆是否已解锁（唯一判定口径）。
 * 未在 continents.json 里登记的大陆不设门槛——宁可放行，也不让一个漏登记的
 * 数据条目把玩家永久关在门外（这类「数据缺失即锁死」是死锁的温床）。
 */
export function continentUnlocked(name: string, s: WorldState = need()): boolean {
  const c = WB.continents.items[name];
  if (!c) return true;
  const u = c.unlock;
  if (u.kind === 'open') return true;
  if (u.kind === 'flag') return !!s.player.flags[u.flag];
  return (s.rep[u.faction] ?? 0) >= u.min;
}

/** 未解锁时的可读原因（给地图与 toast 用）；已解锁返回 null */
export function continentLockReason(name: string, s: WorldState = need()): string | null {
  const c = WB.continents.items[name];
  if (!c) return null;
  const u = c.unlock;
  if (u.kind === 'open') return null;
  if (u.kind === 'flag') return s.player.flags[u.flag] ? null : (u.hint ?? '尚不可通行');
  return (s.rep[u.faction] ?? 0) >= u.min ? null : (u.hint ?? '尚不可通行');
}

/**
 * 地点是否可进入。
 * locked 的地点不再永久不可达——它只表示「这里归某块待开拓的大陆管」，
 * 能不能进由那块大陆的解锁条件说了算。
 */
export function canEnter(loc: string, s: WorldState = need()): boolean {
  const L = WB.locations[loc];
  if (!L) return false;
  if (!L.locked) return true;
  const c = continentOf(loc);
  return c ? continentUnlocked(c, s) : false;
}

export const allRoutes = (): RouteDef[] => Object.values(ROUTES);
export const routeById = (id: string): RouteDef | undefined => ROUTES[id];
/** 抵达某目的地的路线（供地图面板把「待开拓」枢纽显示为可远行） */
export const routeTo = (loc: string): RouteDef | undefined => Object.values(ROUTES).find((r) => r.to === loc);

export interface DepartResult {
  ok: boolean;
  msg?: string;
  days?: number;
  ambushed?: boolean;
}

/**
 * 当前是否落在该路线的季节封锁窗口内（卡 T4 · 世界书 §74）。
 * 纯函数、不写状态：地图置灰、菜单提示与 canDepart 三处共用同一判据，
 * 免得「地图说能走、点了说不能走」这类双实现漂移。
 */
export function seasonalBlock(r: RouteDef, s: WorldState = need()): { blocked: boolean; reason?: string } {
  const sea = r.seasonal;
  if (!sea || !sea.months.length) return { blocked: false };
  if (!sea.months.includes(sceneTime(s).monthIndex)) return { blocked: false };
  return { blocked: true, reason: sea.reason + (sea.until ? '（' + sea.until + '）' : '') };
}

/** 出发前可行性校验（不改状态；供 UI 置灰/提示） */
export function canDepart(id: string, s: WorldState = need()): { ok: boolean; reason?: string } {
  const r = ROUTES[id];
  if (!r) return { ok: false, reason: '路线不存在' };
  /* 双向：路是人走出来的。玩家在路线任一端都能启程——
     此前只认 from，于是「到了外大陆就回不来」（审计发现的第三重死锁）。 */
  const here = s.player.loc;
  if (here !== r.from && here !== r.to) {
    return { ok: false, reason: '需先到「' + (WB.locations[r.from]?.name || r.from) + '」或「' + (WB.locations[r.to]?.name || r.to) + '」' };
  }
  /* 卡 J5：进入某块大陆的资格有**两条来路**，任一满足即可——
     ① 目的地大陆已解锁（声望 / flag 达标）：被那块大陆接纳；
     ② 持有该路线的通行凭证 flag（pass_sea / pass_war / pass_deep / pass_sky）：
        先于大陆声望到手的特殊凭证，留给任务奖励 / 商店 / 势力特权发的后门。
     两者都没有才拒。
     注意这里刻意**不是**「大陆门槛 THEN 凭证门槛」的串联：那样写等于宣布凭证永远
     没用（大陆没解锁时凭证救不了、解锁后凭证又多余），而审计实测这四个 flag 在
     生产代码里本来就没有写入点——串联会让四条航线永久焊死。 */
  const dest = here === r.from ? r.to : r.from;
  const cont = continentOf(dest);
  const unlocked = !cont || continentUnlocked(cont, s);
  const hasPass = !r.needPass || !!s.player.flags[r.needPass];
  if (!unlocked && !hasPass) {
    return { ok: false, reason: cont ? (continentLockReason(cont, s) ?? '那块大陆尚未开放') : '缺少通行凭证' };
  }
  /* 卡 T4：季节封锁（世界书 §74）。判定放在资格之后、费用之前——
     先让玩家知道「这条路现在不开」，而不是先收他一句「钱不够」。 */
  const sea = seasonalBlock(r, s);
  if (sea.blocked) return { ok: false, reason: sea.reason };
  /* 卡 T4：准入等级插槽（minLevel）。留在这里是为了让数据里写了就生效，
     不必等哪个系统先接线——未来调高某条航线门槛只改 JSON。 */
  if (r.minLevel !== undefined && s.player.level < r.minLevel) {
    return { ok: false, reason: '此路需 Lv.' + r.minLevel + ' 以上才能独自通行' };
  }
  if (s.player.gold < r.cost) return { ok: false, reason: '旅费不足（需 ' + r.cost + ' 铜）' };
  return { ok: true };
}

/** 按危险度选一种途中遭遇魔物 */
function ambushMob(danger: number): string {
  if (danger >= 5) return rng.pick(['ghoul', 'wolf']);
  if (danger >= 3) return rng.pick(['wolf', 'bandit', 'rabbit']);
  return 'bandit';
}

/** 出发远行：扣旅费→天气/季节可能延误→推进天数→按危险度触发遭遇→抵达解锁 */
export function depart(id: string): DepartResult {
  const s = need();
  const chk = canDepart(id, s);
  if (!chk.ok) {
    toast('✖ ' + chk.reason, 'bad');
    return { ok: false, msg: chk.reason };
  }
  const r = ROUTES[id];
  /* 卡 J5：从哪一端出发就往另一端去——同一份路线定义服务双向通行 */
  const dest = s.player.loc === r.from ? r.to : r.from;
  const destName = WB.locations[dest]?.name ?? r.name;
  /* 出发地在语义上也是「你待过的地方」。开局就在中央大陆，若不在离开时补记，
     第一次回国会被记成「首度踏上中央大陆」——一个玩家会觉得荒谬的事实。
     补记在出发侧，不需要在 newGame 里特判，也不给查询函数加副作用。 */
  const fromCont = continentOf(s.player.loc);
  if (fromCont) mutate.playerFlag(continentFlagKey(fromCont));
  gainGold(-r.cost);
  let days = r.days;
  // 天气/季节影响行程（雪/雨有概率延误）
  if ((s.weather === '雪' || s.weather === '雨') && rng.chance(0.5)) {
    days += 1;
    log('途中' + (s.weather === '雪' ? '风雪' : '暴雨') + '阻路，行程延误一日。', 'nar', s);
  }
  log(r.flavor || '你踏上了前往' + destName + '的' + r.mode + '之旅。', 'nar', s);
  advance(days * CHEN_PER_DAY);
  mutate.playerLoc(dest);
  addHistory('远行抵达' + destName, r.mode + '·' + days + '日', 2);
  /* 卡 J5 · 首次踏足：把「我什么时候来的这里」变成可追溯的世界事实。
     为什么只记首次：日复一日的往返是噪音，会淹没世界史里真正值得回溯的那一条。 */
  if (!s.player.flags['visited_' + dest]) {
    mutate.playerFlag('visited_' + dest);
    worldBus.emit(makeEvent({ type: 'travel_arrived', day: sceneTime(s).day, level: 1, actor: 'player', location: dest }));
    const c = continentOf(dest);
    const cKey = c ? continentFlagKey(c) : '';
    if (c && !s.player.flags[cKey]) {
      mutate.playerFlag(cKey);
      addHistory('首度踏上' + c, (WB.continents.items[c]?.flavor ?? '').slice(0, 24), 3);
    }
  }
  // 危险度驱动的随机遭遇
  const ambushed = rng.chance(0.12 + r.danger * 0.08);
  if (ambushed) {
    const mob = ambushMob(r.danger);
    log('途中遇袭——' + (WB.monsters[mob]?.name || '不速之客') + '拦住了去路！', 'bad', s);
    sync();
    startCombat([mob]);
    return { ok: true, days, ambushed: true };
  }
  log('历经 ' + days + ' 日风尘，你终于抵达了' + destName + '。', 'nar', s);
  sync();
  return { ok: true, days, ambushed: false };
}

/* ============================================================
   卡 E2 · 城内可达性（《地图面板方案》）

   travel 表是一张有向图，而 ActionExecutor.go() 只认相邻边。
   但「相邻」和「能到」是两件事：在城外旷野时，城里七个地点一个都不在
   wild 的邻接表里（"wild": { "gate": 3, "cave": 3 }），可 wild → gate → plaza
   明明走得通。地图此前只判断相邻，把「两跳可达」和「根本去不了」渲染成
   同一句「需经别处」，而且按钮 disabled——玩家连试都试不了。

   这三件东西补上，UI 不必自己拼判断也不该自己拼：
     · neighborsOf(loc)    一步能到哪
     · routeBetween(a, b)  最少刻数怎么走（松弛求最短路，返回完整路径）
     · reach(a, b)         三态：这里 / 直达 / 需中转到哪 / 到不了

   刻意**不做自动多跳**：go() 每一跳都要结算夜间遇袭与城卫盘查，
   自动连跳会把中间发生的事全吞掉——玩家醒过来在城里，路上遇见了什么
   一无所知。地图负责给路径，走不走、怎么走由玩家一段段决定。

   新增地图只需在 geo.json 的 travel 里连边，这里一行都不用改。
   ============================================================ */

/** 一步能到哪（有向：只取出边；表里没连边的地点返回空数组） */
export function neighborsOf(loc: string): { loc: string; cost: number }[] {
  const row = WB.travel[loc];
  if (!row) return [];
  return Object.entries(row)
    .filter(([, c]) => typeof c === 'number')
    .map(([l, c]) => ({ loc: l, cost: c as number }));
}

/** 某地点是不是当前位置的邻居（直达） */
export const isDirect = (from: string, to: string): boolean => typeof WB.travel[from]?.[to] === 'number';

/**
 * 最少刻数的路径。返回 [from, …, to] 与总刻数；走不到返回 null。
 * 用带重入队的松弛（边权非负、图很小，17 个节点），不做启发式：
 * 这是据点内的步行图，精度比速度重要。
 */
export function routeBetween(from: string, to: string): { path: string[]; cost: number } | null {
  if (!WB.locations[from] || !WB.locations[to]) return null;
  if (from === to) return { path: [from], cost: 0 };
  const dist: Record<string, number> = { [from]: 0 };
  const prev: Record<string, string> = {};
  const q: string[] = [from];
  while (q.length) {
    const cur = q.shift() as string;
    for (const n of neighborsOf(cur)) {
      const nd = dist[cur] + n.cost;
      if (dist[n.loc] === undefined || nd < dist[n.loc]) {
        dist[n.loc] = nd;
        prev[n.loc] = cur;
        q.push(n.loc);
      }
    }
  }
  if (dist[to] === undefined) return null;
  const path: string[] = [];
  for (let p: string | undefined = to; p !== undefined; p = prev[p]) path.unshift(p);
  return { path, cost: dist[to] };
}

/**
 * 三态可达性——地图、场景坞、任何要给「能不能去」下判断的地方都走这里。
 * 加新界面时不要自己写 `cost != null`：那个判断分不出「两跳」和「去不了」，
 * 就是这一版要修的那个 bug。
 */
export type Reach =
  | { kind: 'here' }
  | { kind: 'direct'; cost: number }
  | { kind: 'via'; cost: number; path: string[] }
  | { kind: 'unreachable' };

export function reach(from: string, to: string): Reach {
  if (from === to) return { kind: 'here' };
  if (isDirect(from, to)) return { kind: 'direct', cost: WB.travel[from][to] };
  const r = routeBetween(from, to);
  if (!r || r.path.length < 2) return { kind: 'unreachable' };
  return { kind: 'via', cost: r.cost, path: r.path };
}

/* ============================================================
   卡 S1 · 地标与险区（世界书 §73/§75）
   险区按六星制分级（★ 普通险地 ～ ★★★★★★ 神罚级禁区），穿越概率随星级上升。
   数据在 geo.json 的 landmarks / dangerZones；本段只做判定，不写状态。
   ============================================================ */

export interface LandmarkDef {
  id: string; name: string; kind: 'natural' | 'artificial';
  continent: string; area: string; note: string; danger: number;
}
export interface DangerZoneDef { id: string; name: string; continent: string; stars: number; reason: string }

/** 全部地标（供地图与面板直读） */
export const landmarks = (): LandmarkDef[] =>
  ((WB as unknown as { landmarks?: LandmarkDef[] }).landmarks ?? []).slice();

/** 全部险区 */
export const dangerZones = (): DangerZoneDef[] =>
  ((WB as unknown as { dangerZones?: DangerZoneDef[] }).dangerZones ?? []).slice();

/** 某大陆的地标（地图按大陆聚合） */
export const landmarksOf = (continent: string): LandmarkDef[] => landmarks().filter((l) => l.continent === continent);

/** 某大陆的险区 */
export const zonesOf = (continent: string): DangerZoneDef[] => dangerZones().filter((z) => z.continent === continent);

/** 玩家当前所在地所属大陆上的地标（场景坞/地图提示用） */
export function landmarksHere(s: WorldState = need()): LandmarkDef[] {
  const cont = WB.locations[s.player.loc]?.continent ?? '';
  return cont ? landmarksOf(cont) : [];
}

/** 按 id 取险区 */
export const zoneById = (id: string): DangerZoneDef | undefined => dangerZones().find((z) => z.id === id);

/**
 * 穿越险区的遭遇概率：0.06 + 星级 × 0.07（一星 13%、六星 48%）。
 * 与航行危险度那套分开算——航线危险是"路上有人劫你"，险区是"这片地本身不容人"。
 */
export const zoneEncounterChance = (stars: number): number => Math.min(0.9, 0.06 + Math.max(0, stars) * 0.07);

/** 按险区星级挑一种遭遇魔物（星级越高越硬） */
function zoneMob(stars: number): string {
  if (stars >= 6) return rng.pick(['ghoul', 'abyss_spawn', 'templar']);
  if (stars >= 4) return rng.pick(['ghoul', 'skeleton', 'templar']);
  if (stars >= 3) return rng.pick(['spider', 'skeleton', 'wolf']);
  return rng.pick(['wolf', 'bandit', 'goblin']);
}

/**
 * 进入险区：掷遭遇 → 命中则开战。返回是否触发遭遇（供调用方决定后续叙事）。
 * 不动玩家位置——"进入险区"是就地遭遇，不是传送（位置仍由 go/travel 决定）。
 */
export function enterZone(zoneId: string, s: WorldState = need()): { triggered: boolean; why: string } {
  const z = zoneById(zoneId);
  if (!z) return { triggered: false, why: '没有这片险区' };
  const p = zoneEncounterChance(z.stars);
  if (!rng.chance(p)) {
    log('你踏入' + z.name + '的边缘——风是静的，但静得不太对。', 'nar', s);
    return { triggered: false, why: '' };
  }
  const mob = zoneMob(z.stars);
  log('「' + z.name + '」容不下活人——' + (WB.monsters[mob]?.name ?? '什么东西') + '从' + z.reason + '里扑了出来。', 'bad', s);
  sync();
  startCombat([mob]);
  return { triggered: true, why: z.reason };
}

/* ============================================================
   卡 S2 · 交通体系（世界书 §81 速度等级 / §83 城内交通 / §85 传送阵）
   数据在 routes.json 的 travelModes / portals / cityTransit（卡 T4 已建）。
   本段把「选哪种走法」真正接进可行性判定：传送阵有载员、禁传与费用三重门。
   ============================================================ */

export interface TravelMode { id: string; name: string; speed: number; perDay: number; note: string }
export interface PortalTier { id: string; name: string; km?: [number, number]; startup: number; perHead: number; note?: string }
interface TransportCfg {
  travelModes?: TravelMode[];
  cityTransit?: { carriage: number[]; portalPoint: number; mount: number; walk: number };
  portals?: { tiers: PortalTier[]; maxLoad: number; banRules: string[]; network: { continental: number; longRange: number; cityShort: number } };
}
const TRANS = raw as unknown as TransportCfg;

/** 六档交通方式（§81） */
export const travelModes = (): TravelMode[] => TRANS.travelModes ?? [];
/** 四类传送阵（§85） */
export const portalTiers = (): PortalTier[] => TRANS.portals?.tiers ?? [];
/** 城内交通价目（§83） */
export const cityTransit = () => TRANS.cityTransit;

/** 传送阵的载员上限与禁传清单（§85） */
export const portalLimits = () => ({
  maxLoad: TRANS.portals?.maxLoad ?? 100,
  banRules: TRANS.portals?.banRules ?? [],
  network: TRANS.portals?.network ?? { continental: 0, longRange: 0, cityShort: 0 },
});

/** 某类传送阵的单程总价（启动费 + 人头费；§85 是按「单人次费」记的） */
export function portalCost(tierId: string, heads = 1): number {
  const t = portalTiers().find((x) => x.id === tierId);
  if (!t) return 0;
  return t.startup + t.perHead * Math.max(1, heads);
}

/**
 * 禁传判定（§85）：禁魔物品、被诅咒物品、神器一律不许过阵。
 * 神器在本作里对应 tier ≥ 5 的装备（传说/神话/神器档），与 items 的品质阶梯一致。
 */
export function portalBannedItem(itemId: string): string | null {
  const it = WB.items[itemId] as unknown as { illegal?: boolean; tier?: number; quality?: string } | undefined;
  if (!it) return null;
  if ((it.tier ?? 0) >= 5) return '神器';
  if (it.illegal) return '被诅咒物品';
  const q = it.quality;
  if (q === '神器' || q === '神话') return '神器';
  return null;
}

/** 玩家身上是否有禁传物（返回第一件的名字与类别） */
export function portalCarryBan(s: WorldState = need()): { item: string; kind: string } | null {
  for (const slot of s.player.bag) {
    const kind = portalBannedItem(slot.id);
    if (kind) return { item: WB.items[slot.id]?.name ?? slot.id, kind };
  }
  for (const id of [s.player.equip.wpn, s.player.equip.arm]) {
    if (!id) continue;
    const kind = portalBannedItem(id);
    if (kind) return { item: WB.items[id]?.name ?? id, kind };
  }
  return null;
}

/**
 * 走传送阵（§85）：三重门依次判——载员、禁传、费用。
 * 与远行（depart）的区别：传送**不耗时**（即时），但仍扣钱、仍受禁传约束。
 * 不直接改位置：返回 ok 让调用方决定（保持与 canDepart 同一形状）。
 */
export function canTeleport(tierId: string, dest: string, s: WorldState = need(), heads = 1): { ok: boolean; reason?: string; cost?: number } {
  const t = portalTiers().find((x) => x.id === tierId);
  if (!t) return { ok: false, reason: '没有这一类传送阵' };
  if (heads > portalLimits().maxLoad) return { ok: false, reason: '载员超限（每阵至多 ' + portalLimits().maxLoad + ' 人）' };
  const ban = portalCarryBan(s);
  if (ban) return { ok: false, reason: '「' + ban.item + '」属' + ban.kind + '，传送阵不受——须先寄存或丢弃' };
  if (!WB.locations[dest]) return { ok: false, reason: '没有这个目的地' };
  const cost = portalCost(tierId, heads);
  if (s.player.gold < cost) return { ok: false, reason: '传送费不足（需 ' + formatMoney(cost) + '）' };
  return { ok: true, cost };
}

/** 城内交通（§83）：马车/轿子、传送点、骑乘服务三种可选，步行免费 */
export function cityTransitCost(kind: 'carriage' | 'portalPoint' | 'mount' | 'walk'): number {
  const c = cityTransit();
  if (!c) return 0;
  if (kind === 'carriage') return c.carriage[0];
  if (kind === 'portalPoint') return c.portalPoint;
  if (kind === 'mount') return c.mount;
  return c.walk;
}

/** 按方式估算行程天数（§81 速度等级的用处：同一条路，走法不同，天数不同） */
export function daysByMode(baseDays: number, modeId: string): number {
  const m = travelModes().find((x) => x.id === modeId);
  if (!m || m.speed <= 0) return baseDays; // 传送类：即时，由 portalCost 另行计费
  return Math.max(1, Math.round(baseDays / (m.speed / 5))); // 以「普通骑乘 5x」为基准折算
}
