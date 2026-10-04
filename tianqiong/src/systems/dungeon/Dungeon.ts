/* ============================================================
   卡 H4 · 地下城 100 层爬层（《项目方案》§26 / §45 分层 / §46 魔物来源 / §62 冒险经济）
   - 五主题分层：浅 1–20 / 中 21–50 / 深 51–80 / 最深 81–99 / 深渊 100（魔界裂隙）
   - 层数据全在 data/world/dungeon.json（data 零逻辑）；本模块只放判定与后果
   - 入口分档：cave→1 层 / cave2→21 层 / cave3→51 层 / star6→81 层（需 flag.leak_3）
     入口解锁 = 历史抵达 best >= unlockFloor-1（渐进开放，不硬编码）
   - 遭遇：魔物（走 combat）/ 陷阱（走 check，最多打到 1 血，不致死）/ 拾获（走 D6 物价档）/
     熟人（走 D1 schedule 之外的偶遇 + D2 好感）/ 空层（seed 兜底）
   - 深渊层（100）首次抵达置 flag → D4 directorTick 级联 H2 星渊链
   - 每日 tick（time.newDay 挂）：深层魔气侵蚀扣血
   铁律：后果全在 core；AI 只拿 loreRef(s45/s46/s62/s13) canon 润色，不创设定。
   ============================================================ */
import { DUNGEON as D, MAX_FLOOR as DUNGEON_DEPTH } from '@/data/dungeon';
import type { DungeonBoss, DungeonFloor, DungeonTheme, DungeonTrap, DungeonEntry } from '@/data/dungeon';
import { WB } from '@/data/worldBook';
import type { DungeonState, StatName, WorldState } from '@/types/world';
import type { DungeonView } from '@/types/uispec';
import { rng, toast } from '@/events/EventBus';
import { check } from '@/dice/CheckResolver';
import { startCombat } from '@/systems/combat/Combat';
import { maxHp } from '@/systems/character/Derived';
import { directorTick } from '@/events/EventProcessor';
import { addItem, gainExp, gainGold, log } from '@/systems/character/Gains';
import { tomeWeight } from '@/systems/codex/Codex';
import { formatMoney } from '@/systems/economy/Money';
import { addMem, adjAtt } from '@/systems/npc/Npcs';
/* 卡 G2：六维命名接进真实场景（§106 地点 / §107 组织 / §114 装备 / §115 魔物 / §116 层数 / §117 技艺） */
import { generateFloor, generateMonster, generateOrg, generatePlace, generateSkillOrRelic } from '@/systems/naming/Naming';
import { confirmSheet } from '@/systems/character/Sheet';
import { core, need, sync } from '@/world/WorldState';
import { mutate } from '@/world/WorldMutate';
import { advance } from '@/world/WorldClock';
import { addHistory } from '@/events/EventStore';

/** 层数上限（100）：本模块对外唯一常量出口，避开循环导入下的 live-binding 取值问题 */
export const MAX_FLOOR = DUNGEON_DEPTH;

/* ---------------- 数据取用（纯读，无副作用） ---------------- */

const clampFloor = (f: number) => Math.min(MAX_FLOOR, Math.max(1, Math.trunc(f) || 1));
/** 第 f 层楼层数据（越界夹取，永不返回 undefined） */
export const floorOf = (f: number): DungeonFloor => D.floors[clampFloor(f) - 1];
/** 第 f 层所属主题 */
export const themeOf = (f: number): DungeonTheme => D.themes[floorOf(f).theme] ?? D.themes.shallow;
export const trapOf = (id: string): DungeonTrap | undefined => D.traps.find((t) => t.id === id);

/* ---------------- 卡 N1 · 探索工具（持有即生效，不消耗、不进战斗） ---------------- */

/**
 * 行囊里的应对标签集。
 *
 * 为什么是 Set 而不是计数：工具的价值是「这类麻烦我早一步看得见」，
 * 带三盏灯不该比带一盏灯更亮。标签的对应关系在陷阱侧（DungeonTrap.tags），
 * 道具只声明自己是什么工具，不必知道这世界有几种陷阱。
 */
