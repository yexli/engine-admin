/* ============================================================
   extSession —— 会话模式接线（终局形态 · 客户端装配面）
   ------------------------------------------------------------
   客户端不在本地裁定任何世界事务——dispatch 的全部命令经 extGate
   的会话端口发往 server/game-host.ts（服务端原样跑 dispatch + 24
   系统），响应回来后：

     1. core.S   ← hydrate(snapshot)   整体回灌（世界真相）
     2. core.CB / core.curShop ← 响应   战斗/商店瞬态槽
     3. events   → bus.emit            事实流重放（按 _seq 去重）
     4. bus.emit({type:'changed'})     驱动本地重渲染

   UI 零改动：所有面板/浮层照旧读 core、听 bus——只是 core 的
   内容来自服务端裁定而不是本地执行。

   会话握手（M1 · 修 P0-2/3）：每次转 online 先 health() 取宿主
   lastSeq 重置本地水位（宿主重启后 _seq 归零不再造成永久去重），
   再 state() 拉快照——非空则回灌并切到 game 屏（刷新页面即回到
   进行中的局），最后从该水位起订 SSE（只听增量，不重放历史环）。

   流监督器（M1 · 修 P0-1）：SSE 断开（错误或干净断流）后由独立的
   指数退避监督器重开流，与整体 offline 状态解耦。

   命令串行队列（M1 · 修 P1-5）：命令按 dispatch 顺序逐条在途，
   杜绝乱序快照回滚；每条命令携带幂等键（M1 · 修 P1-6），宿主对
   重放命令返回既有结果。

   断线停摆（Phase 9 · 方案 §22 终局语义）：isActive 恒为 true，
   断线期间命令就地拒收（toast + 自动重连），本地路径不再兜底。
   ============================================================ */
import { bus, core } from '@/world';
import { hydrate } from '@/world/WorldState';
import { runLog } from '@/devlog/RunLog';
import { setExternalCommandPort } from '@/world/extGate';
import { GameSessionClient, type SessionEvent, type SessionStatePayload } from '@/world-engine/client/gameSession';
import { newCommandId } from '@/world-engine/client/WorldEngineClient';
import type { GameCommand } from '@/types/uispec';
import { loadLlmConfig, onLlmConfig, DEFAULT_LLM, type LlmConfig } from '@/ai/llmConfig';
import { OpenAiCompatAdapter } from '@/ai/openaiCompat';
import { aiHelpers } from '@/ai/helpers';
import { gateway } from '@/ai/gateway';
import { markSessionWeaveSeen } from '@/plugins/sessionWeave';

/** 汇报给 store 的会话状态（复用 extWorld 字段：TopBar/徽标零改动） */
export interface SessionReport {
  status: 'connecting' | 'online' | 'reconnecting';
  t: number | null;
  tick: number | null;
  day: number | null;
  playerLoc: string | null;
  lastError: string | null;
}

/** store 里 extWorld 字段的完整形状（session 档是唯一形态；
 *  timeView/worldId 为 bridge 时代遗留字段——保留以不惊动消费方） */
export type ExtWorldReport = {
  enabled: boolean;
  status: 'off' | SessionReport['status'] | 'idle' | 'closed';
  worldId: string | null;
  baseUrl: string;
  day: number | null;
  tick: number | null;
  timeView: null;
  playerLoc: string | null;
  lastError: string | null;
};

export interface AttachExternalSessionOptions {
  baseUrl: string;
  report: (patch: SessionReport) => void;
  fetchImpl?: typeof fetch;
}

const OFFLINE_TOAST = '与世界的连接已断开——正在自动重连，稍候再试';

