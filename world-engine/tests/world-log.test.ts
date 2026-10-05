/* ============================================================
   Event Persistence 测试（V2.4-01 · 方案 §五）
   ------------------------------------------------------------
   验收清单（方案 §5.5 逐项）：
     ✓ Event 重启后仍存在          （恢复：新世界实例读同一 SavePort）
     ✓ Event ID 唯一               （同 id 多行保首次去重）
     ✓ World 隔离                  （每世界独立事件史）
     ✓ 顺序稳定                    （append 顺序 = 恢复顺序）
     ✓ 可按时间/实体查询           （queryEvents 过滤 + HTTP 参数）
     ✓ Evolution Event 可追踪 Run  （P9 因果链，另测覆盖）
     ✓ 普通业务不能覆盖 Event      （无任何公开写路径；append-only）
     ✓ 重复写入不会制造重复事实    （同 id 幂等）
   ============================================================ */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSavePort } from '../src/state/fileStorage.ts';
import { InMemoryWorldStorage } from '../src/state/storage.ts';
import { createWorld } from '../src/index.ts';
import { createWorldHttp } from '../src/http/index.ts';

let dir = '';
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'engine-worldlog-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 产生确定性的世界活动：建 NPC → 移动两次（3+2 条事实） */
function drive(w: ReturnType<typeof createWorld>): void {
  for (const c of [
    { type: 'create_entity', payload: { id: 'milu', type: 'npc', name: '米露', location: 'tavern' } },
    { type: 'move', targetId: 'tavern' },
    { type: 'move', targetId: 'village' },
  ]) {
    const r = w.executeCommand(c);
    if (!r.ok) throw new Error(`命令被拒：${JSON.stringify(r)}`);
  }
}

