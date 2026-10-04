/* ============================================================
   卡 11 · 羁绊系统（core/bond.ts）——关系三层化：
   好感轴（att，已有）+ 亲密度档（intimacy 0-3，好感满后条件门升级）
   + 仇怨状态（grudge，状态+后果+化解）。
   - 赠礼：五档偏好（loved/like/neutral/dislike/hated）× quality 倍率
     （稀有以上按 2 封顶）；单礼增益封顶 [-8,+10]；同 NPC 日≤2、周≤6（R1 三 cap）；
   - 回赠：newDay 钩子（time.ts 在 economy 回归后调用 bondDailyTick）——
     亲密度≥2 小概率回赠，升档当日必赠；池=NpcDef.reciprocate，
     缺省回落其所属商店库存（G14 零代码）；
   - 亲密度：att≥80 + gate（任务/flag/赠礼/聊天累计，per-NPC 可配）→
     1 挚友 / 2 知己 / 3 结义；仇怨期间升级挂起，att<60 权益冻结不退档；
   - 仇怨：重事件触发；后果=拒收礼+商人涨价/拒售+拒请求；
     化解=赔罪（魅力检定+补偿金 100×sev，成功 att+15、sev-1）；
     sev1/2 每 20 天降一档，sev3 长记忆不衰减（太吾式）；
   - 连带（G12 鬼谷关系网本土版）：|rels 边|≥30 的邻接按 Δ×val/100 取整
     同调，clamp ±2——给莉安送礼，老乔会知道。
   纯 core：AI 不参与判定，赠礼/赔罪全规则层（后果单一写入口）。
   ============================================================ */
import { WB } from '@/data/worldBook';
import { giftTagLabel } from '@/data/entityNames';
import type { WorldState } from '@/types/world';
import { clamp, rng, toast } from '@/events/EventBus';
import { check } from '@/dice/CheckResolver';
import { addItem, gainGold, log, removeItem } from '@/systems/character/Gains';
import { addMem, adjAtt, attWord, npcAt, npcDyn } from '@/systems/npc/Npcs';
import { peekRelsOf } from '@/systems/relationship/Relations';
import { confirmSheet } from '@/systems/character/Sheet';
import { need, sync } from '@/world/WorldState';
import { sceneTime } from '@/world/WorldClock';

const INTIMACY_TITLE = ['', '挚友', '知己', '结义'];
/** 品质→赠礼倍率（稀有以上封顶 2，防高价礼通胀 R1/A4） */
const Q_MULT: Record<string, number> = { 普通: 1, 优秀: 1.2, 精良: 1.5, 稀有: 2, 传说: 2, 神话: 2, 神器: 2 };
type Reaction = 'loved' | 'like' | 'neutral' | 'dislike' | 'hated';
const REACT_BASE: Record<Reaction, number> = { loved: 8, like: 5, neutral: 2, dislike: -3, hated: -8 };

export interface BondView {
  att: number;
  attWord: string;
  intimacy: number; // 权益有效档（att<60 冻结为 0，不退档）
  title: string; // '' | 挚友 | 知己 | 结义
  grudge: { why: string; sev: number } | null;
  giftKnown: string[];
}

/** 羁绊读数（G12 单一事实源：UI/chat/runReq/shop 全走此口） */
export function bondOf(id: string, s: WorldState = need()): BondView {
  const dy = s.npcs[id] || { att: 0, mem: [], met: false };
  const lv = dy.intimacy || 0;
  const active = dy.att >= 60 && !dy.grudge;
  return {
    att: dy.att,
    attWord: attWord(dy.att),
    intimacy: active ? lv : 0,
    title: active ? INTIMACY_TITLE[Math.min(3, lv)] : '',
    grudge: dy.grudge ? { why: dy.grudge.why, sev: dy.grudge.sev } : null,
    giftKnown: dy.giftKnown || [],
  };
}

export const grudgeOf = (id: string, s: WorldState = need()) => s.npcs[id]?.grudge ?? null;

/* ---------------- 偏好五档（G14：标签优先，缺省由 interest 推导） ---------------- */

