/* ============================================================
   收益与日志（原型 log/gainExp/gainGold/addItem/removeItem/
   itemCount/hasIllegalStr/addRep —— 一切对 WorldState 的正向写入）
   ------------------------------------------------------------
   架构收口：本模块从「写入实现」降为「原语调用 + 副作用」。
   字段改动一律走 world/mutate（唯一写入实现点），本文件只保留 toast 与
   世界事件这类系统语义。签名全部冻结——19 个系统依赖它们。
   ============================================================ */
import { WB } from '@/data/worldBook';
import type { LogCls, WorldState } from '@/types/world';
import { toast, worldBus } from '@/events/EventBus';
import { makeEvent } from '@/events/EventSchema';
import { maxHp, maxMp, rankName, xpNeed } from '@/systems/character/Derived';
import { lineageOf, raceEff } from '@/systems/character/Race';
import { formatMoney } from '@/systems/economy/Money';
import { addMem } from '@/systems/npc/Npcs';
import { need } from '@/world/WorldState';
import { mutate } from '@/world/WorldMutate';
import { sceneTime } from '@/world/WorldClock';

export function log(text: string, cls: LogCls = 'nar', s: WorldState = need()) {
  /* 累计条数记在世界状态上（§7）：原先它是模块级 let，被 store 值导入后，
     一旦本模块被热替换，新旧绑定就分裂——store 里的计数永久冻结，
     表现是「行动后要刷新界面才看见闻录更新」。写入实现已收进 world/mutate。 */
  mutate.pushLog(text, cls, s);
}

export function gainExp(n: number) {
  const s = need();
  /* 卡 R1：种族 × 职业系的效率（世界书 §26）。精灵学法系 ×1.2、兽人学法师 ×0.7——
     「同一个法术，不同种族学起来不一样快」第一次成为实际数值，而不是设定文里的一句话。 */
  const eff = raceEff(s.player.race, lineageOf(s.player.cls));
  /* 倍率只该作用于**收益**：挂科等负值通道（F-11）按原值透传，
     否则「生疏系 ×0.7」会把 -50 削成 -35，一个惩罚反倒因为种族而变轻。
     下限由 mutate.playerExp 兜住（exp 不允许为负）。 */
  const gain = n > 0 ? Math.round(n * eff) : n;
  mutate.playerExp(gain);
  toast('✧ 经验 +' + gain + (eff !== 1 ? '（' + (eff > 1 ? '亲和' : '生疏') + ' ×' + eff + '）' : ''), 'gain');
  while (s.player.level < 6 && s.player.exp >= xpNeed(s)) {
    mutate.playerNum('level', (v) => v + 1);
    mutate.playerHp(maxHp(s));
    mutate.playerMp(maxMp(s));
    toast('★ 境界提升！你已是 ' + rankName(s) + '（Lv.' + s.player.level + '）', 'gain');
    log('经过历练，你的境界提升了——如今已是「' + rankName(s) + '」。全身的力气像泉水一样涌上来。', 'nar');
    /* 卡 A：技能解锁数据化——按职业 skillPath 逐阶习得（越界/未定义/已学则跳过） */
    const sp = WB.classes[s.player.cls].skillPath;
    const sk = sp && sp[s.player.level - 1];
    if (sk && WB.skills[sk] && !s.player.skills.includes(sk)) {
      s.player.skills.push(sk);
      toast('习得技能：' + WB.skills[sk].name, 'gain');
    }
  }
}

export function gainGold(n: number) {
  mutate.playerGold(n);
  if (n > 0) toast('◈ +' + formatMoney(n), 'gold');
  else if (n < 0) toast('◈ −' + formatMoney(-n), 'bad');
}

/* 卡 I1：实例槽（有 uid）不参与同 id 堆叠——普通件只并入无 uid 的堆叠行；
   旧档无 uid，故 find 命中行为与改动前逐位一致（回归护栏）。 */
export function addItem(id: string, q = 1) {
  mutate.playerBag(id, q);
  toast('获得 ' + WB.items[id].name + (q > 1 ? ' ×' + q : ''), 'gain');
}

export function removeItem(id: string, q = 1): boolean {
  return mutate.playerBag(id, -q);
}

export const itemCount = (id: string, s: WorldState = need()) =>
  s.player.bag.reduce((a, x) => (x.id === id ? a + x.qty : a), 0);

export const hasIllegalStr = (s: WorldState = need()) =>
  s.player.bag.some((x) => WB.items[x.id] && WB.items[x.id].illegal) ? '有（被查获即罪）' : '无';

export function addRep(f: string, n: number) {
  const s = need();
  /* F-11：未知势力键会在存档里留下脏键、UI 渲染成"undefined 声望"——直接忽略 */
  if (!(f in s.rep)) return;
  const before = s.rep[f] || 0;
  const after = mutate.rep(f, n);
  toast((n > 0 ? '▲ ' : '▼ ') + WB.factions[f] + '声望 ' + (n > 0 ? '+' : '') + n, n > 0 ? 'gain' : 'bad');
  /* 试点接入（方案 §22/§34）：只有声望真的变了才发布世界事实——
     「玩家想加声望」是 Action，这里是已经发生的事实 Event。 */
  if (after !== before) {
    worldBus.emit(
      makeEvent({
        type: 'reputation_changed',
        day: sceneTime(s).day,
        tick: s.t,
        actor: 'player',
        target: f,
        /* 符号由上式的 toast 同源给出：负值时写成「+-6」，会把运行日志的 cause
           与 NPC 记忆正文一起写脏（日志 seq 41 与记忆「声望变动 +-8」都是这条）。 */
        cause: '声望变动 ' + (n > 0 ? '+' : '') + n,
        data: { faction: f, from: before, to: after, delta: n },
      }),
    );
  }
}

export { addMem };

