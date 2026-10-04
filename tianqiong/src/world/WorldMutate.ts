/* ============================================================
   受控写入原语（《插件化世界模拟架构方案》§4.2）
   —— 世界状态的**唯一**写入实现点。
   Gains / Npcs 等系统模块只做「调原语 + 自己的副作用（toast / 世界事件）」，
   不再直接改 core.S 的字段；改写路径因此只有一条，能绕开的写法由 lint 守卫挡住。

   ------------------------------------------------------------
   【World Engine 抽取 · V0.2】与引擎 createMutate 合并：
   · **通用原语**（位置/旗帜/背包/实体/声望/天气/状态效果/见闻录）来自引擎
     createMutate——写入路径单一来源，任何满足引擎信封的世界都能用；
   · **天穹资源类原语**（hp/mp/gold/exp/钱包/成长/配偶/转职/统计量/econ）
     与 **npcEntry 的世界书关系种子投影** 留在这里（§9：那是天穹世界观）；
   · 宿主钩子：entryOf 把「建档即投影」的世界书副作用注入引擎实体原语
     （§4/§14：谁先调用谁才读得到关系网——投影必须在建档路径上一次完成，
     只覆盖对外的 npcEntry 而不注入 entryOf 会漏掉 npcAtt 等旁路建档）；
     stamp 把天穹历法注入见闻录时间戳。

   为什么独立成模块、而不是并进 WorldAPI：WorldAPI 经 WorldRuntime 间接依赖全部系统
   （dispatch 的路由表就在那里），而 Gains / Npcs 这类系统模块自己要用原语——
   并进去会形成 Gains → WorldAPI → WorldRuntime → Gains 的近距循环。

   为什么不是把每个写操作都做成 effects：execute() 要 reason、进运行日志、挂因果链，
   是给「有因果依据的世界动词」用的；玩法层的高频写入（+1 金币、扣 3 点血）
   没有依据可写，强行套用会让 reason 变成填字游戏。分工是：mutate 管字段，execute 管世界动词。

   为什么不做上界夹取：maxHp / maxMp 属角色系统，本模块不依赖系统——
   需要上界的调用方把 cap 传进来（见 playerHp 的第二参）。

   对外统一面：WorldAPI 把本对象暴露为 world.mutate。
   ============================================================ */
import { WB } from '@/data/worldBook';
import { need, stripTies } from '@/world/WorldState';
import { timeStr } from '@/world/WorldClock';
import { createMutate } from 'world-engine';
import type { NpcDynamic, WorldState } from '@/types/world';

/** NPC 运行时条目（惰性建档 + 关系种子投影的唯一实现点）。未开局时抛错（同 need）。
    §4/§14：投影必须在建档时一次完成，否则「谁能读到关系网」会取决于调用顺序 */
function npcEntry(id: string, s: WorldState = need()): NpcDynamic {
  let dy = s.npcs[id];
  if (!dy) dy = s.npcs[id] = { att: 0, mem: [], met: false };
  if (!dy.rels) dy.rels = stripTies(WB.npcs[id]?.rels ?? {});
  return dy;
}

/* 引擎通用原语：entryOf / stamp 两个钩子把天穹的世界观注入 */
const engineMutate = createMutate<WorldState>(need, {
  entryOf: (s, id) => npcEntry(id, s),
  stamp: (s) => timeStr(s),
});

