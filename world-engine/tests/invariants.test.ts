/* ============================================================
   World Invariants 测试（V2.4-02 · 方案 §六）
   ------------------------------------------------------------
   §6.1 基础不变量逐项 + §6.4 Mutation 边界 + §21 命令幂等：

     不存在的 Entity 不能被修改（update_attribute / talk / set_attitude
       —— 惰性建档漏洞关闭：白名单动作不能凭空造实体）
     非法 Relation 不能更新（来源/目标必须真实存在）
     删除 NPC 后不能继续产生有效行为 + 悬空引用级联清理
     不存在的 Entity 不能被移动（既有守卫回归）
     时间单调（advance 只增不减）
     Command 幂等（同 commandId 重复提交 → 首次结果 + duplicate 标记，
       不产生重复 Mutation / Event）
     Mutation 边界（规则层不得触碰 IO / 网络侧通道——写路径唯一）
   ============================================================ */
import { describe, expect, it, beforeEach } from 'vitest';
import { createWorld } from '../src/index.ts';
import { readFileSync } from 'node:fs';

let world: ReturnType<typeof createWorld>;
beforeEach(() => {
  world = createWorld({ worldId: 'w-inv', playerName: '旅人', startLoc: 'village', isolated: true });
  for (const c of [
    { type: 'create_entity', payload: { id: 'milu', type: 'npc', name: '米露', location: 'tavern' } },
    { type: 'create_entity', payload: { id: 'keeper', type: 'npc', name: '老板', location: 'tavern' } },
  ]) {
    const r = world.executeCommand(c);
    if (!r.ok) throw new Error(`种子被拒：${JSON.stringify(r)}`);
  }
});

describe('§6.1 不存在的 Entity 不能被修改（惰性建档漏洞关闭）', () => {
  it('update_attribute 幽灵实体 → 拒绝且不凭空建档', () => {
    const r = world.executeCommand({ type: 'update_attribute', targetId: 'ghost', payload: { key: 'mood', value: '被造出来了' } });
    expect(r.ok).toBe(false);
    /* 拒绝原因在事实里（规则拒绝语义：cause 随失败事实留痕） */
    const failFact = world.getEvents(200).find((e) => e.type === 'attribute_update_failed' && e.target === 'ghost');
    expect(failFact).toBeDefined();
    expect(failFact?.cause).toContain('实体不存在');
    const s = world.getState()!;
    expect(s.npcs['ghost']).toBeUndefined(); /* 没有凭空造实体 */
    expect(r.events.some((id) => world.getEvents(200).find((e) => e.id === id)?.type === 'entity_updated')).toBe(false);
  });

  it('talk 幽灵实体 → 拒绝且不产生 met 标记', () => {
    const r = world.executeCommand({ type: 'talk', targetId: 'ghost', text: '在吗' });
    expect(r.ok).toBe(false);
    const s = world.getState()!;
    expect(s.npcs['ghost']).toBeUndefined();
    expect(s.npcs['ghost']?.met).toBeUndefined();
  });

  it('set_attitude 幽灵实体 → 拒绝', () => {
    const r = world.executeCommand({ type: 'set_attitude', targetId: 'ghost', amount: 10 });
    expect(r.ok).toBe(false);
    const s = world.getState()!;
    expect(s.npcs['ghost']).toBeUndefined();
  });

  it('回归：真实实体照常修改（守卫不误伤）', () => {
    const r = world.executeCommand({ type: 'update_attribute', targetId: 'milu', payload: { key: 'mood', value: '开心' } });
    expect(r.ok).toBe(true);
    expect(world.getState()!.npcs.milu.attributes?.['mood']).toBe('开心');
  });
});

describe('§6.1 非法 Relation 不能更新', () => {
  it('目标实体不存在 → 拒绝且不建悬空边', () => {
    const r = world.executeCommand({ type: 'set_relation', actorId: 'milu', targetId: 'ghost', payload: { type: 'ally', value: 10 } });
    expect(r.ok).toBe(false);
    expect(world.getState()!.relations ?? []).toHaveLength(0);
  });

  it('来源实体不存在 → 拒绝', () => {
    const r = world.executeCommand({ type: 'set_relation', actorId: 'ghost', targetId: 'milu', payload: { type: 'ally', value: 10 } });
    expect(r.ok).toBe(false);
    expect(world.getState()!.relations ?? []).toHaveLength(0);
  });

  it('回归：真实双方照常建立关系', () => {
    const r = world.executeCommand({ type: 'set_relation', actorId: 'milu', targetId: 'player', payload: { type: 'noticed', value: 10 } });
    expect(r.ok).toBe(true);
    expect((world.getState()!.relations ?? []).length).toBe(1);
  });
});

