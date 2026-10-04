/* ============================================================
   世界事件簿与因果历史（原型 fireEv / addHistory / timeline）
   §43：世界按日历自行运转，事件后果沉淀进历史。
   卡 D4：timeline 由硬编码 5 日脚本改为委托数据驱动 World Director。
   ============================================================ */
import { need } from '@/world/WorldState';
import { directorTick } from '@/events/EventProcessor';
import { scheduler, worldBus } from '@/events/EventBus';
import { savePort } from '@/plugins/PluginInterface';
import { sceneTime } from '@/world/WorldClock';
import { traceChain, type WorldEvent } from './EventSchema';

/** 事件注册（同 id 幂等，原型 fireEv） */
export function fireEv(id: string, name: string, res?: string, imp?: number) {
  const s = need();
  if (s.events.some((e) => e.id === id)) return;
  s.events.push({ id, name, day: sceneTime(s).day });
  addHistory(name, res || '', imp || 2);
}

/** 因果历史（最多保留 60 条，原型 addHistory） */
export function addHistory(cause: string, result: string, imp: number) {
  const s = need();
  const t = sceneTime(s);
  s.history.unshift({ d: t.month + t.date + '日', c: cause, r: result || '', imp: imp || 1 });
  if (s.history.length > 60) s.history.pop();
}

/** 第三纪元 612 年·世界日历驱动（卡 D4：委托数据驱动 World Director）
 *  保留导出签名以兼容 time.newDay 与既有测试；内部改为扫 events.json。 */
export function timeline() {
  directorTick();
}

/* ============================================================
   世界事件日志（《插件化世界模拟架构方案》§29 / §44）
   —— 存档里的 events/history 是「世界记得的事」（扁平、给人看）；
      本日志是「世界实际发生过的世界事件」（保因果链、给推演与调试用）。
   刻意不写进存档：世界事件是运行时可追踪数据，不是存档结构的一部分。
   ============================================================ */
const LOG_CAP = 500;
const worldLog: WorldEvent[] = [];

export const worldEventLog = {
  record(e: WorldEvent): void {
    worldLog.push(e);
    if (worldLog.length > LOG_CAP) worldLog.shift();
  },

  recent(n = 20): WorldEvent[] {
    return worldLog.slice(-n);
  },

  byId(id: string): WorldEvent | undefined {
    return worldLog.find((e) => e.id === id);
  },

  /** §29 因果链向上追溯：「这个 NPC 为什么现在恨玩家？」 */
  chain(id: string, maxDepth = 12): WorldEvent[] {
    return traceChain(worldLog, id, maxDepth);
  },

  size(): number {
    return worldLog.length;
  },

  clear(): void {
    worldLog.length = 0;
  },

  /** 导出全量（持久化用）：§29 的长期追溯不该因为一次重启就归零 */
  dump(): WorldEvent[] {
    return [...worldLog];
  },

  /** 恢复（载入存档时调用）。上限与淘汰策略不变：只留最后 LOG_CAP 条 */
  restore(rows: WorldEvent[]): void {
    worldLog.length = 0;
    for (const e of rows.slice(-LOG_CAP)) worldLog.push(e);
  },
};

/**
 * 世界史的落盘节流（二期 H-10）。
 * 世界事件是热路径，不能每条都写盘；介质不支持该通道时静默退化为内存
 * （与向量索引同一条约定：能力不足只影响"重启后还在不在"，不影响玩法）。
 */
/** 载入存档时恢复世界史（WorldRuntime 的 continueSave / importState 调用） */
export function restoreWorldLog(rows: WorldEvent[]): void {
  worldEventLog.restore(rows);
}

/**
 * 取消待写的世界史落盘并复位旗标（resetWorld / newGame 调用）。
 * 缺了它，`scheduler.cancelAll()` 会把定时清掉而旗标永远停在 true——
 * 本会话内世界史再也不落盘，且没有任何错误通道提示（二期审查 C2）。
 */
export function cancelWorldLogPersist(): void {
  logSaveQueued = false;
}

let logSaveQueued = false;
function scheduleWorldLogPersist(): void {
  if (logSaveQueued || !savePort()?.saveWorldLog) return;
  logSaveQueued = true;
  scheduler.after(1000, () => {
    logSaveQueued = false;
    savePort()?.saveWorldLog?.(worldEventLog.dump());
  });
}

/** 把世界事件日志挂到世界事件总线上（组合根调用一次） */
export function attachWorldEventLog(): () => void {
  return worldBus.on(
    '*',
    (e) => {
      /* Level 0 是纯内部账目（掉血、扣蓝、CD），不入世界史，避免噪音淹没因果链 */
      if (e.level === 0) return;
      worldEventLog.record(e);
      scheduleWorldLogPersist();
    },
    'world-event-log',
  );
}
