/* ============================================================
   上下文档位（《NPC 分级与 Context Budget 最终方案》§7–§14）

   放 systems/npc 而不是 ai/：消费方有两边——AI 层的 ContextBuilder 与引擎层的
   Chat（对话通道）。分层方向是 systems ← ai，把本模块放 ai/ 会逼引擎层反向依赖它。
   这里只有纯函数与配置读取，谁都能用。

   「这个人值得多少笔墨」（worldImportance，写在数据里，静态）
   ×「此刻与他有多大关系」（LOD，由玩家行为决定，动态）
   ×「什么场景」（对话 / 推演 / 委托）
   → 这一次到底给多少资源

   三者**刻意不合并成一个数字**。合并之后就没人分得清
   「他是神」和「他刚救了你的命」哪个该换来更多上下文——
   而这两件事回答的是不同问题，冲突时也得各让一步。

   全程纯函数：同输入必得同输出，不掷随机、不读时间（方案 §15 硬约束）。
   ============================================================ */
import cfg from '@/data/world/context.json';
import type { NpcLod } from './Lod';
import type { NpcRel } from '@/types/world';

export type ContextProfile = 'minimal' | 'low' | 'medium' | 'high' | 'maximum';
export type SceneName = 'npc_dialogue' | 'world_reasoner' | 'quest';

export interface ContextBudget {
  profile: ContextProfile;
  tokens: number;
  memoryTopK: number;
  relationMax: number;
  eventKnowledge: number;
}

const PROFILES = cfg.profiles as unknown as Record<ContextProfile, Omit<ContextBudget, 'profile'>>;
const MATRIX = cfg.matrix as unknown as Record<string, Record<NpcLod, ContextProfile>>;
const SCENE_TOKENS = cfg.sceneTokens as unknown as Record<string, number>;

/** 世界重要度越界时夹取，不抛错——数据脏不该让玩家的对话崩掉 */
const clampImp = (v: number): number => Math.max(0, Math.min(4, Math.round(v) || 0));

/**
 * 档位查询。矩阵见 `src/data/world/context.json`：
 * 行 = worldImportance 0..4，列 = LOD L0/L1/L2。
 *
 * 矩阵读法的两个要点（方案 §7.1）：
 *   · 世界级 NPC 即使从未被玩家触及（L2）也不会掉到 minimal —— 他是神这件事不因玩家没去过而改变；
 *   · 背景 NPC 即使当下高度相关（L0）也拿不到 maximum —— 今天聊过不等于值得写一部传记。
 */
export function resolveContextProfile(importance: number, lod: NpcLod, _scene: SceneName): ContextProfile {
  const row = MATRIX[String(clampImp(importance))] ?? MATRIX['1'];
  return row?.[lod] ?? 'medium';
}

/** 最终预算 = min(场景上限, Profile 上限)——既避免一刀切，也不推翻既有场景差异 */
export function resolveBudget(importance: number, lod: NpcLod, scene: SceneName): ContextBudget {
  const profile = resolveContextProfile(importance, lod, scene);
  const p = PROFILES[profile];
  const cap = SCENE_TOKENS[scene] ?? 1200;
  return { profile, ...p, tokens: Math.min(p.tokens, cap) };
}

/* ---------------- C 卡 · 对话预算账本（《NPC 立体化与深入对话方案》§4.1(c)） ----------------
   五块共享同一个场景上限：人设 / 记忆 / canon / 立场+关系+历史 / 预留。
   账本的意义不是「省」，而是**别让一块吃掉全部**：此前记忆检索拿的是整个场景预算，
   人设与 canon 只能分零头，于是「同一个人的记忆」越丰富，他越不像他自己。
   core（Chat.buildCtx）与 AI 适配器（openaiCompat.chatAsync）共用这一份，
   免得两边各切一刀——两套预算迟早会漂成两个世界观。 */
export interface ChatBudgetPlan extends ContextBudget {
  /** 本次预算折算出的总字数（1 字 ≈ 0.625 token，比例见 context.json.budget） */
  chars: number;
  persona: number;
  memory: number;
  canon: number;
  relations: number;
  reserve: number;
}

export function chatBudget(importance: number, lod: NpcLod, scene: SceneName): ChatBudgetPlan {
  const b = resolveBudget(importance, lod, scene);
  const chars = Math.round(b.tokens * cfg.budget.charsPerToken);
  const part = (k: keyof (typeof cfg)['budget']['shares']) => Math.round(chars * cfg.budget.shares[k]);
  const plan: ChatBudgetPlan = {
    ...b,
    chars,
    persona: part('persona'),
    memory: part('memory'),
    canon: part('canon'),
    relations: part('relations'),
    reserve: part('reserve'),
  };
  /* 兜底：比例被改坏（和为 0 或全给了 reserve）时，人设与记忆各留一份底价——
     静默变空比截断难查一百倍（persistentCanon 的同一条哲学）。 */
  if (plan.persona <= 0) plan.persona = Math.round(chars * 0.25);
  if (plan.memory <= 0) plan.memory = Math.round(chars * 0.2);
  return plan;
}

/** 人设块的字数上限 = min(通道上限, 档位上限)：两者回答的是不同问题，都要满足 */
export function personaCharsFor(channel: 'chat' | 'greet' | 'decide', profile: ContextProfile): number {
  const a = cfg.personaChars[channel] ?? 0;
  const b = cfg.personaCharsByProfile[profile] ?? 0;
  if (!a || !b) return a || b;
  return Math.min(a, b);
}

/**
 * 关系筛选（方案 §12）：禁止把 `Object.entries(n.rels)` 全量展开塞进上下文。
 *
 * 稳定规则，无随机：
 *   ① 当前事件的当事人（focus）优先 —— 正在发生的事比陈年旧怨更该被看到；
 *   ② 强度绝对值高的优先 —— 爱得深或恨得深的都值得写；
 *   ③ 其余按 id 字典序补齐 —— 排序尾部必须是确定的，否则同输入会给出不同上下文。
 *
 * 第一阶段不做复杂关系评分：上面三条已能挡住「124 人 × 人均 3.7 条边」的无界膨胀。
 */
export function selectRelevantRelations(
  rels: Record<string, NpcRel>,
  limit: number,
  focus: Set<string> = new Set(),
): { other: string; type: string; val: number }[] {
  const rows = Object.entries(rels).map(([other, rel]) => ({
    other,
    type: rel.type,
    val: rel.val,
    score: (focus.has(other) ? 1000 : 0) + Math.abs(rel.val ?? 0),
  }));
  rows.sort((a, b) => b.score - a.score || (a.other < b.other ? -1 : a.other > b.other ? 1 : 0));
  return rows.slice(0, Math.max(0, limit)).map(({ other, type, val }) => ({ other, type, val }));
}
