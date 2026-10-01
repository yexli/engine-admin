/* ============================================================
   Evolution Context Builder（方案 §四：Observation → Context Builder）
   ------------------------------------------------------------
   把引擎的权威事实（World Truth）组装成结构化上下文。与 worldagent
   的 buildWorldContext（给聊天模型的一段散文）不同：演化上下文是
   **结构化数据**——AI 要读字段做跨系统推演，不是陪聊。

   纪律：只陈述引擎里有的字段，一个字都不编；读不到就留空，
   不用缺省值冒充事实。
   ============================================================ */
import type { EngineClient } from '../types.ts';
import type { EvolutionContext } from './types.ts';

/* 引擎 GET /state 响应的最小读取面（允许字段缺失） */
interface StateView {
  t?: number;
  weather?: string;
  player?: { name?: string; loc?: string; bag?: unknown[] };
  npcs?: Record<string, { att?: number; met?: boolean; type?: string; attributes?: Record<string, unknown> }>;
  relations?: { source: string; target: string; type: string; value?: number }[];
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

  const entities: EvolutionContext['entities'] = {};
  for (const [id, n] of Object.entries(s.npcs ?? {})) {
    entities[id] = {
      att: typeof n.att === 'number' ? n.att : 0,
      met: n.met === true,
      ...(n.type !== undefined ? { type: n.type } : {}),
      ...(n.attributes?.['location'] !== undefined ? { location: String(n.attributes['location']) } : {}),
      ...(n.attributes !== undefined ? { attributes: n.attributes } : {}),
    };
  }

  const context: EvolutionContext = {
    worldId,
    builtAt: new Date().toISOString(),
    tick: typeof s.t === 'number' ? s.t : 0,
    day: typeof s.t === 'number' ? Math.floor(s.t / 96) + 1 : 0,
    weather: s.weather ?? '',
    player: {
      name: s.player?.name ?? 'player',
      loc: s.player?.loc ?? '',
      bagSize: Array.isArray(s.player?.bag) ? s.player.bag.length : 0,
    },
    entities,
    relations: (s.relations ?? []).map((r) => ({
      source: r.source,
      target: r.target,
      type: r.type,
      ...(r.value !== undefined ? { value: r.value } : {}),
    })),
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
  lines.push(`玩家 ${context.player.name} 在 ${context.player.loc || '未知'}（随身 ${context.player.bagSize} 项）`);
  const ids = Object.keys(context.entities);
  if (ids.length) {
    lines.push(
      `实体：\n${ids
        .map((id) => {
          const e = context.entities[id]!;
          return `- ${id}（${e.type ?? 'entity'}）att=${e.att} ${e.met ? '已认识玩家' : '未见过玩家'}${
            e.location ? ` @ ${e.location}` : ''
          }${e.attributes ? ` attributes=${JSON.stringify(e.attributes)}` : ''}`;
        })
        .join('\n')}`,
    );
  }
  if (context.relations.length) {
    lines.push(
      `关系：\n${context.relations
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
