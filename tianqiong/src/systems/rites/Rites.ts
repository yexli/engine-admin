/* ============================================================
   卡 L3 · 婚丧嫁娶（世界书 §96）

   §96 给了三张表：七大陆的婚俗（含男女两档婚龄）、七大陆的丧俗、三种继承制度。
   它们此前完全不存在——角色不会成婚，也不会有人替他办身后事。
   本卡把三张表接成一个闭环：

     婚配（好感 80 + 结义 + 双方到龄 + 同在举办地）
       → 有了配偶
         → 寿终（卡 L1 的 life_exhausted）
           → 按所在地的丧俗安葬
             → 按所在地的继承制度分配遗产（配偶 / 最强同伴 / 学院）

   三处判断依据：
   · 年龄取自卡 L1（同一个 birthTick 派生）——婚龄与寿数同源，不另算一份；
   · 婚龄按**玩家自己的性别**取；NPC 的性别世界书没有给，故不臆断，
     缺省按该大陆较宽的那一档计（将来给 NPC 补 gender 即自动生效）；
   · 婚俗与丧俗都按**所在地**的大陆算，不按出身——仪式在哪办就随哪的规矩。
   ============================================================ */
import raw from '@/data/world/rites.json';
import { WB } from '@/data/worldBook';
import type { WorldState } from '@/types/world';
import { toast, worldBus } from '@/events/EventBus';
import { makeEvent } from '@/events/EventSchema';
import { addRep, log } from '@/systems/character/Gains';
import { confirmSheet } from '@/systems/character/Sheet';
import { ageOf } from '@/systems/timeslip/Lifespan';
import { sceneTime } from '@/world/WorldClock';
import { need, sync } from '@/world/WorldState';
import { mutate } from '@/world/WorldMutate';
import { npcDyn } from '@/systems/npc/Npcs';
import { addHistory } from '@/events/EventStore';

interface WeddingRow { continent: string; form: string; ageMale: number; ageFemale: number; custom: string }
interface BurialRow { continent: string; name: string; note: string }
interface InheritRow { id: string; name: string; continents: string[]; who: string; faction: string; note: string }

const CFG = raw as unknown as {
  wedding: WeddingRow[];
  burial: BurialRow[];
  inherit: InheritRow[];
  ritesNote: string;
};

export const weddings = (): WeddingRow[] => CFG.wedding ?? [];
export const burials = (): BurialRow[] => CFG.burial ?? [];
export const inheritRules = (): InheritRow[] => CFG.inherit ?? [];
export const ritesNote = (): string => CFG.ritesNote ?? '';

export const weddingOf = (continent: string): WeddingRow | undefined => weddings().find((w) => w.continent === continent);
export const burialOf = (continent: string): BurialRow | undefined => burials().find((b) => b.continent === continent);
export const inheritRuleOf = (continent: string): InheritRow | undefined => inheritRules().find((r) => r.continents.includes(continent));

/** 玩家所在地的大陆（婚俗与丧俗都按举办地算） */
export function hereContinent(s: WorldState = need()): string {
  return (WB.locations[s.player.loc] as unknown as { continent?: string })?.continent ?? '中央大陆';
}

/** 玩家性别（缺省 male——旧档与不带该参数的调用都与从前一致） */
export const playerGender = (s: WorldState = need()): 'male' | 'female' => s.player.gender ?? 'male';

/**
 * 该大陆的婚龄。传 null 表示"不知道这个人的性别"——此时取较宽的一档，
 * 因为世界书没给 NPC 的性别，猜一个比放宽一档更失真。
 */
export function marriageAge(continent: string, gender: 'male' | 'female' | null): number {
  const w = weddingOf(continent);
  if (!w) return 16;
  if (gender === 'male') return w.ageMale;
  if (gender === 'female') return w.ageFemale;
  return Math.min(w.ageMale, w.ageFemale);
}

export const spouseOf = (s: WorldState = need()): string | undefined => s.player.spouse;

/** NPC 的性别（世界书没给的就返回 null——7/15 人如此，婚龄按宽档计，不猜） */
export function npcGender(id: string): 'male' | 'female' | null {
  return (WB.npcs[id] as { gender?: 'male' | 'female' } | undefined)?.gender ?? null;
}

