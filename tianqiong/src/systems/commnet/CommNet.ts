/* ============================================================
   卡 N2 · 通讯网络（世界书 §84）
   —— 八大通讯方式此前只有「星枢传讯」一条实装。本模块把八条都接上：
     距/费/时效三维判定，跨大陆即时与否直接决定任务时效。
   事件：message_sent（带到达日）→ 供 quest/faction 订阅做「消息在途」。
   ============================================================ */
import raw from '@/data/world/comm.json';
import { WB } from '@/data/worldBook';
import type { WorldState } from '@/types/world';
import { toast, worldBus } from '@/events/EventBus';
import { makeEvent } from '@/events/EventSchema';
import { gainGold, log } from '@/systems/character/Gains';
import { confirmSheet, openSheet } from '@/systems/character/Sheet';
import { formatMoney } from '@/systems/economy/Money';
import { sceneTime } from '@/world/WorldClock';
import { need } from '@/world/WorldState';
import { mutate } from '@/world/WorldMutate';

export interface CommWay {
  id: string; name: string; speedDays: number; maxKm: number; cost: number; note: string;
}
const CFG = raw as unknown as { ways: CommWay[]; limits: Record<string, string>; starnetCoin: number };
export const commWays = (): CommWay[] => CFG.ways ?? [];
export const commLimits = (): Record<string, string> => CFG.limits ?? {};
export const wayById = (id: string): CommWay | undefined => commWays().find((w) => w.id === id);

/** 两地直线距离的粗略口径：同大陆按规模估，跨大陆按 5 日航程计（不引入新数据源） */
const SAME_CONTINENT_KM = 60;
const CROSS_CONTINENT_KM = 1500;

export function distanceOf(fromLoc: string, toLoc: string): number {
  const a = WB.locations[fromLoc];
  const b = WB.locations[toLoc];
  if (!a || !b) return 0;
  return a.continent === b.continent ? SAME_CONTINENT_KM : CROSS_CONTINENT_KM;
}

/** 能否用这种方式发（§84 的限制面） */
export function canSend(wayId: string, fromLoc: string, toLoc: string, s: WorldState = need()): { ok: boolean; why: string; cost: number; days: number } {
  const w = wayById(wayId);
  if (!w) return { ok: false, why: '没有这种通讯方式', cost: 0, days: 0 };
  const km = distanceOf(fromLoc, toLoc);
  if (w.maxKm >= 0 && km > w.maxKm) {
    return { ok: false, why: w.name + '够不到这么远（约 ' + Math.round(km) + ' 公里）', cost: 0, days: 0 };
  }
  if (wayId === 'starnet' && !s.net?.online && !s.player.flags.starnet_pass) {
    return { ok: false, why: '星枢传讯需星符入网', cost: 0, days: 0 };
  }
  if (wayId === 'oracle' && s.player.level < 6) {
    return { ok: false, why: '神谕术仅神官级以上可使用', cost: 0, days: 0 };
  }
  const cost = wayId === 'starnet' ? 0 : w.cost;
  return { ok: true, why: '', cost, days: w.speedDays };
}

/**
 * 发出消息：扣费 + 发事件（带到达日）。
 * 事件是本模块的对外出口——任务与势力各自订阅决定怎么反应，
 * 通讯系统自己不去通知任何人（架构 §21）。
 */
export function sendMessage(wayId: string, toLoc: string, topic: string, s: WorldState = need()): boolean {
  const r = canSend(wayId, s.player.loc, toLoc, s);
  if (!r.ok) { toast('✖ ' + r.why, 'bad'); return false; }
  if (r.cost > 0) {
    if (s.player.gold < r.cost) { toast('✖ 这笔讯息费 ' + r.cost + ' 铜，你付不起。', 'bad'); return false; }
    gainGold(-r.cost);
  }
  if (wayId === 'starnet') {
    const coin = CFG.starnetCoin ?? 2;
    const net = s.net;
    if (!net) { toast('✖ 尚未入网。', 'bad'); return false; }
    if (net.starcoin < coin) { toast('✖ 星币不足（需 ' + coin + '）。', 'bad'); return false; }
    net.starcoin -= coin;
  }
  const day = sceneTime(s).day;
  const arriveDay = day + r.days;
  worldBus.emit(
    makeEvent({
      type: 'message_sent',
      day,
      tick: s.t,
      actor: 'player',
      location: s.player.loc,
      target: toLoc,
      cause: topic,
      level: 1,
      data: { way: wayId, arriveDay, instant: r.days === 0, topic },
    }),
  );
  log(r.days === 0
    ? '讯息发出即达——' + (wayById(wayId)?.name ?? '') + '把话带到了' + (WB.locations[toLoc]?.name ?? toLoc) + '。'
    : '你托' + (wayById(wayId)?.name ?? '人') + '把话送往' + (WB.locations[toLoc]?.name ?? toLoc) + '——约 ' + r.days + ' 日后才有着落。', 'nar', s);
  mutate.playerFlag('msg_' + wayId);
  return true;
}

