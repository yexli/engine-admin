/* ============================================================
   WorldState 容器（唯一事实来源）+ newState + save
   原型对应：let S=null / let CB=null / newState() / save()
   ------------------------------------------------------------
   【World Engine 抽取】容器的**机制**（need / sync 尾节流 / save
   分片落盘 / 事件序号随档走）已抽入独立引擎
   （world-engine/src/state/WorldState.ts，行为逐行等价）。
   留在这里的是**天穹的状态世界观**：core 的三个槽位（S / CB / curShop）、
   世界书驱动的创角（newState）与旧档迁移（hydrate）、以及开发期 HMR。
   本文件对 systems/* 的导入被 arch-deps 门禁冻结为
   [Economy, Factions] 两家——环根不许扩大。
   ============================================================ */
import { WB } from '@/data/worldBook';
import { START_AGE, TICKS_PER_YEAR } from '@/world/TimeBase';
import type { CombatState, WorldState } from '@/types/world';
import { emitChanged, rng } from '@/events/EventBus';
import { eventSeq, setEventSeq } from '@/events/EventSchema';
import { initVendors } from '@/systems/economy/Economy';
import { HOME_TEMPLE, PANTHEON_TEMPLES, initPlayerRep } from '@/systems/faction/Factions';
import { savePort } from '@/plugins/PluginInterface';
import { SHARD_FIELDS } from '@/world/Shards';
import { createWorldContainer } from 'world-engine';

export const core: {
  S: WorldState | null;
  CB: CombatState | null;
  /** 当前打开的商店（原型 curShop） */
  curShop: string | null;
} = { S: null, CB: null, curShop: null };

/* 容器机制来自 World Engine：holder 传入天穹自己的 core（含 CB / curShop 槽位），
   落盘走天穹的 savePort 与分片表，changed 通知接天穹的 UI 总线。 */
const container = createWorldContainer<WorldState>({
  holder: core,
  getSavePort: () => savePort(),
  onChanged: () => emitChanged(),
  shardFields: SHARD_FIELDS,
});

/** 取当前世界状态；未开始游戏时抛错（调用方须先经引擎命令） */
export const need = container.need;
export const save = container.save;
/** 立即落盘（退出前 / 需要读回时用）：丢掉待写标记并写一次 */
export const flushSave = container.flushSave;
/** 状态变化 + 落盘（原型 renderAll();save() 的等价物；changed 立即、落盘尾节流） */
export const sync = container.sync;
/** 落盘节流窗口（F-12）：一次命令链 N 次 sync 只写一次盘。
    100→1000ms（性能收口）：每次 save 都在主线程全量 stringify 四片（大档数 MB），
    100ms 档在操作连发期间接近持续序列化。放宽后频率降为 1/10；
    可靠性不靠窗口兜——退出（beforeunload / onCloseRequested）与页面隐藏
    （visibilitychange，见组合根）都会 flushSave 立即冲盘。导出常量供测试等窗。 */
export const SAVE_THROTTLE_MS = container.SAVE_THROTTLE_MS;

/* 开发期 HMR：core 是全局单例，模块一被热替换 S 就归零——页面上的世界当场丢失，
   表现是「点什么都没反应」却不报错，且只有刷新才能复原。把世界带过模块边界，
   热替换不该等于丢档。（类型用最小面：vite/client 未引入本项目） */
type CoreHotData = { core?: typeof core };
const hot = (import.meta as { hot?: { dispose: (cb: (d: CoreHotData) => void) => void; data: CoreHotData } }).hot;
if (hot) {
  hot.dispose((d) => {
    d.core = core;
  });
  const prev = hot.data.core;
  if (prev) {
    core.S = prev.S;
    core.CB = prev.CB;
    core.curShop = prev.curShop;
  }
}

/** 世界书的关系种子 → 运行时可写的边集合（投影的唯一实现，见 §4/§14 与卡 D2） */
export function stripTies(seed: Record<string, { type: string; val: number }>): Record<string, { type: string; val: number }> {
  return Object.fromEntries(Object.entries(seed).map(([k, v]) => [k, { type: v.type, val: v.val }]));
}

/** 创角参数。卡 L3 加 gender（§96 的婚龄分男女两档），缺省 male——旧调用与旧档都不受影响 */
export type CharSpec = { name: string; race: string; cls: string; gender?: 'male' | 'female' };

