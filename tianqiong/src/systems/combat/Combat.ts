/* ============================================================
   战斗引擎（原型 §25：数值全由规则判定，叙事只做包装）
   CB 由 core 持有；React 只按 combatChanged 事件重绘。
   ============================================================ */
import { WB } from '@/data/worldBook';
import { STARHUB } from '@/data/starhub';
import tablesRaw from '@/data/world/tables.json';
/* 卡 E1b：分支机制直读数据文件（与 affix/craft 等数据同惯例，不经 WB 聚合） */
const CLS_MECH = (tablesRaw as unknown as { classMechanics?: Record<string, unknown> }).classMechanics ?? {};
import { bus, rng, scheduler, toast, worldBus } from '@/events/EventBus';
import { levelOf, makeEvent } from '@/events/EventSchema';
import { AC, atkB, branchActive, mainStat, maxHp, maxMp, mod } from '@/systems/character/Derived';
import type { BagSlot, CombatFoe, ItemDef, SkillDef, StatusId, StatusInst, UseEffect } from '@/types/world';
import { check } from '@/dice/CheckResolver';
import { addItem, gainExp, gainGold, itemCount, log, removeItem } from '@/systems/character/Gains';
import { battleInsight } from '@/systems/character/Learn';
import { settleAxes } from '@/systems/faction/Diplomacy';
import { addInstance, critRate, instName, removeInstance, wornMods } from '@/systems/inventory/Equip';
import { applyStatus, cureStatus, decayStatus, dotOf, elemMult, hasSkip, negativeStatusIds, statusDef, statusName, stMod } from '@/systems/character/Status';
import { closeSheet, confirmSheet } from '@/systems/character/Sheet';
import { core, need, save, sync } from '@/world/WorldState';
import { mutate } from '@/world/WorldMutate';
import { formatMoney } from '@/systems/economy/Money';
import { advance, CHEN_PER_DAY, sceneTime } from '@/world/WorldClock';
import { addHistory } from '@/events/EventStore';
import { runLog } from '@/devlog/RunLog';

/** 开启战斗（原型 startCombat） */
/**
 * 起手一场战斗。
 *
 * 卡 C1 · 定神契约：入网期间**本体打不了架**，但网内比斗（`ctx.net === true`）不受此限——
 * 它本来就是意识投影之间的切磋（§10「比斗无伤」）。
 * 这条边界由调用方以 ctx.net 表达，而不是让 Combat 反向 import 星枢网（那会形成持久的循环依赖）；
 * 现实动作的门禁统一走 StarNet.onlineGate。
 */
/**
 * 卡 E1b · 本场战斗的英灵来源（§34 英灵召唤 60/30/10）。
 * 它是一条**叙事事实**而不是数值：开战时掷一次定下来，终结时按它给一句不同的收尾。
 * 之所以不留成"只写不读"的模块级变量：那种值既是死代码，又会让人误以为它影响判定。
 */
let summonSource: string | null = null;
export const currentSummonSource = (): string | null => summonSource;

export function startCombat(ids: string[], ctx?: { boss?: boolean; caravan?: boolean; net?: boolean; dungeon?: boolean }) {
  /* 卡 E1b · 英灵来源（§34 英灵召唤 60/30/10）：
     开战时按权重记一笔"这一战的灵从哪来"。纯叙事——来源不改数值，
     但让"英灵殿之主"这条线有可读的质感（而不是一个只有名字的终极）。 */
  const sr = (CLS_MECH as unknown as { summonRatio?: { ancient: number; hero: number } }).summonRatio ?? {
    ancient: 0.6,
    hero: 0.3,
  };
  /* 掷点在 core.CB 建立前完成（cbLog 依赖 CB 已存在，故只算不记）。
     注意：掷点**无条件执行**——若按分支跳过，同一种子下走召唤线会让整条随机流位移，
     战斗结果随之改变。分支只决定这句话讲不讲，不决定骰子掷不掷。 */
  const _r01 = rng.next();
  summonSource = branchActive('sm_hero')
    ? _r01 < sr.ancient
      ? '古代英灵'
      : _r01 < sr.ancient + sr.hero
        ? '传说英灵'
        : '自身投影'
    : null;

  core.CB = {
    foes: ids.map((id) => {
      const m = WB.monsters[id];
      return {
        mid: id,
        name: m.name,
        sv: m.sv,
        color: m.color,
        hp: m.hp,
        mhp: m.hp,
        ac: m.ac,
        atk: m.atk,
        dmg: m.dmg,
        undead: m.undead,
        poison: m.poison,
        boss: m.boss,
        dead: false,
      };
    }),
    round: 1,
    /* 卡 E1b · 阴影值从 0 起（§32）；每回合由 endPhase 累积，出手清零 */
    shadow: 0,
    ctx: ctx || {},
    cds: {},
    ward: 0,
    buff: 0,
    over: false,
    log: [],
    status: carryOverStatus(), // 卡 I3：战斗内状态（随 CB 丢弃，不落档）· 卡 N1：开战先接住身上的世界级状态
  };
  /* 立刻记一笔，既是叙事也让这个变量有读者（否则它只是个死值） */
  if (summonSource) cbLog('你唤出的灵光里，站着一位' + summonSource + '。', 'sys');
  if (ctx?.net) {
    const s = need();
    core.CB.netSnap = { hp: s.player.hp, mp: s.player.mp, gold: s.player.gold };
    cbLog('星演场 · 你凝出一具「星演幻影」为对手——网中比斗，真身无损。', 'sys');
  } else {
    cbLog('遭遇了 ' + core.CB.foes.map((e) => e.name).join('、') + '！', 'sys');
  }
  bus.emit({ type: 'combat', open: true });
  renderCbt();
  /* 战斗过程此刻起进运行日志：此前只写叙事（CB.log），面板上除界面开关什么都查不到——
     一次 60 回合的战斗打了几回合、挨了多少伤害，事后全无据可依。 */
  runLog.info('combat', '战斗开始', {
    foes: core.CB.foes.map((e) => e.name).join('、'),
    n: core.CB.foes.length,
    loc: core.S?.player.loc,
  });
}

