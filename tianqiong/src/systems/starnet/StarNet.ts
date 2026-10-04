/* ============================================================
   星枢网（卡 C · §9–13）：意识投影入网、星市只进不出、星演场无伤比斗。
   经济闭环：寄售(物品→星币) / 星市(花星币) / 比斗(得星晶) / 兑换(星晶→星币)。
   铁律：入网禁入 / 出网禁 / 财物只进不出 判定全在此（core），不交给 AI；
   AI 仅负责入网/比斗的叙事文本（读 lore/stardeep + canon）。
   真身无损：网内比斗只动 net 战绩与出网禁，绝不改 hp/gold。
   ============================================================ */
import { WB } from '@/data/worldBook';
import { STARHUB, type StarTower } from '@/data/starhub';
import type { NetState, WorldState } from '@/types/world';
import { rng, toast, worldBus } from '@/events/EventBus';
import { makeEvent } from '@/events/EventSchema';
import { sceneTime } from '@/world/WorldClock';
import { startCombat } from '@/systems/combat/Combat';
import { check } from '@/dice/CheckResolver';
import { directorTick } from '@/events/EventProcessor';
import { gainExp, log } from '@/systems/character/Gains';
import { formatMoney } from '@/systems/economy/Money';
import { isOpen as abyssOpen, leakLevel as abyssLevel, leakName as abyssLevelName } from '@/systems/dungeon/Abyss';
import { trialMirror } from '@/systems/dungeon/Dungeon';
import { closeSheet, confirmSheet } from '@/systems/character/Sheet';
import { instName, instPrice, removeInstance } from '@/systems/inventory/Equip';
import { need, sync } from '@/world/WorldState';
import { mutate } from '@/world/WorldMutate';
import { advance, CHEN_PER_DAY } from '@/world/WorldClock';
import { addHistory } from '@/events/EventStore';

function ensureNet(s: WorldState): NetState {
  if (!s.net) s.net = { online: false, starcoin: 0, starcrystal: 0, consign: [], duels: { won: 0, lost: 0 } };
  return s.net;
}

/* ============================================================
   卡 C1 · 定神（世界书 §10）
   「入网者为意识投影（魂念），本体留守定神；网外有事，一唤即出。」
   —— 此前 net.online 只有星枢网内部在读，现实侧（旅行/战斗/任务/交易）零处消费它，
   于是"定神"只是文档里的一句话。现在：入网发 net_entered / 出网发 net_exited，
   现实动作的入口一律先过 onlineGate（ActionExecutor 现实动作共 10 处：go / gatherIntel /
   search / gather / exploreWild / exploreCave / restAt / drink / healSvc / steal）。

   关于 net_entered / net_exited：**当前没有生产侧订阅者**，它们是事件流的完整性补全
   （「入网」是世界事实，该有记录），而不是拦截机制的一部分。
   拦截走同步守卫是有意为之——动作入口要的是「当场放行或拒绝」，
   订阅式会引入「先放行再回滚」的无谓复杂度。
   将来若真有系统需要「被入网这件事通知」（委托延误、势力监控、魂念离体的警觉），订阅它即可。
   ============================================================ */

/** 本体是否处于「定神」（入网中）。缺省视为未入网，旧档可读。 */
export const isOnline = (s: WorldState = need()): boolean => !!s.net?.online;

/**
 * 现实动作的统一门禁。返回 null 表示放行，否则返回可读原因。
 * 刻意做成**纯函数判定**而不是订阅式拦截：
 *   动作入口是同步的一次性检查，订阅式会在"拒绝之后还要再回滚"上引入无谓复杂度；
 *   而 net_entered / net_exited 事件仍然照发，供将来需要"被入网这件事通知"的系统订阅。
 */
export function onlineGate(what: string, s: WorldState = need()): string | null {
  if (!isOnline(s)) return null;
  return '意识仍在网中——' + what + '须待出网（星枢 · 退出星网）。本体留守定神，一唤即出。';
}

/* ---------------- 卡 C1 · 星阶八档与星符三类（§11） ---------------- */

interface StarRankRow { tier: number; name: string; minRealLevel: number; note: string }
interface StarSealRow { id: string; name: string; grant: string; effect: string; limit: string | null }

export const starRanks = (): StarRankRow[] =>
  ((STARHUB as unknown as { starRanks?: StarRankRow[] }).starRanks ?? []).slice();
