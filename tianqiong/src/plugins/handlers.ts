/* ============================================================
   后果处理器装配（《插件化世界模拟架构方案》§15 / §17 / §20 / §45）
   —— 把「推演产出的后果」接到「真正拥有该能力的系统」上。
   刻意抽成组合根可调用的纯函数（而非 main.tsx 内联），使测试能直接装配、
   避免出现「计划能通过验证却落不了地」的动作。
   每个处理器对应 capabilities 里已登记的一条动作；未登记的动作会被
   Rule Validator 提前拒掉，根本走不到这里。
   ============================================================ */
import { WB } from '@/data/worldBook';
import { bus, isReasonerOrigin, worldBus } from '@/events/EventBus';
import { makeEvent, levelOf } from '@/events/EventSchema';
import { worldEventLog } from '@/events/EventStore';
import { worldExecutor } from '@/execution/WorldExecutor';
/* 卡 N1–N4 · K3 四系统的动作入口 */
import { sendMessage } from '@/systems/commnet/CommNet';
import { enterSlip } from '@/systems/timeslip/Timeslip';
import { violateTaboo } from '@/systems/culture/Culture';
import { capabilities } from './CapabilityRegistry';
import { addItem, addRep, gainExp, gainGold, log, removeItem } from '@/systems/character/Gains';
import { maxHp } from '@/systems/character/Derived';
import { openCase } from '@/systems/law/Investigation';
import { commitCrime } from '@/systems/law/Law';
import { adjAtt, npcDyn } from '@/systems/npc/Npcs';
import { spreadRumor } from '@/systems/relationship/Relations';
import { setGrudge } from '@/systems/relationship/Bond';
import { adjFactionRel } from '@/systems/faction/Factions';
import { giveQuest, turnIn } from '@/systems/quest/Quests';
import { suppressTitle, titleById } from '@/systems/reputation/Title';
import { indexKeyOf } from '@/systems/economy/Economy';
import { core } from '@/world/WorldState';
import { mutate } from '@/world/WorldMutate';
import { sceneTime } from '@/world/WorldClock';
import type { ConsequenceAction } from '@/execution/PlanSchema';
import type { RepAxis } from '@/types/world';

const paramsOf = (a: ConsequenceAction): Record<string, unknown> => (a.params ?? {}) as Record<string, unknown>;
/* 非法数值（'一百' / null / Infinity）一律归一，不把 NaN 交给下游：
   NaN 会写进世界状态 → JSON.stringify 变 null → 下次读档被闸门拒（二期审查 C1）。 */
