/* ============================================================
   Core Rules（V1.0 · 方案 §5.1 Core Command）
   ------------------------------------------------------------
   任何世界都需要的最基本操作：实体增删改、关系、移动、时间、天气。
   不含任何玩法语义（attack/talk/quest 等见 rpgCompat.ts——EXTENSION）。

   全部只操作内核通用容器：实体表 / attributes / relations /
   locations / player.loc / variables。
   ============================================================ */
import type { WorldRule } from './Rules.ts';
import type { EngineWorldState } from '../types.ts';

/** 创建实体：id 唯一；type/attributes/location 可选（§4.2 Entity 形状） */
export function createEntityRule<W extends EngineWorldState>(): WorldRule<W> {
  return {
    name: 'CreateEntityRule',
    for: 'create_entity',
    apply(ctx) {
      const p = ctx.command.payload ?? {};
      const id = typeof p['id'] === 'string' ? p['id'] : undefined;
      if (!id) {
        ctx.emit({ type: 'entity_create_failed', cause: '缺少 id' });
        return false;
      }
      if (ctx.state.npcs[id]) {
        ctx.emit({ type: 'entity_create_failed', cause: '实体已存在', target: id });
        return false;
      }
      const type = typeof p['type'] === 'string' ? p['type'] : 'entity';
      const name = typeof p['name'] === 'string' ? p['name'] : id;
      const location = typeof p['location'] === 'string' ? p['location'] : undefined;
      const attrs: Record<string, unknown> = { name };
      if (typeof p['attributes'] === 'object' && p['attributes'] !== null && !Array.isArray(p['attributes'])) {
        Object.assign(attrs, p['attributes']);
      }
      if (location) attrs['location'] = location;
      ctx.state.npcs[id] = { att: 0, mem: [], met: false, type, attributes: attrs };
      ctx.emit({ type: 'entity_created', target: id, data: { type, name, location } });
    },
  };
}

/** 移除实体 */
export function removeEntityRule<W extends EngineWorldState>(): WorldRule<W> {
  return {
    name: 'RemoveEntityRule',
    for: 'remove_entity',
    apply(ctx) {
      const id = ctx.command.targetId;
      if (!id || !ctx.state.npcs[id]) {
        ctx.emit({ type: 'entity_remove_failed', cause: '实体不存在', target: id });
        return false;
      }
      delete ctx.state.npcs[id];
      /* V2.4-02 不变量：级联清理悬空引用——世界关系表与实体关系网中
         指向被删实体的边必须随实体一起消失（否则留下幽灵关系） */
      let relationsPurged = 0;
      if (ctx.state.relations?.length) {
        const before = ctx.state.relations.length;
        ctx.state.relations = ctx.state.relations.filter((r) => r.source !== id && r.target !== id);
        relationsPurged += before - ctx.state.relations.length;
      }
      for (const dy of Object.values(ctx.state.npcs)) {
        if (dy.rels && dy.rels[id]) {
          delete dy.rels[id];
          relationsPurged++;
        }
      }
      ctx.emit({ type: 'entity_removed', target: id, data: { relationsPurged } });
    },
  };
}

