/* ============================================================
   World Query：通用只读查询（引擎单一实现点）
   ------------------------------------------------------------
   与世界书 / 插件 / 执行器无关的查询面——宿主经 createQuery 复用
   同一份实现（§18：World API 是统一入口；§63：稳定边界）。
   依赖世界书或宿主插件体系的查询（地点表 / 关系种子 / 能力清单）
   归宿主，不在此处。
   ============================================================ */
import type { WorldClock } from '../time/WorldClock.ts';
import type { EngineWorldState } from '../types.ts';

/** 世界时钟读数 */
export interface WorldTimeView {
  tick: number;
  day: number;
  year: number;
  month: string;
  monthIndex: number;
  date: number;
  hour: number;
  period: string;
  weather: string | null;
}

export interface QuerySource<W extends EngineWorldState> {
  /** 当前世界状态（未开局返回 null；查询面绝不抛错） */
  getState(): W | null;
  /** 场景时间换算（历法标签由宿主的时钟实例携带） */
  clock: Pick<WorldClock<W>, 'sceneTime'>;
}

export interface WorldQuery<W extends EngineWorldState> {
  /** 当前世界状态（只读面；改写必须走命令 / mutate） */
  get_world_state(): W | null;
  /** 世界时钟读数（§27：全局唯一时间，各系统不得自建时间） */
  get_time(): WorldTimeView | null;
  get_weather(): string | null;
  /** 玩家所在地点 */
  get_location(): string | null;
  get_player(): W['player'] | null;
  /** 已进入运行时视野的实体 id 列表 */
  get_entities(): string[];
  get_entity(id: string): W['npcs'][string] | null;
  /** 见闻录最近 n 条（时序） */
  get_log(n?: number): W['log'];
  get_history(): W['history'];
}

export function createQuery<W extends EngineWorldState>(src: QuerySource<W>): WorldQuery<W> {
  return {
    get_world_state: () => src.getState(),

    get_time(): WorldTimeView | null {
      const s = src.getState();
      if (!s) return null;
      const t = src.clock.sceneTime(s);
      return {
        tick: s.t,
        day: t.day,
        year: t.year,
        month: t.month,
        monthIndex: t.monthIndex,
        date: t.date,
        hour: t.h,
        period: t.period,
        weather: s.weather,
      };
    },

    get_weather: () => src.getState()?.weather ?? null,
    get_location: () => src.getState()?.player.loc ?? null,
    get_player: () => src.getState()?.player ?? null,
    get_entities: () => {
      const s = src.getState();
      return s ? Object.keys(s.npcs) : [];
    },
    get_entity: (id: string) => (src.getState()?.npcs[id] ?? null) as W['npcs'][string] | null,
    get_log: (n = 20) => (src.getState()?.log ?? []).slice(-n),
    get_history: () => src.getState()?.history ?? [],
  };
}