describe('V2.4-01 事件持久化（append-only 世界事件史）', () => {
  it('重启恢复：事件在进程「重启」（新世界实例）后仍存在，顺序稳定', async () => {
    const port = new FileSavePort(join(dir, 'w-recover.json'), { debounceMs: 50_000 });
    const w1 = createWorld({ worldId: 'w-log', playerName: '旅人', startLoc: 'village', savePort: port });
    drive(w1);
    const ids1 = w1.getEvents(200).map((e) => e.id).reverse(); /* 旧 → 新 */
    expect(ids1.length).toBeGreaterThanOrEqual(3); /* create 1 + move 2 */
    expect(w1.getEvents(200)[0]?.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/); /* 墙钟时间戳 */
    port.flush();

    /* 「重启」：新世界实例挂同一 SavePort（事件史自动恢复；状态恢复是宿主既有正典模式，另测） */
    const w2 = createWorld({ worldId: 'w-log', playerName: '旅人', startLoc: 'village', savePort: port });
    const ids2 = w2.getEvents(200).map((e) => e.id).reverse();
    expect(ids2).toEqual(ids1); /* 顺序稳定、全部仍在 */
    /* 追加：恢复后的世界继续产生事实，旧事实不丢 */
    const before = w2.getEvents(200).length;
    w2.executeCommand({ type: 'move', targetId: 'tavern' });
    expect(w2.getEvents(200).length).toBe(before + 1);
    port.dispose();
  });

  it('幂等恢复：同 id 多行保首次（P2 卡片6 统一 append-only 语义），重复写入不制造重复事实', async () => {
    const port = new FileSavePort(join(dir, 'w-dup.json'), { debounceMs: 50_000 });
    const row = (v: string) => ({ id: 'evt_1_1', type: 'entity_updated', day: 1, tick: v, ts: '2026-01-01T00:00:00Z' });
    port.saveWorldLog([
      row('第一次') as never,
      { id: 'evt_1_2', type: 'new_day', day: 2, tick: 0 } as never,
      row('末次（真相）') as never,
    ]);
    port.flush(); /* 落盘（loadWorldLog 读磁盘文件） */
    const w = createWorld({ worldId: 'w-dup', playerName: '旅人', startLoc: 'village', savePort: port });
    const dup = w.queryEvents!({ id: 'evt_1_1' });
    expect(dup).toHaveLength(1); /* 同 id 只剩一条 */
    expect(dup[0]!.tick).toBe('第一次'); /* 保首次：事实不可变，后行不覆盖前行 */
    port.dispose();
  });

  it('World 隔离：isolated 世界各自独立事件史（事件不跨世界）', async () => {
    /* 隔离语义必须用 isolated:true（缺省共享全局总线是 DR-001 文档化行为） */
    const a = createWorld({ worldId: 'w-iso-a', playerName: '旅人', startLoc: 'village', isolated: true, savePort: new InMemoryWorldStorage() });
    const b = createWorld({ worldId: 'w-iso-b', playerName: '旅人', startLoc: 'village', isolated: true, savePort: new InMemoryWorldStorage() });
    a.executeCommand({ type: 'create_entity', payload: { id: 'onlyA', type: 'npc', name: '只属于A', location: 'tavern' } });
    b.executeCommand({ type: 'create_entity', payload: { id: 'onlyB', type: 'npc', name: '只属于B', location: 'tavern' } });
    a.executeCommand({ type: 'move', targetId: 'tavern' });
    b.executeCommand({ type: 'move', targetId: 'market' });
    /* 事件史隔离：A 的历史只含 A 的活动，B 看不到 onlyA，A 看不到 onlyB */
    expect(a.queryEvents!({ target: 'onlyB' })).toHaveLength(0);
    expect(b.queryEvents!({ target: 'onlyA' })).toHaveLength(0);
    expect(a.queryEvents!({ target: 'onlyA' }).length).toBeGreaterThan(0);
    expect(b.queryEvents!({ target: 'onlyB' }).length).toBeGreaterThan(0);
    /* 同 id 可在不同世界各自存在（作用域内唯一）——这不是隔离破坏 */
    expect(a.getEvents(200).length).toBeGreaterThan(0);
    expect(b.getEvents(200).length).toBeGreaterThan(0);
  });

  it('查询：可按实体 / 类型 / 世界日 / 因果过滤全量历史', async () => {
    const w = createWorld({ worldId: 'w-q', playerName: '旅人', startLoc: 'village', savePort: new InMemoryWorldStorage() });
    w.executeCommand({ type: 'create_entity', payload: { id: 'milu', type: 'npc', name: '米露', location: 'tavern' } });
    const moveId = w.executeCommand({ type: 'move', targetId: 'tavern' }).events[0]!;
    w.executeCommand({ type: 'advance_time', amount: 48 });
    w.executeCommand({ type: 'move', targetId: 'village' });

    /* 按实体 */
    const byActor = w.queryEvents!({ actor: 'player' });
    expect(byActor.length).toBeGreaterThanOrEqual(2); /* 两次 move（create_entity 无 actor 归因） */
    expect(byActor.every((e) => e.actor === 'player')).toBe(true);
    /* 按类型 */
    const moves = w.queryEvents!({ type: 'player_moved' });
    expect(moves.length).toBe(2);
    /* 按时间（世界日区间）：推进一天后的 move 在 D2，前两步在 D1 */
    expect(w.queryEvents!({ type: 'player_moved', dayFrom: 2 }).length).toBe(1);
    expect(w.queryEvents!({ type: 'player_moved', dayTo: 1 }).length).toBe(1);
    /* 按因果（parentId / sourceId 命中）：move 事实可由其 id 追溯 */
    const causal = w.queryEvents!({ causedBy: moveId });
    expect(causal.every((e) => e.parentId === moveId || e.sourceId === moveId)).toBe(true);
    /* 新 → 旧序与 getEvents 同序 */
    expect(w.queryEvents!().map((e) => e.id)).toEqual(w.getEvents(200).map((e) => e.id));
  });

  it('append-only：引擎不提供任何覆盖/删除事件史的公开路径', async () => {
    const w = createWorld({ worldId: 'w-ao', playerName: '旅人', startLoc: 'village', savePort: new InMemoryWorldStorage() });
    const handle = w as unknown as Record<string, unknown>;
    /* 唯一历史写入口是内部 worldLog 挂载（无公开 mutator）——逐项核对公开面 */
    for (const key of ['removeEvents', 'clearEvents', 'overwriteLog', 'deleteEvent', 'truncateLog']) {
      expect(handle[key]).toBeUndefined();
    }
    const before = w.getEvents(200).length;
    w.executeCommand({ type: 'move', targetId: 'tavern' }); /* 旧事实永远保留 */
    expect(w.queryEvents!({ type: 'move_failed' }).length).toBe(0); /* 无删改痕迹 */
    expect(w.getEvents(200).length).toBe(before + 1);
  });
});

describe('V2.4-01 HTTP 事件史过滤', () => {
  it('GET events 带过滤参数 → 走事件史；无参数 → 热窗口快路径', async () => {
    const port = new InMemoryWorldStorage();
    const w = createWorld({ worldId: 'w-http', playerName: '旅人', startLoc: 'village', savePort: port });
    w.executeCommand({ type: 'create_entity', payload: { id: 'milu', type: 'npc', name: '米露', location: 'tavern' } });
    w.executeCommand({ type: 'move', targetId: 'tavern' });
    const http = createWorldHttp({ world: w as never });

    const get = async (pathWithQuery: string) => {
      const u = new URL(pathWithQuery, 'http://x');
      const query: Record<string, string> = {};
      for (const [k, v] of u.searchParams) query[k] = v;
      const res = await http.handle({ method: 'GET', path: u.pathname, query } as never);
      return { status: res.status, body: res.body as { events?: { type: string }[]; total?: number } };
    };

    const byActor = await get('/v1/worlds/w-http/events?actor=player&log=1');
    expect(byActor.status).toBe(200);
    expect(byActor.body.events?.every((e) => e.type === 'player_moved')).toBe(true);

    const full = await get('/v1/worlds/w-http/events?log=1');
    expect(full.body.total).toBeGreaterThan(0);

    const hot = await get('/v1/worlds/w-http/events?n=5');
    expect(hot.body.events?.length).toBeLessThanOrEqual(5); /* 快路径不变 */
  });
});