export const starSeals = (): StarSealRow[] =>
  ((STARHUB as unknown as { starSeals?: StarSealRow[] }).starSeals ?? []).slice();

/** 玩家的星阶：随现实境界逐档映射（§11）；境界不足时停在最低档 */
export function starRank(s: WorldState = need()): StarRankRow {
  const rows = starRanks();
  const lv = s.player.level;
  let cur = rows[0];
  for (const r of rows) if (lv >= r.minRealLevel) cur = r;
  return cur ?? { tier: 1, name: '信徒', minRealLevel: 1, note: '' };
}

/** 玩家持有的星符类型（缺省为连名——公会发放的常规符） */
export function starSeal(s: WorldState = need()): StarSealRow {
  const id = (s.player as { starSeal?: string }).starSeal ?? 'named';
  return starSeals().find((x) => x.id === id) ?? starSeals()[1] ?? { id: 'named', name: '连名星符', grant: '', effect: '', limit: null };
}

/** 鉴印之符（连名/古符）：唯此可「通行七塔」与入星殿（§11）。无名星符两头都不行 */
export const sealIsNamed = (s: WorldState = need()): boolean => !starSeal(s).limit;

/** 该星符能否进星殿（无名星符不可） */
export function sealAllowsCouncil(s: WorldState = need()): boolean {
  return sealIsNamed(s);
}

/* ============================================================
   卡 C2 · 七塔分置（世界书 §9「七塔架构」）
   一塔一城：一塔圣辉城（星市）/ 二塔翠风港（星海）/ 三塔金砂城（星塔）/
   四塔霜锚堡（星演场）/ 五塔血吼城（星斗台）/ 六塔深井城（星渊）/ 七塔天穹之城（星殿）。
   分置在游戏里的意思是：**你栖在哪座塔，就只够得着那座塔的东西**——
   此前七塔的 loc 全写在同一个广场上，等于把七座塔叠成一座。
   唯一的例外来自 §11：连名星符「通行七塔」，无名星符只在本塔有效。
   ============================================================ */

/* 塔的地理归属（哪座塔在哪、你够不够得着）在 Towers.ts——独立成文件是为了避免
   StarNet ↔ dungeon/Abyss 成环（网内门禁要问魔气分级，现实侧门禁要问塔在不在附近）。
   本文件只负责**网内那一层**：星符授权、塔的开放状态。 */
import { netTower, towerHere, towerLocalGate, towerOf } from '@/systems/starnet/Towers';
export { netTower, towerHere, towerLocalGate, towerOf };

/**
 * 塔层面是否拦下这个功能（**不含**"未入网"那一层，那层由 gateOnline 管）。
 * 返回 null 放行，否则返回可读原因。
 */
export function towerBlocks(func: StarTower['func'], s: WorldState = need()): string | null {
  const tower = STARHUB.towers.find((t) => t.func === func);
  if (!tower) return null;
  /* 星渊的门不由 status 说了算——它归 H2 的魔气渗入分级管（Abyss.isOpen） */
  if (func === 'abyss') {
    if (!abyssOpen(s)) return '封印之下的低语隐约可闻……但星渊之门尚未开启。';
  } else if (tower.status !== 'open') {
    return tower.name + '尚未开启。';
  }
  if (func === 'council' && !sealAllowsCouncil(s)) return '无名星符入不了星殿——星殿只认鉴印连名之符（§11）。';
  /* §11：连名星符「通行七塔」——这一句就是全部豁免 */
  if (sealIsNamed(s)) return null;
  if (netTower(s)?.id === tower.id) return null;
  return '无名星符只在本塔有效——' + tower.name + '在' + (tower.city ?? '') + '。';
}

/** towerBlocks 的 toast 版（入口用它，判定本体仍在 towerBlocks） */
function gateTower(func: StarTower['func'], s: WorldState): boolean {
  const why = towerBlocks(func, s);
  if (why) {
    toast(why, 'bad');
    return false;
  }
  return true;
}

/** 七塔面板视图（MapPanel / 测试共用；纯数据，无副作用） */
export interface TowerView {
  id: string;
  name: string;
  func: StarTower['func'];
  city: string;
  continent: string;
  /** 塔本身已开放（星渊另看魔气分级） */
  open: boolean;
  /** 你此刻就栖身于此塔 */
  here: boolean;
  /** 当前星符与位置下，这座塔的功能用不用得上 */
  usable: boolean;
  /** 不可用的原因（usable 时为 null） */
  why: string | null;
}

