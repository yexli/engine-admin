/* ============================================================
   系统能力登记（《插件化世界模拟架构方案》§20 / §21 / §45）
    —— 把已有系统登记为世界插件：声明「我能做什么」。

   分类原则（审计整改：能力表与执行器表必须同源，否则白名单会撒谎）：
     effects  —— 可被后果计划驱动的动作。**每一条都必须有 WorldExecutor 处理器**，
                 由 arch-infra.test.ts 的守卫用例双向钉死（effects ⇔ worldExecutor.actions()）。
     pending —— 待接入执行器。世界后果、接入路径明确，但今天还驱动不了。
                每条都注明了缺什么；接入步骤统一是：
                补数据模型（types/world.ts 里已留字段）→ handlers.ts 注册处理器 →
                把动作从 pending 移到 effects。守卫测试会盯着这个提升动作。
     internal —— 刻意不驱动。玩家操作（move / travel_to / buy_item / pray…）
                 与战斗裁定（attack / kill_character…）：AI 直接驱动它们等于替玩家做决定。
   ============================================================ */
import { plugins } from './PluginRegistry';
import type { ActionConstraint } from './PluginRegistry';

export interface SystemSpec {
  id: string;
  version: string;
  /** 可被后果计划驱动（§15/§17）：必然有执行器处理器 */
  effects: string[];
  /**
   * **待接入执行器**：世界后果，接入路径已经明确（现成的系统函数 + 缺的数据模型），
   * 但今天还不能驱动——Validator 与提示词都按不可执行对待。
   * 接入步骤：补数据模型 → 在 handlers.ts 注册处理器 → 把动作从这里移到 effects。
   * 守卫测试会盯着：一旦它有了处理器却没提升，测试会红。
   */
  pending?: string[];
  /** 玩家操作 / 内部工具：不进计划白名单（且将来也不进） */
  internal?: string[];
  /** 订阅的世界事件类型（§21：靠事件传播，不靠点对点调用） */
  subscribes?: string[];
  /**
   * internal 能力的**真实入口**（能力名 → WorldRuntime 路由名）。
   * 复核发现：此前 28 条 internal 里有 24 条在全仓零出现——它们是人工标签，
   * 面板显示的「我能做什么」无法回溯到任何可寻址入口。这里逐条登记真名，
   * 由 arch-infra 的用例断言「登记的入口必须真在路由里存在」。
   * 没有玩家侧入口的内部工具（日程驱动、记忆写入等）不列出，属如实留空。
   */
  entries?: Record<string, string[]>;
  /** 动作的时空约束（§16 / 二期 H-07）；缺省 = 不受约束 */
  constraints?: Record<string, ActionConstraint>;
}

/** 声明能力全集（effects + pending + internal）：面板与审计看到的「我能做什么」 */
export const capabilitiesOf = (s: SystemSpec): string[] => [...s.effects, ...(s.pending ?? []), ...(s.internal ?? [])];