/** 战斗日志的单调序号（只在本场战斗内有意义，不入档）。 */
let cbLogSeq = 0;

export function cbLog(text: string, cls: 'me' | 'foe' | 'sys', crit = false) {
  const CB = core.CB!;
  CB.log.push({ id: ++cbLogSeq, text, cls, crit });
  if (CB.log.length > 40) CB.log.shift();
}

/** 原型 renderCbt：UI 按 combatChanged 重绘 */
function renderCbt() {
  bus.emit({ type: 'combatChanged' });
}

/** 玩家行动（atk | 技能 key） */
export function playerAct(kind: 'atk' | 'skill', key?: string) {
  const s = need();
  const CB = core.CB;
  if (!CB || CB.over) return;
  const foes = CB.foes.filter((e) => !e.dead);
  if (!foes.length) return;
  const t = foes[0];
  const ti = CB.foes.indexOf(t);
  const m = wornMods(s); // 卡 I1：实例词缀聚合（无实例恒 0 → 战况与改动前一致）
  /* 卡 I3：眩晕（skip 类状态）本回合无法行动 */
  if (CB.status && hasSkip(CB.status)) {
    cbLog('你被震得眼前一白——这一回合没能动。', 'sys');
    endPhase();
    return;
  }
  if (kind === 'atk') {
    const roll = rng.d(20);
    const hit = roll + atkB();
    const acEff = t.ac + stMod(t.status, 'acMod'); // 卡 I3：破甲等状态降低目标防御
    cbLog('你挥出' + wpnLabel(s) + '……（命中 ' + hit + ' vs 防御 ' + acEff + '）', 'me');
    if (roll === 20 || (roll !== 1 && hit >= acEff)) {
      const dmgRange = s.player.equip.wpn ? WB.items[s.player.equip.wpn].dmg! : [1, 3];
      /* 卡 N1：神启等正面态的加算伤害（未挂状态恒 0，与改动前逐位一致） */
      let dmg = Math.max(1, rng.R(dmgRange[0], dmgRange[1]) + mod(mainStat()) + m.elem + stMod(CB.status, 'dmgMod'));
      const crit = roll === 20 || rng.chance(critRate(s)); // 自然 20 必暴，否则按暴击率（封顶 40%）
      if (crit) dmg = Math.max(1, Math.floor(dmg * 2));
      dealDmg(ti, dmg, crit ? '会心一击！' : '干净利落的一击！', crit);
      leechBack(dmg, m.leech);
    } else cbLog('……被' + t.name + '格开了。', 'sys');
  } else {
    const sk = WB.skills[key || ''];
    if (!sk) return;
    /* F-18：MP 与冷却的权威校验在 core——UI 的 dis 只是体验层，不可作为判定 */
    if (s.player.mp < sk.mp || (CB.cds[key!] || 0) > 0) return;
    mutate.playerMp(s.player.mp - sk.mp);
    CB.cds[key!] = sk.cd + 1;
    if (sk.kind === 'debuff') {
      /* 卡 I3：纯减益（无伤害）——一次 d20 判定，抵抗走状态免疫集 */
      const roll = rng.d(20);
      const hit = roll + atkB() + (sk.hit || 0);
      const acEff = t.ac + stMod(t.status, 'acMod');
      if (roll === 20 || (roll !== 1 && hit >= acEff)) applySkillStatus(sk, t);
      else cbLog('【' + sk.name + '】被' + t.name + '挣脱了。', 'sys');
    } else if (sk.heal && !t.undead) {
      mutate.playerHp(s.player.hp + sk.heal, maxHp());
      cbLog('你咏唱【' + sk.name + '】，伤口在暖光中愈合。（生命+' + sk.heal + '）', 'me');
      if (sk.cure && CB.status && CB.status.length) {
        const n = cureStatus(CB.status, sk.cure);
        if (n) cbLog('【' + sk.name + '】涤净了 ' + n + ' 处负面状态。', 'sys');
      }
    } else if (sk.ward) {
      CB.ward = sk.ward;
      cbLog('你张开【' + sk.name + '】，符文之力环绕周身。（防御+3）', 'me');
    } else if (sk.buff) {
      CB.buff = sk.buff;
      cbLog('你受到【' + sk.name + '】的加持。（攻击+2）', 'me');
    } else {
      const hits = sk.hits || 1;
      for (let h = 0; h < hits; h++) {
        const roll = rng.d(20);
        const hit = roll + atkB() + (sk.hit || 0);
        const acEff = t.ac + stMod(t.status, 'acMod');
        if (roll === 20 || (roll !== 1 && hit >= acEff)) {
          const wpn = s.player.equip.wpn;
          const dmgRange = wpn && WB.items[wpn].dmg ? WB.items[wpn].dmg : ([1, 3] as [number, number]);
          /* 卡 E1b · 阴影值（§32 暗杀路线）：每回合暗中累积，出手时按层数加权，出手即清零。
             这是「潜→击→再潜」的节奏在数值上的样子。 */
          const shMech = (CLS_MECH as unknown as { shadow?: { max: number; dmgPerStack: number } }).shadow ?? {
            max: 6,
            dmgPerStack: 0.12,
          };
          const shadowMul = (CB.shadow || 0) > 0 ? 1 + shMech.dmgPerStack * Math.min(CB.shadow || 0, shMech.max) : 1;
          let dmg = Math.max(
            1,
            Math.floor((rng.R(dmgRange[0], dmgRange[1]) * (sk.mult || 1) + mod(mainStat()) + m.elem + stMod(CB.status, 'dmgMod')) * shadowMul),
          );
          if ((CB.shadow || 0) > 0) {
            cbLog('阴影自你脚下散开——这一击比它看上去重得多（阴影值 ' + CB.shadow + '）。', 'me');
            CB.shadow = 0;
          }
          /* 卡 E1b · 时间守恒（§33 时空路线）：时间不会凭空产生——
             凡施加迟缓者，要从自己的刻度里扣。1 刻 = 15 分钟，量级小但**真实流逝**。 */
          const cons = (CLS_MECH as unknown as { conservation?: { selfCostPerSlow: number } }).conservation ?? {
            selfCostPerSlow: 1,
          };
          if (sk.status?.id === 'slow' && branchActive('fs_time')) {
            advance(cons.selfCostPerSlow);
            cbLog('你拉长了对手的一息，自己的表则走快了一格——时间守恒。', 'sys');
          }
          if (t.undead && key === 'holy_light') dmg += 6;
          /* 卡 I3：元素修正（亡灵的圣光/火焰差异走 tables.json.elemMod） */
          if (sk.elem) dmg = Math.max(1, Math.floor(dmg * elemMult(WB.monsters[t.mid], sk.elem)));
          const crit = roll === 20 || rng.chance(critRate(s));
          if (crit) dmg = Math.max(1, Math.floor(dmg * 2));
          dealDmg(ti, dmg, '【' + sk.name + '】正中' + t.name + '！', crit);
          leechBack(dmg, m.leech);
          if (sk.status) applySkillStatus(sk, t);
        } else cbLog('【' + sk.name + '】被' + t.name + '避开了。', 'sys');
      }
    }
  }
  endPhase();
}

