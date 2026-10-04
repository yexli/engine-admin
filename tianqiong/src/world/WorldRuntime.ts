/* ============================================================
   GameCore 门面与命令分发（§42 核心铁律）：
   一切状态改写 = GameCommand → 规则校验 → WorldState 突变。
   UI / AI 都只能提交命令，不能直接摸 S。
   ============================================================ */
import { WB } from '@/data/worldBook';
import { runLog } from '@/devlog/RunLog';
import { bus, scheduler, toast, worldBus } from '@/events/EventBus';
import * as abyss from '@/systems/dungeon/Abyss';
import * as academy from '@/systems/academy/Academy';
import * as growth from '@/systems/academy/Growth';
import * as actions from '@/actions/ActionExecutor';
import * as bond from '@/systems/relationship/Bond';
import * as chat from '@/systems/npc/Chat';
import * as combat from '@/systems/combat/Combat';
import * as codex from '@/systems/codex/Codex';
import * as craft from '@/systems/inventory/Craft';
import * as deity from '@/systems/religion/Deity';
import * as dialogue from '@/systems/dialogue/Dialogue';
import * as dungeon from '@/systems/dungeon/Dungeon';
import * as monsters from '@/systems/dungeon/Monsters';
import * as commNet from '@/systems/commnet/CommNet';
import * as timeslip from '@/systems/timeslip/Timeslip';
import * as culture from '@/systems/culture/Culture';
import * as adventuring from '@/systems/adventuring/Adventuring';
import * as rites from '@/systems/rites/Rites';
import * as shop from '@/systems/economy/Shop';
import * as exchange from '@/systems/economy/Exchange';
import * as starNet from '@/systems/starnet/StarNet';
import * as title from '@/systems/reputation/Title';
import * as theoselect from '@/systems/religion/Theoselect';
import { giveQuest, turnIn } from '@/systems/quest/Quests';
import { freeActSmart, resetFreeInputState } from '@/actions/ActionParser';
import { payFine } from '@/systems/law/Law';
import { depart } from '@/systems/travel/Travel';
import { closeSheet, confirmSheet } from '@/systems/character/Sheet';
import { formatMoney } from '@/systems/economy/Money';
import { advance, CHEN_PER_DAY } from '@/world/WorldClock';
import { core, newState, save, sync, hydrate } from '@/world/WorldState';
import type { CharSpec } from '@/world/WorldState';
import { validateState } from '@/validation/RuleValidator';
import { addRep, gainGold, log } from '@/systems/character/Gains';
import { maxHp, maxMp } from '@/systems/character/Derived';
import { adjAtt } from '@/systems/npc/Npcs';
import { savePort } from '@/plugins/PluginInterface';
import type { GameCommand, OptPayload } from '@/types/uispec';
import type { DeityId, WorldState } from '@/types/world';
import { addHistory, cancelWorldLogPersist, restoreWorldLog, worldEventLog } from '@/events/EventStore';
import { clearEmbeddingCache } from '@/memory/embedding/EmbeddingCache';
import { migrateLegacyMemories } from '@/memory/LegacyMemory';
import { queueNarration, resetNarrationState } from './Narration';
import { checksRolled } from '@/dice/CheckResolver';

/* 卡 H5↔H6 集成点：百年神选神战终局的「候补神」晋升，交 H6 deity.ascendCandidate 收口。
   放在 core 组合根（engine）而非 theoselect 内部：H5 不硬依赖 H6，缺省时退化为只置 flag。 */
theoselect.setAscendHook((npcId) => deity.ascendCandidate(npcId));