export function newState(ch: CharSpec): WorldState {
  const c = WB.classes[ch.cls];
  const stats = { 力量: 10, 体质: 10, 敏捷: 10, 智力: 10, 感知: 10, 魅力: 10 };
  for (const k in WB.races[ch.race].mods) {
    (stats as Record<string, number>)[k] += (WB.races[ch.race].mods as Record<string, number>)[k];
  }
  for (const k in c.stats) {
    (stats as Record<string, number>)[k] += (c.stats as Record<string, number>)[k];
  }
  const s: WorldState = {
    ver: 1,
    /* 种子走统一随机源（§9：一切随机经 rng），但它一旦定下就不再变 */
    seed: Math.floor(rng.next() * 4294967296) >>> 0,
    t: 16,
    weather: '晴',
    player: {
      name: ch.name,
      race: ch.race,
      cls: ch.cls,
      level: 1,
      exp: 0,
      stats,
      hp: 0,
      mp: 0,
      /* 卡 T3：起始资金 600 → 5000。
         装备价按世界书 §55 对齐后（猎刀 7500 / 铁剑 12000 / 皮甲 9000），
         600 铜等于「连一件最便宜的武器都买不起」，开局没有选择空间；
         5000 能买到一件基础武器或防具，其余靠任务与浅层副本赚（掉落与奖励已同步 ×8）。 */
      gold: 5000,
      loc: 'plaza',
      bag: [],
      skills: [c.skill],
      equip: { wpn: c.gear[0], arm: c.gear[1] },
      quests: {},
      wanted: 0,
      crimes: 0,
      flags: {},
      wallet: { magicCrystal: 0, soulCrystal: 0 },
      /* 卡 L1 · 创角 16 岁。年龄按外界时间派生，故此处只落出生刻 */
      birthTick: 16 - START_AGE * TICKS_PER_YEAR,
      lifeBonus: 0,
      netAgedTicks: 0,
      /* 卡 L3 · §96：性别缺省 male（旧调用不带这个参数，行为与从前一致） */
      gender: ch.gender ?? 'male',
    },
    npcs: {},
    /* 势力声望表由世界书**派生**而不是手抄（2026-09 · 神殿拆五）：
       原先这里是十个势力的硬编码字面量，于是每加一个势力都要回来补一行——
       神殿拆五时正是它让 rep 少了两座殿，玩家祈祷记不上账。
       现在照 WB.factions 生成：世界书加势力，这张表自动跟上。 */
    rep: Object.fromEntries(Object.keys(WB.factions).map((f) => [f, 0])) as WorldState['rep'],
    econ: { herb: 1 },
    events: [],
    history: [],
    log: [],
    logSeq: 0,
    killed: {},
    qf: {},
    net: {
      online: false,
      starcoin: 0,
      starcrystal: 0,
      consign: [],
      duels: { won: 0, lost: 0 },
      insights: { mood: 0, sessions: 0 }, // 卡 H1
      trialBest: 0,
      arenaWins: 0,
      councilFavor: {},
    },
    legal: { charges: [] },
    abyss: { leak: 0, sealed: 0 }, // 卡 H2
    dungeon: { floor: 0, best: 0, inRun: false }, // 卡 H4
    theoselect: { enrolled: false, stage: '海选', score: 0 }, // 卡 H5
    academy: { progress: 0, completed: [], titles: [] }, // 卡 H6
    favor: {}, // 卡 H6
    craft: { ranks: {}, made: {} }, // 卡 I2
    codex: { unlocked: [], found: {} }, // 卡 I5
    titles: [], // 卡 I6
    titleHidden: [],
    knowledge: {}, // §8：NPC 感知表（谁知道什么）
    cases: [], // §8：势力案件（立案/取证/结案）
    checks: [], // §44：最近检定留痕
    memories: {}, // 记忆方案 §4：角色记忆表（记得什么、多清楚、从哪知道）
    memSeq: 0, // 记忆 id 序号（随档持久化，避免重启后同日碰撞）
    memTickAt: {}, // Phase 6：记忆分频记账（owner → 上次 tick 日）
    beliefs: {}, // §24：信念表（由记忆推导）
  };
  initPlayerRep(s);
  initVendors(s);
  return s;
}

/**
 * 存档归一化（§4 结构演进：保持旧档可读）。
 * 载入/importState 后调用，为后续版本新增的可选字段补默认，避免 undefined 崩溃。
 */
