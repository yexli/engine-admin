/* ============================================================
   World Schema（P13 · 方案 §十六：通用 World Schema）
   ------------------------------------------------------------
   从两个真实游戏（天穹 · RPG / 商路 · 商贸）的实际用法中提炼的
   **最小通用契约**——不是前瞻设计。三层：

     ① 引擎结构面（Core 已实现，此处只引用）：
        World / State / Entity / Relation / Command / Rule /
        Mutation / Event / Time / Scheduler
     ② 平台识别的规范属性键（本文件）：
        location / name / mood / attention / goal / money ——
        触发评估（P3）、上下文（P4）、个体决策（P5）、观测面（P9）
        读取这些键；语义与归属见 CANONICAL_ATTRIBUTES。
     ③ 游戏自有属性（命名纪律）：
        玩法键由游戏自定（item_silk / spice_stock / ale_stock…），
        平台不解释；命名须过 GAME_KEY_PATTERN。

   铁律：Core 不知道这些键的存在——Schema 是平台与宿主之间的
   约定，引擎依旧只认 Entity/Relation/Attribute 泛型结构。
   本模块只读：inspect 不产生任何命令。

   SCHEMA_VERSION：契约演进用（1.0 = 自 P2-P12 双游戏实践提炼）。
   ============================================================ */

/** Schema 契约版本（随不兼容变更递增） */
export const SCHEMA_VERSION = '1.0';

/** 规范属性键定义（平台识别；Core 不感知） */
export interface CanonicalAttribute {
  /** 值类型（引擎属性袋只存基本类型） */
  type: 'string' | 'number' | 'boolean';
  /** 适用对象：实体 / 玩家 / 两者 */
  appliesTo: 'entity' | 'player' | 'both';
  /** 谁写：host = 游戏宿主（权威）；ai = AI 提案可维护（经白名单）；both */
  writtenBy: 'host' | 'ai' | 'both';
  /** 语义（一句话；平台哪些环节读它） */
  description: string;
}

/** 平台识别的规范属性键（P2-P12 双游戏实践提炼；缺省缺属性不编造） */
export const CANONICAL_ATTRIBUTES: Record<string, CanonicalAttribute> = {
  location: {
    type: 'string',
    appliesTo: 'both',
    writtenBy: 'host',
    description: '当前所在地点 id——触发唤醒评估、上下文地点作用域、日程对齐的依据',
  },
  name: { type: 'string', appliesTo: 'both', writtenBy: 'host', description: '显示名（上下文事实段与观测面呈现）' },
  mood: { type: 'string', appliesTo: 'entity', writtenBy: 'both', description: '心情（AI 提案可维护；上下文完整字段呈现）' },
  attention: {
    type: 'string',
    appliesTo: 'entity',
    writtenBy: 'both',
    description: '当前注意对象（实体 id / "player" / "无人"）——P10 验收的注意力状态',
  },
  goal: {
    type: 'string',
    appliesTo: 'entity',
    writtenBy: 'both',
    description: '当前目标——个体决策的 context.goal 来源（P5）',
  },
  money: {
    type: 'number',
    appliesTo: 'both',
    writtenBy: 'host',
    description: '货币数量——经济归宿主与 Rules；AI 被 forbiddenAttributeKeys 禁改（P5）',
  },
};

/** 游戏自有属性命名纪律（item_silk / spice_stock / ale_stock …） */
export const GAME_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/** 引擎事实类型全集（coreRules + rpgCompat 扩展 + 时钟；按组归类） */
export const CORE_EVENT_TYPES = {
  entity: [
    'entity_created',
    'entity_removed',
    'entity_updated',
    'entity_moved',
    'entity_create_failed',
    'entity_remove_failed',
    'entity_move_failed',
    'attribute_update_failed',
  ],
  player: ['player_spawned', 'player_moved', 'move_failed'],
  relation: ['relation_set', 'relation_set_failed'],
  talk: ['talk_started', 'talk_failed'],
  combat: ['attack_succeeded', 'attack_failed', 'npc_attitude_shift'],
  spawn: ['npc_spawned', 'spawn_failed'],
  time: ['new_day', 'hour_advanced', 'time_advanced'],
  weather: ['weather_changed', 'weather_change_failed'],
} as const;

/** 扩展层事实（rpgCompat；缺省装配但属 EXTENSION——Core/Extension 边界由源码扫描钉住） */
export const EXTENSION_EVENT_GROUPS: readonly ('talk' | 'combat' | 'spawn')[] = ['talk', 'combat', 'spawn'];

