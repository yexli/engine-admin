/* 受控写入原语 + 命令链（Command → Runtime → Rule → Mutation → State → Event） */
import { beforeEach, describe, expect, it } from 'vitest';
import { worldBus } from '../src/events/WorldEventBus';
import { resetEventSeq } from '../src/events/EventSchema';
import { createBaseState, createWorldContainer } from '../src/state/WorldState';
import { createMutate } from '../src/mutate/WorldMutate';
import { createWorldRuntime } from '../src/runtime/WorldRuntime';
import { builtinRules } from '../src/runtime/BuiltinRules';
import { createWorldClock } from '../src/time/WorldClock';
import type { EngineWorldState } from '../src/types';

function harness() {
  const container = createWorldContainer<EngineWorldState>();
  container.core.S = createBaseState();
  const s = container.core.S!;
  const clock = createWorldClock<EngineWorldState>({ need: container.need });
  const mutate = createMutate<EngineWorldState>(container.need);
  const runtime = createWorldRuntime<EngineWorldState>({ container, clock, mutate, rules: builtinRules<EngineWorldState>() });
  return { s, clock, mutate, runtime };
}

beforeEach(() => {
  worldBus.reset();
  resetEventSeq();
});

describe('受控写入原语', () => {
  it('playerBag：堆叠合并不带 uid 的行；扣到 0 及透支都移除该行（与天穹语义一致）', () => {
    const h = harness();
    expect(h.mutate.playerBag('herb', 2)).toBe(true);
    expect(h.mutate.playerBag('herb', 3)).toBe(true);
    expect(h.s.player.bag).toEqual([{ id: 'herb', qty: 5 }]);
    expect(h.mutate.playerBag('herb', -4)).toBe(true);
    expect(h.s.player.bag).toEqual([{ id: 'herb', qty: 1 }]);
    /* 透支同样清行：写入原语的既有语义是「这一行没了」 */
    expect(h.mutate.playerBag('herb', -4)).toBe(true);
    expect(h.s.player.bag).toEqual([]);
    expect(h.mutate.playerBag('herb', -1)).toBe(false); // 没有行可扣
  });

  it('npcAtt：惰性建档 + 夹取 [-100,100] + 返回前后值', () => {
    const h = harness();
    expect(h.mutate.npcAtt('lita', 30)).toEqual({ from: 0, to: 30 });
    expect(h.mutate.npcAtt('lita', 999)).toEqual({ from: 30, to: 100 });
    expect(h.mutate.npcAtt('lita', -500)).toEqual({ from: 100, to: -100 });
    expect(h.mutate.npcEntry('lita').met).toBe(false);
  });

  it('rep：未知势力忽略；已知势力夹取', () => {
    const h = harness();
    h.s.rep['empire'] = 0;
    expect(h.mutate.rep('unknown', 5)).toBe(0);
    expect(h.mutate.rep('empire', 30)).toBe(30);
    expect(h.mutate.rep('empire', 999)).toBe(100);
  });

  it('pushLog：seq 单调 + 70 条窗口；weaveLogs 替换区间并保留玩家原话', () => {
    const h = harness();
    for (let i = 0; i < 72; i++) h.mutate.pushLog('条目' + i);
    expect(h.s.log).toHaveLength(70);
    const firstId = h.s.log[0].id;
    expect(firstId).toBe(3); // 72 - 70 + 1

    h.s.log.length = 0;
    h.s.logSeq = 0;
    h.mutate.pushLog('你挥剑刺向敌人的肩膀。', 'nar');
    h.mutate.pushLog('＞ 我攻击哥布林', 'say');
    const wovenTo = (h.s.logSeq ?? 0) + 0; // 当前水位
    expect(h.mutate.weaveLogs(wovenTo - 2, wovenTo - 1, '战斗一觸即发。')).toBe(true);
    expect(h.s.log.map((e) => e.text)).toEqual(['战斗一觸即发。', '＞ 我攻击哥布林']);
    expect(h.s.log[0].cls).toBe('ai');
  });
});