export function toolTags(s: WorldState = need()): Set<string> {
  const out = new Set<string>();
  for (const slot of s.player.bag) {
    const tags = WB.items[slot.id]?.utility;
    if (tags) for (const t of tags) out.add(t);
  }
  return out;
}

/** 每个命中标签的 DC 减免；上限两道工具——堆成一排不该等于一把万能钥匙 */
export const TRAP_DC_PER_TAG = 2;
export const TRAP_DC_CUT_MAX = 4;

/** 这道陷阱当前吃到的 DC 减免（0 = 身上没有用得上的工具） */
export function trapDcCut(t: DungeonTrap, s: WorldState = need()): number {
  const have = toolTags(s);
  let n = 0;
  for (const tag of t.tags ?? []) if (have.has(tag)) n++;
  return Math.min(TRAP_DC_CUT_MAX, n * TRAP_DC_PER_TAG);
}

/** 护符与暖具把深层魔气挡在外面（有其一即可）——侵蚀伤害减半的判定 */
export const corruptionShield = (s: WorldState = need()): boolean => {
  const tags = toolTags(s);
  return tags.has('ward') || tags.has('warm');
};
export const entryAt = (loc: string): DungeonEntry | undefined => D.entries.find((e) => e.locId === loc);
/** 第 f 层的掉落池（走 D6 economy 定价展示） */
export const lootOf = (f: number): string[] => floorOf(f).loot.slice();
/** 全部入口（MapPanel / 场景坞 用） */
export const allEntries = (): DungeonEntry[] => D.entries.slice();
/* 卡 C2：入口不再有「虚拟地点」这一档——星渊之门落到深井城（星枢六塔）之后，
  四个入口全部是 geo 里的真实地点，判定统一为「人在原地」。 */

/* ---------------- 状态 ---------------- */

export function ensureDungeon(s: WorldState): DungeonState {
  if (!s.dungeon) s.dungeon = { floor: 0, best: 0, inRun: false };
  const d = s.dungeon;
  if (!d.cleared) d.cleared = [];
  if (d.escapes === undefined) d.escapes = 0;
  return d;
}

/**
 * 运行态自愈：玩家若已离开入口地点（阵亡被抬回神殿 / 自行走开），本次爬层视为中断。
 * 这样即便不侵入 combat.defeat，也不会留下“人在神殿却还在层中”的脏状态。
 */
function syncRun(s: WorldState): DungeonState {
  const d = ensureDungeon(s);
  if (!d.inRun) return d;
  /* 卡 C2：入口一律是真实地点，人离开就视为中断（阵亡被抬走 / 自行走开）。 */
  if (!d.entry || s.player.loc !== d.entry) {
    d.inRun = false;
    d.floor = 0;
  }
  return d;
}

/** 是否正在层中（自愈后） */
export const inDungeon = (s: WorldState = need()): boolean => syncRun(s).inRun;

/** 入口解锁判定：require 先行（flag），再按历史深度渐进开放 */
export function entryUnlocked(e: DungeonEntry, s: WorldState = need()): boolean {
  if (e.require && e.require.startsWith('flag.') && !s.player.flags[e.require.slice(5)]) return false;
  return ensureDungeon(s).best >= Math.max(0, e.unlockFloor - 1);
}

/** 入口未解锁原因（已解锁返回空串，供 UI 提示） */
export function entryLockReason(e: DungeonEntry, s: WorldState = need()): string {
  if (e.require && e.require.startsWith('flag.') && !s.player.flags[e.require.slice(5)]) return '星渊未开——那条路还封着。';
  const needFloor = Math.max(0, e.unlockFloor - 1);
  if (ensureDungeon(s).best < needFloor) return '你尚未抵达第 ' + needFloor + ' 层。';
  return '';
}

/* ---------------- 爬层 ---------------- */