/** 卡 I3：命中后判状态（一次 d20，不重复掷）；首领免疫集直接跳过并提示 */
function applySkillStatus(sk: SkillDef, t: CombatFoe) {
  const st = sk.status;
  if (!st) return;
  const ch = st.chance ?? 1;
  if (ch < 1 && !rng.chance(ch)) return;
  const arr = t.status || (t.status = []);
  /* 卡 E1b · 诅咒叠加（§35 辅助·诅咒）：四个 id 各占一档权重，命中时按档次微调强度。
     权重只用于**加权**——不掷新的随机流，避免把战斗的随机序列搅乱。 */
  const curse = (CLS_MECH as unknown as {
    curseStack?: { weights: Record<string, number>; maxStack: number };
  }).curseStack ?? { weights: {}, maxStack: 3 };
  let power = st.power;
  let dur = st.dur;
  if (sk.lineage === '辅助' && sk.kind === 'debuff' && branchActive('au_curse')) {
    const w = curse.weights[st.id] ?? 0;
    if (w >= 0.3) dur += 1; // 权重高的一档更持久
    if (w <= 0.1) power += 1; // 权重最低的一档以强度换稀有
  }
  const res = applyStatus(arr, st.id, dur, power, !!t.boss);
  if (res.ok) {
    const stack = arr.find((x) => x.id === st.id)?.stack || 1;
    cbLog(t.name + '陷入【' + statusName(st.id) + '】' + (res.stacked ? '（叠至 ' + stack + ' 层）' : '') + '。', 'me');
  } else cbLog('（' + t.name + '免疫【' + statusName(st.id) + '】）', 'sys');
}

