/* ============================================================
   Evolution Context Builder（方案 §四：Observation → Context Builder；V2 收敛）
   ------------------------------------------------------------
   把引擎的权威事实（World Truth）组装成结构化上下文。与 worldagent
   的 buildWorldContext（给聊天模型的一段散文）不同：演化上下文是
   **结构化数据**——AI 要读字段做跨系统推演，不是陪聊。

   V2 收敛（方案 §五）：Context 来自真实 State，但不是
   「SELECT * FROM everything」：
     Global（时间/天气/玩家）
     + Current Location（玩家所在地）
     + Relevant NPC（在场实体，完整字段）
     + Recent Events（观察窗口事实）
     + Relevant Relationships（涉及玩家或在场实体的关系边）
     + Current Time
   其余实体只进轻量名册（id/type/location）——AI 看得见世界有哪些人，
   但只有眼前实体的细节可读。世界时间以引擎刻度换算（1 天 = 48 刻）。

   纪律：只陈述引擎里有的字段，一个字都不编；读不到就留空，
   不用缺省值冒充事实。
   ============================================================ */
import type { EngineClient } from '../types.ts';
import type { EvolutionContext } from './types.ts';

const CHEN_PER_DAY = 48; /* 与引擎 TimeBase 同源（内核常量，此处只读换算） */

/* 引擎 GET /state 响应的最小读取面（允许字段缺失） */
interface StateView {
  t?: number;
  weather?: string;
  player?: { name?: string; loc?: string; bag?: unknown[]; attributes?: Record<string, unknown> };
  npcs?: Record<string, { att?: number; met?: boolean; type?: string; attributes?: Record<string, unknown> }>;
  relations?: { source: string; target: string; type: string; value?: number }[];
  locations?: Record<string, { id?: string; type?: string; attributes?: Record<string, unknown> }>;
}

interface EventView {
  id?: string;
  type?: string;
  day?: number;
  actor?: string;
  target?: string;
  location?: string;
  data?: Record<string, unknown>;
}

export interface BuildEvolutionContextOptions {
  /** 观察窗口：最近 N 条世界事实（缺省 20） */
  eventCount?: number;
}

export async function buildEvolutionContext(
  engine: EngineClient,
  worldId: string,
  opts: BuildEvolutionContextOptions = {},
): Promise<{ ok: true; context: EvolutionContext } | { ok: false; status: number; error: string }> {
  const eventN = Math.max(1, Math.min(200, Math.floor(opts.eventCount ?? 20)));
  const [stateRes, eventsRes] = await Promise.all([engine.getState(worldId), engine.getEvents(worldId, eventN)]);
  if (!stateRes.ok) return { ok: false, status: stateRes.status, error: stateRes.error };
  if (!eventsRes.ok) return { ok: false, status: eventsRes.status, error: eventsRes.error };

  const s = (stateRes.state ?? {}) as StateView;
  const rawEvents = (eventsRes.events ?? []) as EventView[];

  const playerLoc = s.player?.loc ?? '';
  const entities: EvolutionContext['entities'] = {};
  const otherEntities: EvolutionContext['otherEntities'] = [];
  for (const [id, n] of Object.entries(s.npcs ?? {})) {
    const loc = n.attributes?.['location'] !== undefined ? String(n.attributes['location']) : undefined;
    if (loc !== undefined && loc === playerLoc) {
      entities[id] = {
        att: typeof n.att === 'number' ? n.att : 0,
        met: n.met === true,
        ...(n.type !== undefined ? { type: n.type } : {}),
        location: loc,
        ...(n.attributes !== undefined ? { attributes: n.attributes } : {}),
      };
    } else {
      otherEntities.push({ id, ...(n.type !== undefined ? { type: n.type } : {}), ...(loc !== undefined ? { location: loc } : {}) });
    }
  }

  /* 关系边只保留涉及玩家或在场实体的（方案 §五：Relevant Relationships） */
  const relevant = new Set<string>(['player', ...Object.keys(entities)]);
  const relations = (s.relations ?? [])
    .filter((r) => relevant.has(r.source) || relevant.has(r.target))
    .map((r) => ({
      source: r.source,
      target: r.target,
      type: r.type,
      ...(r.value !== undefined ? { value: r.value } : {}),
    }));

  const locRec = playerLoc ? s.locations?.[playerLoc] : undefined;
  const context: EvolutionContext = {
    worldId,
    builtAt: new Date().toISOString(),
    tick: typeof s.t === 'number' ? s.t : 0,
    day: typeof s.t === 'number' ? Math.floor(s.t / CHEN_PER_DAY) + 1 : 0,
    weather: s.weather ?? '',
    player: {
      name: s.player?.name ?? 'player',
      loc: playerLoc,
      bagSize: Array.isArray(s.player?.bag) ? s.player.bag.length : 0,
      ...(s.player?.attributes !== undefined ? { attributes: s.player.attributes } : {}),
    },
    ...(playerLoc
      ? {
          location: {
            id: playerLoc,
            ...(locRec?.attributes?.['desc'] !== undefined ? { desc: String(locRec.attributes['desc']) } : {}),
          },
        }
      : {}),
    entities,
    otherEntities,
    relations,
    events: rawEvents
      .filter((e) => typeof e.id === 'string' && typeof e.type === 'string')
      .map((e) => ({
        id: e.id!,
        type: e.type!,
        day: typeof e.day === 'number' ? e.day : 0,
        ...(e.actor !== undefined ? { actor: e.actor } : {}),
        ...(e.target !== undefined ? { target: e.target } : {}),
        ...(e.location !== undefined ? { location: e.location } : {}),
        ...(e.data !== undefined ? { data: e.data } : {}),
      })),
  };
  return { ok: true, context };
}