/** 下潜：从当前所在地点的入口进入地下城（无入口 / 未解锁 / 战斗中一律拒绝） */
export function enterDungeon(loc?: string): boolean {
  const s = need();
  if (core.CB) {
    toast('战斗中无法下潜——先了结眼前这一场。', 'bad');
    return false;
  }
  const d = syncRun(s);
  if (d.inRun) {
    dungeonMenu();
    return true;
  }
  const at = loc || s.player.loc;
  /* 卡 C2：入口全是真实地点，"指定一个入口"不等于"人就在那儿"。
     没有这道守卫，UI 只要传个 id 就能隔着七大陆钻进星渊（旧虚拟入口时代留下的口子）。 */
  if (at !== s.player.loc) {
    toast('你并不在' + (WB.locations[at]?.name ?? '那个入口') + '——地下城的门开在地上，不是开在菜单里。', 'bad');
    return false;
  }
  const e = entryAt(at);
  if (!e) {
    toast('此处没有通往地下城的入口。', 'bad');
    return false;
  }
  const why = entryLockReason(e, s);
  if (why) {
    toast(why, 'bad');
    return false;
  }
  d.inRun = true;
  d.entry = at;
  d.floor = e.startFloor - 1;
  if (e.startFloor - 1 > d.best) d.best = e.startFloor - 1;
  advance(1);
  log('你顺着' + e.name + '的裂隙向下攀行。空气一层层变冷，光在你的背后消失了。', 'nar');
  if (e.startFloor > 1) log('你从第 ' + e.startFloor + ' 层切入——上方的通道已经记在层志里了。', 'sys');
  addHistory('下潜地下城', '自' + e.name + '入层（起始第 ' + e.startFloor + ' 层）', 1);
  sync();
  dungeonMenu();
  return true;
}

/** 继续下潜一层：推进 → 遭遇判定 → 后果落地 */
export function nextFloor(): void {
  const s = need();
  if (core.CB) return;
  const d = syncRun(s);
  if (!d.inRun) {
    toast('你并不在层中。', 'bad');
    return;
  }
  if (d.floor >= MAX_FLOOR) {
    toast('最深处已在脚下——再往下是魔界本身。', 'bad');
    return;
  }
  d.floor++;
  const fl = floorOf(d.floor);
  const th = themeOf(d.floor);
  /* 卡 G2：是不是第一次踏进这一层——"老手怎么叫它"只在第一次值得说 */
  const firstTime = d.floor > d.best;
  if (firstTime) d.best = d.floor;
  advance(1);
  log('【第 ' + d.floor + ' 层 · ' + fl.name + '】' + th.desc, 'nar');
  if (firstTime) {
    /* §116 层数命名：层志上的名字是数据给的，老手嘴里的名字是长出来的 */
    const alias = generateFloor(d.floor).split(' · ')[1];
    if (alias) log('（老手管这里叫「' + alias + '」。）', 'sys');
  }
  if (d.floor === D.rules.abyssFloor) reachAbyss(s);
  if (fl.boss) {
    log('层的尽头没有路——只有' + fl.boss.name + '立在门前的阴影里。', 'bad');
    /* 首通记账与奖励对层主层同样成立（types/world.ts 的 cleared 注释正是这么定义的：
       「已首通的层（BOSS 层与首通奖励去重用）」）。此前这里直接 return，层主层永远拿不到
       首通金币/经验；重复进入只靠 d.best 间接挡，而深层切入会抬高 best，语义不等价（审查 §地下城）。
       grantFirstClear 自身按 cleared 幂等，重复调用不会重复发奖。 */
    grantFirstClear(d.floor);
    startCombat([fl.boss.mid], { boss: true, dungeon: true });
    applyBossTuning(fl.boss); // F-41：层数化强度（数据单调，覆盖魔物表的固定血量）
    sync();
    return;
  }
  grantFirstClear(d.floor); // F-08：首通奖励真正入账（原为零调用死代码）
  resolveEncounter(s, fl, th);
  sync();
}

