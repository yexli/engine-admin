/* ============================================================
   会话模式 VRT（Phase 3 终局形态验收）
   ------------------------------------------------------------
   服务端（server/game-host.ts）原样运行天穹裁定栈；本测试回答：

     同一种子、同一命令序列，服务端裁定与本地裁定的结果是否一致？

   对照协议（同进程顺序双跑，rng 全程确定）：
     · 命令序列以 newGame 开头（第 0 步），两端逐条同喂；
     · 参照组：本地引擎（dispatch 直跑）；
     · 会话组：attachExternalSession（dispatch 经会话门 → 真实宿主
       进程 → 快照回灌 → 事实重放）；宿主不开 AUTONEW——开局也是
       被测命令，rng 消耗完全对齐；
     · 断言：逐命令后 t / loc / gold / hp 与事件类型序列完全一致；
     · 附带：宿主被杀后命令回落本地裁定（迁移期断线契约）。

   宿主 bundle 由 beforeAll 现场构建（vite SSR；与 npm run build:game
   同一条命令）。
   ============================================================ */
import { spawnSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bus, core, dispatch, resetWorld, rng } from '@/world';
import { setSavePort, setAiPort } from '@/plugins/PluginInterface';
import { MemorySaveRepository } from '@/repo';
import { ruleSim } from '@/ai/ruleSim';
import { ruleReasoner } from '@/ai/ruleReasoner';
import { bootstrapWorld } from '@/plugins/bootstrap';
import { plugins } from '@/plugins/PluginRegistry';
import { resetEventSeq } from '@/events/EventSchema';
import { worldEventLog } from '@/events/EventStore';
import { attachExternalSession } from '@/plugins/extSession';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const BUNDLE = ROOT + '.server-build/game-host.mjs';
const SEED = 20261006;
const PORT = 18_700 + Math.floor(Math.random() * 60);
const BASE = `http://127.0.0.1:${PORT}`;

let proc: ChildProcess | null = null;
let saveDir = '';

beforeAll(() => {
  /* 现场构建（bundle 过期不可信） */
  const res = spawnSync(process.execPath, [ROOT + 'node_modules/vite/bin/vite.js', 'build', '-c', 'vite.game-host.config.ts'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (res.status !== 0 || !existsSync(BUNDLE)) {
    throw new Error(`宿主构建失败：${res.stderr?.slice(0, 400)}`);
  }
});

/* 两端同用的 AiPort：ruleSim 的规则通道 + 无编织能力（narrateAsync 缺省）。
   编织（Narration）按方案 §30 属客户端表现层：服务端不注册 AiPort（core
   全部消费方都有无端口兜底），参照组也摘掉编织——否则异步编织事件落在
   哪条命令边界由传输决定，逐命令对照会失真。 */
const noWeaveRuleSim = { ...ruleSim, narrateAsync: undefined };

beforeEach(() => {
  core.S = null;
  core.CB = null;
  core.curShop = null;
  resetWorld();
  setSavePort(new MemorySaveRepository());
  setAiPort(noWeaveRuleSim as typeof ruleSim);
  plugins.clear();
  worldEventLog.clear();
  resetEventSeq();
});

afterEach(() => {
  proc?.kill('SIGKILL');
  proc = null;
  if (saveDir) {
    rmSync(saveDir, { recursive: true, force: true });
    saveDir = '';
  }
});

/** 命令序列（两端同喂；第 0 步开局；确定性裁定路径，不涉 AI 网络） */
const SEQUENCE: Array<{ type: string; [k: string]: unknown }> = [
  { type: 'newGame', name: '对照员', race: 'human', cls: 'warrior' },
  { type: 'travel', loc: 'market' },
  { type: 'wait', ticks: 4 },
  { type: 'travel', loc: 'plaza' },
  { type: 'wait', ticks: 2 },
  { type: 'travel', loc: 'market' },
];

interface StepFact {
  t: number;
  loc: string;
  gold: number;
  hp: number;
  events: string[];
}

/** bus 事实收集（与会话响应同一过滤：去掉 changed） */
function collectEvents(into: string[][]): () => void {
  return bus.on((e) => {
    if (e.type !== 'changed') into[into.length - 1]?.push(e.type);
  });
}

function factOf(events: string[]): StepFact {
  return {
    t: core.S!.t,
    loc: core.S!.player.loc,
    gold: core.S!.player.gold,
    hp: core.S!.player.hp,
    events,
  };
}

const poll = async (cond: () => boolean, what: string, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`超时：${what}`);
    await new Promise((r) => setTimeout(r, 30));
  }
};

/** 起宿主进程并等就绪 */
async function startHost(withSeed: boolean, autoNew: boolean): Promise<void> {
  saveDir = `${ROOT}.qa-tmp/session-vrt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  mkdirSync(saveDir, { recursive: true });
  proc = spawn(
    process.execPath,
    [BUNDLE],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        TIANQIONG_GAME_PORT: String(PORT),
        TIANQIONG_GAME_SAVE: `${saveDir}/save.json`,
        ...(withSeed ? { TIANQIONG_GAME_SEED: String(SEED) } : {}),
        ...(autoNew ? { TIANQIONG_GAME_AUTONEW: '1' } : {}),
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  );
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/game/health`)).ok) return;
    } catch {
      /* not yet */
    }
    if (Date.now() > deadline) throw new Error('宿主 10s 内未就绪');
    await new Promise((r) => setTimeout(r, 150));
  }
}