/**
 * 七塔分置面板（SysPanel 入口）：一张表看清七塔在哪、此刻够不够得着。
 * 这是 towerView 的生产消费者——面板与执行共用同一份判定，不会出现"面板说能、点了说不能"。
 */
export function towerPanel() {
  const s = need();
  const rows = towerView(s);
  const here = netTower(s);
  const list = rows
    .map(
      (r) =>
        (r.usable ? '◦ ' : '× ') +
        r.name +
        '·' +
        r.city +
        (r.here ? '　<b>你在此</b>' : '') +
        (r.usable ? '' : '——' + (r.why ?? '')),
    )
    .join('<br>');
  confirmSheet(
    '星枢七塔 · 一塔一城',
    '塔的功能各归其城：要登星塔就去金砂城、要比斗就去霜锚堡、要进星殿就上天穹之城。' +
      '星枢之间只传心念、不传实物（§10），唯「连名星符」可通行七塔（§11）。<br>你此刻栖于「' +
      (here?.name ?? '—') +
      '」（' +
      (here?.city ?? '') +
      '），持' +
      starSeal(s).name +
      '。<br><br>' +
      list,
    [{ l: isOnline(s) ? '（返回）' : '入网（意识投影）', a: isOnline(s) ? 'sn_back' : 'sn_enter' }],
  );
}

export function towerView(s: WorldState = need()): TowerView[] {
  const here = netTower(s);
  return STARHUB.towers.map((t) => {
    const open = t.func === 'abyss' ? abyssOpen(s) : t.status === 'open';
    const why = towerBlocks(t.func, s);
    return {
      id: t.id,
      name: t.name,
      func: t.func,
      city: t.city ?? '',
      continent: t.continent ?? '',
      open,
      here: here?.id === t.id,
      usable: isOnline(s) && open && !why,
      why: isOnline(s) ? why : '尚未入网',
    };
  });
}

/** 打开星枢入口（复用 ConfirmSheet，零新增 React 组件）。 */
export function openNet() {
  const s = need();
  const net = ensureNet(s);
  const st = '星币 ' + net.starcoin + '　·　星晶 ' + net.starcrystal + '　·　寄售 ' + net.consign.reduce((a, x) => a + x.qty, 0) + ' 件　·　比斗 ' + net.duels.won + '胜' + net.duels.lost + '负';
  if (net.online) {
    const ins = net.insights || { mood: 0, sessions: 0 };
    /* 卡 C2：够不着的塔就标出来并写明它在哪座城——否则玩家会以为点了没反应。
       判定走 towerBlocks，与真执行时的门禁同一处，不存在"菜单说能、执行说不能"。 */
    const item = (label: string, func: StarTower['func'], a: string): { l: string; a: string; dg?: boolean } => {
      const why = towerBlocks(func, s);
      if (!why) return { l: label, a };
      const city = STARHUB.towers.find((t) => t.func === func)?.city ?? '';
      return { l: label + '（须在' + city + '）', a, dg: true };
    };
    const inMenu: { l: string; a: string; dg?: boolean }[] = [
      item('星市 · 寄售（选一件，折星币）', 'market', 'sn_consign'),
      item('星市 · 花 50 星币买入见闻', 'market', 'sn_buy'),
      item('星晶兑换 · 1 星晶 → ' + STARHUB.rates.crystalToCoin + ' 星币', 'market', 'sn_exchange'),
      item('星演场 · 无伤比斗', 'duel', 'sn_duel'),
      item('星海 · 意境参悟（心境 ' + ins.mood + '）', 'insight', 'sn_insight'),
      item('星塔 · 登塔试炼（最佳 ' + (net.trialBest || 0) + ' 层）', 'trial', 'sn_trial'),
      item('星斗台 · 公开竞技（注彩）', 'arena', 'sn_arena'),
      item('星殿 · 议事传讯', 'council', 'sn_council'),
      abyssOpen(s)
        ? { l: '星渊 · 降临（魔气：' + abyssLevelName(abyssLevel(s)) + '）', a: 'sn_abyss', dg: true }
        : { l: '星渊（封印之下，隐有低语……）', a: 'sn_abyss_locked', dg: true },
      { l: '把星币换成现实铜币（网规不许）', a: 'sn_cashout', dg: true },
      { l: '退出星网', a: 'sn_exit' },
    ];
    const hereT = netTower(s);
    confirmSheet(
      '星枢 · 网内',
      '你以意识投影栖身星网，本体留守「定神」。此处财与名只进不出。<br>' +
        st +
        '<br>投影栖于「' +
        (hereT?.name ?? '星枢一塔') +
        '」（' +
        (hereT?.city ?? '') +
        '）　·　' +
        starSeal(s).name +
        '：' +
        starSeal(s).effect,
      inMenu,
    );
  } else {
    const hereT = netTower(s);
    const rows = STARHUB.towers
      .filter((t) => t.status === 'open')
      .map((t) => t.name + '·' + (t.city ?? ''))
      .join('、');
    confirmSheet(
      '星枢 · 未入网',
      '入网者比斗无伤、交易无欺、传讯无界。随身星符墨入符心即可入网。<br>' +
        st +
        '<br><br>七塔分置：' +
        rows +
        '<br>你此刻在' +
        (hereT?.city ?? '无塔可依之地') +
        '，墨入符心即栖「' +
        (hereT?.name ?? '星枢一塔') +
        '」——塔的功能各归其城。',
      [
        { l: '入网（意识投影）', a: 'sn_enter' },
        { l: '算了', a: 'close' },
      ],
    );
  }
}

