/* ============================================================
   核心领域类型（《开发技术栈.md》§2：数据结构是本项目的地基）
   零依赖层：只允许被 data / core / ai / repo / store / ui 引用，
   本身不引用任何其它层。
   ============================================================ */

export type StatName = '力量' | '体质' | '敏捷' | '智力' | '感知' | '魅力';
export type Weather = '晴' | '多云' | '雨' | '雾' | '雪';
/** 'meta' = 内部标记（意图解析结果这类），**不进叙事、不进 AI 上下文**。
    它曾经借用 'ai'，于是被 buildNarrativeContext 当成"已写好的正文"喂给模型——
    模型看到一堆"〔意图解析·LLM〕打听·米露"，自然会顺着编。 */
export type LogCls = 'nar' | 'say' | 'sys' | 'gain' | 'bad' | 'ai' | 'meta';
export type FactionId =
  | 'empire'
  /* 神殿拆五（2026-09 · NPC 规模化）：原「圣辉神殿」单条势力拆为五殿，
     各自有教义、属神与外交立场。归属关系见 factions.json.groups.pantheon。 */
  | 'temple_war'
  | 'temple_wisdom'
  | 'temple_life'
  | 'temple_death'
  | 'temple_chaos'
  | 'guild'
  | 'shadow'
  | 'study'
  | 'frost'
  | 'verdant'
  | 'sand'
  | 'blood'
  | 'deep';

/* ---------------- 世界书静态定义（内容权威 · 唯一事实源） ---------------- */

/** 卡 R2 · 通用境界一阶（世界书 §29 表格的一行） */
export interface RankDef {
  tier: number; // 1–6
  name: string; // 信徒 / 见习 / 正式 / 主教 / 圣徒 / 神阶
  feature: string; // 该阶特征（供 UI 与叙事引用）
}
export interface RankTierDef {
  id: string;
  name: string;
  feature: string;
}
/** 卡 R2 · 末两阶的细分与「等级→细分」映射（§29 圣阶·中/高/极、神官级/神将级/神王级） */
export interface RankTiers {
  5?: RankTierDef[];
  6?: RankTierDef[];
  /** 本作 level（1–6）→ 细分 id；数据化以免散在代码里 */
  levelMap: Record<string, string>;
}

export interface RaceDef {
  name: string;
  mods: Partial<Record<StatName, number>>;
  desc: string;
  /* —— 卡 E1：种族广度（地区分布 / 社会待遇 / 命名规律），均为可选内容字段，不进规则判定 —— */
  continent?: string; // 主要分布大陆
  social?: string; // 在圣辉城/帝国律下的社会待遇（供 NPC 态度与叙事引用）
  naming?: string; // 命名规律提示（供 naming 生成器/文案，不进逻辑）
  playable?: boolean; // 是否可选为玩家种族（缺省 true；龙/巨/魔等高阶族设 false 作世界观）

  /* —— 卡 R1：种族双轴（世界书 §26–§27）。全部为可选字段，缺省＝不受约束 —— */
  bind?: 'soft' | 'strong'; // 软绑定（倾向）/ 强绑定（专属）
  eff?: Record<string, number>; // 各职业系的经验效率倍率（键＝ClassDef.lineage，如「物理」）
  exclusive?: string[]; // 专属职业线（其他种族不可转职；创角与转职两处共用同一判据）
  homeland?: string; // 发源/聚居地（§27 用语；continent 是「常见所在地」，两者不同）
  affinityNote?: string; // 亲和说明（供 UI 与叙事直接引用，不进判定）
}
export interface ClassDef {
  name: string;
  main: StatName;
  stats: Partial<Record<StatName, number>>;
  gear: string[]; // [武器, 护甲]
  skill: string;
  desc: string;
  /* —— 卡 A：五系十九分支树（均为可选，向后兼容旧存档/旧用例）—— */
  lineage?: string; // 所属系：物理/法师/召唤/辅助/生产
  axis?: '灵魂' | '肉体'; // §28 力量双轴
  path?: string[]; // §29–43 境界称号链（长度=6，按 level-1 索引，末位带【终极】）
  skillPath?: string[]; // 按等级逐阶习得的技能 key（长度=6；越界或已学则跳过）
  locked?: boolean; // 阶段门：创角页隐藏，占位待后续开放
}
/* ---------------- 卡 I3 · 状态效果（数据在 tables.json.status） ---------------- */

export type StatusId =
  | 'burn'
  | 'bleed'
  | 'freeze'
  | 'stun'
  | 'slow'
  | 'vuln'
  /* —— 卡 N1：四种正面态（消耗品授予；战斗结束随 CB 一起丢弃，与负面态同命） —— */
  | 'fervor'
  | 'bastion'
  | 'swift'
  | 'oracle';
export interface StatusDef {
  name: string;
  dot?: boolean; // 每回合扣血
  power?: number; // 基础 DoT 强度
  hitMod?: number; // 命中修正（负=降）
  acMod?: number; // 防御修正（负=降）
  /* 卡 N1：加算伤害（神启）。为什么不做成暴击/倍率：暴击是 ×2 的乘法链，
     一个状态就能把上限顶穿；加算的每一层都是可预期的 2 点，balance 好钉。 */
  dmgMod?: number;
  skip?: boolean; // 跳过回合
  maxStack: number;
  dur: number;
  immuneBoss?: boolean; // 首领免疫（防被控死）
  elem?: string;
  desc: string;
}
/** 战斗内状态实例（只活在 CombatState/CombatFoe 上，战斗结束即清除，不落档） */
export interface StatusInst {
  id: StatusId;
  dur: number;
  power: number;
  stack: number;
}