describe('会话模式 VRT：服务端裁定 ≡ 本地裁定', () => {
  it('同一种子同一序列：逐命令状态与事件类型序列完全一致', async () => {
    /* —— 参照组：本地裁定 —— */
    rng.seed(SEED);
    bootstrapWorld({ reasoner: ruleReasoner });
    const reference: StepFact[] = [];
    {
      const ev: string[][] = [];
      const off = collectEvents(ev);
      for (const cmd of SEQUENCE) {
        ev.push([]); /* 当前步的收集槽（本地裁定同步落入） */
        dispatch(cmd as never);
        reference.push(factOf(ev[ev.length - 1]!));
      }
      off();
    }

    /* —— 会话组：干净重置后走真实宿主进程（无 AUTONEW：开局本身是被测命令） —— */
    core.S = null;
    core.CB = null;
    core.curShop = null;
    resetWorld();
    plugins.clear();
    worldEventLog.clear();
    resetEventSeq();
    await startHost(true, false);

    const reports: Array<{ status: string }> = [];
    let reportCount = 0;
    const dispose = attachExternalSession({
      baseUrl: BASE,
      report: (p) => {
        reports.push(p);
        reportCount += 1;
      },
    });
    await poll(() => reports.some((r) => r.status === 'online'), '会话宿主上线');

    const sessionFacts: StepFact[] = [];
    {
      const ev: string[][] = [];
      const off = collectEvents(ev);
      for (const cmd of SEQUENCE) {
        ev.push([]); /* 当前步的收集槽（会话事实经重放异步落入） */
        const seen = reportCount;
        dispatch(cmd as never);
        /* 每条命令恰好一次快照回灌（apply 必 report） */
        await poll(() => reportCount > seen, `会话命令未回灌：${cmd.type}`);
        sessionFacts.push(factOf(ev[ev.length - 1]!));
      }
      off();
    }
    dispose();

    /* —— 逐命令对照 —— */
    expect(sessionFacts).toHaveLength(reference.length);
    for (let i = 0; i < reference.length; i++) {
      const ref = reference[i]!;
      const ses = sessionFacts[i]!;
      expect(
        { step: i + 1, t: ses.t, loc: ses.loc, gold: ses.gold, hp: ses.hp },
        `第 ${i + 1} 步（${SEQUENCE[i]!.type}）状态不一致`,
      ).toEqual({ step: i + 1, t: ref.t, loc: ref.loc, gold: ref.gold, hp: ref.hp });
      expect(
        { step: i + 1, events: ses.events },
        `第 ${i + 1} 步（${SEQUENCE[i]!.type}）事实序列不一致`,
      ).toEqual({ step: i + 1, events: ref.events });
    }
  }, 60_000);

  it('宿主被杀：§22 停摆——命令拒收（时间不动 + toast），重连后恢复', async () => {
    rng.seed(SEED + 1);
    bootstrapWorld({ reasoner: ruleReasoner });
    await startHost(false, true);

    const toasts: string[] = [];
    const offToast = bus.on((e) => {
      const raw = e as unknown as { type: string; text?: string };
      if (raw.type === 'toast' && typeof raw.text === 'string') toasts.push(raw.text);
    });
    const reports: Array<{ status: string }> = [];
    let reportCount = 0;
    const dispose = attachExternalSession({
      baseUrl: BASE,
      report: (p) => {
        reports.push(p);
        reportCount += 1;
      },
    });
    await poll(() => reports.some((r) => r.status === 'online'), '会话宿主上线');

    /* 在线：一条命令走服务端，快照回灌（AUTONEW 世界 t=16 起） */
    const seen = reportCount;
    dispatch({ type: 'wait', ticks: 2 } as never);
    await poll(() => reportCount > seen, '在线命令未回灌');
    expect(core.S!.t).toBeGreaterThan(16);
    const tOnline = core.S!.t;

    /* 杀宿主 → §22 停摆：命令就地拒收——时间不动、toast 说明、自动重连。
       不回落本地裁定（Phase 9 起 session 档是唯一裁定通道）。 */
    proc!.kill('SIGKILL');
    proc = null;
    dispatch({ type: 'wait', ticks: 3 } as never);
    await new Promise((r) => setTimeout(r, 300));
    expect(core.S!.t).toBe(tOnline); /* 时间停摆 */
    expect(toasts.some((t) => t.includes('连接已断开'))).toBe(true);

    /* 宿主回来（同端口新实例）→ 探活拉回 online → 命令恢复裁定 */
    await startHost(false, true);
    await poll(() => reports.some((r, i) => i > 0 && r.status === 'online'), '重连成功', 15_000);
    const state = (await fetch(`${BASE}/game/state`).then((r) => r.json())) as { t: number };
    dispatch({ type: 'wait', ticks: 2 } as never);
    await poll(() => core.S!.t === (state as { t: number }).t + 2, '重连后裁定恢复', 15_000);
    offToast();
    dispose();
  }, 40_000);
});