/** F-41：把 boss 数据里的层数化强度盖到刚开出的战斗实例上（形象/掉落仍取自魔物表） */
function applyBossTuning(b: DungeonBoss): void {
  const CB = core.CB;
  if (!CB || !b.hp) return;
  const foe = CB.foes[0];
  if (!foe) return;
  foe.mhp = b.hp;
  foe.hp = b.hp;
  if (b.ac) foe.ac = b.ac;
}

/** 一层遭遇的权重判定（seed 确定性） */
function resolveEncounter(s: WorldState, fl: DungeonFloor, th: DungeonTheme) {
  const enc = D.rules.encounter;
  const r = rng.next();
  let acc = 0;
  const hit = (k: keyof typeof enc) => {
    acc += enc[k];
    return r < acc;
  };
  if (hit('monster')) {
    const ids = rng.pick(fl.monsters);
    const n = th.tier >= 3 && rng.chance(0.35) ? 2 : 1;
    log('黑暗中有什么动了——' + (n > 1 ? '两' : '一') + '道影子从' + fl.name + '的两侧合围上来。', 'nar');
    startCombat(new Array(n).fill(ids), { dungeon: true });
    /* 卡 G2：深层会遇上"变异体"（§46 五类的最后一类）——图鉴上没这一种，
       名字由 §115 按其所在层数生成。名字变了，数值不变：它是同一只东西长歪了。 */
    if (th.tier >= 3 && core.CB && rng.chance(0.3)) {
      const foe = core.CB.foes[0];
      if (foe) {
        foe.name = generateMonster({ level: fl.id });
        log('——它比同类多出一截不该有的东西，像是被这地方养大的。', 'bad');
      }
    }
  } else if (hit('trap')) resolveTrap(s, fl, th);
  else if (hit('loot')) resolveLoot(fl, th);
  else if (hit('npc')) resolveNpc(s, fl);
  else
    log(
      rng.pick([
        '这一层空得反常，只有你自己的脚步在石壁上折返。',
        '穹顶渗下的水珠砸在石面上，发出规律得令人不安的声响。',
        '墙上的刻痕在火光里一闪——那是前人留下的记号，指向更深。',
      ]),
      'nar',
    );
}

/** 陷阱：走 check 判定；失败最多打到 1 血（地下城的死亡只来自战斗，这是规则而非妥协） */
function resolveTrap(s: WorldState, fl: DungeonFloor, th: DungeonTheme) {
  const t = trapOf(rng.pick(fl.traps)) ?? D.traps[0];
  /* 卡 N1：工具的减免要在判定之前算，且**说出来**——玩家看不见的加成等于没有加成 */
  const cut = trapDcCut(t, s);
  const dc = Math.max(1, th.dcBase + t.dcMod + Math.floor(fl.id / 5) - cut);
  log('（' + t.name + '）' + t.seed, 'nar');
  if (cut > 0) log('行囊里的东西让你早一步看出了门道。（难度 -' + cut + '）', 'sys');
  check(t.name + ' · 第 ' + fl.id + ' 层', t.stat as StatName, dc, (res) => {
    if (res.ok) {
      log('你在最后一瞬避开了' + t.name + '。', 'nar');
    } else {
      const dmg = Math.max(1, Math.ceil((maxHp(s) * t.dmgPct) / 100));
      mutate.playerHp(Math.max(1, s.player.hp - dmg));
      log(t.name + '结结实实地落在了你身上（-' + dmg + '）。你咬着牙站起来——还活着。', 'bad');
      if (s.player.hp === 1) log('（陷阱不会取你性命；但以这种状态走进下一层的魔物视野，无异于送死。）', 'sys');
    }
    sync();
  });
}

/* 卡 I2：深层材料权重——长线材料（剑坯/星枢残片/星髓/虚空精华/白金币）在深层被"优先翻出来"，
   浅层保持原均匀抽取路径（既有确定性零回归）。供给端调平后，工艺配方才有稳定进料。 */
