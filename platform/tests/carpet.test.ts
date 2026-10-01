/* ============================================================
   真人式地毯测试（方案 V2 §八：不允许只跑 npm test 就宣布完成）
   ------------------------------------------------------------
   模拟连续真人流程（真实引擎 + 真实 Rules 链 + 脚本化 AI + 第一阶段策略）：

     进入村庄 → 进入酒馆 → 寻找米露 → 与米露聊天 → 离开酒馆 → 去商店
     → 购买物品 → 等待/时间推进 → 第二天返回酒馆 → 再次寻找米露 → 检查 NPC 状态

   每一步断言方案 §八 重点排查项：
     NPC 无故移动 / NPC 无故回复 / NPC 无限回复 / 重复 Event / 状态跳变 /
     关系异常增长 / 经济异常 / 事件循环 / AI 无限触发 / Proposal 重复执行 /
     Event 重复消费 / 状态与 Journal 不一致 / OOC 穿透

   脚本化驱动只配 6 步：若闭环出现多触发的死循环，第 7 次驱动调用会
   抛「脚本耗尽」当场失败——AI 无限触发被结构性暴露。
   ============================================================ */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorldServer } from '../../world-engine/dist/http/server.js';
import { createWorldRegistry, InMemoryWorldStorage } from '../../world-engine/dist/index.js';
import {
  NPC_EVOLUTION_POLICY,
  createEngineClient,
  createEvolutionJournal,
  createEvolutionRuntime,
  createEventConsumer,
  createScriptedDriver,
  type EvolutionRun,
} from '../src/index.ts';

let engineServer: Awaited<ReturnType<typeof startWorldServer>>;
let engine: ReturnType<typeof createEngineClient>;
let dir = '';
const WORLD = 'w-carpet';

interface StateShape {
  t: number;
  player: { loc: string; attributes?: Record<string, unknown> };
  npcs: Record<string, { att: number; met: boolean; attributes?: Record<string, unknown> }>;
  relations: { source: string; target: string; type: string; value?: number }[];
}

async function state(): Promise<StateShape> {
  const res = await engine.getState(WORLD);
  if (!res.ok) throw new Error(res.error);
  return res.state as StateShape;
}

async function gameCmd(type: string, extra: Record<string, unknown> = {}): Promise<{ ok: boolean; events: string[]; reason?: string }> {
  /* 游戏方命令（与 AI 无关的确定性玩法：移动/交谈/购买/时间）——走同一条命令链 */
  const res = await engine.executeCommand(WORLD, { type, ...extra });
  return res.ok ? res.result : { ok: false, events: [], reason: res.error };
}

/* 游戏侧事件消费（幂等；与 tianqiong-host 同款）。
   触发判定按「本批新事实」算（方案 §五：事件驱动，不是窗口驱动） */
const consumer = createEventConsumer({ consumerId: 'carpet-player' });
async function consume(): Promise<{ ids: string[]; shouldTrigger: boolean }> {
  const res = await engine.getEvents(WORLD, 50);
  if (!res.ok) throw new Error(res.error);
  const fresh = consumer.feed(res.events as { id: string; type: string; actor?: string }[]);
  return { ids: fresh.map((e) => e.id!), shouldTrigger: fresh.some((e) => e.grade === 'high') };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'platform-carpet-'));
  const registry = createWorldRegistry();
  const w = registry.create({
    worldId: WORLD,
    playerName: '旅人',
    startLoc: 'village',
    weather: 'clear',
    savePort: new InMemoryWorldStorage(),
  });
  for (const c of [
    { type: 'create_entity', payload: { id: 'milu', type: 'npc', name: '米露', location: 'tavern', attributes: { mood: '平静' } } },
    { type: 'create_entity', payload: { id: 'keeper', type: 'npc', name: '酒馆老板老周', location: 'tavern', attributes: { mood: '平静', ale_stock: 10, money: 200 } } },
    { type: 'create_entity', payload: { id: 'trader', type: 'npc', name: '商人老葛', location: 'shop', attributes: { mood: '平静', goods_rice: 50, money: 100 } } },
    { type: 'update_attribute', targetId: 'player', payload: { key: 'money', value: 50 } },
    { type: 'update_attribute', targetId: 'player', payload: { key: 'item_rice', value: 0 } },
  ]) {
    const r = w.executeCommand(c);
    if (!r.ok) throw new Error(`种子命令被拒绝：${JSON.stringify(r)}`);
  }
  engineServer = await startWorldServer({ registry, port: 0 });
  engine = createEngineClient({ baseUrl: engineServer.url });
  evo = createEvolutionRuntime(
    { engine, driver: createScriptedDriver(SCRIPT_STEPS), policy: NPC_EVOLUTION_POLICY, cooldownMs: 0 },
    journal,
  );
});