export function attachExternalSession(opts: AttachExternalSessionOptions): () => void {
  const session = new GameSessionClient({ baseUrl: opts.baseUrl, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) });
  let disposed = false;
  let online = false;
  let healthTimer: ReturnType<typeof setTimeout> | null = null;
  /* 迟到事实的水位：响应内事实与 SSE 流共用一把序号尺（宿主单调 _seq）。
     序号空间以宿主进程为单位（boot 标识）：同进程重连保留客户端水位
     （不跳过缺口），换进程（重启/换宿主）取新 head（旧空间不可比，
     错过的瞬态事实由快照回灌承载真相）。 */
  let lastSeq = 0;
  let serverBoot = 0;
  let closeStream: (() => void) | null = null;
  let streamRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let streamRetry = 0;
  let resyncTimer: ReturnType<typeof setTimeout> | null = null;
  /* 命令串行队列：保序（P1-5），杜绝乱序快照回滚 */
  let cmdChain: Promise<void> = Promise.resolve();
  /* 客户端当前屏（用于握手时决定是否切 game 屏；不 import store） */
  let clientScreen = 'title';
  const offLlmListeners: Array<() => void> = [];

  const report = (patch: Partial<SessionReport>): void => {
    opts.report({
      status: online ? 'online' : 'connecting',
      t: core.S?.t ?? null,
      tick: core.S?.t ?? null,
      day: core.S ? Math.floor(core.S.t / 48) + 1 : null,
      playerLoc: core.S?.player.loc ?? null,
      lastError: null,
      ...patch,
    });
  };

  /* —— 快照回灌核心（UI 零改动的关键一步）。事件重放由调用方负责。 —— */
  const applyCore = (res: SessionStatePayload): void => {
    core.S = res.snapshot ? hydrate(res.snapshot as never) : null;
    core.CB = (res.cb ?? null) as never;
    core.curShop = (res.curShop ?? null) as never;
    report({ status: 'online', t: res.t, tick: res.t, playerLoc: res.loc, lastError: null });
  };

  const advanceSeq = (e: SessionEvent): void => {
    if (typeof e._seq === 'number' && e._seq > lastSeq) lastSeq = e._seq;
  };

  const applyCommandResult = (res: SessionCommandResultWithEvents): void => {
    applyCore(res);
    /* 重放按 _seq 过滤（P1-4）：SSE 在线时命令事实已由流先投递，
       无条件重放会造成 toast 双份/浮层双闪 */
    for (const e of res.events ?? []) {
      if (typeof e._seq === 'number' && e._seq <= lastSeq) continue;
      advanceSeq(e);
      bus.emit(e as never);
    }
    bus.emit({ type: 'changed' } as never);
  };

  /* —— 会话握手（M1.1）：boot 对齐序号空间 → state 回局 → 订流 —— */
  const handshake = async (): Promise<void> => {
    const h = (await session.health()) as { boot?: number; lastSeq?: number; gateway?: string };
    const boot = typeof h.boot === 'number' ? h.boot : 0;
    if (boot !== serverBoot) {
      /* 新的序号空间（宿主重启/换宿主）：以新 head 为水位——旧空间的水位
         不可比；错过的瞬态事实由下面的快照回灌承载真相 */
      serverBoot = boot;
      lastSeq = typeof h.lastSeq === 'number' ? h.lastSeq : 0;
    } else if (typeof h.lastSeq === 'number' && h.lastSeq > lastSeq) {
      lastSeq = h.lastSeq; /* 同进程重连：水位前移到 head，不会跳过缺口 */
    }
    if (h.gateway) useGatewayForPresentation(h.gateway);
    let restored = false;
    try {
      const st = await session.state();
      if (st.snapshot) {
        applyCore(st);
        markSessionWeaveSeen(); /* 已在场的历史见闻不重织（只织本页打开后的新增量） */
        restored = true;
      }
    } catch {
      /* 409 = 宿主尚未开局：留在标题屏，开局命令稍后由玩家触发 */
    }
    if (restored && clientScreen !== 'game') bus.emit({ type: 'screen', to: 'game' } as never);
    startStream();
    forwardAiConfig();
  };

  /** 健康检查循环：未在线时探活，成功即握手拉回 online */
  const probe = (delay = 0): void => {
    if (disposed || healthTimer !== null) return;
    healthTimer = setTimeout(() => {
      healthTimer = null;
      if (disposed || online) return;
      session
        .health()
        .then(async () => {
          if (disposed) return;
          online = true;
          report({ status: 'online', lastError: null });
          runLog.info('extsync', '会话宿主已连上（session 档）', {});
          await handshake();
        })
        .catch((err) => {
          if (disposed) return;
          online = false;
          report({ status: 'reconnecting', lastError: err instanceof Error ? err.message : String(err) });
          probe(1_500);
        });
    }, delay);
  };

  /* —— 流监督器（M1.2）：SSE 断开（错误/干净断流）后独立退避重开。
     重开走完整握手：新流的宿主可能是重启后的新进程（_seq 归零），
     必须对齐水位，否则新事实被旧水位永久去重。
     握手失败（宿主还在死着）→ 退避后重试，直到流重新打开。 —— */
  const startStream = (): void => {
    if (disposed || closeStream) return;
    closeStream = session.streamEvents({
      after: lastSeq,
      onEvent: (e) => {
        if (disposed) return;
        const seq = e._seq ?? 0;
        if (seq <= lastSeq) return; /* 命令响应已应用过的，去重 */
        lastSeq = seq;
        bus.emit(e as never);
        scheduleResync(); /* 迟到事实改了服务端状态 → 投影收敛 */
      },
      onError: streamDown,
    });
  };

  const reopenStream = (): void => {
    if (disposed || closeStream || streamRetryTimer !== null) return;
    const delay = Math.min(15_000, 1_000 * 2 ** streamRetry);
    streamRetry += 1;
    runLog.warn('extsync', `事件流断开（${delay}ms 后重开，第 ${streamRetry} 次重试）`, {});
    streamRetryTimer = setTimeout(async () => {
      streamRetryTimer = null;
      if (disposed || !online || closeStream) return;
      try {
        await handshake();
        streamRetry = 0; /* 流已重开 */
      } catch {
        reopenStream(); /* 宿主还没回来：退避重试 */
      }
    }, delay);
  };

  const streamDown = (err: unknown): void => {
    if (disposed) return;
    closeStream?.();
    closeStream = null;
    void err;
    reopenStream();
  };

  const scheduleResync = (): void => {
    if (disposed || resyncTimer !== null) return;
    resyncTimer = setTimeout(() => {
      resyncTimer = null;
      if (disposed || !online) return;
      void session
        .state()
        .then((st) => {
          if (disposed) return;
          applyCore(st);
          bus.emit({ type: 'changed' } as never);
        })
        .catch(() => {
          /* 重同步失败留给健康循环 */
        });
    }, 250);
  };

  /* —— 表现层 AI 走网关（M3.1）：宿主 health 下发网关地址时，客户端的
     表现层通道（编织/场景叙事）切到同一网关（模型名=§65 角色）——
     玩家 Key 只在「网关不可用」时作为本地回退参与。与世界裁定侧
     （服务端 AiPort）使用同一把网关，客户端不再经手世界 AI 的钥匙。 —— */
  let restorePresentationAi: (() => void) | null = null;
  const useGatewayForPresentation = (gwUrl: string): void => {
    if (restorePresentationAi) return;
    const v1 = gwUrl.replace(/\/+$/, '') + '/v1';
    const cfg = {
      ...DEFAULT_LLM,
      enabled: true,
      baseURL: v1,
      apiKey: 'gateway-local',
      model: 'intent',
      tiers: {
        light: { baseURL: v1, model: 'intent', apiKey: 'gateway-local' },
        heavy: { baseURL: v1, model: 'npc', apiKey: 'gateway-local' },
      },
      channelRoutes: { intent: 'light', greet: 'light', npcDecide: 'heavy', chat: 'heavy', reason: 'heavy', narrative: 'heavy' },
    } as LlmConfig;
    const prev = gateway.active();
    /* 注意：客户端表现层**保留 narrateAsync**——sessionWeave 的编织正是用它 */
    gateway.use(new OpenAiCompatAdapter(cfg, () => aiHelpers));
    restorePresentationAi = () => gateway.use(prev);
    runLog.info('extsync', `表现层 AI 已切网关：${v1}`, {});
  };

  /* —— AI 配置转发：把玩家本地已配的 Key 注入服务端（gateway 档激活时
     服务端会显式忽略，且客户端不再转发——钥匙彻底离开客户端路径） —— */
  const forwardAiConfig = (): void => {
    if (disposed) return;
    if (restorePresentationAi) return; /* gateway 档：世界 AI 的钥匙在网关侧 */
    try {
      const cfg = loadLlmConfig();
      void session.setAiConfig(cfg).then((r) => {
        if (!disposed && r.ai !== 'rule') {
          runLog.info('extsync', `服务端 AI 通道已启用：${r.ai}${r.embeddingUsable ? '（含向量）' : ''}`, {});
        }
      });
      if (offLlmListeners.length === 0) {
        offLlmListeners.push(
          onLlmConfig(() => {
            if (!disposed && online) forwardAiConfig();
          }),
        );
      }
    } catch {
      /* 无 localStorage 环境（测试/SSR）：跳过转发 */
    }
  };

  /* —— 单条命令的在途执行（串行队列的工作单元） —— */
  const sendOne = async (cmd: GameCommand): Promise<void> => {
    /* 停摆检查放在执行时（队列等待期间可能断线） */
    if (!online) {
      bus.emit({ type: 'toast', text: OFFLINE_TOAST, cls: 'bad' } as never);
      probe(200);
      return;
    }
    const commandId = newCommandId();
    try {
      const res = await session.command({ ...cmd, commandId });
      if (disposed) return;
      online = true;
      applyCommandResult(res);
    } catch (err) {
      if (disposed) return;
      online = false;
      report({ status: 'reconnecting', lastError: err instanceof Error ? err.message : String(err) });
      runLog.warn('extsync', `会话命令失败（停摆等重连）：${err instanceof Error ? err.message : String(err)}`, {
        cmd: cmd.type,
      });
      bus.emit({ type: 'toast', text: OFFLINE_TOAST, cls: 'bad' } as never);
      probe(1_000);
    }
  };

  /* —— 会话命令端口：dispatch 全量转投（Phase 9 · §22 停摆语义）——
     isActive 恒为 true：session 档是唯一裁定通道，本地路径不再兜底。
     命令经串行队列保序（P1-5），逐条携带幂等键（P1-6）。 */
  setExternalCommandPort({
    isActive: () => true,
    sendCommand: (cmd: GameCommand) => {
      cmdChain = cmdChain.then(() => (disposed ? undefined : sendOne(cmd)));
    },
  });

  /* 记录客户端当前屏（握手决定是否切 game 屏；不 import store） */
  const offScreenWatch = bus.on((e) => {
    const raw = e as unknown as { type: string; to?: string };
    if (raw.type === 'screen' && typeof raw.to === 'string') clientScreen = raw.to;
  });

  probe();
  report({ status: 'connecting' });

  return () => {
    disposed = true;
    if (healthTimer !== null) clearTimeout(healthTimer);
    if (streamRetryTimer !== null) clearTimeout(streamRetryTimer);
    if (resyncTimer !== null) clearTimeout(resyncTimer);
    closeStream?.();
    offScreenWatch();
    for (const off of offLlmListeners) off();
    restorePresentationAi?.();
    setExternalCommandPort(null);
  };
}

interface SessionCommandResultWithEvents extends SessionStatePayload {
  ok: boolean;
  events?: SessionEvent[];
}
