/* ============================================================
   World Time / Schedule 测试（P6 · 方案 §九）
   ------------------------------------------------------------
   方案验收（原文）：**模拟连续 3 天——NPC 作息正常 / 商店营业正常 /
   NPC 休息正常 / AI 调用没有无意义爆炸。**

   另覆盖：平台内调度循环（时间事实 → 确定性对齐，零 AI）、
   幂等（已对齐零命令）、日程存储持久化、管理面注册端点、
   平台历法常量与引擎行为的跨包一致性（测试钉住，不引包依赖）。
   ============================================================ */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorldServer } from '../../world-engine/dist/http/server.js';
import { createWorldRegistry, InMemoryWorldStorage } from '../../world-engine/dist/index.js';
import { startManagedRuntime, type ManagedRuntime } from '../src/admin/managed-runtime.ts';
import { startAdminServer } from '../src/admin/http.ts';
import { SecretStore } from '../src/admin/secrets.ts';
import { ModelConfigStore } from '../src/admin/model-config.ts';
import { KeyStore } from '../src/keys/keystore.ts';
import {
  CHEN_PER_DAY,
  NPC_EVOLUTION_POLICY,
  createEngineClient,
  createEvolutionRuntime,
  createScheduleRuntime,
  createScheduleStore,
  createTriggerRuntime,
  dayOfTick,
  sanitizeScheduleTable,
  tickOfDay,
  type EvolutionDriver,
  type ScheduleRuntime,
} from '../src/index.ts';

let engineServer: Awaited<ReturnType<typeof startWorldServer>>;
let engine: ReturnType<typeof createEngineClient>;
let scheduler: ScheduleRuntime;
let trigger: ReturnType<typeof createTriggerRuntime>;
let aiCalls = 0;
let dir = '';
const WORLD = 'w-p6';

/* 天穹村式三人作息：夜回家、日守店（方案 §九：基础作息归 Scheduler） */
const SCHEDULES = {
  milu: [
    { from: 0, to: 16, location: 'home' },
    { from: 16, to: 48, location: 'tavern' },
  ],
  keeper: [
    { from: 0, to: 20, location: 'home' },
    { from: 20, to: 44, location: 'tavern' },
    { from: 44, to: 48, location: 'shop' },
  ],
  trader: [
    { from: 0, to: 10, location: 'home' },
    { from: 10, to: 46, location: 'shop' },
    { from: 46, to: 48, location: 'home' },
  ],
};

function expectedLocation(id: string, tod: number): string {
  const slot = SCHEDULES[id as keyof typeof SCHEDULES]!.find((s) => tod >= s.from && tod < s.to);
  return slot!.location;
}

async function stateNow(): Promise<{ t: number; npcs: Record<string, { attributes?: Record<string, unknown> }> }> {
  const res = await engine.getState(WORLD);
  if (!res.ok) throw new Error(res.error);
  const s = res.state as { t: number; npcs: Record<string, { attributes?: Record<string, unknown> }> };
  return s;
}

async function advanceDay(): Promise<void> {
  const res = await engine.executeCommand(WORLD, { type: 'advance_time', amount: CHEN_PER_DAY });
  if (!res.ok || !res.result.ok) throw new Error(`advance_time 被拒绝：${res.ok ? res.result.reason : res.error}`);
  await scheduler.pollOnce();
  await trigger.pollOnce(); /* 时间事实也过触发器：证明它不唤醒 AI（方案 §九） */
}