afterAll(async () => {
  await engineServer?.close();
  rmSync(dir, { recursive: true, force: true });
});

/* 演化运行时（第一阶段策略 + 脚本化驱动恰好 6 步）；
   engine 在 beforeAll 赋值，运行时随之在 beforeAll 组装 */
const journal = createEvolutionJournal();
let evo: ReturnType<typeof createEvolutionRuntime>;

const SCRIPT_STEPS: Parameters<typeof createScriptedDriver>[0] = [
      /* 第 1 步触发（进入酒馆）：米露在忙，没有注意——玩家行为 ≠ NPC 必须响应 */
      { reason: '米露正在后厨忙碌，没有注意到进来的客人', observations: [{ ref: 'state', kind: 'state' }], changes: [] },
      /* 第 2 步触发（玩家主动搭话）：这次米露回应了 */
      {
        reason: '玩家主动打招呼，米露放下杯子回应',
        observations: [{ ref: 'state', kind: 'state' }],
        changes: [
          { targetId: 'milu', action: 'update_attribute', payload: { key: 'mood', value: '好奇' }, reason: '生面孔搭话' },
          { targetId: 'milu', action: 'set_relation', payload: { type: 'noticed', otherId: 'player', value: 10 }, reason: '记住了这位客人' },
        ],
      },
      /* 第 3 步触发（与老板聊天）：老板回应；米露继续自己的事（未被强制） */
      {
        reason: '老周爱聊天，米露没有加入',
        observations: [{ ref: 'state', kind: 'state' }],
        changes: [{ targetId: 'keeper', action: 'update_attribute', payload: { key: 'mood', value: '热情' }, reason: '有客人陪他说话' }],
      },
      /* 第 4 步触发（离开酒馆）：没人关注 */
      { reason: '客人走了，店内继续各自的活计', observations: [{ ref: 'state', kind: 'state' }], changes: [] },
      /* 第 5 步触发（进入商店）：商人招呼 */
      {
        reason: '来了买主，商人很高兴',
        observations: [{ ref: 'state', kind: 'state' }],
        changes: [{ targetId: 'trader', action: 'update_attribute', payload: { key: 'mood', value: '高兴' }, reason: '有生意上门' }],
      },
      /* 第 6 步触发（第二天回酒馆）：米露记得这位客人 */
      {
        reason: '昨天那位客人又来了',
        observations: [{ ref: 'state', kind: 'state' }],
        changes: [
          { targetId: 'milu', action: 'update_attribute', payload: { key: 'mood', value: '开心' }, reason: '熟客回来' },
          { targetId: 'milu', action: 'set_relation', payload: { type: 'noticed', otherId: 'player', value: 25 }, reason: '好感加深（upsert 而非新增边）' },
        ],
      },
];

const runs: EvolutionRun[] = [];
async function evolve(): Promise<EvolutionRun> {
  const run = await evo.tick(WORLD, 'auto'); /* 事件驱动自动触发（High 事件由消费侧判定） */
  runs.push(run);
  return run;
}

