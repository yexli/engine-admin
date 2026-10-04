/* ============================================================
   叙事上下文装配（Narrative Context）
   ------------------------------------------------------------
   给「叙事编织」通道装一份上下文。目标不是信息多，而是**接得上**：
     场景   —— 在哪、什么时候、什么天气（由调用方给）
     前情   —— 最近几段已经写出去的正文，越近的越完整
     近因   —— 见闻录里那些"不是散文"的条目：收获、损失、系统提示
     衔接   —— 时间是否连续、地点是否变过
     事实   —— 本轮操作产生的事实（由调用方给）

   为什么要单开一层：没有前情与衔接时，模型每一轮都从零描写同一个场景，
   实机上出现过「米露一段里在喂鸽子、下一段又从广场另一头走来」。
   预算全部来自 data/world/context.json，代码不硬编码数值（与 Context Budget 同规）。
   ============================================================ */
import cfg from '@/data/world/context.json';
import type { LogEntry, WorldState } from '@/types/world';

/** 叙事编织的预算全集（context.json 的 narrative 段） */
export interface NarrativeBudget {
  recapChars: number;
  recapPassages: number;
  eventMax: number;
  eventChars: number;
  recapInContext: number;
  recapArchive: number;
  recapSummaryPassages: number;
  recapKeep: number;
  factsChars: number;
}

/**
 * 预算一律配置化，但**必须兜底**：旧版本或手改过的 context.json 可能缺字段，
 * 缺一个就让 fitBudget 的比较恒为 false——约束静默失效，还不报错。
 * 默认值集中在这一处，Narration 也取它，避免两边各写一半（各写一半必然漏）。
 */
const BUDGET_DEFAULTS: NarrativeBudget = {
  recapChars: 480,
  recapPassages: 2,
  eventMax: 4,
  eventChars: 240,
  recapInContext: 3,
  recapArchive: 4,
  recapSummaryPassages: 4,
  recapKeep: 8,
  factsChars: 500,
};

export function narrativeBudget(): NarrativeBudget {
  return { ...BUDGET_DEFAULTS, ...(((cfg as { narrative?: Partial<NarrativeBudget> }).narrative) ?? {}) };
}

const N = narrativeBudget();

export interface NarrativeContext {
  /** 章级摘要（旧 → 新）：跨天的前情，来自 s.recap */
  chronicle: string[];
  /** 前情：最近几段已写正文（旧 → 新） */
  recap: string[];
  /** 近因：见闻录里的收获 / 损失 / 提示类条目（旧 → 新） */
  events: string[];
  /** 衔接提示：时间是否连续、地点是否变过 */
  continuity: string[];
}

/** 按字数预算**整条丢弃**（与 personaBlock 同规：宁可少一条，不切一句话） */
export function fitBudget(items: string[], limit: number): string[] {
  const kept: string[] = [];
  let used = 0;
  for (const it of items) {
    if (used + it.length > limit && kept.length) break;
    kept.push(it);
    used += it.length;
  }
  return kept;
}

/**
 * 装配前情与近因。
 * @param from      本轮的水位：只看它之前的条目（不能把本轮自己当成前情）
 * @param prevLoc   上一段正文写的是哪个地点（调用方持有，用于判断是否换了地方）
 */
export function buildNarrativeContext(s: WorldState, from: number, prevLoc: string | null): NarrativeContext {
  const history = (s.log || []).filter((e) => (e.id ?? 0) <= from);

  /* 前情：按段落取，越近越完整。倒着收集到配额为止，再正序排回来。 */
  const woven = history.filter((e) => e.cls === 'ai');
  const recapRaw: string[] = [];
  let budget = N.recapChars;
  for (let i = woven.length - 1; i >= 0 && recapRaw.length < N.recapPassages; i--) {
    /* 预算被配置成 0（手改档）时 slice(-0) 会取到整个字符串——预算 0 就该什么都不给 */
    if (budget <= 0) break;
    const t = woven[i].text || '';
    if (t.length > budget && recapRaw.length) break;
    /* 单段就超预算时只留它的尾部（最近发生的事在段尾） */
    recapRaw.unshift(t.length > budget ? t.slice(-budget) : t);
    budget -= Math.min(t.length, budget);
  }

  /* 近因：散文之外的条目才是「发生了什么」——收获、损失、提示 */
  const events = fitBudget(
    history
      .filter((e: LogEntry) => {
        const c = e.cls || 'nar';
        return c !== 'nar' && c !== 'ai' && c !== 'say';
      })
      .slice(-N.eventMax)
      .map((e) => (e.cls === 'gain' ? '获得：' : e.cls === 'bad' ? '不利：' : '') + e.text),
    N.eventChars,
  );

  /* 衔接：把这轮的处境与「上一段写到哪儿」对齐，模型才知道是接着写还是换场 */
  const continuity: string[] = [];
  const lastWoven = woven.at(-1);
  const nowStamp = (s.log || []).filter((e) => (e.id ?? 0) > from).at(-1)?.t;
  if (lastWoven && nowStamp) {
    continuity.push(lastWoven.t === nowStamp ? '这是同一时刻里的后续，接着上一段往下写。' : '时间往前走了（上一段在' + lastWoven.t + '）。');
  }
  if (prevLoc && prevLoc !== s.player.loc) continuity.push('地点已经变了——玩家刚离开上一处，不要把它写成还在那儿。');
  if (!recapRaw.length) continuity.push('这是本局的第一段叙事，没有前文可以衔接。');

  /* 章级摘要：跨天的前情。见闻录只有 70 条会被丢，所以它必须来自持久字段。 */
  const chronicle = (s.recap ?? []).slice(-N.recapInContext);

  return { chronicle, recap: recapRaw, events, continuity };
}

/** 玩家处境的原始量。派生上限（maxHp/maxMp）由调用方给——
    这是为了不让 world/ 为了几个比例数字新增一条到 systems/ 的依赖边。 */
export interface SelfSnapshot {
  hp: number;
  hpMax: number;
  mp: number;
  mpMax: number;
  effects: { id: string; left?: number }[];
  wanted: number;
  titles: string[];
  level: number;
}

/**
 * 把玩家的数值状态翻成**叙事短语**——模型要的是「带着伤」，
 * 不是「hp 32/74」：后者它既用不上，又踩了「不得提及数值」的硬约束。
 * 只报与叙事有关的：伤势、异常状态、通缉、认得出的身份。
 */
export function buildCondition(self: SelfSnapshot): string[] {
  const out: string[] = [];
  const r = self.hpMax > 0 ? self.hp / self.hpMax : 1;
  if (r <= 0.25) out.push('你伤势很重，动作会吃力。');
  else if (r <= 0.6) out.push('你身上带着伤。');
  else if (r < 1) out.push('你身上有几处擦伤。');
  if (self.effects.length)
    out.push(
      '你身上有异常状态：' +
        self.effects.map((e) => e.id + (e.left ? '（还剩 ' + e.left + ' 刻）' : '（持续中）')).join('、') +
        '。',
    );
  if (self.wanted >= 3) out.push('你正被大规模追捕。');
  else if (self.wanted >= 1) out.push('你背着悬赏，'+ self.wanted + ' 级通缉。');
  if (self.titles.length) out.push('你被人认得的身份：' + self.titles.join('、') + '。');
  return out;
}