/** 开始新游戏（原型 startNew） */
export function newGame(ch: CharSpec) {
  /* §29：新局不该查到旧局的因果链（start_investigation 就是靠 byId 取证的）·二期审查 I3 */
  worldEventLog.clear();
  /* 叙事衔接态同样是"上一局"的：不清的话新局第一段会收到「地点已经变了」的误导提示，
     归档检查点也会带着旧局的日期。 */
  resetNarrationState();
  /* 自由行动的会话焦点/在飞锁/编织水位也是上一局的运行态：cancelAll 掐掉的是
     在途的定时链，多步链尾的收口（开织窗/解 freeBusy 锁）再也不会跑了——
     不清的话新局里同一句输入会被「上一句还在解析」永远拒绝。 */
  resetFreeInputState();
  /* 换世界就把**在途的定时链**整批取消：多步自由行动（executeSteps）与检定收束回调
     都是上一局的排程，它们只认得「core.S 还在」，会把结果写进刚开的新档。
     实测复现（2026-09）：复合句「观察环境，然后调查四周」之后立刻开新档，
     2.6 秒后新档的见闻录里出现上一局的「〔意图解析〕调查」。
     resetWorld 早就这么做，换档/读档/导入档这三条路此前都没有。 */
  scheduler.cancelAll();
  /* 创角参数可能来自 UI 之外的通道（脚本 / 将来的 AI 创角）：世界书里没有的 race / cls
     会让 newState 在 WB.classes[cls].stats 上当场抛错，整个"开始新的旅程"按钮哑掉。
     这里统一回落默认值，不让一次脏输入毁掉开局。 */
  core.S = newState({ ...ch, race: WB.races[ch.race] ? ch.race : 'human', cls: WB.classes[ch.cls] ? ch.cls : 'warrior' });
  const s = core.S;
  s.player.hp = maxHp(s);
  s.player.mp = maxMp(s);
  log('三纪元 612 年，春。你随商队抵达圣辉城，在中央广场的喷泉边放下行囊。', 'nar', s);
  log('告示栏上贴着新告示，鸽子掠过圣钟塔尖顶。这座城市有自己的节奏——而你，只是初来乍到的一个。', 'nar', s);
  log('（提示：先「观察环境」认识广场，再与 NPC 交谈。手机端在下方标签页查看角色/任务/地图。）', 'sys', s);
  bus.emit({ type: 'screen', to: 'game' });
  save();
}

/** 读取存档（原型 continue 分支） */
export function continueSave(): boolean {
  const st = savePort()?.load() ?? null;
  if (!st) {
    toast('没有可用的存档', 'bad');
    return false;
  }
  scheduler.cancelAll(); // 同上：上一局在途的定时链不得写进读回来的世界
  core.S = hydrate(st);
  /* §29/§44（二期 H-10）：世界史随档恢复，重启后仍答得出「为什么发生这件事」 */
  restoreWorldLog(savePort()?.loadWorldLog?.() ?? []);
  /* 审计整改：认知层双真相来源的历史部分在这里收口——
     老表（NpcDynamic.mem）里的记忆一次性搬进新记忆表并清空老表。 */
  migrateLegacyMemories(core.S);
  bus.emit({ type: 'screen', to: 'game' });
  sync();
  return true;
}

/** 导入存档 JSON（原型 importSave） */
export function importState(json: string): boolean {
  try {
    /* F-02：先过结构校验再 hydrate——结构不全的档不得进入运行时（曾只判 player/ver） */
    const raw: unknown = JSON.parse(json);
    const why = validateState(raw);
    if (why) throw new Error(why);
    scheduler.cancelAll(); // 同上：导入的是一份新世界，旧排程不得续跑
    core.S = hydrate(raw as WorldState);
    restoreWorldLog(savePort()?.loadWorldLog?.() ?? []);
    migrateLegacyMemories(core.S);
    bus.emit({ type: 'screen', to: 'game' });
    toast('存档已导入', 'gain');
    save();
    sync();
    return true;
  } catch {
    toast('存档文件无效', 'bad');
    return false;
  }
}