export interface CommView {
  ways: CommWay[];
  limits: Record<string, string>;
  reachable: (from: string, to: string) => { id: string; name: string; ok: boolean; cost: number; days: number }[];
}

/* ============================================================
   卡 K3-UI · 通讯面板
   —— 八个系统各自有 view 却没有入口时，玩家只能靠 AI 叙事里的一句话知道"信寄出去了"。
   面板把"发得出去吗、多少钱、几天到"摆在台面上，并给出「发一条」的动作。
   ============================================================ */

/** 可作为收信地的城市（跨大陆才有意义，同城直接走过去就行） */
const COMM_DESTS = ['plaza', 'windport', 'goldveil', 'frosthold', 'bloodhold', 'deepwell', 'skycap'];

/** 发一条口信到某地：自动挑当下最便宜的可用手段 */
export function commSend(toLoc: string, topic = '口信'): boolean {
  const s = need();
  if (!WB.locations[toLoc]) {
    toast('寄不到那个地方。', 'bad');
    return false;
  }
  const rows = commView(s)
    .reachable(s.player.loc, toLoc)
    .filter((r) => r.ok)
    .sort((a, b) => a.cost - b.cost);
  const best = rows[0];
  if (!best) {
    toast('没有哪种手段够得到那里。', 'bad');
    return false;
  }
  return sendMessage(best.id, toLoc, topic, s);
}

/** 挑当前最便宜的可用手段（寄出与写信浮层共用同一份选择，口径不会漂移） */
function bestWay(from: string, toLoc: string): { id: string; name: string; cost: number; days: number } | null {
  const rows = commView(need())
    .reachable(from, toLoc)
    .filter((r) => r.ok)
    .sort((a, b) => a.cost - b.cost);
  const best = rows[0];
  return best ? { id: best.id, name: best.name, cost: best.cost, days: best.days } : null;
}

/**
 * 写信浮层（BUG-001 · 2026-09-29 实测）：点目的地先给「收件地 + 正文」的写信界面，
 * 玩家确认后才扣费寄出。此前这一步不存在——点目的地等于立即把一句硬编码「口信」
 * 寄出去，写信流程整条断在半空。手段仍自动挑当下最便宜的可用一种。
 */
export function commCompose(toLoc: string): void {
  const s = need();
  if (!WB.locations[toLoc]) {
    toast('寄不到那个地方。', 'bad');
    return;
  }
  const best = bestWay(s.player.loc, toLoc);
  if (!best) {
    toast('没有哪种手段够得到那里。', 'bad');
    return;
  }
  openSheet({
    kind: 'comm',
    toLoc,
    toName: WB.locations[toLoc]?.name ?? toLoc,
    wayId: best.id,
    wayName: best.name,
    cost: best.cost,
    days: best.days,
  });
}

export function commMenu(): void {
  const s = need();
  const v = commView(s);
  const from = s.player.loc;
  const here = WB.locations[from]?.name ?? from;
  const btns = COMM_DESTS.filter((d) => d !== from).map((d) => {
    const name = WB.locations[d]?.name ?? d;
    const best = bestWay(from, d);
    if (!best) return { l: name + '（够不到）', a: 'cm_none', id: d, dg: true };
    return { l: name + '（' + best.name + '·' + formatMoney(best.cost) + '·' + best.days + ' 日）', a: 'cm_compose', id: d };
  });
  const limits = Object.values(v.limits).join('<br>');
  confirmSheet(
    '通讯 · 从' + here,
    '八种手段各有距与费的界限：同大陆隔街喊一声就到，跨大陆只有星枢传讯是即时的。<br>' +
      limits +
      '<br><br>发讯只传话，不传物——寄东西得走商队。',
    [...btns, { l: '（退开）', a: 'close' }],
  );
}

export function commView(s: WorldState = need()): CommView {
  return {
    ways: commWays(),
    limits: commLimits(),
    reachable: (from, to) => commWays().map((w) => {
      const r = canSend(w.id, from, to, s);
      return { id: w.id, name: w.name, ok: r.ok, cost: r.cost, days: r.days };
    }),
  };
}