export type SkillKind = 'atk' | 'def' | 'buff' | 'debuff' | 'heal';
export type ElemKind = '火' | '冰' | '雷' | '神圣' | '暗' | '物';
export interface SkillDef {
  /* —— 卡 R3：技能学习四通道（世界书 §44）；缺省视为只有 level —— */
  learn?: ('level' | 'mentor' | 'tome' | 'insight' | 'faith')[];
  mentorHint?: string;
  insightHint?: string;
  name: string;
  mp: number;
  cd: number;
  mult?: number;
  heal?: number;
  ward?: number;
  buff?: number;
  hit?: number;
  hits?: number;
  lv?: number; // 习得等级
  /* —— 卡 I3：五系 38 技能（全可选；缺省按旧四类效果分支走，行为与改动前一致） —— */
  kind?: SkillKind;
  status?: { id: StatusId; dur: number; power: number; chance?: number };
  elem?: ElemKind;
  cure?: StatusId[]; // 治疗类技能的净化集
  desc?: string;
  lineage?: string; // 物理 / 法师 / 召唤 / 辅助 / 生产 / 敏捷
}
export interface ItemDef {
  name: string;
  type: 'wpn' | 'arm' | 'use' | 'mat';
  atk?: number;
  def?: number;
  dmg?: [number, number];
  price: number; // 以「铜」为基数（§58）
  heal?: number;
  illegal?: boolean;
  desc: string;
  /* —— 卡 B：品质七档（§53/§54）与计价币种（§58/§59）—— */
  quality?: '普通' | '优秀' | '精良' | '稀有' | '传说' | '神话' | '神器';
  cur?: 'coin' | 'magic' | 'soul'; // 默认 coin；magic=魔晶、soul=灵魂结晶二级币
  /* —— 卡 11 羁绊：赠礼偏好标签（food/herb/trinket/relic/pelt/gem/rare…，NPC likes 对齐） —— */
  giftTag?: string;
  /* —— 卡 I1：装备实例化（tier 与地下城主题分层对齐；affixPool=词缀白名单；craftable=工坊可产出） —— */
  tier?: number; // 1–5（不设等级墙，靠 tier 与技艺自然分层）
  affixPool?: string[]; // 该 base 可抽词缀 id 白名单（缺省=全池按 kind/tier 过滤）
  stat?: Partial<Record<StatName, number>>; // 基础属性加成（并入 derived.stat）
  craftable?: boolean; // 是否可经技艺工坊产出（卡 I2）
  codexCat?: string; // 卡 I5：文献残卷类目（使用时解锁该类目下的一条藏书）
  /* —— 卡 N1：消耗品效果（仅 use 类读；缺省时沿用 heal 单效果路径，49 件既有数据零改动） —— */
  eff?: UseEffect[];
  /** 仅战斗内可用（战斗药剂/符箓）——战斗外点击给明确指引，不做静默失败 */
  combat?: boolean;
  /** 卡 N1：canon 挂载——世界书条目 id（服务阶段 K 的「玩法层消费」统计，规则层不读） */
  loreRefs?: string[];
  /**
   * 卡 N1 · 探索工具的应对标签（light / rope / breathe / ward / detect / blade / warm）。
   *
   * 语义是「带着它」而不是「用它」：持有即生效、不消耗、不进战斗面板。
   * 对应关系不写在这里——陷阱那一侧才是「什么能化解它」的事实源（见 DungeonTrap.tags）。
   */
  utility?: string[];
}

/**
 * 卡 N1 · 消耗品效果（数据形状；唯一规则落点在 Combat.combatUseItem）。
 *
 * 为什么是数组而不是四个平铺字段：一次使用可能带组合效果（「战吼膏」同时给锋锐与疾行），
 * 数组把「一件东西两个用」变成数据问题而不是代码分支问题。
 *
 * 为什么只有四种 kind：ward（一次性减伤）被坚壁状态完整覆盖——留一个实现上等同 buff 的
 * 第五种 kind，只会让后来者以为存在两条路径。伤害加值走 buff + 状态表的 dmgMod，此处不再开口子。
 */
export type UseEffectKind = 'heal' | 'mp' | 'cure' | 'dot' | 'buff';
export interface UseEffect {
  kind: UseEffectKind;
  /** 强度：heal 回血 / mp 回魔 / dot 每回合伤害；buff 与 cure 走状态表，忽略此字段 */
  power?: number;
  /** 状态 id：cure 的净化目标 / dot 施加的负面态 / buff 授予的正面态 */
  status?: StatusId;
  /**
   * 持续时间。战斗内按**回合**计（dot/buff）；战斗外按**刻**计（buff 写进 player.effects 的 left）。
   * 两种单位共用一个字段是刻意的：同一件「坚壁饮」在两条时间轴上走的是各自的节奏，
   * 而数值本身（3 回合 / 12 刻）在数据里一眼能对上。
   */
  dur?: number;
  /** 触发概率（缺省 1） */
  chance?: number;
}
export interface MonsterDef {
  name: string;
  sv: string; // 字符符印（缺图回退）
  color: string;
  hp: number;
  ac: number;
  atk: number;
  dmg: [number, number];
  poison?: number;
  undead?: boolean;
  xp: number;
  boss?: boolean;
  loot: [string, number][];
  /** 卡 F1 · §46 来源分类 id（ancient/native/fallen/invader/mutant）。
      地表野兽与网内投影缺省——世界书的五类专指地下城魔物，不硬塞。 */
  source?: string;
  /** 卡 F1 · §47 魔物等级档 id（beast/common/elite/areaBoss/floorLord/guardian） */
  tier?: string;
  /** 卡 F1 · §48–§51 世界书原文的等级区间（如「正式级～主教级」） */
  tierRange?: string;
}
export interface LocationDef {
  name: string;
  sv: string;
  color: string;
  area: string;
  danger: number;
  /**
   * 地点能力标签（地区规整）——「这个地点能做什么」的**唯一来源**。
   * 规整前这些判断散落在 ActionParser / ActionExecutor 里，写作
   * if (loc === 'tavern') / if (area === '圣辉城')；每加一个地区都要回来改分支，
   * 地区的机制因此不可复用。现在新增地点 / 地区 = 在 geo.json 标好 abilities，代码零改动。
   * 取值域与语义见 data/regions.ts 的 LOCATION_ABILITIES。
   */
  abilities?: string[];
  desc: string[];
  /* —— 卡 E2：七大陆地理骨架（大陆归属 + 是否待开拓），可选、不进规则 —— */
  continent?: string; // 所属大陆（用于地图分组）
  locked?: boolean; // 待开拓大陆枢纽：地图灰显、不可通行（E3 跨大陆交通后再解锁）
}
/** 卡 D1 · NPC 独立人生：一个时辰区间内的日程段（缺省回落 NpcDef.hours/loc 保旧用例） */
export interface NpcScheduleSeg {
  from: number; // 起始时辰序号（含，0–11）
  to: number; // 结束时辰序号（不含，可跨子夜：from>to 表示环绕）
  loc: string; // 该时段所在地点
  act?: string; // 该时段在做什么（供叙事/AI 引用，不进规则）
}
/**
 * 人物志正文（《天穹纪-人物》档案的叙事字段）。
 *
 * 为什么打包成一个对象而不是摊平成 NpcDef 顶层字段：这七项**一个都不参与判定**——
 * 它们供人物志面板渲染、供 AI 上下文取材，规则层从头到尾不读。摊平会让 NpcDef 的
 * 顶层混着「机制」与「散文」，后来者分不清改哪个会动到玩法。
 * 与 goal 的关系：goal 是「他现在要做什么」（AI 权衡要用），lore 是「他是谁」。
 */
export interface NpcLore {
  /** 检索关键词（档案的「关键词」行）——人物志与大世界检索共用 */
  keywords?: string[];
  /** 身份：一句话说清这个人在世界里的位置 */
  identity?: string;
  /** 外貌 */
  appearance?: string;
  /** 性格 */
  personality?: string;
  /** 能力（叙事性描述，不是技能表） */
  abilities?: string;
  /** 过往 */
  past?: string;
  /** 弱点与把柄——玩家可下手的钩子（仍是叙事，判定另写） */
  flaw?: string;
  /** 持有物（叙事性；真要进背包走 NpcDynamic.bag） */
  belongings?: string;
}