const LOOT_W: Record<string, number> = { blade_blank: 2, star_shard: 3, star_marrow: 4, void_essence: 5, seal_rune: 2, platinum: 3 };

function pickLoot(pool: string[], floor: number): string {
  if (floor < 51) return rng.pick(pool);
  const w = pool.map((id) => 1 + (LOOT_W[id] || 0));
  let total = 0;
  for (const x of w) total += x;
  let x = rng.next() * total;
  for (let i = 0; i < pool.length; i++) {
    x -= w[i];
    if (x < 0) return pool[i];
  }
  return pool[pool.length - 1];
}

/* 卡 I5：深层可捡到文献残卷（图鉴完成度越低越少出、越接近满越保底加速） */
const TOME_POOL: [number, string[]][] = [
  [21, ['tome_history', 'tome_planar']],
  [51, ['tome_faction', 'tome_craft']],
  [81, ['tome_abyss']],
];

function tomeFor(floor: number): string | null {
  let pool: string[] = [];
  for (const [min, ids] of TOME_POOL) if (floor >= min) pool = pool.concat(ids);
  return pool.length ? rng.pick(pool) : null;
}

/** 拾获：物品走层掉落池，铜钱按主题物价档（§62 深层贵于浅层） */
function resolveLoot(fl: DungeonFloor, th: DungeonTheme) {
  const iid = pickLoot(fl.loot, fl.id);
  const g = D.rules.lootGold[th.id] ?? [10, 40];
  const gold = rng.R(g[0], g[1]);
  addItem(iid, 1);
  gainGold(gold);
  log('你在壁龛的碎石下翻出一处前人遗落：' + WB.items[iid].name + '，还有 ' + formatMoney(gold) + '。', 'nar');
  const tome = fl.id >= 21 ? tomeFor(fl.id) : null;
  if (tome && rng.chance(0.12 * tomeWeight())) {
    addItem(tome, 1);
    log('（石缝里还夹着一册《' + WB.items[tome].name + '》——纸页干得发脆。）', 'sys');
  }
}

/** 熟人：深层撞见自己认识的人（走 D2 好感/记忆；浅层也可能是同行） */
function resolveNpc(s: WorldState, fl: DungeonFloor) {
  const id = npcOnFloor(fl.id, s);
  if (!id) {
    resolveLoot(fl, themeOf(fl.id));
    return;
  }
  const n = WB.npcs[id];
  log('转过拐角，你撞见一个不该出现在第 ' + fl.id + ' 层的人——' + n.name + '。对方也愣了一下。', 'nar');
  adjAtt(id, 1, '地下城偶遇');
  addMem(id, '在地下城第' + fl.id + '层与你偶遇', 2, 'event');
}

/** 层中偶遇的熟人（seed 确定性；未结识任何 NPC 时返回 null，调用方回落拾获） */
export function npcOnFloor(f: number, s: WorldState = need()): string | null {
  const met = Object.keys(s.npcs).filter((id) => s.npcs[id].met && WB.npcs[id]);
  if (!met.length) return null;
  /* F-41：概率单源取 rules.encounter.npc（原 rules.npcChance 双写已删） */
  const p = f >= 51 ? D.rules.encounter.npc * 2 : D.rules.encounter.npc;
  return rng.chance(p * 4) ? rng.pick(met) : null;
}

/** 抵达 100 层（魔界裂隙）：首次抵达置 flag → D4 级联 H2 星渊链（幂等） */
function reachAbyss(s: WorldState) {
  if (s.player.flags[D.rules.abyssChainFlag]) return;
  mutate.playerFlag(D.rules.abyssChainFlag);
  log('第一百层。石壁到此为止，前方是一道横贯穹顶的裂口——裂口的另一侧不是岩石，是别的东西在呼吸。', 'bad');
  addHistory('抵达地下城最深', '魔界裂隙·星渊之门', 5);
  directorTick(s); // D4：因果链级联（abyss_crisis 等由 events.json 数据驱动）
}