function dealDmg(ti: number, dmg: number, text: string, crit = false) {
  const CB = core.CB!;
  const e = CB.foes[ti];
  e.hp -= dmg;
  cbLog(text + '（-' + dmg + '）', 'me', crit);
  /* §12 的 damage_applied 是 L0「不进总线」——但「不进总线」不等于「不该被观测」。
     debug 级单行载荷，面板按通道过滤即可。 */
  runLog.debug('combat', '伤害', { foe: e.name, dmg, crit, hp: Math.max(0, e.hp), round: CB.round });
  bus.emit({ type: 'foeHit', index: ti });
  if (e.hp <= 0) {
    e.dead = true;
    cbLog(e.name + ' 倒下了。', 'sys');
  }
  renderCbt();
}

/** 武器显示名（卡 I1：实例走【品质】专名，旧档走 base 名——与改动前逐字一致） */
function wpnLabel(s = need()): string {
  const id = s.player.equip.wpn;
  if (!id) return '拳头';
  const ins = s.player.equip.wpnIns;
  return ins ? instName({ id, ...ins }) : WB.items[id].name;
}

/** 饮血词缀：按造成伤害的比例回血（每击至少 1 点） */
function leechBack(dmg: number, leech: number) {
  if (leech <= 0) return;
  const s = need();
  const heal = Math.max(1, Math.floor(dmg * leech));
  mutate.playerHp(s.player.hp + heal, maxHp());
  cbLog('饮血：生命 +' + heal, 'me');
}

/** 战斗内使用道具（原型 cbtUseItem → 描述符浮层） */
export function combatUseItemSheet() {
  bus.emit({ type: 'sheet', desc: { kind: 'combatItems' } });
}

/** 卡 I3 · 状态（一）：DoT 结算——在敌方回合之前（顺序：DoT → 敌方读跳过/修正 → 回合末递减） */
function statusDot() {
  const s = need();
  const CB = core.CB;
  if (!CB) return;
  const pd = dotOf(CB.status || (CB.status = []));
  if (pd > 0) {
    mutate.playerHp(s.player.hp - pd);
    cbLog('伤口持续发作……（-' + pd + '）', 'foe');
  }
  for (const e of CB.foes) {
    if (e.dead) continue;
    const d = dotOf(e.status || (e.status = []));
    if (d > 0) {
      e.hp -= d;
      cbLog(e.name + '被持续伤害啃噬。（-' + d + '）', 'me');
      if (e.hp <= 0) {
        e.dead = true;
        cbLog(e.name + ' 倒下了。', 'sys');
      }
    }
  }
  renderCbt();
  if (s.player.hp <= 0) defeat();
}

/** 卡 I3 · 状态（二）：回合末递减——放在敌方行动之后，dur=1 的控制才会真正吃掉一个回合 */
function statusDecay() {
  const CB = core.CB;
  if (!CB || CB.over) return;
  const pe = decayStatus(CB.status || (CB.status = []));
  if (pe.length) cbLog('（' + pe.map(statusName).join('、') + ' 已消散）', 'sys');
  for (const e of CB.foes) {
    if (e.dead) continue;
    const ee = decayStatus(e.status || (e.status = []));
    if (ee.length) cbLog('（' + e.name + '的' + ee.map(statusName).join('、') + ' 已消散）', 'sys');
  }
}