/**
 * 话题内容卡（P2 · 《NPC 立体化与深入对话方案》§4.2）。
 * npc.json 的 `topics[{l,tier}]` 是**索引**，本结构是**内容**——
 * 标签只是给玩家点的，说得出话的是这里的文本。
 *
 * 三层应答对应方案第 2 节的验收标准「能连着问 ≥3 层」：
 * 表层 say（第一次问）→ 内层 inner（再问一次）→ 深水区 core（问到第三次且过 gate）。
 * 层进由 core 的确定性规则决定（问过几次 + 好感门槛），不掷随机。
 */
export interface NpcTopicCard {
  /** 标签，与 npc.json 的 topics[].l 挂接 */
  l: string;
  tier?: 'safe' | 'warm' | 'deep';
  /** 表层应答：NPC 口吻的 1–2 句，无模型时直出 */
  say: string;
  /** 内层：问到第二次才说 */
  inner?: string;
  /** 深水区：问到第三次且过了 gate 才说 */
  core?: string;
  /** 他知道的事实要点（给 AI 的展开范围；规则路径不直出） */
  facts?: string[];
  /** 边界：谈到哪为止、怎么推、撒什么谎 */
  edge?: string;
  /** 追问钩子：玩家可以接着问什么（写成玩家口吻，直接当 chip 用） */
  next?: string[];
  /** 深水区门槛（未过则停在 inner） */
  gate?: { att?: number; intimacy?: number; quest?: string; flag?: string; item?: string };
  /** 说透之后的产出（P3 消费；本期只落 mem） */
  /* 说透之后的产出与代价（P3 消费）。代价由用户 2026-09-27 裁决为「带代价」：
     rumor = 他说漏的这半句会传出去；grudge = 他记住你逼问过这件事（结怨 sev 1）；
     两者都不填时仍有基线代价——逼问一次好感 -1（见 systems/npc/Chat.ts 的 settleDeep）。 */
  gain?: { mem?: string; loreId?: string; att?: number; rumor?: string; flag?: string; grudge?: boolean };
}

export interface NpcDef {
  name: string;
  title: string;
  race: string;
  /**
   * 卡 G3 · 性别。§96 的婚龄分男女两档，判定要用到它。
   * **世界书没给这个字段**——目前的值全部来自 people.json 文本里的第三人称代词或性别称谓
   * （莉塔的「老板娘」、雅拉·风吟的「她离开东方群岛时对大贤者立的誓」……），
   * 无代词可依的 7 人一律留空，婚龄按该大陆较宽的一档计。不猜。
   */
  gender?: 'male' | 'female';
  sv: string;
  color: string;
  /**
   * 世界重要度（《NPC 分级与 Context Budget 最终方案》§4）。
   * 只回答一个问题：**「如果完全不考虑玩家，这个人在世界本身有多重要？」**
   *
   * 0 背景 · 1 普通 · 2 区域/组织重要 · 3 阵营与世界结构核心 · 4 世界级（神祇、魔界领主、帝王）
   *
   * 它**只决定叙事投入的上限**，不决定当前投入——后者是动态的 LOD（见 systems/npc/Lod.ts）。
   * 两者刻意不合并成一个数字：一个是「值得多少笔墨」，一个是「此刻有多大关系」。
   */
  worldImportance: 0 | 1 | 2 | 3 | 4;
  hours: [number, number]; // 出没时段（时辰序号，取值域 0–12；有 schedule 时被短路，但仍须合法）
  loc: string;
  needFlag?: string;
  greet: { cold: string; neutral: string; warm: string };
  /* —— 卡 D1：多时段日程 + 目标/利益/底线（叙事字段，落 desc/lore，不进规则判定）—— */
  schedule?: NpcScheduleSeg[]; // 有则优先于 hours/loc，驱动自主行动
  goal?: string; // 人生目标（NPC 独立性来源）
  interest?: string; // 关切/利益
  bottomLine?: string; // 底线（触发拒绝/敌意）
  /* —— 卡 R6：NPC 独立性三字段（世界书 §118–§121）—— */
  voice?: string; // 说话习惯（§120 五要素之「说话习惯」）：语速/停顿/口头禅
  priority?: string[]; // 多目标冲突时的选择序（§120 五要素之「优先级」）
  refuseStyle?: 'direct' | 'stout' | 'smooth' | 'cold' | 'principled' | 'rational'; // §119 性格×拒绝方式六型
  /* —— 卡 D2：NPC↔NPC 关系种子（otherId → 边），hydrate 投影进 NpcDynamic.rels —— */
  rels?: Record<string, NpcRel>;
  /* —— 聊天窗口：势力归属（供关系门禁/立场摘要）与聊天话题种子
      （tier 缺省 safe 人人可聊；warm 需友好以上好感，解锁私密话题） —— */
  faction?: FactionId;
  topics?: { l: string; tier?: 'safe' | 'warm' }[];
  /* 话题内容卡（P2）不在这里：它们放在 <板块>/<id>/talk.json 懒加载，
     因为 npc.json 走 eager glob 打进主包（109 人已约 300KB），
     而话题卡只在开对话时用得到。见 src/data/talk.ts。 */
  /* —— 卡 11 羁绊系统：赠礼偏好（giftTag 列表）/ 亲密度升级门（per-NPC 可配）/
      回赠池（newDay 挂）；全部可选，新 NPC 缺省走 interest 推导（G14 零代码） —— */
  likes?: string[];
  dislikes?: string[];
  intimacyGate?: { quest?: string; flag?: string; gifts?: number; chats?: number; desc?: string };
  reciprocate?: string[];
  /* ---------------- 卡 2026-09 · NPC 规模化：档案人物接入所需 ----------------
     街头 NPC 与档案人物共用这一个 NpcDef——差别只在字段填得满不满，
     不为「大人物」另立一套类型。 */
  /** 《天穹纪-人物》档案编号（001–109）。手写 NPC 无此项。
      留着是为了溯源：数据可疑时能一对一回档案核。 */
  sourceNo?: string;
  /** 设定年龄（档案的「种族·年龄·性别」）。神祇／不可计者留空。
      **不是**运行时年龄——那个按 birthTick 算（见 Lifespan），此处是世界书设定值。 */
  age?: number;
  /** 境界原文（档案的「境界」）。完整保留注解，不截断。 */
  realm?: string;
  /** 境界档：1 信徒 · 2 见习 · 3 正式 · 4 主教 · 5 圣阶 · 6 神阶。
      由 realm 原文推导（见 scripts/gen-npcs-from-md.mjs）。**
      神格层面（主神级及以上）超出六级台阶表**，故留空——那不是「修行到的阶」，
      是神格本身，混进同一条轴上会让「圣阶·极」和「冥府之主」看起来只差一级。 */
  realmTier?: number;
  /** 人物志正文（见 NpcLore）。纯叙事，规则层不读。 */
  lore?: NpcLore;
}
export interface ShopDef {
  name: string;
  /**
   * 开设地点（地区规整）。**可选**——留空表示这是一家随人走的摊子：
   * 由 vendor 这位 NPC 的对话入口打开（铁匠铺、灰烬的货色都是这一类）。
   * 填了 loc 才是「这个地点上固定有的铺面」，场景行动的「买东西」意图按它查。
   * 规整前这一层关联根本不存在：market → grocer 是 ActionParser 里唯一的硬编码。
   */
  loc?: string;
  vendor: string | null;
  stock: string[];
  sell: number;
  herb?: boolean;
  illegal?: boolean;
  faction?: FactionId; // 卡 F：所属势力——通商/信任维度作用于其价格与准入
  allyStock?: { items: string[]; needFlag: string }; // 卡 F 下游：满足 flag（如 shadow_ally）才上架的独家货
}
export interface QuestReward {
  gold?: number;
  exp?: number;
  rep?: Record<string, number>;
  att?: Record<string, number>;
  items?: Record<string, number>;
  flag?: string;
}
export interface QuestDef {
  name: string;
  giver: string;
  type: 'kill' | 'flag' | 'item' | 'deliver' | 'event';
  target?: string;
  count?: number;
  minDay?: number;
  reqTrust?: { faction: FactionId; min: number }; // 卡 F：信任门槛——不足则该委托不向你开放
  reward: QuestReward;
  desc: string;
  hint: string;
}

