/* ============================================================
   日边界结算装配（《插件化世界模拟架构方案》§21 / §27 / §31）
   —— WorldClock 只负责「推进时间 + 发布 new_day 事实」；
   谁在日边界做什么、按什么顺序做，全部由本文件的顺序表显式声明。

   为什么独立成装配点：改造前这些调用内联在 WorldClock.newDay 里，
   时钟因此反向依赖 8 个业务系统 + 2 个记忆模块（复核 §19 判 PARTIAL）。
   更麻烦的是顺序是**隐式契约**——「经济回归必须在羁绊 tick 之前」只写在
   注释里，靠人遵守。抽出来后顺序变成数组本身，有人调整它会被用例拦住。

   顺序与改造前的 newDay 逐位一致，这是硬要求：天气抽取与日常氛围日志
   都吃 rng，挪一步就会让整条随机序列漂移（症状是玩法卡测试静默变值）。
   ============================================================ */
import { rng, worldBus } from '@/events/EventBus';
import { timeline } from '@/events/EventStore';
import { core } from '@/world/WorldState';
import { sceneTime, seasonName } from '@/world/WorldClock';
import { mutate } from '@/world/WorldMutate';
import { econRevert, vendorIncome } from '@/systems/economy/Economy';
import { bondDailyTick } from '@/systems/relationship/Bond';
import { abyssTick } from '@/systems/dungeon/Abyss';
import { dungeonTick } from '@/systems/dungeon/Dungeon';
import { investigationTick } from '@/systems/law/Investigation';
import { memoryTick } from '@/memory/lifecycle/MemoryLifecycle';
import { gossipTick } from '@/memory/propagation/InformationPropagation';
import { theoselectTick } from '@/systems/religion/Theoselect';
import { agingTick } from '@/systems/timeslip/Lifespan';
import { ritesTick } from '@/systems/rites/Rites';
import { serviceTick } from '@/systems/academy/Academy';
import { evalTitles } from '@/systems/reputation/Title';
import { runLog } from '@/devlog/RunLog';
import { dispatchBeliefActions } from './beliefDispatch';
import type { StatusEffect, Weather, WorldState } from '@/types/world';

interface DayStep {
  /** 归属系统（审计用：与 SYSTEM_SPECS 的 id 对齐；world = 世界自身） */
  owner: string;
  why: string;
  run: (s: WorldState, day: number) => void;
}

/** 当日天气抽取（从 WorldClock.newDay 原样搬来，rng 调用次序不变） */
function rollWeather(s: WorldState): void {
  const se = seasonName(s);
  const tb: [Weather, number][] = {
    春: [['晴', 0.45], ['多云', 0.3], ['雨', 0.2], ['雾', 0.05]],
    夏: [['晴', 0.55], ['多云', 0.25], ['雨', 0.2]],
    秋: [['晴', 0.35], ['多云', 0.3], ['雨', 0.2], ['雾', 0.15]],
    冬: [['晴', 0.3], ['多云', 0.25], ['雪', 0.3], ['雾', 0.15]],
  }[se] as [Weather, number][];
  let r = rng.next();
  mutate.weather('晴');
  for (const [w, p] of tb) {
    if (r < p) {
      mutate.weather(w);
      break;
    }
    r -= p;
  }
}

/** 日常氛围日志（0.6 概率；写入走 mutate，时钟不再自己碰世界状态） */
function ambientDailyLog(): void {
  if (!rng.chance(0.6)) return;
  mutate.pushLog(
    rng.pick([
      '城卫队在东市换岗，铁靴声整条街都听得见。',
      '公会任务板前又排起长队。',
      '神殿晨祷开始，唱诗声隔着两条街都能听见。',
      '有商队从金砂城方向进城，驼铃响了一路。',
    ]),
    'sys',
  );
}

/**
 * 世界级状态的按期衰减（二期审查 I6）。
 * `left` 以「刻」计，日边界扣 48；缺省 `left` = 永久。
 * 缺了这一步，「中毒三天」这类效果会永远挂着——add_status 已在可执行白名单里，
 * 白名单不能说假话。
 */
function decayStatusEffects(s: WorldState): void {
  const decay = (arr?: StatusEffect[]): void => {
    if (!arr) return;
    for (let i = arr.length - 1; i >= 0; i--) {
      const e = arr[i];
      if (typeof e.left !== 'number') continue; // 缺省 = 永久，直到被显式移除
      e.left -= 48;
      if (e.left <= 0) arr.splice(i, 1);
    }
  };
  decay(s.player.effects);
  for (const id of Object.keys(s.npcs)) decay(s.npcs[id].effects);
}

/**
 * 日结算顺序表——**它就是契约**。
 * R3 顺序：物价先向基准回归，羁绊日 tick 才在回归后的物价上计算回赠。
 * 调换任意两项都会改变数值走向，`arch-day-settle.test.ts` 的顺序断言会红。
 */
