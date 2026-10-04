/* ============================================================
   卡 L1 · 寿命（世界书 §80「时间与寿命」）

   §80 的寿命表（见习 70-100 / 正式 100-150 / 主教 150-300 / 圣徒 300-500 / 神阶 500+）
   早在 K3 就写进了 timeslip.json，但它当时只有测试在调——因为**年龄根本不存在**：
   PlayerState 里没有出生刻，世界时间走多少年都与这个人无关。
   本模块把表接上真实年龄，于是：

   · 年龄随外界时间自然增长（存出生刻，不存年龄——年龄是派生量，存下来迟早漏同步）；
   · 境界抬升会真的延长寿数（§80 的表按境界给）；
   · 百年神选座次的「寿元 +N 年」有地方落（lifeBonus）——这句赏赐此前是一句空话；
   · §10「网中历时不耗寿」有地方扣（netAgedTicks）；
   · §80「内成长 100 年 = 外成长 20 年」的小世界闭关，代价就是这里的年岁。

   寿终的**后果**不在此写死：世界书没有规定寿数耗尽之后怎样，
   故这里只置事实（flag life_exhausted）并发一条世界事件，由事件链/后续设计决定。
   ============================================================ */
import type { WorldState } from '@/types/world';
import { TICKS_PER_YEAR } from '@/world/TimeBase';
import { mutate } from '@/world/WorldMutate';
import { need } from '@/world/WorldState';
import { makeEvent } from '@/events/EventSchema';
import { worldBus } from '@/events/EventBus';
import { sceneTime } from '@/world/WorldClock';
import { log } from '@/systems/character/Gains';
import { lifespanOf } from '@/systems/timeslip/Timeslip';

/**
 * 年龄（岁）。净时长 = 世界时间 − 出生刻 − 网中时长（§10 网中历时不耗寿）。
 * **不在此舍入**：一天只有 1/360 年，两位小数比一天还粗，会把"过了一日"抹平——
 * 精度归计算，展示归 lifeLine（它才做取整）。
 */
export function ageOf(s: WorldState = need()): number {
  const bt = s.player.birthTick ?? s.t;
  const net = s.player.netAgedTicks ?? 0;
  const ticks = Math.max(0, s.t - bt - net);
  return ticks / TICKS_PER_YEAR;
}

/** 当前寿数区间（§80）；「寿元 +N 年」的赏赐加在上限上 */
export function lifespanRange(s: WorldState = need()): { rank: string; min: number; max: number; bonus: number } {
  const row = lifespanOf(0, s);
  const bonus = s.player.lifeBonus ?? 0;
  return { rank: row.rank, min: row.min + bonus, max: row.max + bonus, bonus };
}

/** young 青年 / prime 盛年 / old 暮年 / exhausted 寿数已尽 */
export type LifeStage = 'young' | 'prime' | 'old' | 'exhausted';

export interface LifeStatus {
  age: number;
  rank: string;
  min: number;
  max: number;
  bonus: number;
  /** 还可活多少年（可为负：已过上限） */
  remain: number;
  /** 已历占比 0–1 */
  pct: number;
  stage: LifeStage;
}

export function lifeStatus(s: WorldState = need()): LifeStatus {
  const r = lifespanRange(s);
  const age = ageOf(s);
  const pct = r.max > 0 ? age / r.max : 1;
  const stage: LifeStage = age >= r.max ? 'exhausted' : pct >= 0.8 ? 'old' : pct >= 0.5 ? 'prime' : 'young';
  return {
    age,
    rank: r.rank,
    min: r.min,
    max: r.max,
    bonus: r.bonus,
    remain: r.max - age,
    pct: Math.round(pct * 1000) / 1000,
    stage,
  };
}

/**
 * 每日寿数检查（挂 daySettle）：寿数耗尽时置事实并上报**一次**（幂等）。
 * 后果留给事件链——世界书没写寿终会怎样，这里就不替它写。
 */
export function agingTick(s: WorldState): void {
  const st = lifeStatus(s);
  if (st.stage !== 'exhausted' || s.player.flags.life_exhausted) return;
  mutate.playerFlag('life_exhausted');
  log('你忽然听清了自己的心跳——岁月的账已经走到了尽头（' + st.age + ' 岁）。', 'bad', s);
  worldBus.emit(
    makeEvent({
      type: 'life_exhausted',
      day: sceneTime(s).day,
      tick: s.t,
      actor: 'player',
      location: s.player.loc,
      level: 0,
    }),
  );
}

/** 寿数面板行（UI 与测试共用）。展示才取整——岁数给到整岁，余数给一位小数 */
export function lifeLine(s: WorldState = need()): string {
  const st = lifeStatus(s);
  const tag = { young: '青年', prime: '盛年', old: '暮年', exhausted: '寿数已尽' }[st.stage];
  const remain = Math.round(st.remain * 10) / 10;
  return (
    Math.floor(st.age) +
    ' 岁（' +
    st.rank +
    '）· ' +
    tag +
    ' · 可活 ' +
    st.min +
    '–' +
    st.max +
    ' 年' +
    (st.bonus > 0 ? '（含寿元 +' + st.bonus + '）' : '') +
    ' · 余 ' +
    remain +
    ' 年'
  );
}