/** 入网：禁入判定（通缉过高 / 魔气沾身 / 出网禁期）全部引擎裁决。 */
export function enterNet(): boolean {
  const s = need();
  const net = ensureNet(s);
  const r = STARHUB.net_rules;
  if (net.online) return true;
  if (net.exitLockUntil && s.t < net.exitLockUntil) {
    toast('魂念未复，尚在出网禁期（还需约 ' + Math.ceil((net.exitLockUntil - s.t) / CHEN_PER_DAY) + ' 日）', 'bad');
    return false;
  }
  if (s.player.wanted >= r.banWantedMin) {
    toast('通缉缠身者禁入星网——你的通缉等级过高。', 'bad');
    return false;
  }
  const banned = r.banFlags.find((f) => s.player.flags[f]);
  if (banned) {
    toast('你身上沾有「' + banned + '」，星枢拒你入网。', 'bad');
    return false;
  }
  net.online = true;
  /* 卡 L1：记下入网时刻——§10「网中历时不耗寿」，出网时把这段净时长从年龄里扣掉 */
  net.onlineSince = s.t;
  /* 卡 C1：入网是**世界事实**——发出去，让需要知道的系统自己订阅 */
  worldBus.emit(
    makeEvent({ type: 'net_entered', day: sceneTime(s).day, tick: s.t, actor: 'player', location: s.player.loc, level: 1 }),
  );
  const t = netTower(s);
  log('墨入符心，意识投影离体——你已入星枢之网，本体在' + (t?.city ?? '') + '·' + (t?.name ?? '星枢塔') + '定神。', 'ai');
  addHistory('入星枢之网', '比斗无伤、交易无欺', 1);
  closeSheet();
  sync();
  return true;
}

export function exitNet() {
  const s = need();
  const net = ensureNet(s);
  /* 卡 L1：网中历时不耗寿（§10）——把这段时长记进 netAgedTicks，
     年龄换算时会扣掉它。魂念离体的那些年，不算在这个人的岁数里。 */
  const since = net.onlineSince ?? s.t;
  mutate.playerNetAged(s.t - since);
  net.onlineSince = undefined;
  net.online = false;
  worldBus.emit(
    makeEvent({ type: 'net_exited', day: sceneTime(s).day, tick: s.t, actor: 'player', location: s.player.loc, level: 1 }),
  );
  log('你收念出网，一唤即回。网中经历唯余记忆与见闻。', 'ai');
  closeSheet();
  sync();
}

/** 只进不出：任何把星币/星晶/网中宝物兑换回现实的操作一律拒绝。 */
export function cashOut(): false {
  const s = need();
  const net = ensureNet(s);
  /* 卡 N1：网内依旧不许变现（§10 管的就是这一层），但不再说「永远不行」——
     地上每个大陆各有一家星枢兑换所，那里才是这笔钱的出口。给去处，不给死路。 */
  toast('网内不可兑现（§10）——出网之后，去大陆枢纽的星枢兑换所换。你现有星币 ' + net.starcoin + '。', 'bad');
  return false;
}

