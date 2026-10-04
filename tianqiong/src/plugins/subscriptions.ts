/* ============================================================
   业务系统的事件订阅（《插件化世界模拟架构方案》§21 / §34 / §45）
   —— 把「系统之间的点对点调用」换成「事件传播」。
   §21 原文：A 产生事件 → Event Bus → B 判断是否需要响应；
   §34 要求验证：一个事件 → 多系统响应。
   本模块是**订阅侧的唯一装配点**；能力白名单仍单源在 systems.ts。
   顺序契约：通配订阅者（感知 / 世界史）先于这里的具体类型订阅者——
   所以罪案到达 law 时，感知表里已经记好了「谁看见了」。
   ============================================================ */
import { plugins } from './PluginRegistry';
import { SYSTEM_SPECS, capabilitiesOf } from './systems';
import { indexKeyOf } from '@/systems/economy/Economy';
import { openCase } from '@/systems/law/Investigation';
import { progKill } from '@/systems/quest/Quests';
import { setGrudge } from '@/systems/relationship/Bond';
import { spreadRumor } from '@/systems/relationship/Relations';
import { deepTalkUnlock, readTome } from '@/systems/codex/Codex';
import { core } from '@/world/WorldState';
import { mutate } from '@/world/WorldMutate';
import type { WorldEvent } from '@/events/EventSchema';

const dataOf = (e: WorldEvent): Record<string, unknown> => (e.data ?? {}) as Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** 在已登记的能力条目上追加订阅（能力白名单保持单源：systems.ts） */
function subscribe(id: string, types: string[], handleEvent: (e: WorldEvent) => void): void {
  const spec = SYSTEM_SPECS.find((s) => s.id === id);
  if (!spec) throw new Error('未登记的系统无法订阅事件：' + id);
  plugins.register({
    id: spec.id,
    version: spec.version,
    capabilities: capabilitiesOf(spec),
    executable: spec.effects,
    /* pending 必须一起带上：覆盖式注册会用缺省值把已经登记好的待接入清单抹掉，
       而守卫跑的是「registerCoreSystems + registerConsequenceHandlers」这条非生产路径，
       看不见这次覆盖——装配顺序里的静默数据丢失。 */
    pending: spec.pending,
    /* entries 与 constraints 也要一起带上：覆盖式注册会把上一次登记的映射抹掉 */
    entries: spec.entries,
    constraints: spec.constraints,
    subscribes: types,
    handleEvent,
  });
}

export function registerSystemSubscriptions(): void {
  /* quest × character_died：击杀事实推进委托进度。
     原先由 Combat 直接 import progKill 调用——改成事件传播后，
     战斗系统不需要知道任务系统的存在（§21 点对点依赖 -1）。 */
  subscribe('quest', ['character_died'], (e) => {
    const mid = str(dataOf(e).monster);
    if (mid) progKill(mid);
  });

  /* law × crime_committed：有人目击的罪行自动立案。
     此前这条链是**断的**：罪案是 L2 事件（不触发 AI 推演），而立案只能由推演产出的
     start_investigation 后果驱动 → 玩家犯罪永远不会被调查（§8/§34）。 */
  subscribe('law', ['crime_committed'], (e) => {
    const s = core.S;
    if (!s) return;
    openCase(e, 'empire', s); // 无人目击时 openCase 自己会拒绝（证据只能来自感知表）
  });

  /* Phase 4.2 撤：原先这里有一条 npc × hour_advanced 订阅，把「当前地点」物化进
     NpcDynamic.curLoc。位置是 npcAt 的纯函数产物，不需要谁在时辰边界推它一把——
     撤掉后 hour_advanced 不再有任何订阅者，那条链路连同它的日 tick 一起消失。 */
  /* academy × lore_unlocked（原 codex 订阅；卡 I5 的图鉴 2026-09 并入 academy）：
     图鉴解锁不再由 Chat / Combat 直接调 codex（§21 点对点依赖 -2）。
     解锁条件与每日门禁仍全部留在 codex 模块内部——生产方只说「发生了一次深谈 / 读了一本书」。 */
  subscribe('academy', ['lore_unlocked'], (e) => {
    const s = core.S;
    if (!s) return;
    const d = dataOf(e);
    if (d.mode === 'read_tome') readTome(String(d.item ?? ''));
    else deepTalkUnlock(String(d.npcId ?? ''), s);
  });
  /* relationship × grudge_formed / rumor_spread：结仇与传闻扩散同样改走事件。
     注意 subscribe 是**覆盖式**注册：同一系统只能调一次，多个事件类型必须合并进这一次。 */
  subscribe('relationship', ['grudge_formed', 'rumor_spread'], (e) => {
    const s = core.S;
    if (!s) return;
    const d = dataOf(e);
    if (e.type === 'grudge_formed') {
      const sev = Number(d.sev ?? 2);
      setGrudge(String(d.npc ?? ''), String(d.why ?? '某件事'), sev === 1 || sev === 3 ? sev : 2);
      return;
    }
    spreadRumor(String(d.src ?? ''), String(d.topic ?? '传闻'), Number(d.imp ?? 1), s);
  });

  /* economy × large_trade：大额扫货推高该品类价格指数，大额抛售压低它。
     幅度刻意小（2%）且 econRevert 每日向基准回归，不会失控（§34 多系统响应的第二跳）。 */
  subscribe('economy', ['large_trade'], (e) => {
    const s = core.S;
    const d = dataOf(e);
    const item = str(d.item);
    const amount = num(d.amount);
    if (!s || !item || amount <= 0) return;
    const key = indexKeyOf(item);
    if (!key) return;
    const cur = s.econ[key] ?? 1;
    const delta = d.kind === 'buy' ? 0.02 : -0.02;
    mutate.econ(key, cur + delta);
  });
}