/** 撤退：保存进度、退回地面（耗时走 rules.retreatTicks） */
export function retreat(): void {
  const s = need();
  const d = syncRun(s);
  if (!d.inRun) {
    toast('你并不在层中。', 'bad');
    return;
  }
  const from = d.floor;
  d.inRun = false;
  d.floor = 0;
  d.escapes = (d.escapes || 0) + 1;
  /* F-08：retreat 不再写 cleared——该数组专表"首通"，撤退层混入会让首通奖励永久漏发 */
  d.lastRetreatAt = s.t;
  advance(D.rules.retreatTicks);
  log('你沿着来路退回地面。第 ' + from + ' 层的位置已经记在层志里——下次可以直接从中段入口切入。', 'nar');
  addHistory('从地下城撤退', '止步第 ' + from + ' 层', 1);
  sync();
}

/** 每日 tick（time.newDay 挂）：深层过夜 → 魔气侵蚀扣血（幂等，按日一次） */
export function dungeonTick(s: WorldState): void {
  const d = syncRun(s);
  if (!d.inRun) return;
  if (d.floor < D.rules.corruptionFrom) return;
  /* 卡 N1：护符与暖具把魔气隔在外面——有它在，侵蚀减半。这是「上层材料换下层生存」的那条线。 */
  const shielded = corruptionShield(s);
  const raw = Math.max(1, Math.ceil((maxHp(s) * D.rules.corruptionHpPct) / 100));
  const dmg = shielded ? Math.max(1, Math.ceil(raw / 2)) : raw;
  mutate.playerHp(Math.max(1, s.player.hp - dmg));
  mutate.playerFlag(D.rules.corruptionFlag);
  log(
    shielded
      ? '深层魔气顺着呼吸渗进来，却被你身上的护具挡回了大半（-' + dmg + '）。'
      : '深层魔气顺着呼吸渗进来。你在此过了一夜，血肉被侵蚀了一分（-' + dmg + '）。',
    'bad',
  );
}

/** 首通奖励（第一次抵达某一层时的额外收益；同一层只发一次） */
export function grantFirstClear(f: number): boolean {
  const s = need();
  const d = ensureDungeon(s);
  const c = clampFloor(f);
  if (d.cleared!.includes(c)) return false;
  d.cleared!.push(c);
  const g = D.rules.firstClear.gold;
  gainGold(rng.R(g[0], g[1]));
  gainExp(D.rules.firstClear.exp);
  log('层志第一次翻到第 ' + c + ' 页——首通奖励入账。', 'gain');
  return true;
}

/* ---------------- 星塔试炼镜像（卡 H1 的 starNet.trial 消费本函数） ---------------- */

/**
 * 星塔试炼第 floor 层的镜像参数：DC 取该层主题基准 + 深度递增（封顶 20，保证终层可挑战成功）。
 * 网内无伤——镜像只借用地下城的「层名 / 主题 / 难度」，绝不动真身 hp。
 */
export function trialMirror(f: number): { dc: number; themeId: string; themeName: string; floorName: string; floor: number } {
  const c = clampFloor(f);
  const th = themeOf(c);
  const fl = floorOf(c);
  return {
    dc: Math.min(20, th.dcBase + Math.floor(c / 12)),
    themeId: th.id,
    themeName: th.name,
    floorName: fl.name,
    floor: c,
  };
}

/* ---------------- 表现层 ---------------- */

/** 爬层 / 入口菜单（复用 ConfirmSheet，零新增弹层协议） */
export function dungeonMenu(): void {
  const s = need();
  const d = syncRun(s);
  if (!d.inRun) {
    entryMenu();
    return;
  }
  const fl = floorOf(d.floor);
  const th = themeOf(d.floor);
  const next = Math.min(MAX_FLOOR, d.floor + 1);
  const nf = floorOf(next);
  confirmSheet(
    '地下城 · 第 ' + d.floor + ' 层',
    '【' + fl.name + '】' + th.name + '（深度档 ' + th.tier + '）<br>' + th.desc +
      '<br><br>历史最深：第 ' + d.best + ' 层　·　撤退 ' + (d.escapes || 0) + ' 次' +
      (d.floor >= D.rules.corruptionFrom ? '<br><span style="color:var(--crimson)">深层魔气侵蚀中——在此过夜会持续失血。</span>' : ''),
    [
      { l: '下潜至第 ' + next + ' 层 · ' + nf.name, a: 'dungeon_next' },
      { l: '撤退回地面', a: 'dungeon_retreat' },
      { l: '（留在原地）', a: 'close' },
    ],
  );
}