/** 重置世界（原型 reset_ok） */
export function resetWorld() {
  resetNarrationState(); // 衔接态随世界一起清（见 newGame 的注释）
  resetFreeInputState(); // 在飞锁/会话焦点同理（见 newGame 的注释）
  core.S = null;
  core.CB = null;
  core.curShop = null;
  /* 向量索引跟着世界一起清：新档的记忆 id 从头重排，留着旧向量只会靠指纹碰运气 */
  clearEmbeddingCache();
  savePort()?.clear();
  /* 世界史跟着世界一起清（I3），并把节流旗标复位——
     否则 scheduler.cancelAll() 清掉定时后旗标永远停在 true，本会话内世界史不再落盘（C2）。 */
  worldEventLog.clear();
  cancelWorldLogPersist();
  worldBus.clearDeadLetters(); // 死信跨世界无界累积（审查 I11）
  scheduler.cancelAll();
  closeSheet();
  bus.emit({ type: 'combat', open: false });
  bus.emit({ type: 'screen', to: 'title' });
}

/* ---------------- 命令分发 ---------------- */

/** 命令载荷里的 id 必须是世界书里真实存在的条目：不存在的 NPC / 委托会在系统内部
    （persona / greet / 关系表 / reqTrust）以 TypeError 的形式炸出来，
    而玩家看到的只是"点了没反应"。守卫放在命令层这一处，UI、脚本、AI 三条来路都覆盖。 */
function npcOk(id: unknown): id is string {
  return typeof id === 'string' && !!WB.npcs[id];
}

export function dispatch(cmd: GameCommand) {
  /* 叙事编织的水位：出口要把**这一轮新写的见闻**交给 AI 织成小说，
     所以先在入口记下 logSeq；纯面板操作不写见闻，出口那一步会直接返回。 */
  const seq0 = core.S?.logSeq ?? 0;
  /* 掷骰计数必须在**命令执行前**取：check() 是同步写 s.checks 与计数的，
     出口再取就已经含本次了，编织会因此判成「没掷骰」而放弃等待窗口。 */
  const rolls0 = checksRolled();
  /* freeText 不在此开编织窗：它的回显行是同步写的，而真正的行动产出要等
     intentAsync（一次网络往返）之后才落。若出口照常 queue，窗口会罩着孤零零的
     「＞ 玩家原文」先发走——玩家输入被织成一段脑补正文，行动产出反而成了第二批
     （实机截图抓到过）。水位整体移交 freeActSmart：一次输入，一个窗，一批正文。 */
  let narrateHere = true;
  /* F-12：命令链的统一落点——任何分支改过状态都必须落盘并通知 UI，
     逐处补 sync 必漏，故在出口兜底（同步/落盘见 state.sync 的尾节流）。 */
  try {
    /* §31 World Tick：一条玩家命令 = 一个 tick；重置本 tick 的事件风暴配额 */
    worldBus.beginTick();
    switch (cmd.type) {
    case 'newGame':
      newGame({ name: cmd.name || '无名旅人', race: cmd.race, cls: cmd.cls, gender: cmd.gender });
      return;
    case 'continueSave':
      continueSave();
      return;
    case 'importState':
      importState(cmd.json);
      return;
    case 'resetWorld':
      resetWorld();
      return;
    case 'travel':
      actions.go(cmd.loc);
      return;
    case 'sceneAction':
      sceneAction(cmd.k);
      return;
    case 'wait':
      /* 原地等待 n 刻——自动流逝按刻提交这条命令。
         它存在、而不是让 UI 直接调 advance()，是因为 dispatch 的两个兜底：
         入口 worldBus.beginTick() 重置本 tick 的事件风暴配额（§31），
         出口 sync() 统一 emitChanged + 节流落盘（F-12）。
         绕开命令链直接推时钟，事件配额会跨 tick 累积，界面也不会刷新。 */
      advance(Math.max(1, Math.min(Math.floor(cmd.ticks) || 1, CHEN_PER_DAY)));
      return;
    case 'npcTalk':
      if (npcOk(cmd.id)) dialogue.openDlg(cmd.id);
      else toast('这里没有这个人', 'bad');
      return;
    case 'dialogChoice':
      dialogue.dlgAct(cmd.n, cmd.a, cmd.t);
      return;
    case 'dialogReq':
      if (npcOk(cmd.n)) dialogue.runReq(cmd.n, cmd.i);
      return;
    case 'shopBuy':
      shop.buy(cmd.id, cmd.p);
      return;
    case 'shopSell':
      shop.sell(cmd.id, cmd.uid);
      return;
    case 'combat':
      combatCommand(cmd.k, cmd.key, cmd.id);
      return;
    case 'freeText':
      /* F-01：玩家原文入库，净化统一在渲染出口（SceneView 的 rich）执行，
         避免此处先转义、出口再转义造成 &lt; 双重转义。 */
      log('＞ ' + cmd.text, 'say');
      narrateHere = false; // 编织责任移交 freeActSmart（见 narrateHere 的注释）
      void freeActSmart(cmd.text, seq0);
      return;
    case 'chatOpen':
      if (npcOk(cmd.id)) chat.openChat(cmd.id);
      return;
    case 'chatSend':
      chat.sendChat(cmd.id, cmd.text);
      return;
    case 'useItem':
      combat.useItem(cmd.id);
      return;
    case 'equipItem':
      combat.equipItem(cmd.id, cmd.uid);
      return;
    case 'ui':
      uiAction(cmd.a, cmd.p);
      return;
    }
  } catch (err) {
    /* 命令层不让异常裸奔到 UI：React 的事件处理器没有错误边界，异常只会留在控制台，
       玩家看到的是"点了没反应"。这里统一留痕 + 给一句可见提示，便于自查与反馈。 */
    const why = err instanceof Error ? err.message : String(err);
    runLog.error('exec', '命令执行失败：' + cmd.type, { why });
    toast('这一步没能完成：' + why, 'bad');
  } finally {
    sync();
    /* 本轮新写的见闻交给 AI 织成小说：规则原文先上屏，AI 回来后原地替换。
       没配模型 / 端口没实现 / 调用失败 —— 都保持规则原文（渐进增强）。 */
    /* 掷骰与否在这里算：入口的快照 vs 现在的计数。判断留在这一层，
       编织层就不必 import dice —— world → dice 会是条新的跨层边。 */
    if (narrateHere) queueNarration(seq0, checksRolled() > rolls0);
  }
}

