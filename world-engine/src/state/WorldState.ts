/* ============================================================
   世界状态容器（机制自宿主 WorldState 原样抽取）
   ------------------------------------------------------------
   引擎负责的是**容器机制**：唯一事实来源槽位 need()、变化通知、
   尾节流落盘、分片落盘、事件序号随档走。状态里**有什么字段**
   是游戏的事——宿主经 holder 注入自己的容器对象（可带任意额外
   槽位，如宿主的 CB / curShop），经 create hook 提供自己的
   创局 / 水合逻辑。

   落盘节流（一次命令链 N 次变更只写一次盘）：changed 通知立即
   （UI 不许滞后），落盘走尾节流（避免一次命令链 N 次全量序列化）。
   节流走 scheduler：测试注入同步调度器时行为可控，生产为 setTimeout。
   ============================================================ */
import type { EngineWorldState, HistoryEntry, LogEntry, WorldEventInst } from '../types.ts';
import { eventSeq } from '../events/EventSchema.ts';
import { rng } from '../rng.ts';
import { scheduler } from '../scheduler.ts';
import { splitShards, type ShardFieldSpec } from './Shards.ts';
import type { SavePort } from './storage.ts';

/** 世界状态槽位：宿主可传入自己的容器对象（带额外槽位） */
export interface StateHolder<W extends EngineWorldState> {
  S: W | null;
}

export interface WorldContainerOptions<W extends EngineWorldState> {
  /** 状态槽位。缺省引擎自建；宿主传入自己的 core 对象（含 CB / curShop 等槽位） */
  holder?: StateHolder<W>;
  /** 存档端口（缺省无介质：save 静默跳过，与宿主行为一致） */
  getSavePort?: () => SavePort<W> | null;
  /** 变化通知（changed 立即发，不节流）：宿主在此接自己的 UI 信号总线 */
  onChanged?: () => void;
  /** 分片字段表（缺省不分片：整档落盘） */
  shardFields?: ShardFieldSpec;
}

export interface WorldContainer<W extends EngineWorldState> {
  /** 状态槽位（与传入的 holder 同一对象） */
  core: StateHolder<W>;
  /** 取当前世界状态；未开始时抛错（调用方须先经引擎命令） */
  need(): W;
  /** 立即落盘：事件序号随档走 + 分片介质优走分片通道 */
  save(): void;
  /** 丢掉待写标记并写一次（退出前 / 需要读回时用） */
  flushSave(): void;
  /** 状态变化 + 落盘：changed 立即，落盘尾节流 */
  sync(): void;
  /** 落盘节流窗口：一次命令链 N 次 sync 只写一次盘 */
  readonly SAVE_THROTTLE_MS: number;
}

export const SAVE_THROTTLE_MS = 1000;

export function createWorldContainer<W extends EngineWorldState>(opts: WorldContainerOptions<W> = {}): WorldContainer<W> {
  const core: StateHolder<W> = opts.holder ?? { S: null };
  const shardFields = opts.shardFields;
  let saveQueued = false;

  function need(): W {
    if (!core.S) throw new Error('WorldState 尚未初始化（先 newGame/导入存档）');
    return core.S;
  }

  function save(): void {
    const s = core.S;
    if (!s) return;
    s.evtSeq = eventSeq(); // 序号随档走
    const p = opts.getSavePort?.() ?? null;
    if (!p) return;
    /* 分片通道：介质支持就拆着写——主档小、每次写，随规模增长的表只在
       内容变了时写。介质不支持（内存介质 / 测试桩）静默退化为整档：
       只是每次都多写几 MB，不会出错。 */
    if (p.saveShards && shardFields) p.saveShards(splitShards(s, shardFields));
    else p.save(s);
  }

  /** 状态变化 + 落盘（节流窗口内只写一次盘） */
  function sync(): void {
    opts.onChanged?.();
    if (saveQueued) return;
    saveQueued = true;
    scheduler.after(SAVE_THROTTLE_MS, () => {
      saveQueued = false;
      save();
    });
  }

  function flushSave(): void {
    saveQueued = false;
    save();
  }

  return {
    core,
    need,
    save,
    flushSave,
    sync,
    SAVE_THROTTLE_MS,
  };
}

/* ============================================================
   引擎自带的通用创局工厂（供独立运行 / 示例 / 新游戏接入起步）。
   注意：这不是宿主 newState 的替身——宿主的创角（世界书种族/职业
   / 起始装备）留在宿主侧。这里产出的是**满足信封的最小合法状态**。
   ============================================================ */

export interface BaseStateSpec {
  worldId?: string;
  playerName?: string;
  startLoc?: string;
  weather?: string;
  seed?: number;
}

export function createBaseState(spec: BaseStateSpec = {}): EngineWorldState {
  const s: EngineWorldState = {
    worldId: spec.worldId,
    ver: 1,
    /* 种子走统一随机源（一切随机经 rng，测试可注入）：它一旦定下就不再变。
       这是世界模拟的复现种子，不是加密材料。 */
    seed: spec.seed ?? Math.floor(rng.next() * 4294967296) >>> 0,
    t: 16, // 开局在第一个白天的第 16 刻（与宿主开局口径一致）
    weather: spec.weather ?? '晴',
    player: {
      name: spec.playerName ?? '旅人',
      loc: spec.startLoc ?? 'plaza',
      bag: [],
      flags: {},
    },
    npcs: {},
    rep: {},
    events: [],
    history: [],
    log: [],
    logSeq: 0,
    recap: [],
    recapSeq: 0,
  };
  return s;
}

/** 便签类型：宿主在水合时常用的行类型再导出 */
export type { LogEntry, HistoryEntry, WorldEventInst };
