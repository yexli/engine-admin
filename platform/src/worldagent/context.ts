/* ============================================================
   world-agent 上下文组装（Phase 1 · 方案 §20）
   ------------------------------------------------------------
   把 World Engine 的权威事实（World Truth）变成 system 上下文：
   时间 / 天气 / 玩家 / NPC / 最近事件。只陈述事实，不替 AI 决定
   剧情走向——叙事取舍交给被路由到的模型。
   ============================================================ */
import type { EngineClient } from '../types.ts';

/* 引擎状态的最小读取面（与 GET /state 响应同形，允许字段缺失） */
interface WorldStateView {
  worldId?: string;
  t?: number;
  weather?: string;
  player?: { name?: string; loc?: string; bag?: unknown[] };
  npcs?: Record<string, { att?: number; met?: boolean; type?: string; attributes?: Record<string, unknown> }>;
  locations?: Record<string, unknown>;
}

interface WorldEventView {
  id?: string;
  type?: string;
  day?: number;
  tick?: number;
  actor?: string;
  target?: string;
}

export async function buildWorldContext(
  engine: EngineClient,
  worldId: string,
  eventN = 10,
): Promise<{ ok: true; context: string } | { ok: false; status: number; error: string }> {
  const [stateRes, eventsRes] = await Promise.all([
    engine.getState(worldId),
    engine.getEvents(worldId, eventN),
  ]);
  if (!stateRes.ok) return { ok: false, status: stateRes.status, error: stateRes.error };
  if (!eventsRes.ok) return { ok: false, status: eventsRes.status, error: eventsRes.error };

  const s = (stateRes.state ?? {}) as WorldStateView;
  const events = (eventsRes.events ?? []) as WorldEventView[];

  const lines: string[] = [];
  lines.push(`World ID: ${s.worldId ?? worldId}`);
  if (typeof s.t === 'number') lines.push(`世界刻度 tick: ${s.t}`);
  if (s.weather) lines.push(`天气: ${s.weather}`);
  if (s.player) {
    lines.push(
      `玩家: ${s.player.name ?? 'player'} @ ${s.player.loc ?? '未知'}${
        Array.isArray(s.player.bag) ? `（随身 ${s.player.bag.length} 项）` : ''
      }`,
    );
  }
  const npcIds = Object.keys(s.npcs ?? {});
  if (npcIds.length) {
    const npcLines = npcIds.map((id) => {
      const n = s.npcs?.[id] ?? {};
      const name = typeof n.attributes?.['name'] === 'string' ? (n.attributes['name'] as string) : id;
      return `- ${name}（${id}）：att=${n.att ?? 0}，${n.met ? '已认识玩家' : '未见过玩家'}`;
    });
    lines.push(`在场 NPC：\n${npcLines.join('\n')}`);
  }
  if (events.length) {
    const evLines = events
      .slice(0, eventN)
      .map(
        (e) =>
          `- [D${e.day ?? '?'}·${e.tick ?? '?'}] ${e.type ?? 'unknown'}${
            e.actor ? `（actor=${e.actor}` : ''
          }${e.actor && e.target ? `, target=${e.target}）` : e.actor ? '）' : ''}`,
      );
    lines.push(`最近世界事实（新 → 旧）：\n${evLines.join('\n')}`);
  }

  const context = lines.join('\n');
  const system = [
    '你是 World Driving Engine 平台的 world-agent。下面是当前世界的权威事实（World Truth），',
    '基于事实回应玩家/客户端；不要编造世界中不存在的人、物、事件；世界之外的问题正常回答。',
    '',
    '<world-context>',
    context,
    '</world-context>',
  ].join('\n');
  return { ok: true, context: system };
}