/** 更新通用属性：targetId='player' 改玩家，否则改实体；payload = { key, value }（一层基本类型） */
export function updateAttributeRule<W extends EngineWorldState>(): WorldRule<W> {
  return {
    name: 'UpdateAttributeRule',
    for: 'update_attribute',
    apply(ctx) {
      const p = ctx.command.payload ?? {};
      const key = typeof p['key'] === 'string' && p['key'].length <= 64 ? p['key'] : undefined;
      const value = p['value'];
      if (!key || !(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')) {
        ctx.emit({ type: 'attribute_update_failed', cause: '缺少 key 或 value 不是基本类型' });
        return false;
      }
      const targetId = ctx.command.targetId ?? 'player';
      /* V2.4-02 不变量：不存在的实体不能被修改（否则白名单动作即可凭空造实体，
         绕过 create_entity 的显式建档禁令）。玩家为原生存在，不在此列。 */
      if (targetId !== 'player' && !ctx.state.npcs[targetId]) {
        ctx.emit({ type: 'attribute_update_failed', cause: '实体不存在', target: targetId });
        return false;
      }
      if (targetId === 'player') {
        const a = (ctx.state.player.attributes = ctx.state.player.attributes ?? {});
        a[key] = value;
      } else {
        const e = ctx.mutate.npcEntry(targetId);
        const a = (e.attributes = e.attributes ?? {});
        a[key] = value;
      }
      ctx.emit({ type: 'entity_updated', target: targetId, data: { key } });
    },
  };
}

/** 设置关系：upsert 到世界关系表（source 缺省 = 执行者/player） */
export function setRelationRule<W extends EngineWorldState>(): WorldRule<W> {
  return {
    name: 'SetRelationRule',
    for: 'set_relation',
    apply(ctx) {
      const p = ctx.command.payload ?? {};
      const target = ctx.command.targetId;
      const type = typeof p['type'] === 'string' ? p['type'] : undefined;
      if (!target || !type) {
        ctx.emit({ type: 'relation_set_failed', cause: '缺少 target 或 type' });
        return false;
      }
      const source = ctx.command.actorId ?? 'player';
      /* V2.4-02 不变量：非法 Relation 不能更新——来源/目标都必须真实存在，
         否则会制造指向幽灵实体的悬空边 */
      if (source !== 'player' && !ctx.state.npcs[source]) {
        ctx.emit({ type: 'relation_set_failed', cause: '来源实体不存在', target: source });
        return false;
      }
      if (target !== 'player' && !ctx.state.npcs[target]) {
        ctx.emit({ type: 'relation_set_failed', cause: '目标实体不存在', target });
        return false;
      }
      const value = typeof p['value'] === 'number' ? p['value'] : undefined;
      const relations = (ctx.state.relations = ctx.state.relations ?? []);
      const existing = relations.find((r) => r.source === source && r.target === target && r.type === type);
      if (existing) {
        if (value !== undefined) existing.value = value;
        (existing.metadata ??= {}).updatedAtDay = ctx.clock.sceneTime(ctx.state).day;
      } else {
        relations.push({ source, target, type, ...(value !== undefined ? { value } : {}), metadata: { updatedAtDay: ctx.clock.sceneTime(ctx.state).day } });
      }
      ctx.emit({ type: 'relation_set', actor: source, target, data: { type, value } });
    },
  };
}

/** 地点存在性校验（P3 卡片3）：有地点表时目的地必须在表内；
 *  无地点表（locations 为空/未定义）时保持既有行为（向后兼容）。 */
function locationExists(state: EngineWorldState, id: string): boolean {
  const locations = state.locations;
  if (!locations) return true;
  const keys = Object.keys(locations);
  if (keys.length === 0) return true;
  return locations[id] !== undefined;
}

/** 移动实体：targetId='player'（或缺省）走玩家位置；否则写实体 attributes.location */
export function moveEntityRule<W extends EngineWorldState>(): WorldRule<W> {
  return {
    name: 'MoveEntityRule',
    for: 'move_entity',
    apply(ctx) {
      const location = typeof ctx.command.payload?.['location'] === 'string' ? (ctx.command.payload!['location'] as string) : ctx.command.text;
      if (!location) {
        ctx.emit({ type: 'entity_move_failed', cause: '缺少目的地' });
        return false;
      }
      if (!locationExists(ctx.state, location)) {
        ctx.emit({ type: 'entity_move_failed', cause: '地点不存在', location });
        return false;
      }
      const id = ctx.command.targetId ?? 'player';
      if (id === 'player' || id === ctx.command.actorId) {
        ctx.mutate.playerLoc(location);
        ctx.emit({ type: 'entity_moved', actor: id, data: { location } });
        return;
      }
      if (!ctx.state.npcs[id]) {
        ctx.emit({ type: 'entity_move_failed', cause: '实体不存在', target: id });
        return false;
      }
      const e = ctx.mutate.npcEntry(id);
      const a = (e.attributes = e.attributes ?? {});
      a['location'] = location;
      ctx.emit({ type: 'entity_moved', actor: id, data: { location } });
    },
  };
}

/** 移动玩家（兼容命令：玩家=特殊实体 id 'player'） */
export function moveRule<W extends EngineWorldState>(): WorldRule<W> {
  return {
    name: 'MoveRule',
    for: 'move',
    apply(ctx) {
      const target = ctx.command.targetId;
      if (!target) {
        ctx.emit({ type: 'move_failed', cause: '缺少目的地' });
        return false;
      }
      if (ctx.state.player.loc === target) {
        ctx.emit({ type: 'move_failed', cause: '已经在这里', location: target });
        return false;
      }
      if (!locationExists(ctx.state, target)) {
        ctx.emit({ type: 'move_failed', cause: '地点不存在', location: target });
        return false;
      }
      ctx.mutate.playerLoc(target);
      ctx.emit({ type: 'player_moved', actor: ctx.command.actorId ?? 'player', location: target });
    },
  };
}

/** 推进时间：世界时钟逐刻走（衰减 / 日边界 / 时辰边界事件都由时钟发布） */
export function advanceTimeRule<W extends EngineWorldState>(): WorldRule<W> {
  return {
    name: 'AdvanceTimeRule',
    for: 'advance_time',
    apply(ctx) {
      /* P3 卡片1：单次推进上限兜底（HTTP 层同口径钳制之外的规则层防线——
         库内调用/宿主直连不经 HTTP，也受保护）。缺省 1440 刻 = 30 天。 */
      const MAX_SINGLE_ADVANCE = 1440;
      const raw = Math.max(1, Math.floor(ctx.command.amount ?? 1));
      const ticks = Math.min(raw, MAX_SINGLE_ADVANCE);
      if (ticks < raw) {
        ctx.emit({ type: 'time_advance_clamped', data: { requested: raw, applied: ticks } });
      }
      ctx.clock.advance(ticks);
      ctx.emit({ type: 'time_advanced', data: { ticks } });
    },
  };
}

/** 变天气：天气是派生状态，只此一处可改 */
export function changeWeatherRule<W extends EngineWorldState>(): WorldRule<W> {
  return {
    name: 'ChangeWeatherRule',
    for: 'change_weather',
    apply(ctx) {
      const w = ctx.command.text;
      if (!w) {
        ctx.emit({ type: 'weather_change_failed', cause: '缺少天气' });
        return false;
      }
      const prev = ctx.state.weather;
      ctx.mutate.weather(w);
      ctx.emit({ type: 'weather_changed', data: { from: prev, to: w } });
    },
  };
}

/** Core 内置规则集（createWorld 缺省装配的核心部分） */
export function coreRules<W extends EngineWorldState>(): WorldRule<W>[] {
  return [
    createEntityRule<W>(),
    removeEntityRule<W>(),
    updateAttributeRule<W>(),
    setRelationRule<W>(),
    moveEntityRule<W>(),
    moveRule<W>(),
    advanceTimeRule<W>(),
    changeWeatherRule<W>(),
  ];
}