/* ---------------- 卡 J5 · 大陆定义 ---------------- */

/**
 * 大陆解锁条件（三选一，数据驱动）。
 * 为什么把条件放进数据而不是写死在代码里：解锁条件会随内容迭代反复调整，
 * 而「哪块大陆因为什么开门」是设计问题，不是工程问题。
 */
export type ContinentUnlock =
  | { kind: 'open' }
  | { kind: 'reputation'; faction: string; min: number; hint?: string }
  | { kind: 'flag'; flag: string; hint?: string };

export interface ContinentDef {
  id: string;
  name: string;
  /** 枢纽地点：跨大陆远行从这里出发，也在这里回到本大陆 */
  hub: string;
  unlock: ContinentUnlock;
  climate: string;
  /** 主导势力（外交与事件可读） */
  faction?: string;
  dangerBase?: number;
  loreRef?: string;
  flavor?: string;
}

export interface WorldBook {
  months: string[];
  shichen: string[];
  periodOf: string[]; // 按小时索引的时段名
  races: Record<string, RaceDef>;
  classes: Record<string, ClassDef>;
  skills: Record<string, SkillDef>;
  items: Record<string, ItemDef>;
  monsters: Record<string, MonsterDef>;
  locations: Record<string, LocationDef>;
  travel: Record<string, Record<string, number>>;
  npcs: Record<string, NpcDef>;
  shops: Record<string, ShopDef>;
  quests: Record<string, QuestDef>;
  factions: Record<string, string>;
  /* 卡 R2：境界由「字符串数组」升级为结构化六阶（§29）+ 末两阶细分（§30） */
  ranks: RankDef[];
  rankTiers?: RankTiers;
  rankAlias?: Record<string, string[]>;
  weatherText: Record<string, string[]>;
  /** 卡 J5：大陆定义（含枚举顺序与解锁条件）—— UI 与引擎共用的唯一来源 */
  continents: { order: string[]; items: Record<string, ContinentDef> };
  /* 卡 S1 · 地标与六星险区（世界书 §73/§75） */
  landmarks?: { id: string; name: string; kind: 'natural' | 'artificial'; continent: string; area: string; note: string; danger: number }[];
  dangerZones?: { id: string; name: string; continent: string; stars: number; reason: string }[];
  /* —— 卡 I3：状态表与元素修正表（data 化；core/status.ts 只读） —— */
  status?: Record<string, StatusDef>;
  elemMod?: Record<string, Record<string, number>>;
}

/* ---------------- 运行时状态（WorldState · 唯一事实来源） ---------------- */

export interface BagSlot {
  id: string;
  qty: number;
  /* —— 卡 I1：装备实例（全可选；无 uid 者=普通品质复制品，仍可堆叠，旧档语义不变） —— */
  uid?: string; // 实例 id（e<base36 序号>），有则 qty 恒为 1
  q?: number; // 品质档索引 0–6（普通…神器）
  af?: string[]; // 词缀 id 列表（长度 = clamp(q-1,0,3)）
}
/** 卡 I1 · 已装备实例（id 由 equip.wpn/arm 承载，此处只带实例增量） */
export interface EquipInstance {
  uid: string;
  q: number;
  af: string[];
}
/**
 * 卡 D2 的老记忆条目形状。
 * **已退役**：现在只作为旧档的迁移载体存在（memory/LegacyMemory.ts 读它一次后清空），
 * 没有任何生产写入者。读取一律走 memory 的 memOf 投影。
 */
export interface NpcMemory {
  event: string;
  imp: number;
  day: number;
  tier?: 'short' | 'long' | 'rel' | 'event' | 'secret';
}
/** 卡 D2 · NPC 关系边（有向，type=关系类型，val=强度 -100..100） */
export interface NpcRel {
  type: string; // kin/friend/rival/mentor/debtor/ally/enemy/court...
  val: number; // 强度（正=亲近/信任，负=敌意）
}
/** 推演赋给 NPC 的目标（方案 §15 create_npc_goal 的落点；来源事件可追溯 §44） */
export interface NpcGoal {
  kind: string;
  target: string;
  /** 赋目标的世界日 */
  since: number;
  sourceEvent?: string;
}

/**
 * §4.2 状态效果（add_status / remove_status 的落点）。
 * **接入点**：目前玩家在非战斗期还没有状态槽——战斗内状态走 `core.CB.status`，
 * 出战斗即清空。要做「中毒三天」「祝福持续一日」这类世界级状态时，
 * 写进 `PlayerState.effects` / `NpcDynamic.effects`，再把两条能力接上处理器。
 * `left` 的**衰减执行者尚未预留**：按刻递减 / 到期移除需要接入方自己在
 * WorldClock 的 tick 里加一跳（战斗内的 `tickStatus` 只管 `CB.status`，两套互不相干）。
 */
export interface StatusEffect {
  id: string;
  /** 剩余时长（刻）；缺省 = 永久，直到被显式移除 */
  left?: number;
  /** 强度（与具体效果同义，由接入方定义） */
  power?: number;
  /** 来源（事件 id / 施术者），§44 可追溯 */
  source?: string;
}