/** 行动坞按钮（原型 data-a=act 的 data-k 分发） */
function sceneAction(k: string) {
  const s = core.S;
  switch (k) {
    case 'observe':
      actions.observe();
      break;
    case 'gather_intel':
      /* 卡 I4：打听消息（情报轴来源；城门/酒馆/集市可用，判定全在 actions.gatherIntel） */
      actions.gatherIntel();
      break;
    case 'search':
      actions.search();
      break;
    case 'rest_inn':
      actions.restAt('lodging');
      break;
    case 'drink':
      actions.drink();
      break;
    case 'shop_grocer':
      shop.openShop('grocer');
      break;
    case 'steal':
      actions.steal('');
      break;
    case 'pray':
      actions.pray();
      break;
    case 'heal_svc':
      actions.healSvc();
      break;
    case 'explore_wild':
      actions.exploreWild();
      break;
    case 'explore_cave':
      actions.exploreCave();
      break;
    case 'enter_dungeon':
      dungeon.enterDungeon();
      break;
    case 'theoselect_menu':
      theoselect.theoselectMenu();
      break;
    case 'academy_menu':
      academy.academyMenu();
      break;
    case 'deity_menu':
      deity.deityMenu();
      break;
    case 'gather':
      actions.gather();
      break;
    case 'craft':
      /* 卡 I2：当地工坊入口（站表数据驱动，见 data/world/craft.json） */
      craft.craftHere();
      break;
    case 'codex_open':
      /* 卡 I5：星枢藏书（行动坞入口） */
      codex.codexMenu();
      break;
    case 'starnet':
      starNet.openNet();
      break;
    case 'rest_wild':
      actions.restAt('camping');
      break;
    /* 卡 N1 · 星枢兑换所：网内所得在地面落成铜（一大陆一家） */
    case 'exchange_go':
      exchange.exchangeMenu();
      break;
    case 'payfine_go': {
      const c = 300 * (s?.player.wanted || 0);
      if ((s?.player.gold || 0) >= c)
        confirmSheet('缴纳罚金', '通缉等级 ' + (s?.player.wanted || 0) + '，赎罪金 ' + formatMoney(c) + '。', [
          { l: '缴清（' + formatMoney(c) + '）', a: 'payfine_ok' },
          { l: '再想想', a: 'close' },
        ]);
      else toast('钱不够（需 ' + formatMoney(c) + '）');
      break;
    }
  }
}

