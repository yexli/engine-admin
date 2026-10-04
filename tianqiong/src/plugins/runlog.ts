/* ============================================================
   运行日志装配（开发阶段观测）：把「世界实际发生了什么」自动接进 runLog
   —— 三条自动来源 + 注入世界快照：
     · worldBus 通配订阅：每条世界事实（类型 / 级别 / 参与者 / 因果父 / 来源标记）
     · bus 订阅：界面侧的关键信号（场景切换、toast、检定卡）
     · 全局错误：未捕获异常与未处理的 Promise 拒绝
   刻意与「死信留痕」分工：死信由 bootstrap 的观察者记（那里本来就有 hook），
   这里不再抢那个单槽——同一个槽被两处抢会互相顶掉。
   ============================================================ */
import { bus, worldBus } from '@/events/EventBus';
import { core } from '@/world/WorldState';
import { sceneTime } from '@/world/WorldClock';
import { runLog, setRunLogSnapshot } from '@/devlog/RunLog';
import type { WorldEvent } from '@/events/EventSchema';

/** 把结构化载荷压成能安全进日志的小对象：长字符串截断，容器只留形状 */
export function shrink(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string') out[k] = v.length > 120 ? v.slice(0, 120) + '…' : v;
    /* 容器只留形状，但要能分辨「数组/对象」与「恰好长这样的字符串」 */
    else if (Array.isArray(v)) out[k] = '{arr:' + v.length + '}';
    else if (typeof v === 'object') out[k] = '{obj:' + Object.keys(v as Record<string, unknown>).length + '}';
    else out[k] = String(v).slice(0, 40);
  }
  return out;
}

export interface RunLogAttachOptions {
  /** 是否记录界面通道（默认记：场景切换 / toast / 检定卡） */
  ui?: boolean;
}

/** 装配运行日志；返回卸载函数（HMR / 重置用） */
export function attachRunLog(opts: RunLogAttachOptions = {}): () => void {
  const offs: (() => void)[] = [];

  /* 世界快照：日志模块本身不依赖引擎，日与刻由这里喂进去 */
  setRunLogSnapshot(() => (core.S ? { day: sceneTime(core.S).day, tick: core.S.t } : null));

  /* 1. 世界事件（主干）：级别越高越显眼，L0/L1 记 debug 免得刷屏 */
  offs.push(
    worldBus.on(
      '*',
      (e: WorldEvent) => {
        if (!runLog.enabled) return;
        const lvl = e.level >= 3 ? 'warn' : e.level >= 2 ? 'info' : 'debug';
        runLog.write('event', lvl, e.type, {
          /* 事件自身的结构字段放在最后：载荷里出现同名键时不许静默改写事件身份 */
          ...(e.data ? shrink(e.data) : {}),
          id: e.id,
          level: e.level,
          actor: e.actor,
          target: e.target,
          loc: e.location,
          cause: e.cause,
          parent: e.parentId,
          origin: e.origin,
          /* 0 个目击者与「没有这个字段」是两件事，别用 || 抹平 */
          wit: e.witnesses ? e.witnesses.length : undefined,
        });
      },
      'runlog',
    ),
  );

  /* 2. 界面信号：只记有观测价值的几类，其余（changed / combatChanged…）太吵 */
  if (opts.ui !== false) {
    offs.push(
      bus.on((e) => {
        if (!runLog.enabled) return;
        if (e.type === 'toast') runLog.write('ui', e.cls === 'bad' ? 'warn' : 'info', 'toast·' + e.text);
        else if (e.type === 'screen') runLog.info('ui', '屏幕切换 → ' + e.to);
        else if (e.type === 'check') runLog.debug('ui', e.desc ? '检定卡·' + e.desc.label : '检定卡收起');
        else if (e.type === 'combat') runLog.debug('ui', '战斗界面 ' + (e.open ? '开' : '关'));
      }),
    );
  }

  /* 3. 全局错误：这是「开发阶段观测」最该抓住的一类 */
  if (typeof window !== 'undefined') {
    const onErr = (ev: ErrorEvent): void => {
      runLog.error('error', ev.message || '未捕获异常', { from: ev.filename, line: ev.lineno });
    };
    const onRej = (ev: PromiseRejectionEvent): void => {
      runLog.error('error', '未处理的 Promise 拒绝', { reason: String(ev.reason).slice(0, 200) });
    };
    window.addEventListener('error', onErr);
    window.addEventListener('unhandledrejection', onRej);
    offs.push(() => {
      window.removeEventListener('error', onErr);
      window.removeEventListener('unhandledrejection', onRej);
    });
  }

  runLog.mark('运行日志已接入', {
    dev: (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true,
    ui: opts.ui !== false,
  });
  return () => {
    for (const off of offs) off();
  };
}