const NEW_DAY_STEPS: DayStep[] = [
  { owner: 'economy', why: '物价向基准回归 + 商人营生进账（当日事件可再拉动）', run: (s) => { econRevert(s); vendorIncome(s); } },
  { owner: 'relationship', why: '羁绊日 tick（回赠 + 仇怨衰减；R3 依赖物价已回归）', run: (s) => bondDailyTick(s) },
  { owner: 'dungeon', why: '星渊魔气日 tick（缓升，封印可压制）', run: (s) => abyssTick(s) },
  { owner: 'law', why: '势力案件取证推进（只有有人目击的案子才会立案）', run: (s) => investigationTick(s) },
  { owner: 'memory', why: '记忆归并与遗忘', run: (s, day) => memoryTick(s, day) },
  { owner: 'memory', why: '关系网传话（确定性节律，不耗主随机序列）', run: (s, day) => gossipTick(s, day) },
  { owner: 'dungeon', why: '深层过夜 → 魔气侵蚀（幂等，按日一次）', run: (s) => dungeonTick(s) },
  { owner: 'religion', why: '百年神选（保底开启 + 按刻推进阶段，幂等）', run: (s) => theoselectTick(s) },
  { owner: 'world', why: '当日天气抽取（§27；写入走 mutate.weather）', run: (s) => rollWeather(s) },
  { owner: 'world', why: '日常氛围日志（0.6 概率；写入走 mutate.pushLog）', run: () => ambientDailyLog() },
  { owner: 'reputation', why: '按当天状态评估称号（幂等，只记首次获得的历史）', run: (s) => evalTitles(s) },
  { owner: 'world', why: '世界史时间线记账（EventStore，非业务模块）', run: () => timeline() },
  /* Phase 4.2：这里原有一格「跨日刷新 NPC 自主位置（卡 D1）」。位置是 npcAt 的纯函数产物，
     从没有过「必须被 tick」的理由——撤掉后顺序表少一格，不再有每天一次的全表物化。 */
  { owner: 'character', why: '世界级状态按期衰减（I6：left 的读者）', run: (s) => decayStatusEffects(s) },
  /* 卡 J2：信念 → 行动。两个约束，理由不同：
     ① 必须排在 memory 格之后——信念要先重建完才有得匹配；
     ② 排在末尾保护的是**当天**：本格在 weather / ambientDailyLog 之后，
        所以玩家当天看到的天气与氛围不因信念而变化。
        跨天的随机序列**会**偏移，且这是不可避免的——信念产生的记忆与传闻会进入
        memoryTick / gossipTick（顺序表第 5/6 格，排在天气之前），那两格本身消耗 rng。
        实测确认：带信念与不带信念跑同样天数，第 1 天的天气就已经不同。
        这是新玩法接入世界的正常后果，不是缺陷。traceability.test.ts 钉住的是
        **确定性**（同种子同操作 → 同一结果），而不是「序列一字不动」——后者在信念
        真正参与世界之后本就不可能。 */
  { owner: 'memory', why: '信念驱动行动（J2：认知闭环的最后一段）', run: (s, day) => void dispatchBeliefActions(s, day) },
  /* 卡 L1：寿数检查。排在末尾的理由与 J2 同——新格排末尾不位移既有各步的随机消耗；
     它自己也不掷骰（只读年龄与境界、比一下、幂等地置事实），所以放在哪个位置都不改数值，
     那就按"新步骤追加在尾部"这条既有约定办。 */
  { owner: 'timeslip', why: '寿数检查（§80：年龄随外界时间走，寿尽时置事实并上报一次）', run: (s) => agingTick(s) },
  /* 卡 L3：身后事必须**紧跟**寿数检查——它读的就是上一步置下的 life_exhausted。
     仍是"新步骤追加在末尾"这条约定的延续。 */
  { owner: 'customs', why: '身后事（§96：寿尽则按当地丧俗安葬、按当地继承制度分配遗产，幂等）', run: (s) => ritesTick(s) },
  /* 卡 G3：服役（§101 寒门通道的另一半）。按年发饷、期满入册；不在服役期时一眼返回。 */
  { owner: 'academy', why: '服役结算（§101：神殿预备役／军工定向按年发饷并积累声望，期满入册）', run: (s) => serviceTick(s) },
];

/** 装配顺序（= 执行顺序）。返回卸载函数，供组合根的 dispose 链使用。 */
export function registerDaySettle(): () => void {
  return worldBus.on(
    'new_day',
    () => {
      const s = core.S;
      if (!s) return;
      const day = sceneTime(s).day;
      /* 逐步隔离（审查 §日边界）：此前任何一步抛错都会带走当天后续全部步骤——
         表现是「某天之后天气不再变、声望不再回归、身后事不再办」却不报错。
         顺序表是显式契约（arch-day-settle 钉着），顺序不动，但单步失败不得拖垮其余步骤。 */
      for (const step of NEW_DAY_STEPS) {
        try {
          step.run(s, day);
        } catch (err) {
          runLog.error('event', '日结算步骤失败：' + step.owner, {
            why: step.why,
            day,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    },
    'day-settle',
  );
}

/** 顺序表的只读投影（契约用例与审计用） */
export function daySettleOrder(): { owner: string; why: string }[] {
  return NEW_DAY_STEPS.map((x) => ({ owner: x.owner, why: x.why }));
}
