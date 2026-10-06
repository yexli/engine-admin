/* ============================================================
   sessionWeave 测试（session 档客户端编织）
   ------------------------------------------------------------
   验证覆盖表语义（§30 表现层归位）：
   ① 快照回灌后差分新见闻 → 一批一织：锚点替换为织后正文（cls 'ai'），
     其余吸收（渲染隐藏）；玩家原话行「＞ …」保留；
   ② 水位：旧条目不重织，新批次只织增量；
   ③ 失败保底：narrateAsync 不产出 → 原文照常（无覆盖）；
   ④ 无编织能力：完全不织；
   ⑤ 换代自愈：新局 log id 回退 → 覆盖表与水位清零。

   驱动方式：模块监听 bus 'changed'，本地引擎的命令链同样发——
   不需要真宿主（编织是纯客户端表现层）。
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { core, dispatch, newGame, resetWorld, rng } from '@/world';
import { sync } from '@/world/WorldState';
import { setSavePort, setAiPort, type AiPort } from '@/plugins/PluginInterface';
import { MemorySaveRepository } from '@/repo';
import { ruleReasoner } from '@/ai/ruleReasoner';
import { bootstrapWorld } from '@/plugins/bootstrap';
import { plugins } from '@/plugins/PluginRegistry';
import { resetEventSeq } from '@/events/EventSchema';
import { worldEventLog } from '@/events/EventStore';
import { applyWeaveOverride, attachSessionWeave, resetSessionWeave } from './sessionWeave';

/** 脚本化编织端口：确定性正文，记录调用 */
function stubNarratePort(script: Array<string | null>): AiPort & { calls: string[][] } {
  let i = 0;
  const base = { ...({} as AiPort) };
  const port = {
    ...base,
    calls: [] as string[][],
    provider: 'stub',
    narrative: () => '',
    narrativeAmbient: () => '',
    npcDecide: () => ({ ok: true } as never),
    contextLayers: () => [],
    chat: () => ({ text: '' } as never),
    narrateAsync: async (facts: string[]) => {
      port.calls.push(facts);
      const v = script[Math.min(i, script.length - 1)] ?? null;
      i += 1;
      return v;
    },
  } as AiPort & { calls: string[][] };
  return port;
}

const noWeave = { provider: 'stub-plain', narrative: () => '', narrativeAmbient: () => '', npcDecide: () => ({}) as never, contextLayers: () => [] as never, chat: () => ({}) as never } as unknown as AiPort;

beforeEach(() => {
  resetSessionWeave();
  core.S = null;
  core.CB = null;
  resetWorld();
  setSavePort(new MemorySaveRepository());
  plugins.clear();
  worldEventLog.clear();
  resetEventSeq();
  rng.seed(20261006);
});

/** 等待异步编织落地（changed → onChanged → narrateAsync → 覆盖 → changed） */
const settle = async (rounds = 8): Promise<void> => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('sessionWeave：覆盖表语义', () => {
  it('① 一批一织：锚点替换（cls ai）、其余吸收、原话行保留', async () => {
    const port = stubNarratePort(['【织】风穿过市集，人声鼎沸。']);
    setAiPort(port);
    bootstrapWorld({ reasoner: ruleReasoner });
    newGame({ name: '织者', race: 'human', cls: 'warrior' });
    const dispose = attachSessionWeave();

    dispatch({ type: 'travel', loc: 'market' });
    await settle();

    /* 新见闻条目全部被定夺：要么是锚点（织后正文），要么被吸收 */
    const woven = (core.S!.log || []).map((e) => applyWeaveOverride(e as never));
    const anchors = woven.filter((e) => e !== null && (e as { cls?: string }).cls === 'ai');
    expect(anchors.length).toBe(1);
    expect((anchors[0] as unknown as { text: string }).text).toBe('【织】风穿过市集，人声鼎沸。');
    expect(port.calls.length).toBe(1);
    dispose();
    resetSessionWeave();
  });

  it('② 水位：第二条命令只织增量', async () => {
    const port = stubNarratePort(['【织】一', '【织】二']);
    setAiPort(port);
    bootstrapWorld({ reasoner: ruleReasoner });
    newGame({ name: '织者', race: 'human', cls: 'warrior' });
    const dispose = attachSessionWeave();

    dispatch({ type: 'travel', loc: 'market' });
    await settle();
    const callsAfterFirst = port.calls.length;

    dispatch({ type: 'travel', loc: 'plaza' }); /* travel 必写见闻（wait 不写） */
    await settle();

    expect(port.calls.length).toBe(callsAfterFirst + 1); /* 只多一批 */
    dispose();
    resetSessionWeave();
  });

  it('③ 失败保底：narrateAsync 返回 null → 原文照常（无覆盖）', async () => {
    const port = stubNarratePort([null]);
    setAiPort(port);
    bootstrapWorld({ reasoner: ruleReasoner });
    newGame({ name: '织者', race: 'human', cls: 'warrior' });
    const dispose = attachSessionWeave();

    dispatch({ type: 'travel', loc: 'market' });
    await settle();

    for (const e of core.S!.log || []) {
      expect(applyWeaveOverride(e as never)).toBe(e); /* 原样通过 */
    }
    dispose();
    resetSessionWeave();
  });

  it('④ 无编织能力：完全不织', async () => {
    setAiPort(noWeave);
    bootstrapWorld({ reasoner: ruleReasoner });
    newGame({ name: '织者', race: 'human', cls: 'warrior' });
    const dispose = attachSessionWeave();

    dispatch({ type: 'travel', loc: 'market' });
    await settle();

    for (const e of core.S!.log || []) {
      expect(applyWeaveOverride(e as never)).toBe(e);
    }
    dispose();
    resetSessionWeave();
  });

  it('⑤ 换代自愈：新局后覆盖表清零（log id 回退检测）', async () => {
    const port = stubNarratePort(['【织】A', '【织】B']);
    setAiPort(port);
    bootstrapWorld({ reasoner: ruleReasoner });
    newGame({ name: '织者', race: 'human', cls: 'warrior' });
    const dispose = attachSessionWeave();

    dispatch({ type: 'travel', loc: 'market' });
    await settle();
    expect(port.calls.length).toBeGreaterThan(0);

    /* 新局：log id 从头开始（回退检测） */
    newGame({ name: '新档', race: 'human', cls: 'warrior' });
    sync();
    await settle();

    for (const e of core.S!.log || []) {
      /* 新局的条目还没被织过：不存在上一局的覆盖残留 */
      const w = applyWeaveOverride(e as never);
      if (w !== e) expect((w as unknown as { text: string }).text).not.toContain('【织】A');
    }
    dispose();
    resetSessionWeave();
  });
});