/** 敌人回合 */
function enemyPhase() {
  const s = need();
  const CB = core.CB!;
  for (const e of CB.foes) {
    if (e.dead || s.player.hp <= 0) continue;
    /* 卡 I3：被眩晕/冻结控住的敌手跳过本回合 */
    if (hasSkip(e.status)) {
      cbLog(e.name + '僵在原地，动弹不得。', 'sys');
      continue;
    }
    const roll = rng.d(20);
    const hit = roll + e.atk + stMod(e.status, 'hitMod'); // 冻结/迟缓降低其命中
    if (roll === 20 || (roll !== 1 && hit >= AC())) {
      const dmg = Math.max(1, rng.R(e.dmg[0], e.dmg[1]));
      mutate.playerHp(s.player.hp - dmg);
      cbLog(e.name + '扑击命中！（-' + dmg + '）', 'foe');
      /* 卡 I1：荆棘词缀反噬（有实例才生效） */
      const th = wornMods(s).thorns;
      if (th > 0) {
        e.hp -= th;
        cbLog('护甲上的棘刺反噬了' + e.name + '。（-' + th + '）', 'me');
        if (e.hp <= 0) {
          e.dead = true;
          cbLog(e.name + ' 倒下了。', 'sys');
        }
      }
      if (e.poison && rng.chance(e.poison)) {
        mutate.playerHp(s.player.hp - 3);
        cbLog('毒素蔓延……（额外 -3）', 'foe');
      }
    } else cbLog(e.name + '的攻击被你躲开了。', 'sys');
  }
  renderCbt();
  if (s.player.hp <= 0) {
    defeat();
    return;
  }
  CB.round++;
  for (const k in CB.cds) if (CB.cds[k] > 0) CB.cds[k]--;
  if (CB.ward > 0) CB.ward--;
  if (CB.buff > 0) CB.buff--;
}

/**
 * 卡 E1b · 阴影值累积（§32 暗杀路线）：每回合 +gainPerRound，封顶 max，出手即清零。
 * 非暗杀线（branchActive 为假）直接返回——数值分毫不动，是本条机制"专属"二字的落点。
 */
function accumulateShadow() {
  const CB = core.CB;
  if (!CB || CB.over || !branchActive('ph_assassin')) return;
  const m = (CLS_MECH as unknown as { shadow?: { max: number; gainPerRound: number } }).shadow ?? { max: 5, gainPerRound: 1 };
  CB.shadow = Math.min(m.max, (CB.shadow || 0) + m.gainPerRound);
}

/** 玩家回合结束 → 延迟结算敌方（原型 endPhase：520ms 演出节奏） */
function endPhase() {
  scheduler.after(520, () => {
    const CB = core.CB;
    if (!CB || CB.over) return;
    if (CB.foes.every((e) => e.dead)) {
      victory();
      return;
    }
    /* 卡 I3：状态结算顺序 = DoT →（敌方回合内读跳过/命中修正）→ 回合末递减（方案 §I3 改动 5） */
    statusDot();
    const CBs = core.CB;
    if (!CBs || CBs.over) return;
    if (CBs.foes.every((e) => e.dead)) {
      victory();
      return;
    }
    /* 卡 E1b · 阴影值累积累在回合末（§32）：只有走在暗杀线上的人，才在"潜行"里存下势。
       非暗杀线恒为 0，因此下面所有按 CB.shadow 加权的伤害对他们是逐位不变的。 */
    accumulateShadow();
    enemyPhase();
    const CB2 = core.CB;
    if (!CB2 || CB2.over) return;
    statusDecay();
    if (CB2.foes.every((e) => e.dead)) victory();
  });
}

