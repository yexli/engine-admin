/* ============================================================
   V2.4 Runtime Hardening 加固补丁测试（2026-10 复审轮）
   ------------------------------------------------------------
   基线复审发现的缺口逐项钉死：
     ✓ 重启后事件 id 序号续接——新事实不撞车、不静默丢史（P1）
     ✓ 缺省作用域多世界不互相污染环与世界史（事件 worldId 归属，P1）
     ✓ 死信（限流/熔断丢弃）也是世界事实，入史且原因留痕（P2）
     ✓ setSavePort 后装介质吸收既有世界史（P2）
     ✓ 命令幂等账跨重启（SavePort 账本通道，P2）
     ✓ 世界史/幂等账损坏 → 备份留证不静默覆盖（P2）
     ✓ HTTP /events?n 上界钳制（P3）
   ============================================================ */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSavePort } from '../src/state/fileStorage.ts';
import { InMemoryWorldStorage } from '../src/state/storage.ts';
import { createWorld } from '../src/index.ts';
import { createWorldHttp } from '../src/http/index.ts';

let dir = '';
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'engine-v24-hardening-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 产生确定性的世界活动：建 NPC → 移动两次 */
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

describe('V2.4 加固 · 重启序号续接（P1）', () => {
  it('重启后新事件 id 不与历史撞车，且进入世界史（不再静默丢失）', () => {
    const port = new InMemoryWorldStorage();
    const w1 = createWorld({ worldId: 'w-seq', playerName: '旅人', startLoc: 'village', savePort: port });
    drive(w1);
    const ids1 = new Set(w1.queryEvents!().map((e) => e.id));
    expect(ids1.size).toBeGreaterThanOrEqual(3);

    /* 「重启」：新世界实例挂同一 SavePort */
    const w2 = createWorld({ worldId: 'w-seq', playerName: '旅人', startLoc: 'village', savePort: port });
    const r = w2.executeCommand({ type: 'move', targetId: 'tavern' });
    expect(r.ok).toBe(true);
    const fresh = w2.queryEvents!({ type: 'player_moved' })[0]!;
    /* 关键断言 1：新事件 id 是全新序号（修复前 = evt_1_1 撞历史首条） */
    expect(ids1.has(fresh.id)).toBe(false);
    /* 关键断言 2：新事实在世界史里（queryEvents 查的就是 worldLog；
       修复前撞车事件只进环形窗口、永不入史） */
    expect(fresh.id).toMatch(/^evt_\d+_\d+$/);
    /* 继续推进：全程无重复 id */
    w2.executeCommand({ type: 'move', targetId: 'village' });
    const ids = w2.queryEvents!().map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('序号续接绝不回退（多世界共享缺省序号域时取 max）', () => {
    const old = new InMemoryWorldStorage();
    old.saveWorldLog([{ id: 'evt_1_50', type: 'ancient', day: 1, tick: 0 } as never]);
    const w = createWorld({ worldId: 'w-seq-max', playerName: '旅人', startLoc: 'village', savePort: old });
    const e = w.emitEvent({ type: 'probe', day: 1 });
    expect(e.id).toBe('evt_1_51'); /* 从 50 续接，不是 evt_1_1 */
  });
});

describe('V2.4 加固 · 缺省作用域多世界归属过滤（P1）', () => {
  it('命名世界的事实不再渗入其他世界的环与世界史', () => {
    const a = createWorld({ worldId: 'w-poll-a', playerName: '旅人', startLoc: 'village', savePort: new InMemoryWorldStorage() });
    const b = createWorld({ worldId: 'w-poll-b', playerName: '旅人', startLoc: 'village', savePort: new InMemoryWorldStorage() });
    const r = a.executeCommand({ type: 'create_entity', payload: { id: 'onlyA', type: 'npc', name: '只属于A', location: 'tavern' } });
    expect(r.ok).toBe(true);

    /* B 的环与史零渗透（修复前：A 的事实会进 B 的 ring 和 worldLog） */
    expect(b.getEvents(200)).toHaveLength(0);
    expect(b.queryEvents!()).toHaveLength(0);

    /* 事件自带世界归属 */
    const ev = a.getEvents(1)[0]!;
    expect(ev.worldId).toBe('w-poll-a');

    /* B 自己的事实照常产生与记账 */
    const rb = b.executeCommand({ type: 'move', targetId: 'tavern' });
    expect(rb.ok).toBe(true);
    expect(b.queryEvents!({ type: 'player_moved' })).toHaveLength(1);
    /* A 的史不受 B 影响 */
    expect(a.queryEvents!({ type: 'player_moved' })).toHaveLength(0);
    /* 双方世界史各自完整、互不掺杂 */
    expect(a.queryEvents!({ target: 'onlyA' }).length).toBeGreaterThan(0);
    expect(b.queryEvents!({ target: 'onlyA' })).toHaveLength(0);
  });

  it('未命名世界保持缺省单世界语义（不过滤，兼容既有宿主）', () => {
    const w = createWorld({ playerName: '旅人', startLoc: 'village', savePort: new InMemoryWorldStorage() });
    w.executeCommand({ type: 'move', targetId: 'tavern' });
    const ev = w.getEvents(1)[0]!;
    expect(ev.worldId).toBeUndefined(); /* 未标注归属 */
    expect(w.queryEvents!({ type: 'player_moved' })).toHaveLength(1);
  });
});

describe('V2.4 加固 · 死信入史（P2）', () => {
  it('限流丢弃的事件同样进世界史，丢弃原因留痕', () => {
    const w = createWorld({ worldId: 'w-dead', playerName: '旅人', startLoc: 'village', isolated: true, savePort: new InMemoryWorldStorage() });
    /* ambient 通道单 tick 上限 64：70 条同 tick 事件 → 64 派发 + 6 死信 */
    for (let i = 0; i < 70; i++) w.emitEvent({ type: 'chatter', day: 1, tick: i });

    const all = w.queryEvents!({ type: 'chatter' });
    expect(all).toHaveLength(70); /* 世界史无空洞 */
    const dead = all.filter((e) => (e.data as Record<string, unknown> | undefined)?.deadLetter !== undefined);
    expect(dead.length).toBe(6);
    expect(String(dead[0]!.data!.deadLetter)).toContain('cap');
    /* 死信同样可查观测窗口（getEvents 环内可见） */
    expect(w.getEvents(200).some((e) => (e.data as Record<string, unknown> | undefined)?.deadLetter !== undefined)).toBe(true);
  });
});

describe('V2.4 加固 · setSavePort 后装介质（P2）', () => {
  it('后装介质吸收既有世界史 + 序号续接，不再覆盖档案', () => {
    const port = new InMemoryWorldStorage();
    port.saveWorldLog([{ id: 'evt_1_9', type: 'ancient_fact', day: 1, tick: 0 } as never]);
    const w = createWorld({ worldId: 'w-late', playerName: '旅人', startLoc: 'village' }); /* 不带介质启动 */
    w.executeCommand({ type: 'move', targetId: 'tavern' }); /* 内存事实（此刻无史通道） */
    w.setSavePort(port);

    /* 历史吸收 + 内存事实保留 */
    expect(w.queryEvents!({ type: 'ancient_fact' })).toHaveLength(1);
    expect(w.queryEvents!({ type: 'player_moved' })).toHaveLength(1);
    /* 序号续接：新事件不撞 evt_1_9 */
    w.executeCommand({ type: 'move', targetId: 'village' });
    const ids = w.queryEvents!().map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    /* 介质与内存史一致（下一条事件不会用空史覆盖档案） */
    const saved = port.loadWorldLog() as { id: string }[];
    expect(saved.some((r) => r.id === 'evt_1_9')).toBe(true);
    expect(saved.length).toBe(w.queryEvents!().length);
  });
});

describe('V2.4 加固 · 命令幂等账跨重启（P2）', () => {
  it('重启后同 commandId 重试：幂等命中、世界不再变化', () => {
    const port = new InMemoryWorldStorage();
    const w1 = createWorld({ worldId: 'w-idem', playerName: '旅人', startLoc: 'village', savePort: port });
    const r1 = w1.executeCommand({ type: 'move', targetId: 'tavern', commandId: 'cmd-1' });
    expect(r1.ok).toBe(true);

    /* 介质上已有账本行（首次结果） */
    const ledger = port.loadCommandLedger() as { commandId: string; result: { ok: boolean; events: string[] } }[];
    const row = ledger.find((r) => r.commandId === 'cmd-1');
    expect(row?.result.ok).toBe(true);
    expect(row?.result.events).toEqual(r1.events);

    /* 「重启」：同介质新实例——跨重启重试不再重复执行 */
    const w2 = createWorld({ worldId: 'w-idem', playerName: '旅人', startLoc: 'village', savePort: port });
    const before = w2.queryEvents!().length;
    const r2 = w2.executeCommand({ type: 'move', targetId: 'tavern', commandId: 'cmd-1' });
    expect(r2.duplicate).toBe(true);
    expect(r2.events).toEqual(r1.events);
    expect(w2.queryEvents!().length).toBe(before); /* 零新事实 */
    expect((w2.getState() as { player: { loc: string } }).player.loc).toBe('village'); /* 未移动 */
  });

  it('损坏的幂等账：备份留证、返回 null，不静默覆盖', () => {
    const path = join(dir, 'w-ledger-corrupt.json');
    const p1 = new FileSavePort(path, { debounceMs: 50_000 });
    p1.saveCommandLedger([{ commandId: 'c1', result: { ok: true, events: [] } }]);
    p1.flush();
    p1.dispose();
    writeFileSync(`${path}.commands.json`, '{oops', 'utf8');

    const errors: string[] = [];
    const p2 = new FileSavePort(path, { debounceMs: 50_000, onError: (m) => errors.push(m) });
    expect(p2.loadCommandLedger()).toBeNull();
    expect(errors.some((m) => m.includes('幂等账'))).toBe(true);
    /* 坏档被改名备份（可修复，绝不无声销毁） */
    expect(existsSync(`${path}.commands.json`)).toBe(false);
    expect(readdirSync(dir).some((f) => f.startsWith('w-ledger-corrupt.json.commands.json.corrupt-'))).toBe(true);
    p2.dispose();
  });

  it('FileSavePort 幂等账落盘往返', () => {
    const path = join(dir, 'w-ledger-roundtrip.json');
    const p1 = new FileSavePort(path, { debounceMs: 50_000 });
    p1.saveCommandLedger([
      { commandId: 'c1', result: { ok: true, events: ['evt_1_1'] } },
      { commandId: 'c2', result: { ok: false, events: [], reason: '规则 MoveRule 拒绝了命令 move' } },
    ]);
    p1.flush();
    p1.dispose();
    const p2 = new FileSavePort(path, { debounceMs: 50_000 });
    expect(p2.loadCommandLedger()).toEqual([
      { commandId: 'c1', result: { ok: true, events: ['evt_1_1'] } },
      { commandId: 'c2', result: { ok: false, events: [], reason: '规则 MoveRule 拒绝了命令 move' } },
    ]);
    p2.dispose();
  });
});

describe('V2.4 加固 · 世界史损坏备份（P2）', () => {
  it('损坏的世界史文件被备份留证，不被静默覆盖', () => {
    const path = join(dir, 'w-log-corrupt.json');
    const p1 = new FileSavePort(path, { debounceMs: 50_000 });
    p1.saveWorldLog([{ id: 'evt_1_1', type: 'x', day: 1, tick: 0 } as never]);
    p1.flush();
    p1.dispose();
    writeFileSync(`${path}.log.json`, 'not-json{{', 'utf8');

    const errors: string[] = [];
    const p2 = new FileSavePort(path, { debounceMs: 50_000, onError: (m) => errors.push(m) });
    expect(p2.loadWorldLog()).toBeNull();
    expect(errors.some((m) => m.includes('世界史损坏'))).toBe(true);
    expect(existsSync(`${path}.log.json`)).toBe(false);
    expect(readdirSync(dir).some((f) => f.startsWith('w-log-corrupt.json.log.json.corrupt-'))).toBe(true);
    /* 备份之后的新写入是干净档案（恢复语义：同 id 保末次） */
    p2.saveWorldLog([]);
    p2.flush();
    expect(p2.loadWorldLog()).toEqual([]);
    p2.dispose();
  });
});

describe('V2.4 加固 · HTTP /events?n 上界（P3）', () => {
  it('n 超大值被钳制，全量检索走过滤路径且带 total', async () => {
    const w = createWorld({ worldId: 'w-cap', playerName: '旅人', startLoc: 'village', savePort: new InMemoryWorldStorage() });
    for (let i = 0; i < 600; i++) w.emitEvent({ type: 'chatter', day: 1, tick: i });
    const http = createWorldHttp({ world: w as never });
    const u = new URL('/v1/worlds/w-cap/events?type=chatter&n=100000', 'http://x');
    const query: Record<string, string> = {};
    for (const [k, v] of u.searchParams) query[k] = v;
    const res = await http.handle({ method: 'GET', path: u.pathname, query } as never);
    const body = res.body as { events: unknown[]; total: number };
    expect(res.status).toBe(200);
    expect(body.events.length).toBeLessThanOrEqual(500); /* 钳制生效 */
    expect(body.total).toBeGreaterThan(500); /* 全量仍在史中，total 如实 */
  });
});