const TAG_HINTS: Record<string, string[]> = {
  food: ['酒', '饭', '吃', '麦酒', '口粮', '面包'],
  herb: ['药', '草', '月见', '医'],
  trinket: ['小玩意', '信', '趣', '月光'],
  relic: ['古', '典', '籍', '星', '祭', '圣'],
  pelt: ['皮', '猎', '毛'],
  gem: ['矿', '宝', '钱', '铜板', '晶', '白金'],
  rare: ['秘', '禁', '暗', '奇', '虚空'],
};
function deriveTag(n: { interest?: string; goal?: string }, tag: string, itemName: string): boolean {
  const hints = TAG_HINTS[tag] || [];
  const hay = [n.interest || '', n.goal || ''].join('');
  return hints.some((h) => hay.includes(h) || itemName.includes(h));
}

/** 五档反应：likes/dislikes 标签命中 → loved/hated；无种子时按 interest 推导 → like */
export function reactionOf(id: string, iid: string): Reaction {
  const n = WB.npcs[id];
  const it = WB.items[iid];
  if (!n || !it) return 'neutral';
  const tag = it.giftTag || '';
  if (tag && n.dislikes?.includes(tag)) return 'hated';
  if (tag && n.likes?.includes(tag)) return 'loved';
  if (tag && !n.likes && deriveTag(n, tag, it.name)) return 'like';
  return 'neutral';
}

/* ---------------- 赠礼 ---------------- */

const REACT_LINES: Record<Reaction, (n: string, item: string) => string> = {
  loved: (n, it) => '「' + it + '？你是特意给我留的吧……」' + n + '的眼睛亮了一下，把东西小心收进了怀里。',
  like: (n, it) => n + '接过' + it + '端详了一番，嘴角松了松：「有心了。」',
  neutral: (n, it) => n + '收下了' + it + '，点了点头：「东西是好东西。」',
  dislike: (n, it) => n + '把' + it + '推了回来：「这个……我不缺。」',
  hated: (n) => n + '的脸色沉了下来：「拿这种东西打发我？」',
};

/** 赠礼日/周计数（懒初始化 + 跨日跨周滚动） */
function giftGate(dy: { giftDay?: { day: number; n: number; weekStart: number; week: number } }, day: number) {
  if (!dy.giftDay) dy.giftDay = { day, n: 0, weekStart: day, week: 0 };
  const g = dy.giftDay;
  if (day - g.weekStart >= 7) {
    g.weekStart = day;
    g.week = 0;
  }
  if (g.day !== day) {
    g.day = day;
    g.n = 0;
  }
  return g;
}

/** 赠礼（dlgAct 'gift' → 选择器 → 本函数）：门禁+封顶+反应+连带+升级检查 */
export function giveGift(id: string, iid: string) {
  const s = need();
  const n = WB.npcs[id];
  const it = WB.items[iid];
  if (!n || !it) return;
  if (npcAt(id, s) !== s.player.loc) {
    toast('✖ ' + n.name + '不在你面前');
    return;
  }
  const day = sceneTime(s).day;
  const dy = npcDyn(id, s);
  /* 门禁校验前置：拒收不碰背包（无"先扣还"时序噪音） */
  if (dy.grudge) {
    log(n.name + '看也没看，把' + it.name + '原样推了回来：「我们之间，不兴这个。」', 'bad');
    sync();
    return;
  }
  const g = giftGate(dy, day);
  if (g.n >= 2 || g.week >= 6) {
    log(n.name + '摆摆手：「今天收的礼够多了，再收就说不过去了。」', 'nar');
    sync();
    return;
  }
  if (!removeItem(iid, 1)) {
    toast('✖ 背包里没有' + it.name);
    return;
  }
  g.n++;
  g.week++;
  const react = reactionOf(id, iid);
  const mult = Q_MULT[it.quality || '普通'] || 1;
  const gain = clamp(Math.round(REACT_BASE[react] * mult), -8, 10); // 单礼封顶（R1）
  log('你送上' + it.name + '。', 'nar');
  log(REACT_LINES[react](n.name, it.name), 'say');
  if (react === 'loved' || react === 'hated') {
    if (!dy.giftKnown) dy.giftKnown = [];
    if (it.giftTag && !dy.giftKnown.includes(it.giftTag)) {
      dy.giftKnown.push(it.giftTag);
      log('（你记下了：' + n.name + (react === 'loved' ? '很喜欢' : '很排斥') + '这类东西。）', 'gain');
    }
  }
  if (!dy.bondProg) dy.bondProg = { gifts: 0, chats: 0, quests: 0 };
  dy.bondProg.gifts++;
  adjAtt(id, gain, '赠礼');
  addMem(id, (gain > 0 ? '收了你的' : '退回你的') + it.name, Math.abs(gain) >= 8 ? 2 : 1);
  propagateAtt(id, gain, s);
  sync();
  tryIntimacyUp(id);
}