function victory() {
  runLog.info('combat', '战斗胜利', { foes: core.CB?.foes.map((e) => e.name).join('、'), round: core.CB?.round });
  const s = need();
  const CB = core.CB!;
  CB.over = true;
  if (CB.ctx.net) {
    const snap = CB.netSnap;
    if (snap) {
      mutate.playerHp(snap.hp);
      mutate.playerMp(snap.mp);
      mutate.playerGold(snap.gold - s.player.gold);
    }
    if (s.net) {
      s.net.duels.won++;
      s.net.starcrystal += STARHUB.duel.winStarcrystal;
    }
    cbLog('投影技压幻影，星演场喝彩四起——赢得 ' + STARHUB.duel.winStarcrystal + ' 星晶，真身无恙。', 'sys');
    renderCbt();
    scheduler.after(1300, () => {
      bus.emit({ type: 'combat', open: false });
      core.CB = null;
      log('（星演场取胜：+' + STARHUB.duel.winStarcrystal + ' 星晶。可于星市熔炼换星币。）', 'ai');
      save();
      sync();
    });
    return;
  }
  const loot: string[] = [];
  for (const e of CB.foes) {
    const m = WB.monsters[e.mid];
    gainExp(m.xp);
    s.killed[e.mid] = (s.killed[e.mid] || 0) + 1;
    /* §22/§34：被击败的威胁是**已经发生的事实**。目击名单留空——
       由感知层（events/Perception）按在场 NPC 与事件显眼度判定谁看见了。
       §21：委托进度改由 quest 系统订阅本事件推进，本模块不再直接调用任务系统。 */
    worldBus.emit(
      makeEvent({
        type: 'character_died',
        day: sceneTime(s).day,
        tick: s.t,
        actor: 'player',
        target: e.mid,
        location: s.player.loc,
        cause: 'combat',
        data: { monster: e.mid, name: WB.monsters[e.mid]?.name },
      }),
    );
    for (const lp of m.loot || [])
      if (rng.chance(lp[1])) {
        addItem(lp[0]);
        loot.push(WB.items[lp[0]].name);
      }
    if (rng.chance(0.5)) gainGold(rng.R(10, 40));
  }
  /* 卡 I4↔I3 集成点：击杀当场结算军功/情报轴（此前只能靠场景行动惰性结算） */
  settleAxes(s);
  /* 卡 R3 · 实战领悟（世界书 §44「突破方式」）：真刀真枪才算数——网内比斗是意识投影，
     按 §10「网内练的是招式与见闻，练不出心性」不触发领悟，故 net 域战斗跳过。 */
  if (!CB.ctx.net) {
    const got = battleInsight(s);
    /* cbLog 只接受 sys/me/foe 三档（战斗通道），授技通知由 grantSkill 自己发 */
    if (got) cbLog('电光火石之间，你忽然懂了——「' + WB.skills[got].name + '」的关窍在此。', 'sys');
  }
  cbLog('战斗胜利！' + (loot.length ? '缴获：' + loot.join('、') : ''), 'sys');
  if (CB.ctx.boss) {
    s.qf.boss_dead = true;
    cbLog('祭坛上的鬼火熄灭了。尘埃之间，一块泛着微光的金属残片静静躺在残缺的六芒星纹中央。', 'sys');
    addHistory('讨伐尸鬼祭司', '浅层洞窟三层威胁清除', 3);
  }
  if (CB.ctx.caravan) {
    if (s.player.quests.q_caravan) s.player.quests.q_caravan.stage = 'done';
    cbLog('劫掠者被制服。成箱的药材就堆在营地中央。', 'sys');
    renderCbt();
    scheduler.after(900, () => {
      bus.emit({ type: 'combat', open: false });
      confirmSheet('成箱的药材', '完好无损地送还奥托，还是……留下几箱“辛苦费”？', [
        { l: '全部送还（义举）', a: 'caravan_good' },
        { l: '私吞一部分（暗影行事）', a: 'caravan_bad', dg: true },
      ]);
    });
    return;
  }
  renderCbt();
  scheduler.after(1300, () => {
    bus.emit({ type: 'combat', open: false });
    core.CB = null;
    save();
    sync();
  });
}

/** 败北：真实战斗＝濒死获救；网内比斗＝真身无损、仅出网禁 */
function defeat() {
  runLog.warn('combat', '战斗败北', { foes: core.CB?.foes.map((e) => e.name).join('、'), round: core.CB?.round, hp: core.S?.player.hp });
  const s = need();
  const CB = core.CB!;
  const isNet = CB.ctx.net;
  const snap = CB.netSnap;
  CB.over = true;
  bus.emit({ type: 'combat', open: false });
  core.CB = null;
  if (isNet) {
    if (snap) {
      mutate.playerHp(snap.hp);
      mutate.playerMp(snap.mp);
      mutate.playerGold(snap.gold - s.player.gold);
    }
    if (s.net) {
      s.net.duels.lost++;
      s.net.online = false;
      s.net.exitLockUntil = s.t + STARHUB.net_rules.exitLockDays * CHEN_PER_DAY;
    }
    log('投影被击散，斥出星网。' + STARHUB.net_rules.exitLockDays + ' 日禁入、神思昏沉——但你抬头，仍立在圣辉城，分毫无损。', 'ai');
    addHistory('星演场落败', '出网禁 ' + STARHUB.net_rules.exitLockDays + ' 日', 1);
    sync();
    return;
  }
  const lost = Math.floor(s.player.gold * 0.2);
  mutate.playerGold(-lost);
  mutate.playerHp(Math.ceil(maxHp() * 0.5));
  mutate.playerMp(Math.ceil(maxMp() * 0.5));
  advance(36);
  mutate.playerLoc('temple');
  log(
    '剧痛之后是黑暗。再睁眼时，你躺在神殿的病榻上——艾德里安救回了你，但治疗费花去了 ' + formatMoney(lost) + '。',
    'nar',
  );
  log('（濒死获救：这是规则世界的后果，而非终点。）', 'sys');
  addHistory('冒险濒死', '被神殿救治，损失' + formatMoney(lost), 2);
  sync();
}