/**
 * 寄售：物品离开行囊、不可带回现实，按市价折入星币（收入源）。
 * uid 给出时按**实例**精确取件，并按实例价（品质档 / 词缀）折算——实例槽 qty 恒为 1，
 * 若仍按 id 取第一件，等于把整件实例删掉却只折基础价，混装时还会卖掉玩家没点的那一件（审查 §寄售）。
 * 计价与移除都复用 inventory/Equip 的原语（与 Shop.sell 的 uid 分支同口径）。
 */
export function consign(itemId: string, uid?: string): boolean {
  const s = need();
  const net = ensureNet(s);
  if (!net.online) {
    toast('须先入网才能寄售。', 'bad');
    return false;
  }
  if (!gateTower('market', s)) return false;
  const def = WB.items[itemId];
  const inst = uid ? s.player.bag.find((x) => x.uid === uid && x.id === itemId) : null;
  const i = inst ?? s.player.bag.find((x) => x.id === itemId && !x.uid);
  if (uid && !inst) {
    toast('行囊里没有这件东西了。', 'bad');
    return false;
  }
  if (!i || i.qty <= 0 || !def) {
    toast('行囊里没有可寄售的「' + (def?.name || itemId) + '」。', 'bad');
    return false;
  }
  const coin = Math.max(1, Math.floor((inst ? instPrice(inst, s) : def.price) / STARHUB.rates.consignPerCopper));
  if (inst?.uid) removeInstance(inst.uid, s);
  else {
    i.qty -= 1;
    if (i.qty <= 0) s.player.bag.splice(s.player.bag.indexOf(i), 1);
  }
  const slot = net.consign.find((x) => x.id === itemId);
  if (slot) slot.qty += 1;
  else net.consign.push({ id: itemId, qty: 1 });
  net.starcoin += coin;
  const label = inst ? instName(inst) : def.name + '（约 ' + formatMoney(def.price) + '）';
  log('你把「' + label + '」挂上星市，即时售出，入账 ' + coin + ' 星币——它已无法带回现实。', 'gain');
  sync();
  return true;
}

/** 寄售选择器：列出可行囊物品逐件选，避免强取首件。 */
export function consignMenu() {
  const s = need();
  const net = ensureNet(s);
  if (!net.online) {
    toast('须先入网。', 'bad');
    return;
  }
  if (!gateTower('market', s)) return;
  const items = s.player.bag.filter((x) => WB.items[x.id] && WB.items[x.id].price > 0);
  if (!items.length) {
    toast('行囊里没有可寄售之物。', 'bad');
    openNet();
    return;
  }
  const btns: { l: string; a: string; id?: string; uid?: string }[] = items.slice(0, 8).map((x) => {
    const def = WB.items[x.id];
    const worth = x.uid ? instPrice(x, s) : def.price;
    const coin = Math.max(1, Math.floor(worth / STARHUB.rates.consignPerCopper));
    /* 实例必须带上 uid：选择器要能区分「哪一件」，不能由 core 替玩家挑第一件 */
    return { l: (x.uid ? instName(x) : def.name) + ' ×' + x.qty + ' → ' + coin + ' 星币', a: 'sn_consign_item', id: x.id, uid: x.uid };
  });
  btns.push({ l: '（返回星枢）', a: 'sn_back' });
  confirmSheet('星市 · 寄售（只进不出）', '选一件挂上寄售单——它将离开现实，换回星币。', btns);
}

/** 星市买入：只耗星币，绝不触碰现实铜币。 */
export function marketBuy(): boolean {
  const s = need();
  const net = ensureNet(s);
  const cost = 50;
  if (!net.online) {
    toast('须先入网。', 'bad');
    return false;
  }
  if (!gateTower('market', s)) return false;
  if (net.starcoin < cost) {
    toast('星币不足（需 ' + cost + '，你 ' + net.starcoin + '）。星币只能靠网内挣得，不可从现实换入。', 'bad');
    return false;
  }
  net.starcoin -= cost;
  log('你以 50 星币买入一条跨大陆见闻。现实的钱袋分文未动。', 'gain');
  sync();
  return true;
}