describe('§6.3 删除 NPC 后不能继续产生有效行为 + 悬空引用级联清理', () => {
  beforeEach(() => {
    /* 建立关系网：a↔b（世界表）、b→player、player 关注 a */
    for (const c of [
      { type: 'create_entity', payload: { id: 'temp', type: 'npc', name: '临时工', location: 'tavern' } },
      { type: 'set_relation', actorId: 'temp', targetId: 'keeper', payload: { type: 'ally', value: 10 } },
      { type: 'set_relation', actorId: 'keeper', targetId: 'temp', payload: { type: 'ally', value: 5 } },
      { type: 'update_attribute', targetId: 'milu', payload: { key: 'attention', value: 'temp' } },
    ]) {
      const r = world.executeCommand(c);
      if (!r.ok) throw new Error(`种子被拒：${JSON.stringify(r)}`);
    }
  });

  it('删除 temp：世界关系表与实体关系网的悬空边级联清理', () => {
    const before = (world.getState()!.relations ?? []).filter((r) => r.source === 'temp' || r.target === 'temp').length;
    expect(before).toBeGreaterThan(0);
    const r = world.executeCommand({ type: 'remove_entity', targetId: 'temp' });
    expect(r.ok).toBe(true);
    const s = world.getState()!;
    expect(s.npcs['temp']).toBeUndefined();
    /* 世界关系表零残留 */
    expect((s.relations ?? []).some((x) => x.source === 'temp' || x.target === 'temp')).toBe(false);
    /* 实体关系网零残留（keeper.rels.temp 已清） */
    expect(s.npcs.keeper.rels?.['temp']).toBeUndefined();
    /* 级联事实可观测 */
    const removed = world.getEvents(50).find((e) => e.type === 'entity_removed');
    expect(removed?.data?.['relationsPurged']).toBeGreaterThan(0);
  });

  it('删除后不能继续产生有效行为：修改 / 交谈 / 关系全部拒绝', () => {
    world.executeCommand({ type: 'remove_entity', targetId: 'temp' });
    expect(world.executeCommand({ type: 'update_attribute', targetId: 'temp', payload: { key: 'mood', value: '诈尸' } }).ok).toBe(false);
    expect(world.executeCommand({ type: 'talk', targetId: 'temp', text: '在吗' }).ok).toBe(false);
    expect(world.executeCommand({ type: 'set_relation', actorId: 'temp', targetId: 'milu', payload: { type: 'haunt', value: 10 } }).ok).toBe(false);
    expect(world.executeCommand({ type: 'move_entity', targetId: 'temp', payload: { location: 'tavern' } }).ok).toBe(false);
    expect(world.getState()!.npcs['temp']).toBeUndefined(); /* 不复活 */
  });

  it('注意力指向被删实体：宿主语义保留（可观察、AI 提案改它会被守卫拦），不越权清理', () => {
    world.executeCommand({ type: 'remove_entity', targetId: 'temp' });
    /* milu.attention=temp 是宿主属性约定——引擎不猜语义、不越权清理；
       引用已删实体的 AI 提案会被存在性守卫拒绝（下方守卫已测） */
    expect(world.getState()!.npcs.milu.attributes?.['attention']).toBe('temp');
  });
});

describe('§6.1 时间单调 / §21 命令幂等', () => {
  it('时间单调：advance 只增不减，无回退路径', () => {
    const t0 = world.getState()!.t;
    world.executeCommand({ type: 'advance_time', amount: 5 });
    expect(world.getState()!.t).toBe(t0 + 5);
    /* 负数被规则层钳制为最小 1 刻——时间只进不退（单调性由钳制保证） */
    const r = world.executeCommand({ type: 'advance_time', amount: -5 });
    expect(r.ok).toBe(true);
    expect(world.getState()!.t).toBe(t0 + 5 + 1); /* 钳制推进 1 刻，绝不回退 */
  });

  it('命令幂等：同 commandId 重复提交 → 首次结果 + duplicate 标记，金币只扣一次', () => {
    const before = world.getState()!.npcs.keeper.attributes?.['money'];
    const cmd = { type: 'update_attribute', targetId: 'keeper', payload: { key: 'money', value: (before as number) - 5 }, commandId: 'trade-op-001:1' };
    const first = world.executeCommand(cmd);
    expect(first.ok).toBe(true);
    expect(first.duplicate).toBeUndefined();
    const second = world.executeCommand(cmd); /* HTTP 重试：同键重发 */
    expect(second.duplicate).toBe(true); /* 幂等命中 */
    expect(second.events).toEqual(first.events); /* 同一结果（不再产生新事件） */
    expect(world.getState()!.npcs.keeper.attributes?.['money']).toBe((before as number) - 5); /* 只扣一次 */
  });

  it('不同 commandId → 各自执行（幂等键不影响正常流）', () => {
    const before = world.getState()!.npcs.keeper.attributes?.['money'];
    const r1 = world.executeCommand({ type: 'update_attribute', targetId: 'keeper', payload: { key: 'money', value: (before as number) - 1 }, commandId: 'op-a' });
    const r2 = world.executeCommand({ type: 'update_attribute', targetId: 'keeper', payload: { key: 'money', value: (before as number) - 2 }, commandId: 'op-b' });
    expect(r1.ok && r2.ok).toBe(true);
    expect(r1.duplicate ?? r2.duplicate).toBeUndefined();
    expect(world.getState()!.npcs.keeper.attributes?.['money']).toBe((before as number) - 2);
  });

  it('无 commandId → 行为与此前完全一致（向后兼容）', () => {
    const before = world.getEvents(200).length;
    const r = world.executeCommand({ type: 'move', targetId: 'tavern' });
    expect(r.ok).toBe(true);
    expect(r.duplicate).toBeUndefined();
    expect(world.getEvents(200).length).toBe(before + 1);
  });
});

describe('§6.4 Mutation 边界（规则层无 IO / 侧通道；写路径唯一）', () => {
  it('规则与 mutate 层零 IO / 零网络 / 零子进程（侧通道扫描）', () => {
    for (const file of ['src/rules/coreRules.ts', 'src/rules/rpgCompat.ts', 'src/mutate/WorldMutate.ts']) {
      const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      for (const banned of ['node:', 'fetch(', 'child_process', 'execSync', 'writeFileSync', 'require(']) {
        expect(src.includes(banned), `${file} 含侧通道 ${banned}`).toBe(false);
      }
    }
  });
});
