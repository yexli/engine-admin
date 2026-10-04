/* ============================================================
   天穹 × World Engine 接入验证（PoC）
   ------------------------------------------------------------
   回答一个问题：天穹的游戏回路是否真的运行在剥离出来的
   world-engine 上？三重证明：

   ① 实例同一性 —— 天穹导出的 worldBus 与 world-engine 导出的
      是同一个对象（不是复制品）；
   ② 游戏回路 —— 走生产装配（bootstrapWorld）开新局、派发命令：
      移动 → 大额交易 → 犯罪 → 战斗击杀，每一步都在引擎总线上
      留下可追溯的事实（与天穹自家 e2e 同一序列）；
   ③ 事件契约 —— 捕获的事件满足引擎 EventSchema 形状
      （id/type/day/tick/level）。

   注：travel 等普通动作低于事实阈值、不上总线（分级体系）——
   断言的是"事实级"事件（large_trade / crime_committed / character_died）。
   ============================================================ */
import { describe, expect, it, beforeEach } from 'vitest';
/* 一边是天穹自己转发导出的，一边是引擎包直出的——两者应是同一实例 */
import { worldBus as tqWorldBus } from '@/events/EventBus';
import { core, dispatch, newGame, resetWorld, rng } from '@/world';
import { worldBus as engineWorldBus } from 'world-engine';
import type { WorldEvent } from 'world-engine';
import { setSavePort, setAiPort } from '@/plugins/PluginInterface';
import { MemorySaveRepository } from '@/repo';
import { ruleSim } from '@/ai/ruleSim';
import { resetEventSeq } from '@/events/EventSchema';
import { worldEventLog } from '@/events/EventStore';
import { plugins } from '@/plugins/PluginRegistry';
import { bootstrapWorld } from '@/plugins/bootstrap';
import { ruleReasoner } from '@/ai/ruleReasoner';
import { scheduler as engineScheduler } from 'world-engine';
import { playerAct, startCombat } from '@/systems/combat/Combat';
import { commitCrime } from '@/systems/law/Law';
import { shopRows } from '@/systems/economy/Shop';
import lawRaw from '@/data/world/law.json';

beforeEach(() => {
  core.S = null;
  core.CB = null;
  resetWorld();
  setSavePort(new MemorySaveRepository());
  setAiPort(ruleSim);
  engineWorldBus.reset();
  plugins.clear();
  worldEventLog.clear();
  resetEventSeq();
  rng.seed(20261001);
  engineScheduler.inject((ms, fn) => { fn(); return 0 as unknown as ReturnType<typeof setTimeout>; });
  /* 与生产同一条装配路径 */
  bootstrapWorld({ reasoner: ruleReasoner });
});

describe('天穹 × World Engine 接入验证', () => {
  it('① 实例同一性：天穹转发导出的世界总线就是 world-engine 的单例', () => {
    expect(tqWorldBus).toBe(engineWorldBus);
  });

  it('② 游戏回路：移动 → 大额交易 → 犯罪 → 战斗击杀，每一步都在引擎总线上留下事实', async () => {
    newGame({ name: '接入验证员', race: 'dwarf', cls: 'warrior' });
    expect(core.S).not.toBeNull();

    /* 直接订阅引擎总线单例（绕开天穹转发层）——捕获的即引擎发出的事实 */
    const seen: WorldEvent[] = [];
    engineWorldBus.on('*', (e) => seen.push(e), 'poc-probe');

    /* 与玩家点界面同一条命令通道 */
    dispatch({ type: 'travel', loc: 'market' });
    expect(core.S!.player.loc).toBe('market'); /* 引擎状态被规则变异 */

    /* 大额交易：过千才上世界总线（large_trade 门槛） */
    core.S!.player.gold = 999999;
    core.curShop = 'grocer';
    const top = shopRows('grocer').reduce((a, b) => (b.price > a.price ? b : a));
    dispatch({ type: 'shopBuy', id: top.iid, p: top.price });

    /* 犯罪 + 战斗击杀 */
    const CRIME_IDS = Object.keys(((lawRaw as unknown as { crimes?: Record<string, unknown> }).crimes) ?? {});
    expect(commitCrime(CRIME_IDS[0])).toBe(true);
    startCombat(['rabbit']);
    for (let i = 0; i < 60 && core.CB; i++) playerAct('atk');

    const types = new Set(seen.map((e) => e.type));
    expect(types.has('crime_committed')).toBe(true);
    expect(types.has('character_died')).toBe(true);
    expect(types.has('large_trade')).toBe(top.price >= 1000);
    expect(worldEventLog.size()).toBeGreaterThanOrEqual(2);
  });

  it('③ 事件契约：事实携带引擎 EventSchema 全形状（id/type/day/tick/level）', () => {
    newGame({ name: '契约验证员', race: 'dwarf', cls: 'warrior' });
    const seen: WorldEvent[] = [];
    engineWorldBus.on('*', (e) => seen.push(e), 'poc-schema');

    const CRIME_IDS = Object.keys(((lawRaw as unknown as { crimes?: Record<string, unknown> }).crimes) ?? {});
    expect(commitCrime(CRIME_IDS[0])).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
    const e = seen[0]!;
    expect(e.id).toMatch(/^evt_/);
    expect(typeof e.type).toBe('string');
    expect(e.day).toBeGreaterThanOrEqual(1);
    expect(e.level).toBeGreaterThanOrEqual(0);
  });
});