/** 星晶 → 星币（§11：星晶可兑星币，仍不可出网）——给星晶一个消耗出口。 */
export function exchangeCrystal(): boolean {
  const s = need();
  const net = ensureNet(s);
  if (!net.online) {
    toast('须先入网。', 'bad');
    return false;
  }
  if (!gateTower('market', s)) return false;
  if (net.starcrystal < 1) {
    toast('你还没有星晶。星演场比斗获胜可得。', 'bad');
    return false;
  }
  net.starcrystal -= 1;
  net.starcoin += STARHUB.rates.crystalToCoin;
  log('你熔了 1 枚星晶，化入 ' + STARHUB.rates.crystalToCoin + ' 星币——仍在网中，出不得。', 'gain');
  sync();
  return true;
}

/** 星演场无伤比斗：进入全屏战斗演出（vs 星演幻影），终局由 combat 还原真身、只落 net 战绩/出网禁。 */
export function duel() {
  if (!gateOnline('duel')) return;
  advance(STARHUB.duel.costTicks); // 网中历时耗神思（软限，抑制无限刷）
  startCombat(['phantom'], { net: true });
}

/* ============================================================
   卡 H1 · 七塔完全体（§32–35）：星海参悟 / 星塔试炼 / 星斗台竞技 / 星殿议事
   网内铁律同卡 C：一切只动 net 域（星币/星晶/战绩/心境），真身无损；
   判定全走 check/d20（core），AI 只在叙事层。
   ============================================================ */

/**
 * 网内入口的统一门禁：先判入网，再判塔（卡 C2 七塔分置）。
 * func 可省——省则只判入网（与旧行为逐字一致）。
 */
function gateOnline(func?: StarTower['func']): boolean {
  const s = need();
  if (!ensureNet(s).online) {
    toast('须先入网（星符墨入符心）。', 'bad');
    return false;
  }
  if (!func) return true;
  const why = towerBlocks(func, s);
  if (why) {
    toast(why, 'bad');
    return false;
  }
  return true;
}

/* ---------------- 星海 · 意境参悟（star2）---------------- */
export function insight(): void {
  if (!gateOnline('insight')) return;
  const s = need();
  const net = ensureNet(s);
  const cfg = STARHUB.insight;
  net.insights = net.insights || { mood: 0, sessions: 0 };
  advance(cfg.costTicks); // 参悟按现实时辰计（§10 防无尽修行）
  if (rng.chance(cfg.nightmareChance)) {
    net.insights.mood = Math.max(0, net.insights.mood - 10);
    log('星海深处翻起黑色的潮——心魔之考。你从意境中仓皇退出，心境反而沉了几分。', 'bad');
  } else {
    net.insights.mood += rng.R(5, 10) + s.player.level;
    log('你沉入星海。万千流转的意境擦过意识边缘，心境如水面渐平、渐深。', 'ai');
  }
  if (net.insights.mood >= cfg.breakthroughAt) {
    net.insights.mood = 40; // 破境后心境回落（防无限累积）
    net.insights.sessions++;
    gainExp(cfg.breakthroughExp);
    log('心境圆满，破境！星海的光落在意识的湖面上——你对自身的理解更进一层。', 'gain');
    addHistory('星海破境', '心境圆满·经验大进', 3);
  }
  sync();
}

/** 星海菜单（sn_insight 路由） */
export function insightMenu(): void {
  if (!gateOnline('insight')) return;
  const net = ensureNet(need());
  const ins = net.insights || { mood: 0, sessions: 0 };
  confirmSheet(
    '星枢二塔 · 星海',
    '意境参悟·心魔之考。每次参悟耗 ' + STARHUB.insight.costTicks + ' 刻（现实时辰），心境累积至 ' + STARHUB.insight.breakthroughAt + ' 可破境得大经验。<br>当前心境 ' + ins.mood + ' · 历次破境 ' + ins.sessions + ' 次。',
    [
      { l: '沉入星海（参悟）', a: 'sn_insight' },
      { l: '（返回星枢）', a: 'sn_back' },
    ],
  );
}

