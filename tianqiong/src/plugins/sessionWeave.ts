/* ============================================================
   sessionWeave —— session 档的客户端叙事编织（§30 表现层归位）
   ------------------------------------------------------------
   本地引擎里，编织（Narration）在命令出口把见闻织成小说正文并
   经 mutate.weaveLogs 写回状态。session 档里世界真相在服务端：
   客户端**不得**为编织改写投影（下一次快照会把它冲掉）。

   归位方案：编织照常在客户端跑（gateway.active()——ruleSim 或
   真模型），但产物进**覆盖表**（logId → 织后文本），渲染时叠加；
   被织掉的条目标记为空串（吸收），不再显示。状态零改动，快照
   随便刷——覆盖表按 logId 记账，天然幸存于快照替换。

   批次语义与本地 Narration 同源：
   · 触发：每次快照回灌（bus 'changed'）差分出 id > 水位的新见闻；
   · 一批一织：锚点 = 本批第一条（替换为织后正文，cls 'ai'），
     其余条目吸收（从渲染中消失——与 weaveLogs 的合并语义一致，
     玩家原话行「＞ …」也保留，同 weaveLogs 的铁律）；
   · 换代自愈：新局/重置后 log id 回退，覆盖表与水位自动清零。
   ============================================================ */
import { bus, core } from '@/world';
import { gateway } from '@/ai/gateway';
import { sceneTime } from '@/world/WorldClock';
import { buildNarrativeContext } from '@/world/NarrativeContext';
import { WB } from '@/data/worldBook';
import { runLog } from '@/devlog/RunLog';

/** 见闻行（结构化窄类型，避免依赖引擎包类型） */
interface LogRow {
  id?: number;
  text: string;
  cls: string;
}

/** logId → 织后文本；'' = 已被本批吸收（渲染时隐藏） */
const overrides = new Map<number, string>();
/** 已定夺（织过/判过）的最大条目 id */
let watermark = 0;
let inFlight = false;
let pendingAgain = false;
let disposed = true;

/** 渲染入口：返回替换后的条目（锚点：织后正文 + cls 'ai'）或
 *  null（被本批吸收，不渲染）。无覆盖 = 原样返回 null 之外的语义
 *  由调用方决定——这里约定：没有覆盖时返回原条目本身。 */
export function applyWeaveOverride<T extends LogRow>(e: T): T | null {
  if (e.id === undefined) return e;
  const w = overrides.get(e.id);
  if (w === undefined) return e;
  if (w === '') return null; /* 被织进锚点那条了 */
  /* 锚点：正文换织后文本，cls 换 'ai'（与本地 weaveLogs 的产物同款渲染） */
  return { ...e, text: w, cls: 'ai' };
}

/** 测试/换档用：清空覆盖与水位 */
export function resetSessionWeave(): void {
  overrides.clear();
  watermark = 0;
  inFlight = false;
  pendingAgain = false;
}

function onChanged(): void {
  if (disposed) return;
  if (inFlight) {
    pendingAgain = true;
    return;
  }
  const S = core.S;
  if (!S) return;
  const log = (S.log || []) as LogRow[];
  const maxId = log.reduce((m, e) => Math.max(m, e.id ?? 0), 0);
  /* 换代检测：新局/重置后条目 id 回退 → 覆盖表与水位作废 */
  if (maxId < watermark) {
    overrides.clear();
    watermark = maxId;
  }
  /* GC（审查 P2-12）：已被见闻录环形窗口滚出去的覆盖条目是死数据 */
  if (overrides.size > 0) {
    const live = new Set(log.map((e) => e.id ?? -1));
    for (const id of [...overrides.keys()]) {
      if (!live.has(id)) overrides.delete(id);
    }
  }
  const fresh = log.filter((e) => (e.id ?? 0) > watermark && e.cls !== 'meta' && e.id !== undefined);
  if (fresh.length === 0) {
    watermark = Math.max(watermark, maxId);
    return;
  }
  /* 能力门放在水位推进**之前**（审查 P2-12）：玩家中途配好模型时，
     尚未编织的条目仍可补织；每次 changed 至多尝试一批，不风暴 */
  if (!gateway.active().narrateAsync) return;
  watermark = Math.max(watermark, maxId);
  void weaveBatch(fresh);
}

/** 会话握手用（extSession）：把当前见闻全部标记为「已看过」——
 *  页面刷新/中途接入时不重织既有历史，只织本页打开后的新增量。 */
export function markSessionWeaveSeen(): void {
  const S = core.S;
  if (!S) return;
  const maxId = ((S.log || []) as LogRow[]).reduce((m, e) => Math.max(m, e.id ?? 0), 0);
  watermark = Math.max(watermark, maxId);
}

async function weaveBatch(entries: LogRow[]): Promise<void> {
  inFlight = true;
  const anchor = entries[0]!.id!;
  const S = core.S;
  /* 藏起这一批直到织完（复用本地编排的 weave 描述符信号） */
  if (S) bus.emit({ type: 'weave', from: anchor - 1 } as never);
  try {
    const s = core.S;
    if (!s) return;
    const t = sceneTime(s);
    const nc = buildNarrativeContext(s, anchor - 1, s.player.loc);
    const ctx = {
      loc: s.player.loc,
      locName: WB.locations[s.player.loc]?.name ?? s.player.loc,
      time: t.month + t.date + '日 ' + t.period,
      weather: s.weather,
      chronicle: nc.chronicle,
      recap: nc.recap,
      events: nc.events,
      continuity: nc.continuity,
    };
    const text = await gateway
      .active()
      .narrateAsync!(entries.map((e) => e.text), ctx as never)
      .catch(() => null);
    if (!text) {
      runLog.warn('extsync', '会话编织未产出正文（保留规则原文）', { anchor });
      return;
    }
    /* 玩家原话行不吸收（与 weaveLogs 同一铁律：保留「我说过什么」的锚点） */
    overrides.set(anchor, text);
    for (const e of entries.slice(1)) {
      if (e.id === undefined) continue;
      const echo = e.cls === 'say' && e.text.startsWith('＞');
      overrides.set(e.id, echo ? e.text : '');
    }
    bus.emit({ type: 'changed' } as never); /* 重渲染：覆盖生效 */
  } finally {
    inFlight = false;
    bus.emit({ type: 'weave', from: null } as never);
    if (pendingAgain && !disposed) {
      pendingAgain = false;
      onChanged();
    }
  }
}

/** 组合根装配（main.tsx，仅 session 档）：监听快照回灌后的 changed。
 *  本地/bridge 档不装配——本地 Narration 已经在做同一件事。 */
export function attachSessionWeave(): () => void {
  disposed = false;
  const off = bus.on((e) => {
    if (e.type === 'changed') onChanged();
  });
  return () => {
    disposed = true;
    off();
  };
}