/* ---------------- 连带（鬼谷关系网本土版） ---------------- */

/** |rels 边|≥30 的邻接按 Δ×val/100 同调，clamp ±2；|Δ|<3 不扰（R2）
 *  遍历用**只读投影**（peekRelsOf）：relsOf 会经 npcDyn 建档，而 LOD 的唯一判据是
 *  「有没有条目」——遍历全表的写法会让一次赠礼把 109 个 NPC 全部降级到 L1（审查 §LOD）。 */
export function propagateAtt(id: string, delta: number, s: WorldState = need()) {
  if (Math.abs(delta) < 3) return;
  const n = WB.npcs[id];
  for (const oid of Object.keys(WB.npcs)) {
    if (oid === id) continue;
    const edge = peekRelsOf(oid, s)[id];
    if (!edge || Math.abs(edge.val) < 30) continue;
    const adj = clamp(Math.round((delta * edge.val) / 100), -2, 2);
    if (adj !== 0) adjAtt(oid, adj, '看在' + n.name + '的份上');
  }
}

/* ---------------- 亲密度三档 ---------------- */

/** 升级门校验：att≥80 + 无仇怨 + gate（任务 done/fin、flag、赠礼/聊天累计） */
export function intimacyUpOk(id: string, s: WorldState = need()): boolean {
  const n = WB.npcs[id];
  const dy = s.npcs[id];
  if (!n || !dy || dy.att < 80 || dy.grudge) return false;
  if ((dy.intimacy || 0) >= 3) return false;
  const g = n.intimacyGate || {};
  if (g.quest) {
    const st = s.player.quests[g.quest]?.stage;
    if (st !== 'done' && st !== 'fin') return false;
  }
  if (g.flag && !s.player.flags[g.flag]) return false;
  const prog = dy.bondProg || { gifts: 0, chats: 0, quests: 0 };
  if ((g.gifts || 0) > prog.gifts) return false;
  if ((g.chats || 0) > prog.chats) return false;
  return true;
}

/** 好感满+条件门 → 升档仪式（必赠回礼 + toast + 见闻录） */
export function tryIntimacyUp(id: string) {
  const s = need();
  const n = WB.npcs[id];
  if (!n || !intimacyUpOk(id, s)) return;
  const dy = npcDyn(id, s);
  dy.intimacy = (dy.intimacy || 0) + 1;
  const title = INTIMACY_TITLE[dy.intimacy];
  log('（你们的关系近了——如今' + n.name + '待你如' + title + '。）', 'gain');
  toast('♥ 羁绊升级：' + n.name + ' · ' + title, 'gold');
  addMem(id, '视你为' + title, 3, 'rel');
  reciprocate(id, true); // 升档当日必赠
  sync();
}

/* ---------------- 回赠（相互性） ---------------- */

function reciprocatePool(id: string): string[] {
  const n = WB.npcs[id];
  if (n?.reciprocate?.length) return n.reciprocate;
  const shop = Object.values(WB.shops).find((sh) => sh.vendor === id);
  return shop?.stock.slice(0, 3) || [];
}

function reciprocate(id: string, force: boolean) {
  const pool = reciprocatePool(id);
  const n = WB.npcs[id];
  if (!n || !pool.length) return;
  const iid = pool[rng.d(pool.length) - 1];
  if (!WB.items[iid]) return;
  addItem(iid, 1);
  log(force ? n.name + '执意塞给你一件' + WB.items[iid].name + '：「拿着！跟我还客气？」' : '（' + n.name + '托人捎来一件' + WB.items[iid].name + '。）', 'gain');
  addMem(id, '回赠了' + WB.items[iid].name, 1);
}

/** newDay 钩子（time.ts 在 economy 回归后调用）：亲密度≥2 概率回赠 + 仇怨衰减 */
export function bondDailyTick(s: WorldState) {
  const day = sceneTime(s).day;
  for (const id of Object.keys(WB.npcs)) {
    const dy = s.npcs[id];
    if (!dy) continue;
    if ((dy.intimacy || 0) >= 2 && dy.att >= 60 && !dy.grudge && dy.met && rng.chance(0.1)) reciprocate(id, false);
    /* 仇怨衰减：sev1/2 满 20 天降一档（降为 0 即释嫌）；sev3 长记忆（太吾式） */
    if (dy.grudge && dy.grudge.sev < 3 && day - dy.grudge.since >= 20) {
      const next = dy.grudge.sev - 1;
      if (next <= 0) {
        delete dy.grudge;
        log('（' + WB.npcs[id].name + '心里的火，到底让时间磨平了。）', 'sys');
      } else {
        dy.grudge.sev = next as 1 | 2;
        dy.grudge.since = day;
        log('（时间磨着' + WB.npcs[id].name + '的火气——那桩旧怨淡了些。）', 'sys');
      }
    }
  }
}