/** 上下文 → 驱动提示词的**事实陈述**段（驱动负责包装自己的指令）。
 *  只做序列化，不做任何叙事加工——喂给 AI 的和 Admin 看到的必须是同一份事实。 */
export function renderContextFacts(context: EvolutionContext): string {
  const lines: string[] = [];
  lines.push(`世界 ${context.worldId}：第 ${context.day} 天，刻度 ${context.tick}，天气 ${context.weather || '未知'}`);
  lines.push(
    `玩家 ${context.player.name} 在 ${context.player.loc || '未知'}（随身 ${context.player.bagSize} 项）${
      context.player.attributes ? ` attributes=${JSON.stringify(context.player.attributes)}` : ''
    }`,
  );
  if (context.location) lines.push(`当前地点：${context.location.id}${context.location.desc ? `（${context.location.desc}）` : ''}`);
  const ids = Object.keys(context.entities);
  if (ids.length) {
    lines.push(
      `在场实体（完整字段）：\n${ids
        .map((id) => {
          const e = context.entities[id]!;
          return `- ${id}（${e.type ?? 'entity'}）att=${e.att} ${e.met ? '已认识玩家' : '未见过玩家'}${
            e.attributes ? ` attributes=${JSON.stringify(e.attributes)}` : ''
          }`;
        })
        .join('\n')}`,
    );
  }
  if (context.otherEntities.length) {
    lines.push(
      `世界其余实体（名册，细节不可见）：\n${context.otherEntities
        .map((e) => `- ${e.id}${e.type ? `（${e.type}）` : ''}${e.location ? ` @ ${e.location}` : ''}`)
        .join('\n')}`,
    );
  }
  if (context.relations.length) {
    lines.push(
      `相关关系：\n${context.relations
        .map((r) => `- ${r.source} → ${r.target} [${r.type}]${r.value !== undefined ? ` = ${r.value}` : ''}`)
        .join('\n')}`,
    );
  }
  if (context.events.length) {
    lines.push(
      `最近世界事实（新 → 旧）：\n${context.events
        .map(
          (e) =>
            `- [${e.id}] D${e.day} ${e.type}${e.actor ? ` actor=${e.actor}` : ''}${e.target ? ` target=${e.target}` : ''}${
              e.location ? ` @ ${e.location}` : ''
            }${e.data ? ` data=${JSON.stringify(e.data)}` : ''}`,
        )
        .join('\n')}`,
    );
  }
  return lines.join('\n');
}