export interface NpcDynamic {
  att: number;
  /** @deprecated 老记忆表：仅作旧档迁移载体，勿在新代码里读写（见 memory/LegacyMemory.ts） */
  mem: NpcMemory[];
  met: boolean;
  /* Phase 4.2：原 curLoc（自主行动 tick 物化的地点缓存）已撤——位置是 npcAt 的纯函数产物，
     物化只会多出一份会过期的第二真相。查询走 Npcs.npcCurLoc(id, s)。 */
  rels?: Record<string, NpcRel>; // 卡 D2：NPC↔NPC 横向关系（otherId → 边），hydrate 从世界书种子初始化
  chatDay?: { day: number; gain: number }; // 聊天窗口：该 NPC 好感日增益计数（日封顶 +2 防 farm）
  /* —— 卡 11 羁绊系统（全可选，hydrate 懒初始化，旧档可读）—— */
  intimacy?: number; // 亲密度 0-3（挚友/知己/结义）：好感满（≥80）+ gate 条件升级
  bondProg?: { gifts: number; chats: number; quests: number }; // 升级门计数
  grudge?: { since: number; why: string; sev: 1 | 2 | 3 }; // 仇怨状态：拒收礼/拒售/涨价；sev1/2 可衰减，sev3 长记忆
  giftDay?: { day: number; n: number; weekStart: number; week: number }; // 赠礼日/周封顶（≤2/日、≤6/周）
  giftKnown?: string[]; // 已发现的偏好标签（赠礼后人物志显式呈现）
  /* —— P3 深谈（《NPC 立体化与深入对话方案》§4.3）：进展必须落档 ——
     不能从 Chat 的对话窗口里数「问过几次」：窗口有 20 条封顶（CAP_TURNS），
     满窗之后最老的提问被丢掉，深水区会当场退回表层、追问链也会把问过的标签重新吐出来。 */
  talkProg?: Record<string, number>; // 标签 → 已问次数（单调；键数 ≤8，判据见 systems/npc/Talk.ts）
  talkDeep?: string[]; // 已谈透（进过深水区）的标签，≤8：图鉴解锁与「代价只付一次」的幂等依据
  goal?: NpcGoal; // 世界推演给出的行动目标（可选：旧档无此字段，UI 不感知）
  /* —— §4.2 NPC 侧物品与金钱（transfer_item / transfer_money 的落点）——
     已接入：处理器见 plugins/handlers.ts。字段保持可选——缺失即「这个存档里
     还没有这回事」，读取方自己兜 undefined（见《架构规范》§2.3）。 */
  bag?: BagSlot[];
  gold?: number;
  /** 状态效果：add_status / remove_status 的落点（见 StatusEffect 的说明） */
  effects?: StatusEffect[];
}
export interface QuestState {
  stage: string; // go | trail | confront | done | fin
  count?: number;
}
export interface PlayerState {
  name: string;
  race: string;
  cls: string;
  level: number;
  exp: number;
  stats: Record<StatName, number>;
  hp: number;
  mp: number;
  gold: number;
  loc: string;
  bag: BagSlot[];
  skills: string[];
  /* 卡 I1：wpn/arm 仍是权威 id（既有读取方零改动）；wpnIns/armIns 为可选实例增量 */
  equip: { wpn: string | null; arm: string | null; wpnIns?: EquipInstance; armIns?: EquipInstance };
  quests: Record<string, QuestState>;
  wanted: number;
  crimes: number;
  flags: Record<string, boolean>;
  /** 卡 R5 · 公会认证等级（D/C/B/A/S；缺省时由境界推算，旧档可直接读） */
  guildRank?: string;
  /** 卡 A1 · 四条成长线的状态（师徒/神殿/自学；学院制在 academy 域，不重复） */
  growth?: GrowthState;
  /** 卡 D4 · 转职记录（旧职业的已学技能名，供面板回溯「你曾是什么」） */
  transferLog?: string[];
  /* —— 卡 B：二级货币钱包（魔晶/灵魂结晶）；可选以兼容旧存档，载入时由 hydrate 补默认 —— */
  wallet?: { magicCrystal: number; soulCrystal: number };
  /**
   * §4.2 状态效果：add_status / remove_status 的落点。
   * 可选字段——旧档没有它，`hydrate` 也不会补：缺失即「这个存档里还没有状态这回事」。
   */
  effects?: StatusEffect[];
  /* ---------------- 卡 L1 · 寿命（§80） ---------------- */
  /**
   * 出生刻。年龄是**派生量**：age = (t - birthTick - netAgedTicks) / TICKS_PER_YEAR。
   * 存出生刻而不是存年龄，是因为年龄随每一次 advance 变化——
   * 存下来就得在每个推进点同步一遍，迟早漏一处。
   */
  birthTick?: number;
  /** 寿元加成（年）：百年神选座次奖赏等（§80「神阶 500 年以上，部分永生」也走这里） */
  lifeBonus?: number;
  /** 网中累计刻数（§10「网中历时不耗寿」）：这一段不计入年龄 */
  netAgedTicks?: number;
  /* ---------------- 卡 L3 · §96 婚丧嫁娶 ---------------- */
  /** 性别：§96 的婚龄分男女两档，判定按此取（缺省 male，旧档可读） */
  gender?: 'male' | 'female';
  /** 配偶（NPC id）。§96 的婚配是一生一次的事，故只存一个 */
  spouse?: string;
}
export interface LogEntry {
  t: string;
  text: string;
  cls: LogCls;
  /** 单调递增条目号（F-33：UI 用它作 key——用长度派生索引时，70 条封顶后 key 恒定，
      新条目会复用旧节点，入场动画从此不再播放）；旧档缺此字段时 UI 回落长度索引 */
  id?: number;
}
export interface HistoryEntry {
  d: string;
  c: string;
  r: string;
  imp: number;
}
export type CrimeGrade = 'S' | 'A' | 'B' | 'C' | 'D';
/** 卡 D5 · 法律状态：案底(罪名 id) + 刑期(总刻) —— 可选，hydrate 兜底 */
export interface LegalState {
  charges: string[]; // law.json.crimes 的 id 列表（可重犯）
  jailedUntil?: number; // 监禁释放刻（s.t < jailedUntil 视为在押）
  exiledTo?: string; // 流放地 location id
  executed?: boolean; // S 级灭世罪 → 处决标记
}
/** 卡 D3 · 势力外交 7 轴（§13 关系不是单维度数字 / §31 多重声望） */
export interface FactionRelation {
  attitude: number; // 总体态度
  trust: number; // 信任
  hostility: number; // 敌意
  trade: number; // 贸易往来
  military: number; // 军事态势
  religion: number; // 宗教/意识形态
  intelligence: number; // 情报渗透
}
export type RepAxis = keyof FactionRelation;
/** 玩家对某势力的多维声望：attitude 轴由旧 WorldState.rep[f] 承载（向后兼容），其余 6 轴存此 */
export type PlayerRep = Omit<FactionRelation, 'attitude'>;
export interface WorldEventInst {
  id: string;
  name: string;
  day: number;
}
/** 卡 C · 星枢网内状态（§9–13）：意识投影、网内币只进不出、败亡出网禁 */
export interface NetState {
  online: boolean;
  exitLockUntil?: number; // 出网禁：到此刻数前不可再入网
  starcoin: number; // 星币
  starcrystal: number; // 星晶
  consign: BagSlot[]; // 网内寄售（财物只进不出）
  duels: { won: number; lost: number }; // 网内比斗战绩（不涉真身）
  /* —— 卡 H1 · 七塔完全体（全可选，hydrate 补默认，旧档可读）—— */
  insights?: { mood: number; sessions: number }; // 星海·意境参悟：心境累积与会话数
  trialBest?: number; // 星塔·登塔试炼最佳层数（1–100，镜像地下城层数上限）
  arenaWins?: number; // 星斗台·公开竞技胜场（注彩结算）
  councilFavor?: Record<string, number>; // 星殿·议事：各势力观感（议事调停累积）
  /** 卡 L1 · 本次入网的时刻：出网时结算"网中历时不耗寿"（§10）的累计时长 */
  onlineSince?: number;
}
/* ---------------- 卡 H4–H6 长线状态（全可选 · hydrate 补默认 · ver 保持 1） ---------------- */