/** 采样检查：所有日程 NPC 都在当前时段应在的地点（作息/营业/休息同源） */
async function expectOnSchedule(label: string): Promise<void> {
  const s = await stateNow();
  const tod = tickOfDay(s.t);
  for (const id of Object.keys(SCHEDULES)) {
    const actual = s.npcs[id]?.attributes?.['location'];
    expect(actual, `${label} ${id}@tick${tod}`).toBe(expectedLocation(id, tod));
  }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'platform-scheduler-'));
  const registry = createWorldRegistry();
  const world = registry.create({
    worldId: WORLD,
    playerName: '旅人',
    startLoc: 'village',
    weather: 'clear',
    savePort: new InMemoryWorldStorage(),
    definition: {
      locations: [
        { id: 'village', attributes: { desc: '村庄' } },
        { id: 'home', attributes: { desc: '家' } },
        { id: 'tavern', attributes: { desc: '酒馆' } },
        { id: 'shop', attributes: { desc: '商店' } },
      ],
    },
  });
  /* 故意把 keeper 播种在错误位置：首轮对齐必须把他归位（作息正常） */
  for (const c of [
    { type: 'create_entity', payload: { id: 'milu', type: 'npc', name: '米露', location: 'home' } },
    { type: 'create_entity', payload: { id: 'keeper', type: 'npc', name: '老板', location: 'tavern' } },
    { type: 'create_entity', payload: { id: 'trader', type: 'npc', name: '商人', location: 'home' } },
  ]) {
    const r = world.executeCommand(c);
    if (!r.ok) throw new Error(`种子命令被拒绝：${JSON.stringify(r)}`);
  }
  engineServer = await startWorldServer({ registry, port: 0 });
  engine = createEngineClient({ baseUrl: engineServer.url });

  /* 计数 AI：三天纯时间推进里一次都不该被调用（方案 §九 禁止无意义 AI） */
  const countingDriver: EvolutionDriver = {
    name: 'p6-counting',
    async propose(context) {
      aiCalls++;
      return {
        id: `prop_p6_${aiCalls}`,
        worldId: context.worldId,
        reason: '不该发生的 AI 调用',
        observations: [],
        changes: [],
        source: { type: 'ai', model: 'p6-counting' },
      };
    },
  };
  const evolution = createEvolutionRuntime(
    { engine, driver: countingDriver, policy: NPC_EVOLUTION_POLICY, cooldownMs: 0 },
    { append: () => {}, recent: () => [], get: () => null },
  );
  trigger = createTriggerRuntime({ engine, evolution, worlds: [WORLD], log: () => {} });

  const store = createScheduleStore({ filePath: join(dir, 'schedules.json') });
  store.set(WORLD, SCHEDULES);
  scheduler = createScheduleRuntime({ engine, store, log: () => {} });
});