/** 婚配前置：未婚 + 好感 80 + 亲密度「结义」+ 双方到婚龄 + 同在大陆 */
export function canMarry(id: string, s: WorldState = need()): { ok: boolean; reason: string } {
  const n = WB.npcs[id];
  if (!n) return { ok: false, reason: '没有这个人' };
  /* 相等判断必须在前：spouse 为真时上一行就已经拦下了，写在后面等于永不可达的死分支
     （「你们已经是夫妻」这句提示永远看不到，审查 §婚配）。 */
  if (s.player.spouse === id) return { ok: false, reason: '你们已经是夫妻' };
  if (s.player.spouse) return { ok: false, reason: '你已有婚约在身' };
  const dy = npcDyn(id, s);
  if (dy.grudge) return { ok: false, reason: n.name + '与你有怨未解' };
  if (dy.att < 80) return { ok: false, reason: '好感不够（需 80，现为 ' + dy.att + '）' };
  if ((dy.intimacy || 0) < 3) return { ok: false, reason: '交情未到「结义」（现为 ' + (dy.intimacy || 0) + '/3 档）' };
  const cont = hereContinent(s);
  const w = weddingOf(cont);
  if (!w) return { ok: false, reason: '此地没有办婚事的规矩' };
  const myAge = ageOf(s);
  const myNeed = marriageAge(cont, playerGender(s));
  if (myAge < myNeed) {
    return { ok: false, reason: '你还没到' + cont + '的婚龄（' + w.ageMale + '/' + w.ageFemale + '，你 ' + Math.floor(myAge) + ' 岁）' };
  }
  /* NPC 的年龄：世界书没有给出具体岁数，故只校验"他在不在本地"——
     不编造一个不存在的年龄再拿它拦人。 */
  if (n.loc && WB.locations[n.loc]?.continent && WB.locations[n.loc].continent !== cont) {
    return { ok: false, reason: n.name + '不在此地（' + String(WB.locations[n.loc].continent) + '）' };
  }
  return { ok: true, reason: '' };
}

/** 成婚：按所在地的婚俗办（一生一次） */
export function marry(id: string): boolean {
  const s = need();
  const n = WB.npcs[id];
  if (!n) return false;
  const g = canMarry(id, s);
  if (!g.ok) {
    toast('婚事未成：' + g.reason, 'bad');
    return false;
  }
  const cont = hereContinent(s);
  const w = weddingOf(cont);
  if (!w) return false;
  mutate.playerSpouse(id);
  log('按' + cont + '的规矩，婚事办成——' + w.form + '。' + w.custom + '。' + n.name + '从此与你共一册名籍。', 'gain', s);
  addRep(cont === '中央大陆' ? 'temple_life' : cont === '东方群岛' ? 'verdant' : cont === '南方沙漠' ? 'sand' : cont === '北方冻土' ? 'frost' : cont === '西方荒野' ? 'blood' : cont === '地下深渊' ? 'deep' : 'study', 2);
  addHistory('成婚 · ' + n.name, cont + '·' + w.form, 4);
  worldBus.emit(
    makeEvent({
      type: 'married',
      day: sceneTime(s).day,
      tick: s.t,
      actor: 'player',
      target: id,
      location: s.player.loc,
      level: 3,
    }),
  );
  sync();
  return true;
}

/** 好感最高的 NPC（强者继承制下的继承人） */
export function bestFriend(s: WorldState = need()): string | undefined {
  let best: string | undefined;
  let top = -1;
  for (const id of Object.keys(WB.npcs)) {
    const dy = s.npcs[id];
    if (!dy) continue;
    if (dy.att > top) {
      top = dy.att;
      best = id;
    }
  }
  return best;
}

export interface RitesResult {
  burial: BurialRow;
  rule: InheritRow;
  heir?: string;
  heirName?: string;
}

/**
 * 身后事：按所在地的丧俗安葬，按所在地的继承制度分配遗产。
 * 由 daySettle 的 ritesTick 驱动（不在 Lifespan 里调 —— 那会形成 timeslip ↔ rites 的环）。
 * 幂等：办过一次就置 flag，不做第二次。
 */