/** 卡 H4 · 地下城 100 层爬层状态 */
export interface DungeonState {
  floor: number; // 当前层（0 = 不在层中）
  best: number; // 历史抵达最深
  inRun: boolean; // 是否正在一次爬层中（撤退/阵亡即 false）
  entry?: string; // 本次入口（geo 地点 id）
  cleared?: number[]; // 已首通的层（BOSS 层与首通奖励去重用）
  escapes?: number; // 撤退次数（统计用）
  lastRetreatAt?: number; // 上次撤退刻（防同刻反复进出）
}
/** 卡 H5 · 百年神选候选人（NPC 候选，确定性打分） */
export interface TheoselectCandidate {
  npcId: string;
  temple: string;
  score: number;
}
/** 卡 H5 · 百年神选状态：海选 → 预选 → 正赛 → 神战 → 候补 */
export interface TheoselectState {
  enrolled: boolean;
  temple?: string; // 玩家报名神殿（temple id）
  stage: string; // 海选 | 预选 | 正赛 | 神战 | 候补 | idle
  score: number; // 玩家当前评分
  rank?: number; // 玩家座次（神战后定格）
  enrolledDay?: number; // 报名日
  cycle?: number; // 当前届次（§4 canon 周期 100 年）
  candidates?: TheoselectCandidate[]; // 同届候选池（NPC）
  stageEndsAt?: number; // 本阶段结束刻
  advancedAt?: number; // 上次推进刻（幂等门）
  disqualified?: boolean; // 被取消资格
  champion?: string; // 本届神战魁首 npcId（玩家夺魁时为 'player'）
}
/** 卡 H6 · 培养学院修业状态 */
export interface AcademyState {
  enrolled?: string; // 在读学院 id
  course?: string; // 当前课程 id
  progress: number; // 当前课程已修刻数
  completed: string[]; // 已结业课程 id
  titles: string[]; // 已获称号（毕业授予）
  term?: number; // 当前学期序号（学制 3 年 × 3 学期）
  startedAt?: number; // 入学刻
  failed?: number; // 考试失利次数（挂科）
  graduated?: string[]; // 已毕业学院 id
  /** 卡 L2 · 寒门通道垫付的学费（待偿）。§101 的代偿/资助/服役抵扣在本作里落成一笔账 */
  debt?: number;
  /** 卡 L2 · 这笔账是哪条通道垫的（guild_advance / temple_sponsor / military_bond） */
  debtFrom?: string;
  /**
   * 卡 G3 · §101 寒门通道的「服役」偿还（神殿预备役 / 军工定向）。
   * 与 debt 并列而不是取代它：公会代偿要还钱，神殿与军工要用人还。
   */
  service?: {
    aid: string;
    faction: string;
    years: number;
    startedAt: number;
    until: number;
    /** 已按年发过几年军饷（防同一年重复结算） */
    paidYears: number;
  };
}
/** 卡 H6 · 神明偏好与信仰阶位 */
export interface DeityFavor {
  favor: number; // 偏好 0–100
  rank: string; // 信仰阶位（信徒→…→神王级，见 deities.json.ranks）
  lastPrayDay?: number; // 上次祈祷日（日限 3 次）
  intervened?: number; // 已降下神迹次数
  lastMiracleDay?: number; // 上次神迹日（冷却天数门，见 deities.json.intervene.cooldownDays）
}
export type DeityId = 'war' | 'wisdom' | 'life' | 'death' | 'chaos' | 'dragon';

/* ---------------- 卡 I2 · 技艺工坊（数据契约见 data/world/craft.json，零逻辑） ---------------- */

/** 站点解锁门：course=需某课程结业（学院制）；tower=需星枢对应塔开放 */
export interface StationUnlock {
  course?: string;
  tower?: string;
}
export interface StationDef {
  id: string;
  name: string;
  loc: string;
  npcId: string | null; // G10 契约：非空时对话选项由数据字段派生，不在 dialogue.ts 逐人加 case
  faction: FactionId;
  lineage: string;
  bonus: number;
  unlock: StationUnlock | null;
  desc: string;
}
/** 配方产出：base=装备实例（掷品质/词缀）；item=普通物品 */
export interface RecipeOut {
  base?: string;
  item?: string;
  qty?: number;
  tier?: number;
  luckBias?: number;
}
export interface RecipeDef {
  id: string;
  name: string;
  station: string;
  tier: number;
  need: { items: [string, number][]; gold: number };
  out: RecipeOut;
  ticks: number;
  failRate: number;
  skillMin: number;
  needCodex?: string; // 卡 I5：需图鉴解锁该 lore 才可制作
  seed: string; // 关 AI 兜底的制作用叙事（不得含占位符）
}
/** 卡 A1 · 成长线状态（可选；缺省＝只走学院或不走培养线，旧档可读） */
export interface GrowthState {
  master?: string; // 当前师傅 npcId（师徒制）
  masterSinceDay?: number; // 拜师日
  lastTeachDay?: number; // 上次授业日
  taught?: number; // 本次随师已受技数
  graduated?: string[]; // 出师记录（师门名）
  temple?: string; // 正在修业的神殿名（神殿培养）
  selfCount?: number; // 今日自学次数
  selfDay?: number; // 计数所属日
}

/** 卡 R3 · 实战领悟状态（可选，hydrate 补默认，旧档可读） */
export interface InsightState {
  pts: number; // 累计领悟点（每次实战胜利 +INSIGHT_PER_WIN）
  learned: string[]; // 已经靠领悟学会的技能 id（留痕，供面板与审计）
}

/** 卡 I2 · 工坊状态（可选，hydrate 补默认，旧档可读） */
export interface CraftState {
  ranks: Record<string, number>; // station → 熟练度（每制作一次 +1）
  made: Record<string, number>; // recipeId → 累计制作成功次数
  recent?: Record<string, number>; // 幂等键 craft_<recipeId>_<tick> → 刻
}