export function hydrate(s: WorldState): WorldState {
  /* F-22：容器字段全量兜底（与 validate 的"缺失放行"策略配对）——
     结构不全的旧档/手改档不再半可读，任何 UI 面板都能安全索引。 */
  if (typeof s.seed !== 'number') s.seed = 0; // 旧档：0 也是合法种子，且档内恒定
  if (typeof s.evtSeq !== 'number') s.evtSeq = 0;
  /* 基座字段的第二道兜底（第一道是 validateState 的必填校验）。
     任何绕过闸门进入运行时的档——外部脚本直接 hydrate、老版本迁移、手改内存——
     都不该以 undefined 的位置启动：舞台会当场崩在 WB.locations[undefined] 上。 */
  if (typeof s.player.loc !== 'string' || !WB.locations[s.player.loc]) s.player.loc = 'plaza';
  if (typeof s.player.race !== 'string' || !WB.races[s.player.race]) s.player.race = 'human';
  if (typeof s.player.cls !== 'string' || !WB.classes[s.player.cls]) s.player.cls = 'warrior';
  if (typeof s.t !== 'number' || !Number.isFinite(s.t)) s.t = 16;
  /* 事件序号续接：取「档内记录」与「本次进程已用」的较大者，
     否则新事件会拿到已经发过的 id → 被判 duplicate 静默丢弃 */
  setEventSeq(Math.max(eventSeq(), s.evtSeq));
  if (!s.player.bag) s.player.bag = [];
  if (!s.player.skills) s.player.skills = [];
  if (!s.player.equip) s.player.equip = { wpn: null, arm: null };
  if (typeof s.isq !== 'number') s.isq = 0; // 卡 I1：装备实例序号（旧档补 0）
  if (!s.player.quests) s.player.quests = {};
  if (!s.player.flags) s.player.flags = {};
  if (!s.npcs) s.npcs = {};
  if (!s.rep) s.rep = {};
  if (!s.events) s.events = [];
  if (!s.history) s.history = [];
  if (!s.log) s.log = [];
  /* 旧档补基线：必须从既有条目的最大 id 续起，不能补 0——
     见闻录用 e.id 作 React key，补 0 会让读档后第一条新日志拿到 id=1，
     与档内历史条目撞号；key 一撞 React 就复用错节点，见闻录越点越多。
     没有 id 的老条目（原型时期）按 0 计，不参与续接。 */
  const maxLogId = s.log.reduce((mx, e) => Math.max(mx, typeof e.id === 'number' ? e.id : 0), 0);
  /* 缺失或落后都要拉回：值存在但小于历史最大 id，同样是撞号的来源——
     上一版迁移曾把旧档补成 0 并写回盘，只判「缺失」捞不回这些档。 */
  if (typeof s.logSeq !== 'number' || s.logSeq < maxLogId) s.logSeq = maxLogId;
  if (!s.killed) s.killed = {};
  if (!s.qf) s.qf = {};
  if (!s.chats) s.chats = {};
  /* 神殿拆五（2026-09 · NPC 规模化）：旧档的 rep.temple 是「圣辉神殿」的单一账目。
     势力拆成五殿之后这笔声望无主——不迁移，玩家攒的信仰会因换了势力 id 而凭空消失
     （改代号等于换账本，这是拆分时就知道要还的债）。
     分摊规则：主事殿得全额，其余四殿得半数（它们在圣辉城只是分殿）。
     迁完删旧键，免得它变成一笔永远还不清的幽灵账。 */
  const legacyTemple = (s.rep as Record<string, number>).temple;
  if (typeof legacyTemple === 'number') {
    s.rep[HOME_TEMPLE] = Math.max(s.rep[HOME_TEMPLE] || 0, legacyTemple);
    for (const t of PANTHEON_TEMPLES) {
      if (t === HOME_TEMPLE) continue;
      s.rep[t] = Math.max(s.rep[t] || 0, Math.round(legacyTemple / 2));
    }
    delete (s.rep as Record<string, number>).temple;
    if (s.playerRep) delete (s.playerRep as Record<string, unknown>).temple;
  }
  for (const k of Object.keys(WB.factions)) if (typeof s.rep[k] !== 'number') s.rep[k] = 0;
  if (!s.player.wallet) s.player.wallet = { magicCrystal: 0, soulCrystal: 0 };
  if (!s.net) s.net = { online: false, starcoin: 0, starcrystal: 0, consign: [], duels: { won: 0, lost: 0 } };
  // 结构演进兜底：夹取等级到 [1,6]（xpNeed 仅 0–6），补 stats，防旧/手改档 NaN 或越界。
  s.player.level = Math.min(6, Math.max(1, Math.trunc(s.player.level) || 1));
  if (!s.player.stats) s.player.stats = { 力量: 10, 体质: 10, 敏捷: 10, 智力: 10, 感知: 10, 魅力: 10 };
  initPlayerRep(s); // 卡 D3：旧档投影多维声望（attitude 仍读 rep）
  if (!s.legal) s.legal = { charges: [] }; // 卡 D5：旧档补法律状态
  if (!s.econ) s.econ = { herb: 1 }; // 卡 D6：旧档 econ 兜底
  initVendors(s); // 卡 D6：旧档补商店收购本金
  if (s.net) {
    // 卡 H1：七塔完全体字段兜底（旧档可读）
    if (!s.net.insights) s.net.insights = { mood: 0, sessions: 0 };
    if (s.net.trialBest === undefined) s.net.trialBest = 0;
    if (s.net.arenaWins === undefined) s.net.arenaWins = 0;
    if (!s.net.councilFavor) s.net.councilFavor = {};
  }
  if (!s.abyss) s.abyss = { leak: 0, sealed: 0 }; // 卡 H2
  if (!s.dungeon) s.dungeon = { floor: 0, best: 0, inRun: false }; // 卡 H4
  if (!s.theoselect) s.theoselect = { enrolled: false, stage: '海选', score: 0 }; // 卡 H5
  if (!s.academy) s.academy = { progress: 0, completed: [], titles: [] }; // 卡 H6
  if (!s.favor) s.favor = {}; // 卡 H6
  if (!s.craft) s.craft = { ranks: {}, made: {} }; // 卡 I2：技艺工坊（旧档补默认，全站不崩）
  if (!s.codex) s.codex = { unlocked: [], found: {} }; // 卡 I5：文献图鉴（I2 只读 needCodex 门）
  if (!Array.isArray(s.titles)) s.titles = []; // 卡 I6：头衔（旧档补默认）
  /* 叙事编织：章级前情摘要 + 归档水位。旧档补空 —— 摘要可以从头攒，
     它只是上下文的润滑剂，缺失不影响任何既有功能的可读性。 */
  if (!Array.isArray(s.recap)) s.recap = [];
  if (typeof s.recapSeq !== 'number') s.recapSeq = 0;
  if (!Array.isArray(s.titleHidden)) s.titleHidden = [];
  if (!s.knowledge) s.knowledge = {}; // §8：旧档补空感知表（没人知道任何事）
  if (!s.memories) s.memories = {}; // 记忆方案 §4：旧档补空记忆表
  /* 记忆 id 序号与 logSeq 是同一范式，也必须**从档内最大值续起**：
     nextMemoryId 只拿 `s.memSeq ?? 0` 兜底，于是「有记忆、没序号」的档（序号还挂在
     模块变量上的那一版、或经 importState 导入的手改档）会从 1 重新开始，当天的新记忆
     就与档内旧记忆撞 id，recall 会静默改到旧的那条。缺失与落后都要拉回，理由同 logSeq。 */
  let maxMemSeq = 0;
  for (const list of Object.values(s.memories)) {
    if (!Array.isArray(list)) continue;
    for (const m of list) {
      const raw = m && typeof m.id === 'string' ? m.id : '';
      const n = Number(raw.slice(raw.lastIndexOf('_') + 1));
      if (Number.isFinite(n) && n > maxMemSeq) maxMemSeq = n;
    }
  }
  if (typeof s.memSeq !== 'number' || s.memSeq < maxMemSeq) s.memSeq = maxMemSeq;
  /* Phase 6：旧档没有分频记账 → 补空表，等价于「所有 owner 都刚到点」，
     于是第一次日边界照旧全量跑一遍，与改造前行为一致。 */
  if (!s.memTickAt) s.memTickAt = {};
  if (!s.beliefs) s.beliefs = {}; // 记忆方案 §24：旧档补空信念表（可由记忆重建）
  if (!Array.isArray(s.cases)) s.cases = []; // §8：旧档补空案件表
  if (!Array.isArray(s.checks)) s.checks = []; // §44：旧档补空检定留痕
  /* 卡 L1：旧档补出生刻——按当前时间倒推 16 岁，等价于「这个人一直就是这个岁数」，
     不做"从第 1 天算起"的追溯（那会让老存档一读进来就濒死）。 */
  if (s.player.birthTick === undefined) s.player.birthTick = s.t - START_AGE * TICKS_PER_YEAR;
  if (s.player.lifeBonus === undefined) s.player.lifeBonus = 0;
  if (s.player.netAgedTicks === undefined) s.player.netAgedTicks = 0;
  return s;
}
