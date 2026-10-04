/* ============================================================
   RPG 兼容规则（EXTENSION · 方案 §5.2/§5.3）
   ------------------------------------------------------------
   attack / talk / set_attitude / spawn_entity 属于**领域语义**
   （战斗 / 社交 / 关系），不进内核内置集——本模块即它们的
   Extension 落点。为兼容既有测试与示例，createWorld 缺省仍装配
   本集（§5.3 Legacy → Extension → Core 收敛路径的第一步）；
   新游戏请用 create_entity 等 Core 命令或自建规则。
   ============================================================ */
import type { WorldRule } from './Rules.ts';
import type { EngineWorldState } from '../types.ts';

/** 攻击：目标必须存在；伤害由调用方给（战斗数值归游戏规则） */
export function attackRule<W extends EngineWorldState>(): WorldRule<W> {
  return {
    name: 'AttackRule',
    for: 'attack',
    apply(ctx) {
      const id = ctx.command.targetId;
      if (!id || !ctx.state.npcs[id]) {
        ctx.emit({ type: 'attack_failed', actor: ctx.command.actorId ?? 'player', cause: '目标不存在', target: id });
        return false;
      }
      const dmg = Math.max(0, Math.floor(ctx.command.amount ?? 1));
      /* 内核不认识「HP」这种游戏数值——攻击的数值结果（掉血 / 死亡）由游戏规则
         写自己的字段。内核保证的是：目标存在性校验 + 事实被发布。 */
      ctx.emit({
        type: 'attack_succeeded',
        actor: ctx.command.actorId ?? 'player',
        target: id,
        data: { damage: dmg },
      });
    },
  };
}

/** 交谈：对象必须存在；首谈记「正式见过」；玩家原话进见闻录 */
export function talkRule<W extends EngineWorldState>(): WorldRule<W> {
  return {
    name: 'TalkRule',
    for: 'talk',
    apply(ctx) {
      const id = ctx.command.targetId;
      if (!id) {
        ctx.emit({ type: 'talk_failed', cause: '缺少对象' });
        return false;
      }
      /* V2.4-02 不变量：不存在的实体不能被交谈（npcMet 惰性建档会凭空造实体） */
      if (id !== 'player' && !ctx.state.npcs[id]) {
        ctx.emit({ type: 'talk_failed', cause: '实体不存在', target: id });
        return false;
      }
      ctx.mutate.npcMet(id);
      if (ctx.command.text) ctx.mutate.pushLog(`＞ ${ctx.command.text}`, 'say');
      ctx.emit({ type: 'talk_started', actor: ctx.command.actorId ?? 'player', target: id });
    },
  };
}

/** 调整实体态度：好感变化的通用通道，夹取由写入原语负责 */
export function setAttitudeRule<W extends EngineWorldState>(): WorldRule<W> {
  return {
    name: 'SetAttitudeRule',
    for: 'set_attitude',
    apply(ctx) {
      const id = ctx.command.targetId;
      if (!id) {
        ctx.emit({ type: 'attitude_change_failed', cause: '缺少对象' });
        return false;
      }
      /* V2.4-02 不变量：不存在的实体不能被修改态度（惰性建档会凭空造实体） */
      if (id !== 'player' && !ctx.state.npcs[id]) {
        ctx.emit({ type: 'attitude_change_failed', cause: '实体不存在', target: id });
        return false;
      }
      const { from, to } = ctx.mutate.npcAtt(id, ctx.command.amount ?? 0);
      ctx.emit({ type: 'npc_attitude_shift', target: id, data: { from, to } });
    },
  };
}

/** 生成实体（兼容别名：语义与 create_entity 重叠，保留给既有用例） */
export function spawnEntityRule<W extends EngineWorldState>(): WorldRule<W> {
  return {
    name: 'SpawnEntityRule',
    for: 'spawn_entity',
    apply(ctx) {
      const p = ctx.command.payload ?? {};
      const id = typeof p['id'] === 'string' ? p['id'] : undefined;
      const name = typeof p['name'] === 'string' ? p['name'] : id;
      const kind = p['kind'] === 'player' ? 'player' : 'npc';
      if (!id || !name) {
        ctx.emit({ type: 'spawn_failed', cause: '缺少 id / name' });
        return false;
      }
      if (kind === 'npc' && ctx.state.npcs[id]) {
        ctx.emit({ type: 'spawn_failed', cause: '实体已存在', target: id });
        return false;
      }
      if (kind === 'npc') {
        ctx.mutate.npcEntry(id);
        ctx.emit({ type: 'npc_spawned', target: id, data: { name, loc: typeof p['loc'] === 'string' ? p['loc'] : undefined } });
      } else {
        ctx.state.player.name = name;
        ctx.emit({ type: 'player_spawned', actor: 'player', data: { name } });
      }
    },
  };
}

/** RPG 兼容规则集（createWorld 缺省装配的兼容部分；可经 noBuiltinRules 排除） */
export function rpgCompatRules<W extends EngineWorldState>(): WorldRule<W>[] {
  return [
    attackRule<W>(),
    talkRule<W>(),
    setAttitudeRule<W>(),
    spawnEntityRule<W>(),
  ];
}