/** 逃跑（原型 flee） */
export function flee() {
  check(
    '脱离战斗',
    '敏捷',
    13,
    (r) => {
      if (r.ok) {
        const CB = core.CB;
        if (CB) CB.over = true;
        runLog.info('combat', '脱离战斗', { round: CB?.round, loc: core.S?.player.loc });
        bus.emit({ type: 'combat', open: false });
        core.CB = null;
        log('你瞅准空隙拔腿就跑，身后的动静渐渐远去。', 'nar');
        save();
        sync();
      } else {
        cbLog('你转身就跑——却被拦住了去路！', 'sys');
        renderCbt();
        enemyPhase();
        const CB2 = core.CB;
        if (CB2 && !CB2.over && CB2.foes.every((e) => e.dead)) victory();
      }
    },
  );
}

/**
 * 卡 N1 · 把世界级状态带进战斗。
 *
 * 「吃了烤肉之后几个时辰里身上有坚壁」这句话必须在这一刻兑现，否则食物就只是叙事。
 * 两套时间轴各自独立：世界级状态按**刻**走，战斗内状态按**回合**走。进战斗时按状态表
 * 给标准时长；打完架世界级那条还在（刻数没走完的话），该剩多久剩多久。
 */
function carryOverStatus(): StatusInst[] {
  const s = need();
  const out: StatusInst[] = [];
  for (const e of s.player.effects ?? []) {
    if (!e.left) continue;
    const d = statusDef(e.id as StatusId);
    if (!d) continue; // 非战斗类标记不进战斗
    out.push({ id: e.id as StatusId, dur: Math.max(1, d.dur), power: e.power ?? 0, stack: 1 });
  }
  return out;
}

/** 卡 N1 · 效果归一化：eff 缺省时把 heal 折成单条 heal 效果。
    49 件既有数据无 eff 字段，走这里与改动前逐位一致——新增能力不要求旧数据迁移。 */
function effOf(it: ItemDef): UseEffect[] {
  if (it.eff && it.eff.length) return it.eff;
  return it.heal && it.heal > 0 ? [{ kind: 'heal', power: it.heal }] : [];
}

/**
 * 战斗中使用道具（原型 data-cact=useitem 分支）。
 *
 * 卡 N1：一件东西可以同时回血与上状态——效果全部由 ItemDef.eff 驱动，core 是唯一判定方。
 * 旧口径（只认 heal 一个字段）下，解毒剂写着「清除中毒」却只是加 8 点血；
 * 现在同一张表里写明它净化的到底是什么。
 */
export function combatUseItem(id: string) {
  const s = need();
  const CB = core.CB;
  const it = WB.items[id];
  /* core 权威校验（审查 §战斗用药）：UI 只提交 id，所以「是否真在战斗中」与「到底有没有这件药」
     都必须在这里判。原实现无条件回血——没有药也能凭空治疗；且非战斗状态下调用会走到
     cbLog 里对 null 的 core.CB 取属性。 */
  if (!CB) return;
  if (!it || itemCount(id, s) <= 0) {
    toast('行囊里没有这件东西。', 'bad');
    return;
  }
  const effs = effOf(it);
  if (!effs.length) {
    toast('这件东西在战斗里派不上用场。', 'bad');
    return;
  }
  const notes: string[] = [];
  for (const e of effs) {
    if (e.chance !== undefined && !rng.chance(e.chance)) {
      notes.push('药性没能走开');
      continue;
    }
    if (e.kind === 'heal') {
      const hp = Math.max(0, Math.floor(e.power || 0));
      mutate.playerHp(s.player.hp + hp, maxHp());
      notes.push('生命+' + hp);
    } else if (e.kind === 'cure') {
      /* 未指定 status = 净化全部负面态（数据判定，见 Status.negativeStatusIds） */
      const ids = e.status ? [e.status] : negativeStatusIds();
      const n = cureStatus(CB.status || (CB.status = []), ids);
      if (n) notes.push('涤净' + ids.map(statusName).join('/'));
    } else if (e.kind === 'dot') {
      const t = CB.foes.find((x) => !x.dead);
      if (!t || !e.status) continue;
      const res = applyStatus(t.status || (t.status = []), e.status, e.dur || 1, e.power || 0, !!t.boss);
      if (res.ok) notes.push(t.name + '陷入「' + statusName(e.status) + '」');
    } else if (e.kind === 'buff') {
      if (!e.status) continue;
      const res = applyStatus(CB.status || (CB.status = []), e.status, e.dur || 1, 0);
      if (res.ok) notes.push('获得「' + statusName(e.status) + '」');
    }
  }
  removeItem(id);
  cbLog('你使用了' + it.name + '。' + (notes.length ? '（' + notes.join('，') + '）' : ''), 'me');
  closeSheet();
  renderCbt();
}