const numberOr = (v: unknown, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
/* deltaOf 也走 numberOr：此前用裸 Number()，"abc" 会还原成 NaN 写进 rep / 好感，
   "999999999" 会还原成 9.99e8——文本参数不该因为 handler 愿意转换就变成数字（审查 §数值通道）。 */
const deltaOf = (a: ConsequenceAction): number => numberOr(paramsOf(a).delta, 0);
const amountOf = (a: ConsequenceAction): number => Math.max(0, Math.round(numberOr(paramsOf(a).amount, 0)));
/* 件数保持非负：0 与非法值都交给原语层兜住（`!qty` 直接返回 false），
   而不是规整成 1——「给 0 件」不该被悄悄执行成「给 1 件」。 */
const qtyOf = (a: ConsequenceAction): number => Math.max(0, Math.round(numberOr(paramsOf(a).qty, 1)));

export function registerConsequenceHandlers(): void {
  /* ============================================================
     卡 N1–N4 · K3 四个新系统的后果处理器
     —— 这三个能力都是「事件驱动的一次性动作」（发讯/入小世界/触犯禁忌），
     统一走同一个处理入口：按 capability 分发到对应模块。这样以后加同类动作
     不必再写一遍样板（也避免"登记了却落不了地"）。
     ============================================================ */
  const K3_ROUTES: Record<string, (actor: string, params: Record<string, unknown>) => void> = {
    /* 发讯：把 actor 的位置当作起点 */
    send_message: (actor, p) => {
      void actor;
      const way = String(p.way ?? 'letter');
      const to = String(p.to ?? '');
      if (to) sendMessage(way, to, String(p.topic ?? '口信'));
    },
    /* 入小世界修炼：给经验，不直接改位置（位置由玩家行动决定） */
    enter_timeslip: (actor, p) => {
      void actor;
      const r = enterSlip(String(p.type ?? 'fast'), Number(p.days ?? 7));
      if (r.ok && r.exp > 0) gainExp(r.exp);
    },
    /* 触犯禁忌：扣声望 + 发事件 */
    violate_taboo: (actor, p) => {
      void actor;
      const id = String(p.taboo ?? '');
      if (id) violateTaboo(id);
    },
  };
  for (const [cap, run] of Object.entries(K3_ROUTES)) {
    worldExecutor.registerHandler(cap, (a) => run(a.actor ?? 'player', paramsOf(a)));
  }

  /* ---------------- §8 调查 ---------------- */

  /* 立案——证据只能来自感知表，所以「没人目击」时这里什么也立不了案 */
  worldExecutor.registerHandler('start_investigation', (a, plan) => {
    const e = worldEventLog.byId(plan.triggerEvent);
    if (e) openCase(e, a.actor ?? 'empire');
  });

  /* ---------------- §4.2 角色与物品 ---------------- */

  worldExecutor.registerHandler('gain_exp', (a) => {
    const n = amountOf(a);
    if (n > 0) gainExp(n);
  });

  worldExecutor.registerHandler('damage_character', (a) => {
    const s = core.S;
    const dmg = amountOf(a);
    if (!s || dmg <= 0) return;
    mutate.playerHp(s.player.hp - dmg);
    log('（' + dmg + ' 点伤害落在身上。）', 'bad', s);
    /* 归零的死亡后果留给战斗系统裁定：非战斗路径没有败北流程，不擅自触发 */
  });

  worldExecutor.registerHandler('heal_character', (a) => {
    const s = core.S;
    const heal = amountOf(a);
    if (!s || heal <= 0) return;
    const before = s.player.hp;
    mutate.playerHp(s.player.hp + heal, maxHp(s));
    if (s.player.hp > before) log('（伤势好转了一些。）', 'gain', s);
  });

  worldExecutor.registerHandler('add_item', (a) => {
    if (a.target && WB.items[a.target]) addItem(a.target, qtyOf(a));
  });

  worldExecutor.registerHandler('remove_item', (a) => {
    if (a.target && WB.items[a.target]) removeItem(a.target, qtyOf(a));
  });

  /* ---------------- §4.2 经济（NPC 侧金钱模型尚未建立，只做玩家侧） ---------------- */

  worldExecutor.registerHandler('add_money', (a) => {
    const n = amountOf(a);
    if (n > 0) gainGold(n);
  });

  worldExecutor.registerHandler('remove_money', (a) => {
    const n = amountOf(a);
    if (n > 0) gainGold(-n);
  });

  /* ---------------- §4.2 关系与声望 ---------------- */

  worldExecutor.registerHandler('change_reputation', (a) => {
    const s = core.S;
    const target = a.target;
    if (!s || !target || !(target in s.rep)) return;
    addRep(target, deltaOf(a));
  });

  worldExecutor.registerHandler('change_relationship', (a) => {
    const s = core.S;
    const npc = a.target;
    if (!s || !npc || !WB.npcs[npc]) return;
    adjAtt(npc, deltaOf(a), a.reason);
  });

  /* §15：NPC 目标落在 NpcDynamic.goal —— 推演与 NPC 系统之间唯一的写入口
     §44：溯源优先取 plan 级的 triggerEvent（权威），action 级只作补充 */
  worldExecutor.registerHandler('change_goal', (a, plan) => {
    const s = core.S;
    if (!s || !a.actor || !WB.npcs[a.actor]) return;
    npcDyn(a.actor, s).goal = {
      kind: String(paramsOf(a).goal ?? a.reason ?? 'unknown'),
      target: a.target ?? 'player',
      since: sceneTime(s).day,
      sourceEvent: a.triggerEvent ?? plan.triggerEvent,
    };
  });

  /* 授予称号：target = 受赏者（实体），称号 id 是规则表条目，走 params。
     与方案 §15 的示例同形（目标实体 + 动作参数分开），也避免把非实体塞进存在性校验。 */
  worldExecutor.registerHandler('grant_title', (a) => {
    const s = core.S;
    const tid = String(paramsOf(a).title ?? '');
    if (!s || !tid) return;
    if (!Array.isArray(s.titles)) s.titles = [];
    if (s.titles.includes(tid)) return; // 幂等：同一称号只记一次
    s.titles.push(tid);
    const def = titleById(tid) as { name?: string; desc?: string } | undefined;
    log('（世人开始这样称呼你：' + (def?.name ?? tid) + '）', 'gain', s);
  });

  /* ---------------- §4.2 关系网（二期复核后从 pending 提升为 effects） ----------------
     这四条的函数早就存在，缺的一直是「谁在什么时机驱动它」。提升之后，
     AI 推演可以提出「让某件事在关系网里传开」「某人记恨玩家」这类世界后果。 */

  /* 传闻扩散：target = 起点 NPC，params.topic = 话题文本，params.imp = 强度（1–3，默认 2） */
  worldExecutor.registerHandler('spread_rumor', (a) => {
    const s = core.S;
    if (!s || !a.target || !WB.npcs[a.target]) return;
    const p = paramsOf(a);
    const topic = String(p.topic ?? a.reason ?? '传闻');
    const imp = Math.max(1, Math.min(3, Math.round(Number(p.imp ?? 2))));
    spreadRumor(a.target, topic, imp, s);
  });

  /* 结仇：target = 被记恨的 NPC，params.severity = 1|2|3（默认 2） */
  worldExecutor.registerHandler('form_grudge', (a) => {
    const s = core.S;
    if (!s || !a.target || !WB.npcs[a.target]) return;
    const sev = Math.max(1, Math.min(3, Math.round(Number(paramsOf(a).severity ?? 2)))) as 1 | 2 | 3;
    setGrudge(a.target, a.reason ?? '某件事', sev);
  });

  /* 结好：target = NPC，params.delta = 好感增量（缺省 +10，单次夹取 ±20 防一次性拉满） */
  worldExecutor.registerHandler('befriend', (a) => {
    const s = core.S;
    if (!s || !a.target || !WB.npcs[a.target]) return;
    const d = Math.max(-20, Math.min(20, Math.round(Number(paramsOf(a).delta ?? 10))));
    if (d) adjAtt(a.target, d, a.reason);
  });

  /* 势力↔势力关系：两个势力都是实体，所以走 params { a, b, axis, dv } 而不是 target
     （与 §15「target 是受影响的实体、规则表条目走 params」同一条约定）。 */
  worldExecutor.registerHandler('change_faction_relation', (a) => {
    const s = core.S;
    if (!s) return;
    const p = paramsOf(a);
    const fa = String(p.a ?? '');
    const fb = String(p.b ?? '');
    const dv = Number(p.dv ?? 0);
    if (!(fa in s.rep) || !(fb in s.rep) || !dv) return;
    adjFactionRel(fa, fb, String(p.axis ?? '') as RepAxis, dv, s);
  });

  /* ---------------- §4.2 委托 ---------------- */

  worldExecutor.registerHandler('start_quest', (a) => {
    if (a.target && WB.quests[a.target]) giveQuest(a.target);
  });

  worldExecutor.registerHandler('complete_quest', (a) => {
    if (a.target && WB.quests[a.target]) turnIn(a.target);
  });

  /* 现有任务状态机只有 go / done / fin，没有「失败」档：
     这里只做世界侧记录，不擅自改 stage（UI 不认识的状态会让委托面板渲染异常）。 */
  const noteQuest = (a: ConsequenceAction, why: string) => {
    const s = core.S;
    if (!s || !a.target) return;
    const name = (WB.quests as Record<string, { name?: string } | undefined>)[a.target]?.name ?? a.target;
    log('（「' + name + '」' + why + '。）', 'sys', s);
  };
  worldExecutor.registerHandler('update_quest', (a) => noteQuest(a, '因时局生变而受阻'));
  worldExecutor.registerHandler('fail_quest', (a) => noteQuest(a, '已无从挽回'));

  /* ---------------- §4.2 法律 ---------------- */

  /* 立案：罪名与案发地是规则表条目与地点，走 params；target 仍是受影响的实体 */
  worldExecutor.registerHandler('commit_crime', (a) => {
    const cid = String(paramsOf(a).crime ?? '');
    const loc = String(paramsOf(a).location ?? '');
    if (cid) commitCrime(cid, loc || undefined);
  });

  /* ---------------- §4.2 跨实体转移（二期 H-06：NPC 侧字段接入后） ----------------

     转出方不足则**整条不落地**，不做部分转移——A 给 B 10 件而 A 只有 3 件时，
     世界不该出现「给了 3 件」这种没人提出过的结果。 */

  worldExecutor.registerHandler('transfer_item', (a) => {
    const s = core.S;
    if (!s) return;
    const p = paramsOf(a);
    const from = String(p.from ?? '');
    const to = String(p.to ?? '');
    const iid = String(p.item ?? a.target ?? '');
    if (!iid || !WB.items[iid] || !from || !to || from === to) return;
    if (from !== 'player' && !WB.npcs[from]) return;
    if (to !== 'player' && !WB.npcs[to]) return;
    const qty = qtyOf(a);
    /* 先查库存再动手：mutate.playerBag / npcBag 的「转出」在库存不足时**仍返回 true**
       ——它们沿用 Gains.removeItem 的既有语义（减到 <=0 就删行）。
       所以这里必须自己判足额，否则会把「转出 99 件而对方只有 3 件」
       执行成「凭空造出 99 件」。 */
    const have =
      from === 'player'
        ? (s.player.bag.find((x) => x.id === iid && !x.uid)?.qty ?? 0)
        : (mutate.npcEntry(from).bag?.find((x) => x.id === iid && !x.uid)?.qty ?? 0);
    if (have < qty) return;
    const taken = from === 'player' ? mutate.playerBag(iid, -qty) : mutate.npcBag(from, iid, -qty);
    if (!taken) return;
    if (to === 'player') mutate.playerBag(iid, qty);
    else mutate.npcBag(to, iid, qty);
  });

  worldExecutor.registerHandler('transfer_money', (a) => {
    const s = core.S;
    if (!s) return;
    const p = paramsOf(a);
    const from = String(p.from ?? '');
    const to = String(p.to ?? '');
    const amount = amountOf(a);
    if (!from || !to || from === to || amount <= 0) return;
    if (from !== 'player' && !WB.npcs[from]) return;
    if (to !== 'player' && !WB.npcs[to]) return;
    const have = from === 'player' ? s.player.gold : (mutate.npcEntry(from).gold ?? 0);
    if (have < amount) return;
    if (from === 'player') mutate.playerGold(-amount);
    else mutate.npcGold(from, -amount);
    if (to === 'player') mutate.playerGold(amount);
    else mutate.npcGold(to, amount);
  });

  /* ---------------- §4.2 状态效果（二期 H-05：数据模型就位后接入） ---------------- */

  /* 挂状态：owner 由 target 给出（player 或 NPC id），效果定义走 params
     （与「规则表条目走 params」同一条约定：target 只承载实体）。 */
  worldExecutor.registerHandler('add_status', (a) => {
    const s = core.S;
    if (!s || !a.target) return;
    if (a.target !== 'player' && !WB.npcs[a.target]) return;
    const p = paramsOf(a);
    const id = String(p.status ?? '');
    if (!id) return;
    mutate.addEffect(a.target, {
      id,
      left: typeof p.left === 'number' ? Math.max(0, Math.round(p.left)) : undefined,
      power: typeof p.power === 'number' ? p.power : undefined,
      source: a.triggerEvent,
    });
  });

  worldExecutor.registerHandler('remove_status', (a) => {
    const s = core.S;
    if (!s || !a.target) return;
    if (a.target !== 'player' && !WB.npcs[a.target]) return;
    const id = String(paramsOf(a).status ?? '');
    if (!id) return;
    mutate.removeEffect(a.target, id);
  });

  /* ---------------- §4.2 产品口径三条（二期 H-12：pending 清零） ----------------

     这三条此前一直挂在 pending 上，缺的是玩法口径而不是技术路径。
     口径定案如下，写进处理器旁边，避免以后有人再对着源码猜。 */

  /* 调价（change_price）——口径：**能推动价格的是品类指数，不是单件售价**。
     econ 表就是品类价格指数（large_trade 订阅也在改它），玩家侧看到的售价由
     priceOf 按指数换算。所以动词改的是指数：params.index（品类键）或
     params.item（物品 id，经 indexKeyOf 映射）+ params.delta。 */
  worldExecutor.registerHandler('change_price', (a) => {
    const s = core.S;
    if (!s) return;
    const p = paramsOf(a);
    const key = String(p.index ?? '') || indexKeyOf(String(p.item ?? ''));
    if (!key) return;
    const delta = Number(p.delta ?? 0);
    if (!delta) return;
    mutate.econ(key, (s.econ[key] ?? 1) + delta);
  });

  /* 藏称号（suppress_title）——口径：**抹掉的是世人眼里的称呼，不是玩家自己的履历**。
     现成函数 suppressTitle 已实现这个语义（titles 不动，只入 titleHidden，
     且带「已获得 + 未隐藏 + 付得起」三重门），这里只负责把它接到动词通道上。 */
  worldExecutor.registerHandler('suppress_title', (a) => {
    if (!core.S) return;
    const tid = String(paramsOf(a).title ?? '');
    if (tid) suppressTitle(tid);
  });

  /* 抹案宗（clear_crime）——口径：**能抹掉的是案宗，抹不掉的是记忆**。
     案件表里 subject 为玩家的在办案件直接撤档、通缉随之归零；
     感知表（谁知道你干过什么）**一字不动**——这正是 §8「世界真相 ≠ NPC 认知」的
     直接体现：案子可以撤，目击者仍然记得，NPC 对话与后续推演照样可能引用。
     刻意不从 cases 里留一个 'cleared' 状态：UI 只认 open/concluded/cold，
     留未知状态会让案件面板渲染异常（同 update_quest 不改 stage 的理由）。 */
  worldExecutor.registerHandler('clear_crime', (a) => {
    const s = core.S;
    if (!s || !Array.isArray(s.cases)) return;
    const subject = a.target ?? 'player';
    if (!s.cases.some((c) => c.subject === subject && c.status === 'open')) return;
    /* **要付得起**：与玩家通道的 payFine（300 × 通缉等级）同一条代价语义。
       零成本销案是审查指出的漏洞——后果计划通道不该比玩家手点便宜。 */
    const need = 300 * Math.max(0, Math.round(numberOr(s.player.wanted, 0)));
    const fine = Math.max(0, Math.round(numberOr(paramsOf(a).fine, 0)));
    if (fine < need || s.player.gold < fine) return;
    if (fine > 0) mutate.playerGold(-fine);
    s.cases = s.cases.filter((c) => !(c.subject === subject && c.status === 'open'));
    if (s.legal) s.legal.charges = [];
    /* 通缉跟着案宗一起撤：没有案子，也就没有缉拿文书 */
    mutate.playerSet('wanted', 0);
  });

  /* ---------------- §4.2 世界事件（§47 的 New Events 出口） ---------------- */

  const emitCustom = (a: ConsequenceAction): void => {
    const s = core.S;
    if (!s) return;
    const type = String(paramsOf(a).type ?? 'custom_event');
    worldBus.emit(
      makeEvent({
        type,
        day: sceneTime(s).day,
        tick: s.t,
        level: levelOf(type),
        actor: a.actor,
        target: a.target,
        location: s.player.loc,
        cause: a.reason,
        parentId: a.triggerEvent,
        origin: isReasonerOrigin() ? 'reasoner' : undefined,
      }),
    );
  };

  /* create_event 与 trigger_event 在当前模型下同义：都表示「立刻让世界发生这件事」；
     区别只在调用者的意图（前者新建、后者触发），事件结构完全一致。 */
  worldExecutor.registerHandler('create_event', emitCustom);
  worldExecutor.registerHandler('trigger_event', emitCustom);

  worldExecutor.registerHandler('schedule_event', (a) => {
    const s = core.S;
    if (!s) return;
    const type = String(paramsOf(a).type ?? 'custom_event');
    const delayDays = Math.max(1, Math.round(Number(paramsOf(a).delayDays ?? 1)));
    worldBus.schedule(
      makeEvent({
        type,
        day: sceneTime(s).day,
        tick: s.t,
        level: levelOf(type),
        actor: a.actor,
        target: a.target,
        location: s.player.loc,
        cause: a.reason,
        parentId: a.triggerEvent,
        /* 来源标记必须在**安排的那一刻**打上：这条事件隔日才发布，
           那时推演作用域早已结束，按深度判定就漏了。 */
        origin: isReasonerOrigin() ? 'reasoner' : undefined,
      }),
      delayDays,
    );
  });

  /* 装配自检（dev-time，fail fast）：装进来的每个处理器都必须在能力表里
     被声明为**可执行**。与 arch-infra 的守卫互补——守卫看静态同源，
     这里挡住「运行时装了处理器却没声明」的反向空洞。
     （两个方向都堵上，才叫同源；只堵一边时另一边的漏洞同样会让白名单失真。） */
  const orphans = worldExecutor.actions().filter((a) => !capabilities.executable(a));
  if (orphans.length) {
    const why = '后果处理器未标记为可执行能力：' + orphans.join('、');
    /* 开发期直接炸掉（装配顺序是隐式契约，越早发现越好）。
       生产期不能白屏、也不能只 console——装配发生在任何存档载入之前，
       core.S 必然是 null，写世界日志那条路走不通；toast 是此时唯一玩家可见的通道。 */
    if (import.meta.env?.DEV) throw new Error(why);
    bus.emit({ type: 'toast', text: '（装配自检：' + why + '）', cls: 'bad' });
  }
}