/** 全部事实类型的平铺集合 */
export const ALL_EVENT_TYPES: string[] = Object.values(CORE_EVENT_TYPES).flat();

/* ---------------- 符合性检查（只读） ---------------- */

export interface WorldSchemaInput {
  worldId?: string;
  t?: number;
  locations?: Record<string, unknown>;
  /** 玩家：loc 为引擎原生位置字段（canonical location 对玩家即此字段） */
  player?: { loc?: string; attributes?: Record<string, unknown> };
  npcs?: Record<string, { att?: unknown; met?: unknown; type?: string; attributes?: Record<string, unknown> }>;
  relations?: unknown;
}

export interface WorldSchemaReport {
  schemaVersion: string;
  /** 是否符合（无 error；warning 不影响） */
  conforming: boolean;
  /** 违反契约（类型错 / 命名违纪） */
  errors: string[];
  /** 建议关注（缺规范键 / 缺位置——不阻断，缺事实不编造） */
  warnings: string[];
  stats: {
    entities: number;
    locations: number;
    relations: number;
    /** 规范键使用计数（键 → 使用该键的实体数） */
    canonicalKeys: Record<string, number>;
    /** 游戏自有键（去重；平台不解释，仅透出） */
    gameKeys: string[];
  };
}

function checkValue(label: string, attr: CanonicalAttribute, v: unknown, errors: string[]): void {
  if (attr.type === 'number') {
    if (typeof v !== 'number' || !Number.isFinite(v)) errors.push(`${label} 应为 number（${attr.description}）`);
  } else if (attr.type === 'string') {
    if (typeof v !== 'string' || v.length === 0) errors.push(`${label} 应为非空 string（${attr.description}）`);
  } else if (attr.type === 'boolean' && typeof v !== 'boolean') {
    errors.push(`${label} 应为 boolean`);
  }
}

/**
 * 检查一个世界状态对 World Schema 的符合性（只读，不产生命令）。
 * 典型用途：宿主播种后自检 / 管理观测面 / 升级前兼容性核对。
 */
export function inspectWorldSchema(state: WorldSchemaInput): WorldSchemaReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const canonicalKeys: Record<string, number> = {};
  const gameKeySet = new Set<string>();

  const entities: Record<string, Record<string, unknown>> = {};
  if (state.player?.attributes) {
    /* 玩家位置是引擎原生字段（player.loc），投影进属性面参与规范覆盖统计 */
    const playerAttrs: Record<string, unknown> = { ...state.player.attributes };
    if (state.player.loc !== undefined && playerAttrs['location'] === undefined) playerAttrs['location'] = state.player.loc;
    entities['player'] = playerAttrs;
  }
  for (const [id, n] of Object.entries(state.npcs ?? {})) {
    if (n?.attributes) entities[id] = n.attributes;
  }

  for (const [id, attrs] of Object.entries(entities)) {
    for (const [key, value] of Object.entries(attrs ?? {})) {
      const canonical = CANONICAL_ATTRIBUTES[key];
      if (canonical) {
        canonicalKeys[key] = (canonicalKeys[key] ?? 0) + 1;
        if (canonical.appliesTo === 'entity' && id === 'player') continue; /* 实体专属键在玩家身上 → 仅提示 */
        checkValue(`entities.${id}.attributes.${key}`, canonical, value, errors);
      } else {
        if (!GAME_KEY_PATTERN.test(key)) errors.push(`entities.${id}.attributes.${key} 游戏键不符合命名纪律（${GAME_KEY_PATTERN}）`);
        else gameKeySet.add(key);
      }
    }
    /* 平台依赖键的缺省提示（缺 = 相关能力对该实体不生效，属合法选择） */
    if (id !== 'player' && attrs?.['location'] === undefined) warnings.push(`entities.${id}.attributes.location 缺失——触发唤醒/上下文作用域/日程对齐不会考虑它`);
    if (id !== 'player' && attrs?.['goal'] === undefined) warnings.push(`entities.${id}.attributes.goal 缺失——个体决策无目标段（合法，缺事实不编造）`);
  }

  if (state.player?.attributes?.['money'] === undefined) warnings.push('player.attributes.money 缺失——经济类玩法需要它');

  const relations = Array.isArray(state.relations) ? state.relations.length : 0;
  return {
    schemaVersion: SCHEMA_VERSION,
    conforming: errors.length === 0,
    errors,
    warnings,
    stats: {
      entities: Object.keys(entities).length,
      locations: Object.keys(state.locations ?? {}).length,
      relations,
      canonicalKeys,
      gameKeys: [...gameKeySet].sort(),
    },
  };
}