export function lastRites(s: WorldState = need()): RitesResult | null {
  if (!s.player.flags.life_exhausted) return null;
  if (s.player.flags.rites_done) return null;
  const cont = hereContinent(s);
  const burial = burialOf(cont);
  const rule = inheritRuleOf(cont);
  if (!burial || !rule) return null;
  const spouse = s.player.spouse;
  const heir = spouse ?? (rule.id === 'might' ? bestFriend(s) : undefined);
  const heirName = heir ? WB.npcs[heir]?.name ?? heir : undefined;
  log(
    '你在这世上走完了自己的刻度。按' + cont + '的规矩，行' + burial.name + '——' + burial.note + '。' +
      (heirName ? '送你的第一个人是' + heirName + '。' : ''),
    'bad',
    s,
  );
  log('（' + rule.name + '：' + rule.who + '。' + rule.note + '）', 'sys', s);
  addRep(rule.faction, 3);
  addHistory('身故 · ' + burial.name, rule.name, 5);
  worldBus.emit(
    makeEvent({
      type: 'last_rites',
      day: sceneTime(s).day,
      tick: s.t,
      actor: 'player',
      location: s.player.loc,
      level: 3,
      data: { burial: burial.name, rule: rule.id },
    }),
  );
  mutate.playerFlag('rites_done');
  sync();
  return { burial, rule, heir, heirName };
}

/** daySettle 的日步：寿数已尽则办身后事（幂等） */
export function ritesTick(s: WorldState): void {
  lastRites(s);
}

/* ---------------- 面板 ---------------- */

export function ritesMenu(): void {
  const s = need();
  const cont = hereContinent(s);
  const w = weddingOf(cont);
  const b = burialOf(cont);
  const r = inheritRuleOf(cont);
  const spouse = spouseOf(s);
  const cands = Object.keys(WB.npcs).filter((id) => {
    const dy = s.npcs[id];
    return dy && !dy.grudge && dy.att >= 80 && (dy.intimacy || 0) >= 3;
  });
  const btns: { l: string; a: string; id?: string; dg?: boolean }[] = [];
  if (spouse) {
    btns.push({ l: '（你与' + (WB.npcs[spouse]?.name ?? spouse) + '已成婚）', a: 'close', dg: true });
  } else if (!cands.length) {
    btns.push({ l: '（还没有交情到「结义」的人——好感 80、亲密度 3 档）', a: 'close', dg: true });
  } else {
    for (const id of cands) {
      const g = canMarry(id, s);
      const ng = npcGender(id);
      /* 世界书只规定了「男 N 岁／女 M 岁」，没说 NPC 的岁数——
         故这里如实标出"对方的档位已知还是未知"，而不是假装算过。 */
      const tag = ng ? '（' + (ng === 'male' ? '男' : '女') + '·本档 ' + marriageAge(cont, ng) + ' 岁起）' : '（性别未载，按宽档 ' + marriageAge(cont, null) + ' 岁起）';
      btns.push({ l: '迎娶／嫁给' + WB.npcs[id].name + tag + (g.ok ? '' : '（' + g.reason + '）'), a: 'rt_marry', id, dg: !g.ok });
    }
  }
  btns.push({ l: '（退开）', a: 'close' });
  confirmSheet(
    '婚丧嫁娶 · ' + cont,
    (w ? '<b>此地的婚事</b>：' + w.form + '，男 ' + w.ageMale + ' 岁／女 ' + w.ageFemale + ' 岁起，' + w.custom + '。' : '（此地未载婚俗）') +
      '<br><br><b>此地的身后事</b>：' + (b ? b.name + '——' + b.note : '未载') +
      '<br><b>遗产</b>：' + (r ? r.name + '——' + r.who : '未载') +
      '<br><br>你现下 ' + Math.floor(ageOf(s)) + ' 岁' + (spouse ? '，配偶 ' + (WB.npcs[spouse]?.name ?? spouse) : '，尚未成婚'),
    btns,
  );
}