export const SYSTEM_SPECS: SystemSpec[] = [
  {
    id: 'character',
    version: '1.0.0',
    /* add_status 的 left 由 daySettle 的日边界衰减（二期 I6）：以刻计、日扣 48、缺省永久。
       状态 id 不做白名单校验——世界级效果由接入方自定义语义（与 StatusEffect 的注释一致）。 */
    effects: ['gain_exp', 'heal_character', 'damage_character', 'add_status', 'remove_status'],
  },
  {
    id: 'npc',
    version: '1.0.0',
    effects: ['change_goal', 'change_relationship'],
    internal: ['talk', 'move', 'observe', 'remember'],
    entries: { talk: ['npcTalk'], observe: ['observe'] },
  },
  {
    id: 'combat',
    version: '1.0.0',
    effects: [],
    /* 战斗裁定生死：AI 只能「提出让某人受伤」，不能直接判定死亡（§9 骰子属规则层） */
    internal: ['start_combat', 'attack', 'calculate_damage', 'apply_damage', 'kill_character'],
    /* 战斗裁定全部经 GameCommand 的 combat 命令（k = atk / skill / item / flee / useitem） */
    entries: { start_combat: ['combat'], attack: ['combat'] },
  },
  {
    id: 'quest',
    version: '1.0.0',
    effects: ['start_quest', 'update_quest', 'complete_quest', 'fail_quest'],
    /* 卡 N1 的冒险宏观面并入本系统（2026-09 收敛）：它用认证阶序 D/C/B/A/S 与 roi 表
       对齐，与公会同源；领兑换物的触发点在 UI 公会柜台，故仍为 internal。 */
    internal: ['claim_token', 'roi_tiers', 'wealth_bands', 'industry_of', 'plan_advice'],
    entries: {},
  },
  {
    id: 'inventory',
    version: '1.0.0',
    effects: ['add_item', 'remove_item', 'transfer_item'],
    internal: ['craft_item'],
    entries: { craft_item: ['craft_do', 'craft_menu'] },
  },
  {
    id: 'economy',
    version: '1.0.0',
    effects: ['add_money', 'remove_money', 'transfer_money', 'change_price'],
    internal: ['buy_item', 'sell_item'],
    entries: { buy_item: ['shopBuy', 'buy'], sell_item: ['shopSell', 'sell'] },
  },
  {
    id: 'faction',
    version: '1.0.0',
    effects: ['change_reputation', 'start_investigation', 'change_faction_relation'],
    internal: ['gather_intel'],
    /* 情报轴：gather_intel 是真实路由入口（场景行动的「打听消息」）。
       军功轴（Diplomacy.ts 的 addMilitary）由观察 / 探索内嵌结算，确无独立命令入口，
       故不登记 entries——不为了凑表面覆盖率去登记不存在的路由名。 */
    entries: { gather_intel: ['gather_intel'] },
    /* 调停势力关系要有场合：在自己的势力核心地点才说得上话。 */
    constraints: { change_faction_relation: { locations: ['plaza', 'gate', 'guild', 'temple'] } },
  },
  {
    id: 'relationship',
    version: '1.0.0',
    effects: ['spread_rumor', 'form_grudge', 'befriend'],
    internal: ['chat_bond'],
    /* 羁绊（Bond.ts 的 bondOf / grudgeOf / intimacyUpOk）读取走查询；
       写入由赠礼（dialogue.give_gift → gift_give 路由）与聊天窗口（chatSend）驱动。 */
    entries: { chat_bond: ['chatSend'] },
    /* 传闻要有听众：在人多的场合才散得开（这条与现状一致——散布本来就在交谈中发生）。 */
    constraints: { spread_rumor: { locations: ['plaza', 'market', 'tavern', 'guild'] } },
  },
  {
    id: 'reputation',
    version: '1.0.0',
    effects: ['grant_title', 'suppress_title'],
    /* 曾试过给 grant_title 加 minLevel: 2，被现有用例当场打回：新局（Lv.1）本来就会授称号。
       时空约束只该把**已经存在的规则**显式化，不该凭空发明门槛——撤掉。 */
  },
  {
    id: 'law',
    version: '1.0.0',
    effects: ['commit_crime', 'clear_crime'],
    /* clear_crime 的口径见 handlers.ts：抹案宗、不抹记忆。 */
  },
  {
    id: 'travel',
    version: '1.0.0',
    /* 卡 N2 的通讯并入本系统（2026-09 收敛）：同属「距离」这件事——发讯要扣钱、要发事实，
       故进 effects；其余为查询。 */
    effects: ['send_message'],
    internal: ['travel_to', 'comm_ways', 'comm_limits', 'comm_reachable'],
    /* GameCommand 的 travel 与 uiAction 的 go 都落到 actions.go() */
    entries: { travel_to: ['travel', 'go'] },
  },
  {
    id: 'religion',
    version: '1.0.0',
    effects: [],
    internal: ['pray', 'divine_intervene'],
    entries: { pray: ['de_pray', 'pray'], divine_intervene: ['de_intervene'] },
  },
  {
    id: 'academy',
    version: '1.0.0',
    effects: [],
    /* 卡 I5 的文献图鉴并入本系统（2026-09 收敛）：两者同属「学习与知识」，
       解锁触发点也一致（观察 / 阅读 / 深谈）。能力名不变，只是换了归属系统。 */
    internal: ['academy_enroll', 'academy_study', 'unlock_lore'],
    entries: { academy_enroll: ['ac_enroll'], academy_study: ['ac_study'], unlock_lore: ['codex_open'] },
  },
  {
    id: 'dungeon',
    version: '1.0.0',
    effects: [],
    internal: ['enter_dungeon', 'descend'],
    entries: { enter_dungeon: ['dungeon_enter', 'enter_dungeon'], descend: ['dungeon_next'] },
  },
  {
    id: 'starnet',
    version: '1.0.0',
    effects: [],
    /* 星枢网原有 25 条交互入口只登记了 3 条（复核 §15 PARTIAL 的来源之一）。
       这里按功能分组补全，每条都能在 WorldRuntime 的路由里找到真名，
       由 arch-infra 的守卫用例盯着——登记了却不存在的入口会让测试变红。 */
    internal: ['star_trade', 'star_duel', 'chat_free', 'net_access', 'star_market', 'star_tower', 'star_arena', 'star_council'],
    entries: {
      star_trade: ['sn_buy', 'sn_exchange', 'sn_cashout'],
      star_duel: ['sn_duel'],
      chat_free: ['chatOpen', 'chatSend'],
      net_access: ['sn_enter', 'sn_exit', 'sn_back'],
      star_market: ['sn_consign', 'sn_consign_item'],
      star_tower: ['sn_insight', 'sn_trial', 'sn_trial_go'],
      star_arena: ['sn_arena', 'sn_arena_bet'],
      star_council: ['sn_council', 'sn_council_talk', 'sn_decree'],
    },
  },
  /* codex 已并入 academy（2026-09 收敛）。 */
  {
    id: 'dialogue',
    version: '1.0.0',
    effects: [],
    internal: ['open_dialogue', 'deliver_request', 'give_gift'],
    entries: { open_dialogue: ['npcTalk', 'npc'], deliver_request: ['dialogReq'], give_gift: ['gift_give'] },
  },
  /* naming 已降级为规则模块（零状态读写，不进登记表）：见《架构规范》§3.4。 */
  /* 世界自身作为行动者（§4.2 的事件三动词）：让外部脚本与 AI 也能把新事实注入总线，
     与各系统自己 emit 的事件走同一条通道（§47 的 New Events 出口）。 */
  /* ============================================================
     卡 N1–N4 · K3 新系统（按 §19 四要素登记：能力 / 可执行 / 入口 / 约束）
     —— 它们的共同点是「管的是环境而非玩家动作」：通讯管消息在途、时间流速管内外时钟、
     文化管禁忌判定、冒险经济管宏观产出。故 effects 少而 internal 多。
     2026-09 收敛：commnet → travel、culture → customs、adventuring → quest，
     只有 timeslip 保持独立（时间与寿数自成一体）。能力名未变，只换归属。
     ============================================================ */
  /* commnet 已并入 travel（2026-09 收敛）。 */
  {
    id: 'timeslip',
    version: '1.0.0',
    /* 入小世界练功是玩家动作；寿命与换算为查询 */
    effects: ['enter_timeslip'],
    internal: ['slip_types', 'lifespan_table', 'time_magic_rules', 'inner_days', 'outer_days'],
    entries: {},
  },
  {
    id: 'customs',
    version: '1.0.0',
    /* 卡 L3（礼制）+ 卡 N4（风俗）合并（2026-09 收敛）：同一个概念域——都按「所在地」
       判定、都没有自有状态域（只写配偶与 flag）。成婚与身后事不经后果计划
       （前者是 UI 面板动作、后者由 daySettle 驱动）；触犯禁忌是判定类动作，故进 effects。 */
    effects: ['violate_taboo'],
    internal: [
      'wedding_of', 'burial_of', 'inherit_rule_of', 'marriage_age', 'spouse_of', 'rites_note',
      'culture_here', 'taboos_of', 'attires', 'games', 'food_of',
    ],
    entries: {},
  },
  /* culture 已并入 customs（2026-09 收敛）。 */
  /* adventuring 已并入 quest（2026-09 收敛）。 */
  /* 端口型系统：世界自身作为行动者——让外部脚本与 AI 也能把新事实注入总线。
     它没有状态域（不是玩法系统），保留登记是因为这三个动作必须有人拥有，
     否则外部注入通道会随白名单一起消失。 */
  { id: 'world_facts', version: '1.0.0', effects: ['create_event', 'schedule_event', 'trigger_event'] },
];

/** 组合根调用一次：把全部已有系统登记进世界插件表 */
export function registerCoreSystems(): void {
  for (const s of SYSTEM_SPECS) {
    plugins.register({
      id: s.id,
      version: s.version,
      capabilities: capabilitiesOf(s),
      executable: s.effects,
      pending: s.pending,
      entries: s.entries,
      constraints: s.constraints,
      subscribes: s.subscribes,
    });
  }
}