/* ---------------- 星塔 · 登塔试炼（star3）---------------- */
export function trialMenu(): void {
  if (!gateOnline('trial')) return;
  const net = ensureNet(need());
  const best = net.trialBest || 0;
  const next = Math.min(STARHUB.trial.maxFloor, best + 1);
  confirmSheet(
    '星枢三塔 · 星塔',
    '登塔试炼 1–' + STARHUB.trial.maxFloor + ' 层，镜像地下城 100 层与古代英灵——网中无伤，败者神思昏沉而已。<br>下一层镜像：' +
      trialMirror(next).themeName + '·' + trialMirror(next).floorName + '（DC ' + trialMirror(next).dc + '）<br>当前最佳：第 ' + best + ' 层。每 ' + STARHUB.trial.starcrystalEvery + ' 层得 1 星晶。',
    [
      { l: '挑战第 ' + next + ' 层', a: 'sn_trial_go' },
      { l: '（返回星枢）', a: 'sn_back' },
    ],
  );
}

/** 逐层挑战：DC 随层数递增；层数属性轮换（力量/敏捷/智力）；第 maxFloor 层为顶点试炼。 */
export function trialClimb(): void {
  if (!gateOnline('trial')) return;
  const s = need();
  const net = ensureNet(s);
  const cfg = STARHUB.trial;
  const floor = Math.min(cfg.maxFloor, (net.trialBest || 0) + 1);
  /* F-09：首通语义——floor 高于历史最佳才算新层，重复挑战塔顶不再产星晶/星币 */
  const firstClear = floor > (net.trialBest || 0);
  const stats = ['力量', '敏捷', '智力'] as const;
  const stat = stats[(floor - 1) % 3];
  /* 卡 H4：试炼镜像地下城层数据——层名 / 主题 / 难度全部取自 dungeon.json；
     网内无伤铁律不变：只动 net 域，真身 hp/mp/gold 分毫不动。 */
  const mir = trialMirror(floor);
  const dc = mir.dc;
  check('星塔试炼·第 ' + floor + ' 层 · ' + mir.floorName, stat, dc, (r) => {
    if (r.ok) {
      net.trialBest = Math.max(net.trialBest || 0, floor);
      /* F-09：成功路径同样耗刻——原实现零时间成本，塔顶可无限刷晶换星币 */
      advance(cfg.climbTicks);
      if (!firstClear) {
        log('你又走了一遍第 ' + floor + ' 层的镜像。古代英灵不发一言——重复的攀登不再有落赠。', 'sys');
      } else if (floor % cfg.starcrystalEvery === 0) {
        net.starcrystal += 1;
        log('第 ' + floor + ' 层的古代英灵向你颔首消散——落下一枚星晶。', 'gain');
      } else {
        net.starcoin += 3;
        log('第 ' + floor + ' 层（镜像：' + mir.themeName + '·' + mir.floorName + '）的幻影壁垒碎裂，塔内响起悠远钟声（+3 星币）。', 'gain');
      }
      if (firstClear && floor >= cfg.maxFloor) {
        net.starcrystal += 5;
        mutate.playerFlag('star_trial_100');
        log('第一百层！塔顶之外是星海本身。你以意识之躯立于万网之巅——5 星晶与「登顶者」之名归于你。', 'gain');
        addHistory('星塔登顶', '试炼一百层·镜像完美通关', 5);
      }
    } else {
      advance(cfg.fallTicks);
      log('第 ' + floor + ' 层的守关幻影将你的投影击散重组。神思昏沉了半日——但塔还立着，你还接着爬。', 'bad');
    }
    sync();
  });
}

/* ---------------- 星斗台 · 公开竞技（star5）---------------- */
export function arenaMenu(): void {
  if (!gateOnline('arena')) return;
  const net = ensureNet(need());
  confirmSheet(
    '星枢五塔 · 星斗台',
    '公开竞技·众生观战。注彩下场，胜者得双彩（净赚一倍），败者失注——输赢皆在网内。<br>当前胜场 ' + (net.arenaWins || 0) + '。',
    [
      ...STARHUB.arena.stakes.map((st) => ({ l: '注 ' + st + ' 星币下场', a: 'sn_arena_bet', id: String(st) })),
      { l: '（返回星枢）', a: 'sn_back' },
    ],
  );
}