/* ============================================================
   《插件化世界模拟架构方案》§8 / §29：感知与调查
   —— 引擎侧契约放在 types 层，供 events（感知层）/ systems（调查）/ repo（存档）共用。
   ============================================================ */

/** NPC 掌握的一条世界事实：亲历或听说（World Truth ≠ NPC Knowledge） */
/** 一次检定的留痕（§44：重要状态变化要能回答「骰子结果是什么」） */
export interface CheckRecord {
  label: string;
  /** 检定属性（StatName 的可读形式，与 CheckResolver 的入参同源） */
  stat: string;
  mod: number;
  dc: number;
  roll: number;
  total: number;
  ok: boolean;
  crit: boolean;
  day: number;
  tick: number;
}

export interface PerceivedFact {
  eventId: string;
  type: string;
  day: number;
  location?: string;
  /** 保真度：1 = 亲历；<1 = 传闻（细节会失真） */
  fidelity: number;
  via: 'witness' | 'rumor';
  /** 该 NPC 记住的版本（传闻会把起因与细节模糊掉） */
  account: string;
}

/** 势力的案件：立案 → 取证 → 结案（§8 调查与证据） */
export interface CaseState {
  id: string;
  /** 触发立案的事件 id（证据保真度按此回查） */
  eventId: string;
  /** 触发立案的事件类型 */
  crime: string;
  /** 被调查者（实体 id 或其别名，如 'player'） */
  subject: string;
  /** 立案势力 */
  filedBy: string;
  /** 立案日 */
  day: number;
  /** 调查进度 0–100 */
  progress: number;
  /** 证据（目击者 NPC id） */
  evidence: string[];
  status: 'open' | 'concluded' | 'cold';
}

/* ============================================================
   《Memory Engine 记忆系统设计方案》§4-§9：记忆领域模型
   —— World Truth ≠ Character Memory ≠ Belief ≠ Rumor（§3/§24）。
   注意与 PerceivedFact 的分工：
     PerceivedFact（knowledge）是**事件级**感知记录（谁看见了哪个事件），调查取证据此；
     Memory（memories）是**角色级**记忆条目，带置信度/重要度/情绪/衰减，供 AI 召回。
   ============================================================ */

export type MemoryType =
  | 'personal_event' | 'relationship' | 'observation' | 'knowledge' | 'belief'
  | 'rumor' | 'secret' | 'evidence' | 'experience' | 'preference' | 'goal'
  | 'important_event' | 'conversation' | 'location_memory' | 'faction_memory';

export type MemorySource =
  | 'direct_observation' | 'conversation' | 'received_information' | 'inference'
  | 'rumor' | 'system_generated' | 'document' | 'quest' | 'combat';

export type MemoryVisibility = 'private' | 'public' | 'faction' | 'party' | 'secret' | 'restricted';

export type EmotionType =
  | 'joy' | 'fear' | 'anger' | 'sadness' | 'trust' | 'gratitude' | 'hatred' | 'love' | 'neutral';

/** 一条角色记忆（方案 §4 的核心字段） */
export interface Memory {
  id: string;
  ownerId: string;
  type: MemoryType;
  content: string;
  source: MemorySource;
  /** §6 来源链：三选一或并存，用于追溯「你从哪知道的」 */
  sourceEventId?: string;
  sourceCharacterId?: string;
  sourceMemoryId?: string;
  /** §7 置信度 [0,1] */
  confidence: number;
  /** §8 重要度 [0,1] */
  importance: number;
  emotion?: { type: EmotionType; weight: number };
  /** §9 时间：以世界日为单位（与 WorldClock 同源，不引入第二套时间） */
  createdAt: number;
  lastUpdatedAt: number;
  lastRecalledAt?: number;
  recalledCount: number;
  lastConfirmedAt?: number;
  /** §9 衰减率（按重要度分档，配置化） */
  decayRate: number;
  /** §36 权限边界：检索前必须过滤 */
  visibility: MemoryVisibility;
  status: 'active' | 'archived' | 'forgotten';
  /** §15 结构化过滤用的相关实体（NPC / 地点 / 势力 / 物品） */
  entities?: string[];
  /**
   * §24 信念命题（`主体|事件类型|客体`），**写入时算好**。
   * 必须落在记忆自身：事件日志是不入档的环形缓冲，重启后查不到来源事件，
   * 若让信念推导依赖它，重启后的第一个日边界就会把所有信念清成空表。
   */
  proposition?: string;
}

/**
 * 一条信念（《Memory Engine 记忆系统设计方案》§24/§25）。
 * 命题形如 `主体|事件类型|客体`；支撑它的原始记忆永不因观点改变而被覆盖。
 */
export interface Belief {
  proposition: string;
  /** 命题的机器可读拆解（省得下游再去解析字符串） */
  subject: string;
  predicate: string;
  object: string;
  ownerId: string;
  /** 由支持它的记忆加权得出（取最可信的一条 + 少量同类加成） */
  confidence: number;
  supporting: string[];
  /** §25：互相冲突的记忆都留着，谁占上风由置信度体现，不由删除决定 */
  contradicting: string[];
  /* ---- §23「谣言 → 信念 → 行动」的接入位 ----
     内容侧（什么信念导致什么行动）是游戏设计，规则表在 data/world/memory.json 的
     beliefActions 里留空；字段先就位，填表即生效，不必再改结构。 */
  /** 据此行动过的世界日（驱动过就不再重复驱动） */
  actedAt?: number;
  /* ---- 卡 J2 · 独立审查整改：成功与失败分开记 ----
     原先失败不记账，理由是「怕它不再重试」——把因果写反了：once 的判据是
     「已驱动过」，不记账恰恰导致**每天重试一次**。而 target 不在世界书、
     来源事件已滚出缓冲这类失败是结构性不可满足的，重试到天荒地老也没有结果。 */
  /** 判定为不可满足的世界日（同样参与 once 判定） */
  failedAt?: number;
  /** 失败原因（排障用；生产 runLog 默认关闭，所以必须落在状态里才看得见） */
  failedReason?: string;
  /** 驱动出的行动类型：对应 beliefActions 规则里的 action 名 */
  actionKind?: string;
  updatedAt: number;
}