/** 战斗外使用/装备（原型 data-a=use/equip） */
export function useItem(id: string) {
  const it = WB.items[id];
  if (!it) return;
  /* 卡 I5：文献残卷——研读即解锁，不走治疗分支。
     消耗与解锁**都不在这里**：本分支只广播「玩家读了一本书」这条事实，真正的落点在校验层
     （plugins/subscriptions 的 codex 订阅者 → Codex.readTome：那里挑未读条目、授技、扣一册）。
     别在这里补 removeItem——会扣两次；事件链是这条路径的既定形态（§21 不点对点依赖 codex）。 */
  if (it.codexCat) {
    {
      const st = core.S;
      if (st)
        worldBus.emit(
          makeEvent({
            type: 'lore_unlocked',
            day: sceneTime(st).day,
            tick: st.t,
            level: levelOf('lore_unlocked'),
            actor: 'player',
            data: { mode: 'read_tome', item: id },
          }),
        );
      sync();
    }
    return;
  }
  /* 卡 N1：战斗专属消耗品（战斗药剂/符箓）。战斗外的状态槽与探索类效果在批 2 落地，
     此处给明确指引而不是静默失败——「点了没反应」是最差的一种交互。 */
  if (it.combat) {
    toast('这件东西要在战斗里用。', 'bad');
    return;
  }
  const effs = effOf(it);
  if (!effs.length) return;
  const s = need();
  /* 同上：持有量由 core 判（此前没药也能吃，UI 的按钮只是体验层） */
  if (itemCount(id, s) <= 0) {
    toast('行囊里没有这件东西。', 'bad');
    return;
  }
  const notes: string[] = [];
  for (const e of effs) {
    if (e.kind === 'heal') {
      const n = Math.max(0, Math.floor(e.power || 0));
      mutate.playerHp(s.player.hp + n, maxHp());
      notes.push('生命+' + n);
    } else if (e.kind === 'mp') {
      const n = Math.max(0, Math.floor(e.power || 0));
      mutate.playerMp(s.player.mp + n, maxMp());
      notes.push('魔力+' + n);
    } else if (e.kind === 'buff' && e.status) {
      /* 卡 N1：战斗外的增益写进世界级状态、按刻计时——食物与饮品是 effects 槽的第一个消费者。
         它会在开战时被 carryOverStatus 接住，所以「吃一顿好的再下地」是真的有用。 */
      const ticks = Math.max(1, Math.floor(e.dur || 8));
      mutate.addEffect('player', { id: e.status, left: ticks, power: 0 });
      notes.push('获得「' + statusName(e.status) + '」（' + ticks + '刻）');
    } else if (e.kind === 'cure') {
      /* 战斗外的净化：从世界级状态里摘掉负面条目（数据判定，同战斗内口径） */
      const ids = e.status ? [e.status] : negativeStatusIds();
      let n = 0;
      for (const x of ids) if (mutate.removeEffect('player', x)) n++;
      if (n) notes.push('涤净' + ids.map(statusName).join('/'));
    }
  }
  removeItem(id);
  toast('使用 ' + it.name + (notes.length ? '（' + notes.join('，') + '）' : ''), 'gain');
  sync();
}

/** 装备（卡 I1：uid 存在时按实例精确取件，并记录实例增量 wpnIns/armIns）
    无 uid 时走原路径（找不到也从背包移除的老行为不变，保 1:1 原型语义）。 */
export function equipItem(id: string, uid?: string) {
  const s = need();
  const it = WB.items[id];
  if (!it) return;
  const slot = it.type === 'wpn' ? 'wpn' : 'arm';
  const insKey = it.type === 'wpn' ? 'wpnIns' : 'armIns';
  let taken: BagSlot | null = null;
  if (uid) {
    taken = removeInstance(uid, s);
    if (!taken) {
      toast('背包里没有这件装备。', 'bad');
      return;
    }
  } else removeItem(id);
  const old = s.player.equip[slot];
  const oldIns = s.player.equip[insKey];
  if (old) {
    /* 卸下：实例原样回包（不重掷），普通件走堆叠 */
    if (oldIns) addInstance({ id: old, qty: 1, uid: oldIns.uid, q: oldIns.q, af: [...oldIns.af] }, s);
    else addItem(old);
  }
  s.player.equip[slot] = id;
  s.player.equip[insKey] = taken ? { uid: taken.uid!, q: taken.q || 0, af: [...(taken.af || [])] } : undefined;
  toast('装备了 ' + (taken ? instName(taken) : it.name), 'gain');
  sync();
}