describe('命令链', () => {
  it('move：改位置 + 发布 player_moved（完整链路）', () => {
    const h = harness();
    const r = h.runtime.execute({ type: 'move', actorId: 'player', targetId: 'forest' });
    expect(r.ok).toBe(true);
    expect(h.s.player.loc).toBe('forest');
    expect(r.events).toHaveLength(1);
  });

  it('move 到原地被拒：零改动 + 拒绝也是事实（move_failed）', () => {
    const h = harness();
    const r = h.runtime.execute({ type: 'move', targetId: 'plaza' });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('MoveRule');
    expect(h.s.player.loc).toBe('plaza');
    expect(r.events.length).toBe(1);
  });

  it('attack：目标存在发布 attack_succeeded；目标不存在拒绝并发布 attack_failed', () => {
    const h = harness();
    h.mutate.npcEntry('goblin');
    expect(h.runtime.execute({ type: 'attack', targetId: 'goblin', amount: 5 }).ok).toBe(true);
    const bad = h.runtime.execute({ type: 'attack', targetId: 'ghost', amount: 5 });
    expect(bad.ok).toBe(false);
    expect(bad.reason).toContain('AttackRule');
  });

  it('未注册的命令给可诊断的拒绝', () => {
    const h = harness();
    const r = h.runtime.execute({ type: 'summon_dragon' });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('没有规则处理');
  });

  it('advance_time：经命令链推进时间并发布 time_advanced', () => {
    const h = harness();
    const t0 = h.s.t;
    const r = h.runtime.execute({ type: 'advance_time', amount: 3 });
    expect(r.ok).toBe(true);
    expect(h.s.t).toBe(t0 + 3);
    expect(r.events.some(() => true)).toBe(true);
  });

  it('规则抛错不炸链：转成可读拒绝', () => {
    const h = harness();
    h.runtime.rules.register({
      name: 'BoomRule',
      for: 'boom',
      apply: () => {
        throw new Error('库存损坏');
      },
    });
    const r = h.runtime.execute({ type: 'boom' });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('库存损坏');
  });

  it('appliedRules：ok:true 列出全部匹配规则（P2 卡片7）', () => {
    const h = harness();
    h.runtime.rules.register({ name: 'EchoRuleA', for: 'echo', apply: () => {} });
    h.runtime.rules.register({ name: 'EchoRuleB', for: 'echo', apply: () => true });
    const r = h.runtime.execute({ type: 'echo' });
    expect(r.ok).toBe(true);
    expect(r.appliedRules).toEqual(['EchoRuleA', 'EchoRuleB']);
  });

  it('appliedRules：ok:false 时列出已产生副作用的规则（命令链非事务性可见）', () => {
    const h = harness();
    h.runtime.rules.register({
      name: 'SideEffectRule',
      for: 'halfway',
      apply: (ctx) => {
        ctx.mutate.pushLog('先改了状态');
      },
    });
    h.runtime.rules.register({ name: 'VetoRule', for: 'halfway', apply: () => false });
    const r = h.runtime.execute({ type: 'halfway' });
    expect(r.ok).toBe(false);
    expect(r.appliedRules).toEqual(['SideEffectRule']); /* A 的变更已落地、不回滚 */
    expect(h.s.log.at(-1)?.text).toBe('先改了状态');
  });

  it('appliedRules：规则抛错时同样带上已执行清单', () => {
    const h = harness();
    h.runtime.rules.register({ name: 'First', for: 'crash-mid', apply: () => {} });
    h.runtime.rules.register({
      name: 'CrashRule',
      for: 'crash-mid',
      apply: () => {
        throw new Error('中途崩了');
      },
    });
    const r = h.runtime.execute({ type: 'crash-mid' });
    expect(r.ok).toBe(false);
    expect(r.appliedRules).toEqual(['First']);
  });

  it('实体版本戳 _ver：create 不设；写入路径单调递增（P2 卡片8）', () => {
    const h = harness();
    expect(h.runtime.execute({ type: 'create_entity', payload: { id: 'milu', type: 'npc', name: '米露' } }).ok).toBe(true);
    expect(h.s.npcs['milu']!._ver).toBeUndefined(); /* 建档不经受控写入访问 */
    expect(h.runtime.execute({ type: 'update_attribute', targetId: 'milu', payload: { key: 'mood', value: '平静' } }).ok).toBe(true);
    expect(h.s.npcs['milu']!._ver).toBe(1);
    expect(h.runtime.execute({ type: 'update_attribute', targetId: 'milu', payload: { key: 'mood', value: '开心' } }).ok).toBe(true);
    expect(h.s.npcs['milu']!._ver).toBe(2);
    h.mutate.npcAtt('milu', 10);
    expect(h.s.npcs['milu']!._ver).toBe(3);
    /* 玩家不设版本戳（并发检测只针对实体） */
    h.mutate.playerLoc('tavern');
    expect((h.s.player as unknown as { _ver?: number })._ver).toBeUndefined();
  });

  it('实体版本戳 _ver 随状态序列化持久化（P2 卡片8）', () => {
    const h = harness();
    h.mutate.npcAtt('milu', 10);
    const ver = h.s.npcs['milu']!._ver;
    const roundtrip = JSON.parse(JSON.stringify(h.s)) as EngineWorldState;
    expect(roundtrip.npcs['milu']!._ver).toBe(ver);
  });

  it('advance_time 规则层钳制：超限推进 1440 刻 + clamp 事实（P3 卡片1）', () => {
    const h = harness();
    const types: string[] = [];
    worldBus.on('*', (e) => types.push(e.type));
    const t0 = h.s.t;
    const r = h.runtime.execute({ type: 'advance_time', amount: 9999 });
    expect(r.ok).toBe(true);
    expect(h.s.t - t0).toBe(1440); /* 实际只推进 1440，不是 9999 */
    expect(types).toContain('time_advance_clamped');
    expect(types).toContain('time_advanced');
    /* 正常推进不受影响 */
    types.length = 0;
    const t1 = h.s.t;
    expect(h.runtime.execute({ type: 'advance_time', amount: 5 }).ok).toBe(true);
    expect(h.s.t - t1).toBe(5);
    expect(types).not.toContain('time_advance_clamped');
  });
});