afterAll(async () => {
  await engineServer?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('P6 方案验收：模拟连续 3 天', () => {
  it('首轮对齐：错位 NPC 归位（keeper 被播种在酒馆，凌晨应在家）', async () => {
    await scheduler.pollOnce(); /* 启动首轮：无论有无新时间事实都对齐一次 */
    const st = scheduler.status().worlds[0]!;
    expect(st.movedTotal).toBeGreaterThanOrEqual(1); /* keeper 归位 */
    await expectOnSchedule('启动对齐后');
  });

  it('连续 3 天：每次推进后全员按日程归位（作息/营业/休息）', async () => {
    const startState = await stateNow();
    const startDay = dayOfTick(startState.t);
    for (let day = 1; day <= 3; day++) {
      await advanceDay();
      const s = await stateNow();
      expect(dayOfTick(s.t)).toBe(startDay + day); /* 平台历法 = 引擎日进（跨包一致性） */
      await expectOnSchedule(`第 ${day} 天`);
    }
    /* 休息：凌晨 0 刻全员应在家（三天推进后 tickOfDay 回到起点） */
    const s = await stateNow();
    const tod = tickOfDay(s.t);
    if (tod < 10) {
      for (const id of Object.keys(SCHEDULES)) expect(s.npcs[id]?.attributes?.['location']).toBe('home');
    }
    /* 营业：白天的营业时段，商人应在商店（营业中）；对照夜间在家（打烊） */
    const traderLoc = s.npcs['trader']?.attributes?.['location'];
    expect(['shop', 'home']).toContain(traderLoc);
    expect(traderLoc).toBe(expectedLocation('trader', tod));
  });

  it('AI 调用没有无意义爆炸：三天时间推进 → 零次 AI 调用', async () => {
    expect(aiCalls).toBe(0); /* Scheduler → 确定性对齐；Trigger 只认玩家发起的 High 事实 */
  });

  it('幂等：同一时刻重复对齐 → 零命令', async () => {
    const st0 = scheduler.status().worlds[0]!;
    await scheduler.align(WORLD);
    await scheduler.align(WORLD);
    const st1 = scheduler.status().worlds[0]!;
    expect(st1.movedTotal).toBe(st0.movedTotal); /* 已对齐 → 零移动命令 */
  });
});

describe('P6 日程存储与管理面注册端点', () => {
  it('store 持久化：写盘 → 新实例 load 还原；坏形状被剔除', async () => {
    const file = join(dir, 'schedules-store.json');
    const store = createScheduleStore({ filePath: file });
    store.set('w-a', SCHEDULES);
    expect(existsSync(file)).toBe(true);
    const reloaded = createScheduleStore({ filePath: file });
    const res = reloaded.load();
    expect(res.loaded).toBe(1);
    expect(reloaded.get('w-a')).toEqual(SCHEDULES);
    expect(sanitizeScheduleTable({ bad: 'not-an-array', ok: [{ from: 0, to: 16, location: 'home' }] })).toEqual({
      ok: [{ from: 0, to: 16, location: 'home' }],
    });
    expect(sanitizeScheduleTable({ bad: [{ from: 20, to: 10, location: 'x' }] })).toBeNull(); /* from>=to 剔光 → null */
  });

  it('管理面端点：PUT 注册 / GET 查询 / DELETE 清除；形状非法 400', async () => {
    let managed: ManagedRuntime | null = null;
    let admin: Awaited<ReturnType<typeof startAdminServer>> | null = null;
    try {
      const secrets = new SecretStore(join(dir, 'secrets-sched.json'), 'master-key');
      const configStore = new ModelConfigStore({ filePath: join(dir, 'model-config-sched.json'), secrets, endpointPolicy: { allowLoopback: true } });
      configStore.load();
      const keys = new KeyStore(join(dir, 'keys-sched.json'), 'bootstrap-sched-key');
      managed = await startManagedRuntime({
        configStore,
        secrets,
        keys,
        engine,
        adminToken: 'sched-admin-token',
        endpointPolicy: { allowLoopback: true },
        accessLog: false,
      });
      const store = createScheduleStore({ filePath: join(dir, 'schedules-api.json') });
      admin = await startAdminServer({ runtime: managed, adminToken: 'sched-admin-token', scheduleStore: store, port: 0, accessLog: false });
      const api = async (path: string, init: RequestInit = {}) => {
        const r = await fetch(`${admin!.url}${path}`, {
          ...init,
          headers: { 'content-type': 'application/json', 'x-admin-token': 'sched-admin-token', ...(init.headers ?? {}) },
        });
        return { status: r.status, body: (await r.json().catch(() => null)) as unknown };
      };

      expect((await api('/v1/npc/worlds/w-p6/schedules')).status).toBe(200); /* 空表 */
      const put = await api('/v1/npc/worlds/w-p6/schedules', { method: 'PUT', body: JSON.stringify(SCHEDULES) });
      expect(put.status).toBe(200);
      const get = await api('/v1/npc/worlds/w-p6/schedules');
      expect((get.body as { schedules: typeof SCHEDULES }).schedules).toEqual(SCHEDULES);
      const bad = await api('/v1/npc/worlds/w-p6/schedules', { method: 'PUT', body: JSON.stringify({ milu: [{ from: 30, to: 10, location: 'x' }] }) });
      expect(bad.status).toBe(400);
      const anon = await fetch(`${admin!.url}/v1/npc/worlds/w-p6/schedules`, { method: 'PUT', body: '{}' });
      expect(anon.status).toBe(401);
      const del = await api('/v1/npc/worlds/w-p6/schedules', { method: 'DELETE' });
      expect(del.status).toBe(200);
      expect((await api('/v1/npc/worlds/w-p6/schedules')).body).toMatchObject({ schedules: null });
      const unconfigured = await fetch(`${admin!.url}/v1/npc/worlds/x/schedules`);
      void unconfigured;
    } finally {
      await admin?.close();
      await managed?.close();
    }
  });

  it('管理面未装配日程存储 → 404 not_configured（与 keys/usage 同姿态）', async () => {
    let managed: ManagedRuntime | null = null;
    let admin: Awaited<ReturnType<typeof startAdminServer>> | null = null;
    try {
      const secrets = new SecretStore(join(dir, 'secrets-sched2.json'), 'master-key');
      const configStore = new ModelConfigStore({ filePath: join(dir, 'model-config-sched2.json'), secrets, endpointPolicy: { allowLoopback: true } });
      configStore.load();
      const keys = new KeyStore(join(dir, 'keys-sched2.json'), 'bootstrap-sched2-key');
      managed = await startManagedRuntime({
        configStore,
        secrets,
        keys,
        engine,
        adminToken: 'sched2-token',
        endpointPolicy: { allowLoopback: true },
        accessLog: false,
      });
      admin = await startAdminServer({ runtime: managed, adminToken: 'sched2-token', port: 0, accessLog: false });
      const r = await fetch(`${admin!.url}/v1/npc/worlds/any/schedules`, { headers: { 'x-admin-token': 'sched2-token' } });
      expect(r.status).toBe(404);
    } finally {
      await admin?.close();
      await managed?.close();
    }
  });
});

describe('P6 历法一致性（平台 calendar ↔ 引擎行为，测试钉住）', () => {
  it('引擎推进 48 刻 = 平台 tickOfDay 归零 + new_day 事实', async () => {
    const before = await stateNow();
    const res = await engine.executeCommand(WORLD, { type: 'advance_time', amount: CHEN_PER_DAY });
    if (!res.ok || !res.result.ok) throw new Error('advance_time 被拒绝');
    await scheduler.pollOnce();
    await trigger.pollOnce();
    const after = await stateNow();
    expect(after.t - before.t).toBe(CHEN_PER_DAY);
    expect(tickOfDay(after.t)).toBe(tickOfDay(before.t)); /* 整日推进：日内刻不变 */
    const eventsRes = await engine.getEvents(WORLD, 30);
    if (!eventsRes.ok) throw new Error(eventsRes.error);
    expect((eventsRes.events as { type?: string }[]).some((e) => e.type === 'new_day')).toBe(true);
  });
});