/** 注彩竞技：注额越大 DC 越高（dcPerStake×档位）。 */
export function arenaBet(stake: number): void {
  if (!gateOnline('arena')) return;
  const s = need();
  const net = ensureNet(s);
  if (!STARHUB.arena.stakes.includes(stake)) return;
  if (net.starcoin < stake) {
    toast('星币不足（需 ' + stake + '，你 ' + net.starcoin + '）。', 'bad');
    return;
  }
  const tier = STARHUB.arena.stakes.indexOf(stake);
  const dc = STARHUB.arena.baseDc + STARHUB.arena.dcPerStake * tier;
  /* 下注即暂扣本金（审查 §注彩）：检定演出要 1450ms 后才回调，把扣钱留在回调里，
     等待期内点「买见闻」「发布星谕」就能把余额打成负数——玩家资源原语都夹 ≥0，
     而星币没有原语。结算只做「已扣本金之上」的加减，余额因此恒非负；
     输赢的净效果与迁移前一致（输 -stake，赢 +stake）。 */
  net.starcoin -= stake;
  check('星斗台 · 注 ' + stake + ' 星币', '敏捷', dc, (r) => {
    if (r.ok) {
      net.starcoin += stake * 2; // 赢家拿走双彩：本金 + 彩金
      net.arenaWins = (net.arenaWins || 0) + 1;
      log('众目睽睽之下，你的投影技惊四座——彩声如潮，入账 ' + stake + ' 星币。', 'gain');
    } else {
      log('对手一记干净的反手把你打下台。彩金尽失——星斗台只认胜负。', 'bad');
    }
    sync();
  });
}

/* ---------------- 星殿 · 议事传讯（star7）---------------- */
export function councilMenu(): void {
  if (!gateOnline('council')) return;
  const net = ensureNet(need());
  const fav = net.councilFavor || {};
  const favStr = Object.keys(WB.factions)
    .map((f) => (WB.factions[f as keyof typeof WB.factions] || f) + ' ' + (fav[f] || 0))
    .join('　');
  confirmSheet(
    '星枢七塔 · 星殿',
    '议事传讯·发布星谕。调停积攒各势力观感；星谕可借星网一念千里、广播全大陆。<br>观感：' + favStr,
    [
      { l: '议事调停（' + STARHUB.council.talkTicks + ' 刻）', a: 'sn_council_talk' },
      { l: '发布星谕（' + STARHUB.council.decreeCost + ' 星币）', a: 'sn_decree' },
      { l: '（返回星枢）', a: 'sn_back' },
    ],
  );
}

/** 议事调停：耗网内历时，随机势力观感 +1..3、声望 +1。 */
export function councilTalk(): void {
  if (!gateOnline('council')) return;
  const s = need();
  const net = ensureNet(s);
  net.councilFavor = net.councilFavor || {};
  advance(STARHUB.council.talkTicks);
  const fs = Object.keys(WB.factions);
  const f = rng.pick(fs);
  const dv = rng.R(1, 3);
  net.councilFavor[f] = (net.councilFavor[f] || 0) + dv;
  mutate.rep(f, 1);
  log('你在星殿的圆桌旁调停了' + (WB.factions[f as keyof typeof WB.factions] || f) + '的一场争端——各方记下了你的名字（观感 +' + dv + '）。', 'ai');
  sync();
}

/** 发布星谕：花星币借星网广播全大陆（走 D4 事件引擎，因果入历史）。 */
export function councilDecree(): void {
  if (!gateOnline('council')) return;
  const s = need();
  const net = ensureNet(s);
  const cost = STARHUB.council.decreeCost;
  if (net.starcoin < cost) {
    toast('星币不足（需 ' + cost + '，你 ' + net.starcoin + '）。', 'bad');
    return;
  }
  net.starcoin -= cost;
  mutate.playerFlag('star_decree');
  directorTick(); // 触发 star_decree 事件（events.json 数据驱动）
  log('你借星殿之权发布星谕——一念之间，七个字浮现在每座星环法阵上空：「广而告之，皆知此人。」', 'ai');
  addHistory('发布星谕', '借星网广播全大陆', 2);
  sync();
}

/** 星渊入口（卡 H2 交接位）：leak≥1 时由 abyss 模块接管；此前一律拒绝。 */
export function abyssLocked(): void {
  toast(towerBlocks('abyss') ?? '封印之下的低语隐约可闻……但星渊之门尚未开启。', 'bad');
}