export const mutate = {
  /* ---------------- 引擎通用原语（单一来源在 world-engine） ----------------
     playerLoc / playerFlag / playerBag / npcEntry / npcAtt / npcMet / npcBag /
     npcGold / rep / weather / addEffect / removeEffect / pushLog / appendRecap /
     weaveLogs —— 行为与抽取前逐行一致（npcAtt 的夹取、playerBag 的堆叠规则、
     weaveLogs 的区间替换与玩家原话保留都由引擎实现承载）。 */

  ...engineMutate,

  /* 对外仍暴露天穹版 npcEntry（含关系种子投影的完整语义） */
  npcEntry,

  /* ---------------- 天穹资源类原语（游戏世界观，不进引擎） ---------------- */

  /**
   * 卡 A1 · 成长线状态（师徒/神殿/自学）的唯一写入入口。
   * 语义是「取到可写的容器并自愈」：缺省时把它补成空对象，返回同一引用供调用方改字段。
   * 写字段**不绕过**写入层——容器由这里创建，字段是玩家的成长记录（与 craft/memory
   * 同类的次级容器），不像 gold/hp 那样有跨系统读者。
   */
  playerGrowth(): NonNullable<WorldState['player']['growth']> {
    const s = need();
    /* 本文件是写入层的实现点，规则对本文件豁免（写入守卫拦的是**别处**的 s.player.* 赋值，
       单层属性同样拦——卡 L1 实测确认，不是只拦整个 player 对象）。 */
    if (!s.player.growth) s.player.growth = {};
    return s.player.growth;
  },
  /**
   * 卡 L1 · 寿元加成（年）：百年神选座次赏赐等（§80）。
   * 与 gold/hp 同理——它有跨系统读者（Lifespan 读它算寿数上限），故走写入层。
   */
  playerLifeBonus(delta: number): void {
    const s = need();
    s.player.lifeBonus = (s.player.lifeBonus ?? 0) + delta;
  },
  /** 卡 L3 · §96 婚配：记下配偶（一生一次，故是"设定"而非"累加"；解约传 undefined） */
  playerSpouse(npcId: string | undefined): void {
    const s = need();
    s.player.spouse = npcId;
  },
  /** 卡 L1 · 网中累计刻数（§10「网中历时不耗寿」）：出网时把这段净时长记上，年龄换算会扣掉它 */
  playerNetAged(ticks: number): void {
    const s = need();
    s.player.netAgedTicks = (s.player.netAgedTicks ?? 0) + Math.max(0, ticks);
  },

  /** 生命值。cap 由调用方给出（缺省只保下界，与调用方自己算好的写法等价） */
  playerHp(v: number, cap?: number): void {
    if (!Number.isFinite(v)) return; // 非有限数一律不落地（二期审查 C1）
    const s = need();
    s.player.hp = cap === undefined ? Math.max(0, v) : Math.max(0, Math.min(cap, v));
  },

  /** 法力值，语义同 playerHp */
  playerMp(v: number, cap?: number): void {
    if (!Number.isFinite(v)) return;
    const s = need();
    s.player.mp = cap === undefined ? Math.max(0, v) : Math.max(0, Math.min(cap, v));
  },

  /** 金钱增量（负数=扣除），夹取到 >= 0 */
  playerGold(delta: number): void {
    if (!Number.isFinite(delta)) return;
    const s = need();
    s.player.gold = Math.max(0, s.player.gold + delta);
  },

  /** 经验增量，夹取到 >= 0。升级判定不在这里——那是角色系统的玩法规则 */
  playerExp(delta: number): void {
    if (!Number.isFinite(delta)) return;
    const s = need();
    s.player.exp = Math.max(0, s.player.exp + delta);
  },

  /**
   * 卡 D4 · 转职：一次性写回职业相关字段（技能线 / 职业 id / 转职留痕）。
   * 三个字段必须**一起改**——只改 cls 不改 skills 会让玩家带着旧职业的技能在新线里跑，
   * 那正是转职要防的"多线叠加"。合成一个原语，不给调用方"只改一半"的机会。
   */
  playerTransfer(cls: string, skills: string[], purged: string[]): void {
    const s = need();
    s.player.cls = cls;
    s.player.skills = skills;
    s.player.transferLog = [...(s.player.transferLog ?? []), ...purged];
  },

  /**
   * 卡 D4 · 直接扣减金币（**仅在已经校验过余额之后**使用）。
   * 与 playerGold 的区别：playerGold 收 delta（可正可负、由调用方给负数），
   * 这里刻意只接受"已经判定可以付"的支出，避免调用方把符号搞反。
   */
  payGold(amount: number): void {
    const s = need();
    s.player.gold = Math.max(0, s.player.gold - Math.max(0, amount));
  },

  /** 玩家数值字段的受控读改写（wanted / crimes / level 这类非资源标量）。
      传函数而不是传引用：读—算—写三步全在原语内完成，调用方拿不到 s.player。 */
  playerNum(key: 'wanted' | 'crimes' | 'level', fn: (cur: number) => number): void {
    const s = need();
    s.player[key] = fn(s.player[key]);
  },

  /** 直接设值的受控入口（「清空通缉」这类赋值语义）；仍然不接受外部持有引用 */
  playerSet(key: 'wanted' | 'crimes' | 'level', v: number): void {
    need().player[key] = v;
  },

  /** 二级货币钱包增减（魔晶 / 灵魂结晶），夹取到 >= 0 */
  playerWallet(unit: 'magicCrystal' | 'soulCrystal', delta: number): void {
    if (!Number.isFinite(delta)) return;
    const s = need();
    if (!s.player.wallet) s.player.wallet = { magicCrystal: 0, soulCrystal: 0 };
    s.player.wallet[unit] = Math.max(0, s.player.wallet[unit] + delta);
  },

  /** 品类价格指数（econ）：夹取到 [0.2, 5]，与 large_trade 订阅同一范围。
      返回写入后的值，便于调用方留痕。 */
  econ(index: string, next: number): number {
    if (!Number.isFinite(next)) return 1;
    const s = need();
    s.econ[index] = Math.max(0.2, Math.min(5, Math.round(next * 100) / 100));
    return s.econ[index];
  },
};