export interface WorldState {
  ver: number;
  /** 事件序号（随档持久化，避免重启后 id 回退——确定性采样依赖 eventId 稳定）。
      与 memSeq 同一范式：id 序号必须随档走。 */
  evtSeq?: number;
  /** 本局的世界种子（改进版 §11）：确定性采样的输入之一。旧档 hydrate 补 0，
      补 0 是安全的——同一档内它恒定，跨档相同只影响「同路径重开得到同一结果」。 */
  seed?: number;
  /* —— 卡 I1：装备实例序号（uid 计数；可选，hydrate 补 0，旧档可读） —— */
  isq?: number;
  t: number; // 总刻数（48 刻=1 日）
  weather: Weather;
  player: PlayerState;
  npcs: Record<string, NpcDynamic>;
  rep: Record<string, number>;
  econ: Record<string, number>; // 卡 D6：多商品价格指数（含旧 herb 键），非单一 herb
  vendors?: Record<string, number>; // 卡 D6：商店收购本金（shopId → 铜），钱不够拒收
  events: WorldEventInst[];
  history: HistoryEntry[];
  log: LogEntry[];
  /** 见闻录累计条数（单调递增）。S.log 有 70 条上限、长度恒定，
      UI 的增量检测必须用这个计数——它是世界状态的一部分，不是模块级变量。 */
  logSeq?: number;
  /** 章级前情摘要（叙事编织用）：每若干段正文压成一段，按时间正序。
      与 log 分开存是必须的——见闻录只有 70 条上限，早期的正文会被丢掉，
      跨天的衔接不能靠它现算。旧档无此字段时 hydrate 补空数组。 */
  recap?: string[];
  /** 已归档到哪一条见闻（log 的 id 水位）。用它而不是计数，
      才不会在重启/读档后把同一批段落重复摘要一遍 */
  recapSeq?: number;
  killed: Record<string, number>;
  qf: Record<string, boolean>;
  net?: NetState;
  /* —— 卡 D3：多维势力外交（均可选，hydrate 从 rep/种子投影；attitude 轴仍以 rep 为准）—— */
  playerRep?: Partial<Record<FactionId, PlayerRep>>; // 玩家对各势力的非态度轴
  factionRel?: Record<string, Record<string, Partial<FactionRelation>>>; // 势力↔势力外交矩阵（缺省回落 factions.json）
  /* —— 卡 D5：法律状态（罪名分级 + 刑期，可选；hydrate 兜底）—— */
  legal?: LegalState;
  /* —— 聊天窗口：自由对话历史（每 NPC 封顶 20 轮，hydrate 补默认，旧档可读）
      与羁绊每日计数（聊天好感日封顶防 farm）—— */
  chats?: Record<string, { who: 'p' | 'n'; text: string; day: number; id?: string }[]>; // id：会话条目的稳定 key（旧档没有，UI 回落下标）
  bondDay?: { day: number; chatGain: number; giftGain?: number };
  /* —— 卡 H2 · 星渊暗线（可选，hydrate 兜底）：leak=魔气浓度 0–5，sealed=封印次数 —— */
  abyss?: { leak: number; sealed: number };
  /* —— 卡 H4 · 地下城 100 层（可选）：floor=当前层（未在层中为 0），best=历史最深 —— */
  dungeon?: DungeonState;
  /* —— 卡 H5 · 百年神选（可选）：海选→预选→正赛→神战→候补 —— */
  theoselect?: TheoselectState;
  /* —— 卡 H6 · 培养学院 + 神明（可选）：学院修业 + 六主神偏好 —— */
  academy?: AcademyState;
  /* —— 卡 I2 · 技艺工坊（可选）：ranks/made 熟练度与产出统计 —— */
  craft?: CraftState;
  /** 卡 R3：实战领悟（可选；缺省视为 0 点，旧档可直接读） */
  insight?: InsightState;
  /* —— 世界模拟架构 §8（可选，hydrate 补默认，旧档可读）：
       knowledge = NPC 感知表（npcId → 该 NPC 知道的事实）；
       cases    = 势力在办/已结案件（证据只能来自感知表）—— */
  knowledge?: Record<string, PerceivedFact[]>;
  cases?: CaseState[];
  /** §44 事实来源：最近若干次检定留痕（骰值、难度、成败）——「怎么判出来的」要回答得出 */
  checks?: CheckRecord[];
  /** §4 角色记忆表（ownerId → 记忆条目，含衰减/情绪/来源链） */
  memories?: Record<string, Memory[]>;
  /** 记忆 id 的持久化序号：必须随档走，否则重启后同日 id 碰撞、召回会改错记忆 */
  memSeq?: number;
  /** 规模化 Phase 6 · 记忆分频记账（ownerId → 上次跑记忆 tick 的世界日）。
      存进档案而不是模块变量：重启后归零的话，每个 owner 都会被当成「刚到点」而全量重跑一次。 */
  memTickAt?: Record<string, number>;
  /** §24 信念表（ownerId → 信念），由记忆推导，不是独立事实来源 */
  beliefs?: Record<string, Belief[]>;
  /* —— 卡 I6 · 头衔声名（可选）：titles=已获得（按获得顺序），titleHidden=花钱藏起的负面称号 —— */
  titles?: string[];
  titleHidden?: string[];
  /* —— 卡 I5 · 文献图鉴（可选）：unlocked=lore id 列表，found=条目累计发现次数
       obsDay=观察解锁的「地点+日」配额（每地点每日上限，防一站刷满） —— */
  codex?: { unlocked: string[]; found: Record<string, number>; obsDay?: { day: number; loc: string; n: number } };
  favor?: Partial<Record<DeityId, DeityFavor>>; // 神明偏好（0–100，缺省 0）
  favorDay?: { day: number; n: number }; // 祈祷日限（≤3/日）
}

/* ---------------- 战斗状态（规则引擎持有，UI 只渲染） ---------------- */

export interface CombatFoe {
  mid: string;
  name: string;
  sv: string;
  color: string;
  hp: number;
  mhp: number;
  ac: number;
  atk: number;
  dmg: [number, number];
  undead?: boolean;
  poison?: number;
  boss?: boolean;
  dead: boolean;
  status?: StatusInst[]; // 卡 I3：战斗内状态（可选，不落档）
}
export interface CombatLogEntry {
  /** 稳定 key（审查 §下标 key）：窗口 40 条 shift 掉最旧，用下标做 key 会让每一行
      「换了内容但保留节点」，整段 innerHTML 重设、动画重播。CB 不入档，序号只在会话内有效。 */
  id?: number;
  text: string;
  cls: 'me' | 'foe' | 'sys';
  crit?: boolean; // 卡 I3：暴击条目（补 H 缺口 3——此前面板靠文案扫描猜暴击）
}
export interface CombatState {
  foes: CombatFoe[];
  round: number;
  ctx: { boss?: boolean; caravan?: boolean; net?: boolean; dungeon?: boolean }; // dungeon=卡 H4 地下城层中遭遇
  /** 网内无伤比斗：开战的真实状态快照，终局整体还原（真身无损） */
  netSnap?: { hp: number; mp: number; gold: number };
  cds: Record<string, number>;
  ward: number;
  buff: number;
  over: boolean;
  log: CombatLogEntry[];
  status?: StatusInst[]; // 卡 I3：玩家战斗内状态（不落档，战斗结束随 CB 一并丢弃）
  /** 卡 E1b · 暗杀路线的「阴影值」（§32）：战斗中累积的势，出手即清零 */
  shadow?: number;
}