/* ---------------- 仇怨 ---------------- */

/** 触发/加重仇怨（重事件：行凶/告发/威胁后由 dialogue 调用） */
export function setGrudge(id: string, why: string, sev: 1 | 2 | 3) {
  const s = need();
  const dy = npcDyn(id, s);
  const day = sceneTime(s).day;
  if (dy.grudge) {
    dy.grudge.sev = Math.min(3, dy.grudge.sev + (sev >= 3 ? 2 : 1)) as 1 | 2 | 3;
    dy.grudge.since = day;
    dy.grudge.why = why;
    log('（新仇叠旧怨——' + WB.npcs[id].name + '把你的名字记得更牢了。）', 'bad');
  } else {
    dy.grudge = { since: day, why, sev };
    log('（' + WB.npcs[id].name + '记住了这件事——仇，结下了。）', 'bad');
  }
  addMem(id, '结怨：' + why, 3, 'rel');
}

/** att 大幅恶化后的通用检查（chat 拒开/赠礼拒收外的兜底入口） */
export function grudgeCheck(id: string) {
  const s = need();
  const dy = s.npcs[id];
  if (dy && dy.att <= -60 && !dy.grudge) setGrudge(id, '你做过的事', 2);
}

/** 赔罪（dlgAct 'apologize'）：魅力检定 + 补偿金 100×sev → sev-1、att+15；sev 清零即释嫌 */
export function apologize(id: string) {
  const s = need();
  const n = WB.npcs[id];
  const dy = npcDyn(id, s);
  const gr = dy.grudge;
  if (!gr) return;
  const cost = 100 * gr.sev;
  check('赔罪·' + n.name, '魅力', 10 + gr.sev * 2, (r) => {
    if (s.player.gold < cost) {
      log(n.name + '冷笑一声：「' + cost + '铜板的诚意都拿不出，赔什么罪？」', 'say');
    } else if (r.ok) {
      gainGold(-cost);
      const next = gr.sev - 1;
      adjAtt(id, 15, '赔罪');
      if (next <= 0) {
        delete dy.grudge;
        log(n.name + '长长出了口气，把旧账翻了过去：「……就这样吧。下不为例。」', 'nar');
        toast('♥ 旧怨已解：' + n.name, 'gain');
      } else {
        gr.sev = next as 1 | 2;
        gr.since = sceneTime(s).day;
        log('你奉上' + cost + '铜板与赔礼的话。' + n.name + '的神色松动了几分——但眉间的疙瘩还没全消。', 'nar');
      }
    } else {
      gainGold(-Math.floor(cost / 2));
      log('钱收了，气没消。' + n.name + '把门帘一甩：「滚。」（赔罪失败，补偿折半）', 'bad');
      adjAtt(id, -5, '赔罪不得法');
    }
    sync();
  }, '魅力检定：会说话的人赔罪更顺');
}

/* ---------------- 赠礼选择器（dlgAct 'gift' → confirmSheet） ---------------- */

export function giftPicker(id: string) {
  const s = need();
  const n = WB.npcs[id];
  const rows = s.player.bag.filter((b) => WB.items[b.id] && WB.items[b.id].price > 0 && !WB.items[b.id].illegal);
  if (!rows.length) {
    log('你翻了翻背包——没有拿得出手的东西。', 'nar');
    sync();
    return;
  }
  const known = (n.likes || []).length
    ? '（据说喜欢：' + (n.likes || []).map(giftTagLabel).join('、') + '）'
    : '';
  const btns: { l: string; a: string; id?: string; n?: string }[] = rows.map((b) => ({
    l: WB.items[b.id].name + ' ×' + b.qty,
    a: 'gift_give',
    id: b.id,
    n: id,
  }));
  btns.push({ l: '（再想想）', a: 'close' });
  confirmSheet('赠礼——给' + n.name + known, '挑一件东西送出去。日限两件、周限六件；对方喜恶，要送了才知道。', btns);
}