/** 战斗内动作 */
function combatCommand(k: 'atk' | 'skill' | 'item' | 'flee' | 'useitem', key?: string, id?: string) {
  if (k === 'atk') combat.playerAct('atk');
  else if (k === 'skill') combat.playerAct('skill', key);
  else if (k === 'item') combat.combatUseItemSheet();
  else if (k === 'flee') {
    closeSheet();
    combat.flee();
  } else if (k === 'useitem' && id) combat.combatUseItem(id);
}

/** 原型 data-a 事件委托兜底路由（保证 1:1 行为覆盖） */
/* 载荷类型直接取命令契约里的 OptPayload：再加字段时不必两处同步（此前是内联副本） */
function uiAction(a: string, p: OptPayload) {
  switch (a) {
    /* 卡 A1 · 成长线：四条路径菜单与自学入口（ui 命令在此分发，不在 dispatch 层） */
    case 'exchange_sell':
      closeSheet();
      exchange.sellStarcoin();
      break;
    case 'exchange_buy':
      closeSheet();
      exchange.buyStarcoin();
      break;
    case 'exchange_crystal':
      closeSheet();
      exchange.sellCrystal();
      break;
    case 'growth_menu':
      closeSheet();
      growth.growthMenu();
      break;
    case 'growth_self':
      closeSheet();
      growth.selfStudy();
      break;
    /* 卡 C2 · 七塔分置：一张表看清七塔在哪、此刻够不够得着 */
    case 'net_towers':
      closeSheet();
      starNet.towerPanel();
      break;
    /* 卡 F1 · 魔物图鉴：五类来源、六档等级、食物链（§46–§52） */
    case 'bestiary':
      closeSheet();
      monsters.bestiaryPanel();
      break;
    /* 卡 K3-UI · 四个系统的面板入口（此前只有 effects，玩家在界面上看不见） */
    case 'cm_menu':
      closeSheet();
      commNet.commMenu();
      break;
    /* 通讯·写信流程（BUG-001）：选目的地 → 写信浮层 → 确认后才扣费寄出 */
    case 'cm_compose':
      closeSheet();
      commNet.commCompose(String(p.id ?? ''));
      break;
    case 'cm_send_ok':
      closeSheet();
      commNet.commSend(String(p.id ?? ''), (p.t ?? '').trim().slice(0, 60) || '口信');
      break;
    case 'cm_send': // 直通寄出（旧路由，写信浮层确认走 cm_send_ok）
      closeSheet();
      commNet.commSend(String(p.id ?? ''));
      break;
    case 'cm_none': // 够不到的目的地（此前是无 case 的死按钮：点了毫无反应）
      toast('现在没有哪种手段够得到那里。', 'bad');
      break;
    case 'tl_menu':
      closeSheet();
      timeslip.timeslipMenu();
      break;
    case 'tl_enter':
      closeSheet();
      timeslip.timeslipEnter(String(p.id ?? 'fast'));
      break;
    case 'cu_menu':
      closeSheet();
      culture.cultureMenu();
      break;
    case 'cu_taboo':
      closeSheet();
      culture.violateTaboo(String(p.id ?? ''));
      break;
    case 'ad_menu':
      closeSheet();
      adventuring.adventuringMenu();
      break;
    case 'ad_claim':
      closeSheet();
      adventuring.claimToken(String(p.id ?? ''));
      break;
    /* 卡 L3 · §96 婚丧嫁娶 */
    case 'rt_menu':
      closeSheet();
      rites.ritesMenu();
      break;
    case 'rt_marry':
      closeSheet();
      rites.marry(String(p.id ?? ''));
      break;
    case 'go':
      closeSheet();
      actions.go(p.loc!);
      break;
    case 'npc':
      if (npcOk(p.id)) dialogue.openDlg(p.id);
      else toast('这里没有这个人', 'bad');
      break;
    case 'act':
      sceneAction(p.k!);
      break;
    case 'buy':
      shop.buy(p.id!, p.p || 0);
      break;
    case 'sell':
      shop.sell(p.id!, p.uid);
      break;
    case 'use':
      combat.useItem(p.id!);
      break;
    case 'equip':
      combat.equipItem(p.id!, p.uid);
      break;
    case 'payfine_ok':
      payFine();
      closeSheet();
      sync();
      break;
    case 'cbt_caravan':
      closeSheet();
      combat.startCombat(['bandit', 'bandit'], { caravan: true });
      break;
    case 'caravan_good':
      closeSheet();
      log('你把货箱原封不动地送回了东市。奥托看到货箱时，眼眶都红了。', 'nar');
      addRep('empire', 5);
      sync();
      break;
    case 'caravan_bad': {
      closeSheet();
      const s = core.S!;
      gainGold(1500);
      addRep('shadow', 10);
      addRep('empire', -8);
      adjAtt('otto', -25, '私吞货物');
      log('夜色里，你留下了三箱“辛苦费”。没有人看见——至少你是这么想的。', 'bad');
      addHistory('私吞商队货物', '暗影议会声望上升', 2);
      if (s.player.quests.q_caravan) s.player.quests.q_caravan.stage = 'fin';
      sync();
      break;
    }
    case 'q_give':
      /* 委托 id 也守卫：giveQuest 内部读 WB.quests[id].reqTrust，缺 id 就是一条 TypeError */
      if (typeof p.id === 'string' && WB.quests[p.id]) {
        giveQuest(p.id);
        sync();
      }
      break;
    case 'q_in':
      turnIn(p.id!);
      break;
    case 'reset':
      confirmSheet('重置世界', '当前世界的一切进程将被抹去（导出存档可留底）。', [
        { l: '确认重置', a: 'reset_ok', dg: true },
        { l: '取消', a: 'close' },
      ]);
      break;
    case 'reset_ok':
      closeSheet();
      resetWorld();
      break;
    /* —— 卡 C · 星枢网内动作（ConfirmSheet 按钮经 ui 路由）—— */
    case 'sn_enter':
      starNet.enterNet();
      break;
    case 'sn_exit':
      starNet.exitNet();
      break;
    case 'sn_duel':
      starNet.duel();
      break;
    case 'sn_buy':
      starNet.marketBuy();
      break;
    case 'sn_exchange':
      starNet.exchangeCrystal();
      break;
    case 'sn_cashout':
      starNet.cashOut();
      break;
    case 'sn_consign':
      starNet.consignMenu();
      break;
    case 'sn_consign_item':
      starNet.consign(p.id!, p.uid);
      break;
    case 'sn_back':
      starNet.openNet();
      break;
    /* —— 卡 H1 · 七塔完全体（星海/星塔/星斗台/星殿）—— */
    case 'sn_insight':
      closeSheet();
      starNet.insightMenu();
      break;
    case 'sn_trial':
      closeSheet();
      starNet.trialMenu();
      break;
    case 'sn_trial_go':
      closeSheet();
      starNet.trialClimb();
      break;
    case 'sn_arena':
      closeSheet();
      starNet.arenaMenu();
      break;
    case 'sn_arena_bet':
      closeSheet();
      starNet.arenaBet(Number(p.id) || 0);
      break;
    case 'sn_council':
      closeSheet();
      starNet.councilMenu();
      break;
    case 'sn_council_talk':
      closeSheet();
      starNet.councilTalk();
      break;
    case 'sn_decree':
      closeSheet();
      starNet.councilDecree();
      break;
    case 'sn_abyss_locked':
      closeSheet();
      starNet.abyssLocked();
      break;
    /* —— 卡 H2 · 星渊暗线 —— */
    case 'sn_abyss':
      closeSheet();
      abyss.abyssMenu();
      break;
    case 'abyss_menu':
      closeSheet();
      abyss.abyssMenu();
      break;
    case 'abyss_probe':
      closeSheet();
      abyss.probeAbyss();
      break;
    case 'abyss_seal':
      closeSheet();
      abyss.sealAbyss();
      break;
    case 'abyss_gate':
      closeSheet();
      dungeon.enterDungeon(); // 卡 C2：abyssMenu 已确认人在深井城，此处按所在地进入
      break;
    /* —— 卡 H6 · 培养学院 + 神明系统 —— */
    case 'ac_menu':
      closeSheet();
      academy.academyMenu();
      break;

    case 'ac_courses':
      closeSheet();
      academy.academyCoursesMenu();
      break;
    case 'ac_enroll':
      closeSheet();
      academy.enroll(p.id || '');
      break;
    case 'ac_study':
      closeSheet();
      academy.study(p.id);
      break;
    case 'ac_graduate':
      closeSheet();
      academy.graduate();
      break;
    case 'de_menu':
      closeSheet();
      deity.deityMenu();
      break;
    case 'de_show':
      closeSheet();
      deity.deityDetail((p.id || 'war') as DeityId);
      break;
    case 'de_pray':
      closeSheet();
      deity.pray((p.id || 'war') as DeityId);
      break;
    case 'de_intervene':
      closeSheet();
      deity.divineIntervene((p.id || 'war') as DeityId);
      break;
    /* —— 卡 H5 · 百年神选 —— */
    case 'theoselect_menu':
      closeSheet();
      theoselect.theoselectMenu();
      break;
    case 'ts_enroll':
      closeSheet();
      theoselect.enroll(p.id || 'war');
      break;
    case 'ts_spectate':
      closeSheet();
      theoselect.spectate();
      break;
    /* —— 卡 H4 · 地下城 100 层 —— */
    case 'dungeon_menu':
      closeSheet();
      dungeon.dungeonMenu();
      break;
    case 'dungeon_enter':
      closeSheet();
      dungeon.enterDungeon();
      break;
    case 'dungeon_next':
      closeSheet();
      dungeon.nextFloor();
      break;
    case 'dungeon_retreat':
      closeSheet();
      dungeon.retreat();
      break;
    case 'depart':
      if (p.id) depart(p.id);
      break;
    /* —— 卡 11 羁绊：赠礼选择器路由（confirmSheet 按钮 → giveGift）—— */
    case 'gift_give':
      closeSheet();
      if (p.n && p.id) bond.giveGift(p.n, p.id);
      break;
    /* —— 卡 I2 · 技艺工坊（craft_menu / craft_do / craft_back 照 H4–H6 既有模式）—— */
    case 'craft_menu':
      closeSheet();
      craft.craftMenu(p.id || '');
      break;
    case 'craft_do':
      closeSheet();
      craft.craft(p.id || '');
      break;
    case 'craft_back':
      closeSheet();
      break;
    /* —— 卡 I5 · 星枢藏书（图鉴）—— */
    case 'codex_open':
      closeSheet();
      codex.codexMenu(p.k || '');
      break;
    /* —— 卡 I6 · 称号：花钱隐藏负面称号（世界记得，只抹称呼）—— */
    case 'title_hide':
      if (p.id) title.suppressTitle(p.id);
      break;
    case 'close':
      closeSheet();
      break;
    /* —— 双页（星穹剧场）：此刻 ⇄ 深谈。纯渲染状态，不碰 WorldState —— */
    case 'dlgPage':
      dialogue.setDlgPage(p.page === 'timeline' ? 'timeline' : 'now');
      break;
  }
}

/** 引擎版本（存档兼容校验预留） */
export const ENGINE_VERSION = 1;