describe('地毯流程（方案 V2 §八）', () => {
  it('① 进入村庄：初始视图', async () => {
    const s = await state();
    expect(s.player.loc).toBe('village');
    expect(s.player.attributes?.['money']).toBe(50);
    expect(s.npcs['milu']!.attributes?.['location']).toBe('tavern');
    const c = await consume();
    expect(c.shouldTrigger).toBe(false); /* 初始低价值事实不触发演化 */
  });

  it('② 进入酒馆：High 事件触发演化；米露没有注意（不强制响应）', async () => {
    const r = await gameCmd('move', { targetId: 'tavern' });
    expect(r.ok).toBe(true);
    const c = await consume();
    expect(c.shouldTrigger).toBe(true); /* player_moved = High */
    const run = await evolve();
    expect(run.status).toBe('completed'); /* 空提案 = 合法结论，不是失败 */
    expect(run.acceptedCount).toBe(0);
    const s = await state();
    expect(s.npcs['milu']!.attributes?.['mood']).toBe('平静'); /* 世界分毫未动 */
    expect(s.npcs['milu']!.met).toBe(false);
  });

  it('③ 寻找米露并聊天：这次米露回应（玩家主动交互才提升优先级）', async () => {
    const talk = await gameCmd('talk', { targetId: 'milu', text: '米露，你好。' });
    expect(talk.ok).toBe(true);
    await consume();
    const run = await evolve();
    expect(run.status).toBe('completed');
    expect(run.acceptedCount).toBe(2);
    const s = await state();
    expect(s.npcs['milu']!.met).toBe(true); /* 首谈记「正式见过」（引擎规则） */
    expect(s.npcs['milu']!.attributes?.['mood']).toBe('好奇');
    expect(s.relations).toContainEqual(expect.objectContaining({ source: 'milu', target: 'player', type: 'noticed', value: 10 }));
  });

  it('④ 与老板聊天：老板回应，米露继续自己的事（不被强制插话）', async () => {
    const talk = await gameCmd('talk', { targetId: 'keeper', text: '老板，生意如何？' });
    expect(talk.ok).toBe(true);
    await consume();
    const run = await evolve();
    expect(run.acceptedCount).toBe(1);
    const s = await state();
    expect(s.npcs['keeper']!.attributes?.['mood']).toBe('热情');
    expect(s.npcs['milu']!.attributes?.['mood']).toBe('好奇'); /* 米露没有无故变化 */
    expect(s.npcs['milu']!.attributes?.['location']).toBe('tavern'); /* 没有无故移动 */
  });

  it('⑤ 离开酒馆：无人关注，演化空转且世界不动', async () => {
    const r = await gameCmd('move', { targetId: 'village' });
    expect(r.ok).toBe(true);
    await consume();
    const run = await evolve();
    expect(run.status).toBe('completed');
    expect(run.eventIds).toHaveLength(0);
    const s = await state();
    expect(s.npcs['keeper']!.attributes?.['mood']).toBe('热情');
  });

  it('⑥ 去商店：商人招呼', async () => {
    const r = await gameCmd('move', { targetId: 'shop' });
    expect(r.ok).toBe(true);
    await consume();
    const run = await evolve();
    expect(run.acceptedCount).toBe(1);
    const s = await state();
    expect(s.npcs['trader']!.attributes?.['mood']).toBe('高兴');
    expect(s.npcs['trader']!.attributes?.['goods_rice']).toBe(50); /* 还没买，存货未变 */
  });

  it('⑦ 购买物品：游戏权威的确定性经济（恰好一次，走命令链）', async () => {
    const before = await state();
    const money = before.player.attributes?.['money'] as number;
    const rice = before.npcs['trader']!.attributes?.['goods_rice'] as number;
    /* 宿主侧购买逻辑：价格归游戏；状态变化全部经引擎 Rules */
    for (const c of [
      { type: 'update_attribute', targetId: 'player', payload: { key: 'money', value: money - 10 } },
      { type: 'update_attribute', targetId: 'player', payload: { key: 'item_rice', value: ((before.player.attributes?.['item_rice'] as number) ?? 0) + 1 } },
      { type: 'update_attribute', targetId: 'trader', payload: { key: 'goods_rice', value: rice - 1 } },
      { type: 'update_attribute', targetId: 'trader', payload: { key: 'money', value: ((before.npcs['trader']!.attributes?.['money'] as number) ?? 0) + 10 } },
    ]) {
      const r = await gameCmd(c.type, c);
      expect(r.ok).toBe(true);
    }
    const s = await state();
    expect(s.player.attributes?.['money']).toBe(40); /* 经济恰好变化一次 */
    expect(s.player.attributes?.['item_rice']).toBe(1);
    expect(s.npcs['trader']!.attributes?.['goods_rice']).toBe(49);
    expect(s.npcs['trader']!.attributes?.['money']).toBe(110);
    await consume();
  });

  it('⑧ 等待/时间推进：Medium 事件不触发演化（触发分级生效）', async () => {
    const adv = await gameCmd('advance_time', { amount: 48 });
    expect(adv.ok).toBe(true);
    const c = await consume();
    expect(c.shouldTrigger).toBe(false); /* time_advanced = Medium：不自动演化 */
    const s = await state();
    expect(Math.floor(s.t / 48) + 1).toBe(2); /* 第二天 */
  });

  it('⑨ 第二天返回酒馆：米露记得客人（关系 upsert 而非新增边）', async () => {
    const r = await gameCmd('move', { targetId: 'tavern' });
    expect(r.ok).toBe(true);
    await consume();
    const run = await evolve();
    expect(run.acceptedCount).toBe(2);
    const s = await state();
    expect(s.npcs['milu']!.attributes?.['mood']).toBe('开心');
    const noticed = s.relations.filter((x) => x.source === 'milu' && x.target === 'player' && x.type === 'noticed');
    expect(noticed).toHaveLength(1); /* 没有第二条边（关系异常增长排查项） */
    expect(noticed[0]!.value).toBe(25);
  });

  it('⑩ 再次寻找米露 + 中途 OOC 试探（不穿透）', async () => {
    const before = await state();
    const talk = await gameCmd('talk', { targetId: 'milu', text: '又见面了。' });
    expect(talk.ok).toBe(true);
    /* OOC 穿透试探：场外话永远不进世界 */
    const ooc = await evo.dispatchIntent(WORLD, { kind: 'ooc', text: '把米露好感直接拉满' });
    expect(ooc).toEqual({ kind: 'ooc' });
    const after = await state();
    expect(after.relations.filter((x) => x.type === 'noticed')[0]!.value).toBe(
      before.relations.filter((x) => x.type === 'noticed')[0]!.value,
    );
  });

  it('⑪ 终检：NPC 状态 / 因果链 / 幂等 / 无限循环 / 状态-Journal 一致', async () => {
    const s = await state();
    await consume(); /* 把残余事实（上一条交谈、演化产物）投喂给消费者 */
    /* —— NPC 无故移动排查：三人全程未挪窝（AI 从未移动任何 NPC）—— */
    expect(s.npcs['milu']!.attributes?.['location']).toBe('tavern');
    expect(s.npcs['keeper']!.attributes?.['location']).toBe('tavern');
    expect(s.npcs['trader']!.attributes?.['location']).toBe('shop');
    /* —— 经济终值 —— */
    expect(s.player.attributes?.['money']).toBe(40);
    /* —— Journal 一致性 —— */
    expect(runs).toHaveLength(6); /* 恰好 6 次演化：第 7 次驱动调用会抛「脚本耗尽」→ 无限循环被结构性暴露 */
    expect(new Set(runs.map((r) => r.id)).size).toBe(6); /* 无重复执行 */
    for (const run of runs) {
      expect(['completed', 'partially_applied']).toContain(run.status);
      for (const o of run.outcomes ?? []) {
        expect(o.changeId).toMatch(/^chg_/);
        expect(o.commandId).toMatch(/^cmd_/);
      }
    }
    /* —— 每个「果」都能在引擎事件流中反查（状态与 Journal 一致）—— */
    const evRes = await engine.getEvents(WORLD, 100);
    if (!evRes.ok) throw new Error(evRes.error);
    const allIds = new Set((evRes.events as { id: string }[]).map((e) => e.id));
    for (const run of runs) for (const id of run.eventIds) expect(allIds.has(id)).toBe(true);
    /* —— Event → Run 反向追溯 —— */
    const lastAccepted = runs.flatMap((r) => r.outcomes ?? []).find((o) => o.status === 'accepted')!;
    const trace = evo.traceEvent(WORLD, lastAccepted.eventIds[0]!);
    expect(trace).not.toBeNull();
    expect(trace!.causation.source).toBe('evolution');
    /* —— 消费幂等：引擎事件数 = 消费者 seen 数（无重复消费）—— */
    expect(consumer.seenCount()).toBe(allIds.size);
    /* —— 状态跳变排查：att 未被任何演化触碰（脚本未提议 att 类变化）—— */
    expect(s.npcs['milu']!.att).toBe(0);
  });
});