/** 入口菜单（人在有入口的地点、尚未入层） */
export function entryMenu(): void {
  const s = need();
  const e = entryAt(s.player.loc);
  if (!e) {
    toast('此处没有通往地下城的入口。', 'bad');
    return;
  }
  const why = entryLockReason(e, s);
  const d = ensureDungeon(s);
  const btns = why
    ? [{ l: '（' + why + '）', a: 'close' }]
    : [
        { l: '下潜 · 自第 ' + e.startFloor + ' 层开始', a: 'dungeon_enter' },
        { l: '（返回）', a: 'close' },
      ];
  confirmSheet(
    '地下城入口 · ' + e.name,
    e.desc + '<br><br>此入口可自第 ' + e.startFloor + ' 层切入。层志最深：第 ' + d.best + ' 层。<br>' +
      '地下城共 ' + MAX_FLOOR + ' 层，五主题分层：浅 1–20 · 中 21–50 · 深 51–80 · 最深 81–99 · 深渊 100。',
    btns,
  );
}

/**
 * 卡 G2 · 无名遗迹的发现：一次消费三个命名维度。
 *
 * 为什么这三个维度天然咬合：遗迹本来就是「谁在这里做过什么」留下的痕迹——
 * 一处地点（§106）· 一个组织（§107）· 一门失传的技艺（§117）。
 * 分开接入会显得硬凑，放在一起才是同一件事的三面。
 */
export function discoverRuin(): { place: string; org: string; skill: string } {
  const s = need();
  const lineage = WB.classes[s.player.cls]?.lineage ?? '物理';
  const place = generatePlace();
  const org = generateOrg();
  const skill = generateSkillOrRelic(lineage);
  log('碎石堆后是一道塌了半边的门楣——「' + place + '」。', 'nar');
  log('门楣内侧留着' + org + '的徽记，笔画被人用刀刮过，但没刮干净。', 'nar');
  log('最里间石室的墙上有一式残谱：「' + skill + '」——只有起手三招还看得清。', 'sys');
  addHistory('发现遗迹 · ' + place, org + ' · ' + skill, 2);
  sync();
  return { place, org, skill };
}

/** 供 UI 面板 / Overlay 渲染的纯数据视图 */
export function dungeonView(): DungeonView {
  const s = need();
  const d = syncRun(s);
  const shown = d.floor > 0 ? d.floor : Math.max(1, d.best);
  const fl = floorOf(shown);
  const th = themeOf(shown);
  /* 人在入口地点时取当前入口；否则回落到本次下潜的入口，保证层中 HUD 仍有入口名与起始层 */
  const e = entryAt(s.player.loc) ?? (d.inRun ? entryAt(d.entry ?? '') : undefined);
  return {
    inRun: d.inRun,
    floor: d.floor,
    best: d.best,
    next: Math.min(MAX_FLOOR, d.floor + 1),
    themeId: th.id,
    themeName: th.name,
    themeDesc: th.desc,
    tier: th.tier,
    floorName: fl.name,
    isBoss: !!fl.boss,
    seed: fl.seed,
    escapes: d.escapes || 0,
    corrupted: d.floor >= D.rules.corruptionFrom,
    atAbyss: d.floor >= D.rules.abyssFloor,
    canEnter: !!e,
    entryName: e?.name ?? '',
    entryStart: e?.startFloor ?? 0,
    entryOk: !!e && entryUnlocked(e, s),
    entryLock: e ? entryLockReason(e, s) : '',
  };
}
