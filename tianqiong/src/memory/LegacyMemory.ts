/* ============================================================
   老记忆（卡 D2 的 NpcDynamic.mem）→ 新记忆表的迁移与读取投影
   （审计整改：认知层曾有两套真相来源）

   事实陈述：老表是「文本 + 粗档 imp」，被 8 个系统直接写入、永不衰减、
   无可见性规则、无校验闸；新表（WorldState.memories）才有衰减、遗忘、
   私密边界与 MemoryValidator。两边并存时，同一个 NPC 对同一件事会各存一份。

   现在的单向规则（半迁移 = 0）：
     写入 —— 只走 MemoryEngine（systems 侧的 addMem 是它的适配器）
     读取 —— 只走 memOf 投影；UI / 对话 / 规则模拟不再直接摸 npcs[id].mem
     历史 —— migrateLegacyMemories 在载入存档后一次性搬入新表并清空老表
   ============================================================ */
import { memoryEngine } from './MemoryEngine';
import { findMemory, memoriesOf } from './MemoryStore';
import { dayOfTick } from '@/world/WorldClock';
import type { MemoryVisibility, NpcMemory, WorldState } from '@/types/world';

/**
 * 老 imp（1–3 粗档）→ 新重要度（0–1）。
 * 刻意不映射到 0.9：那是「人生大事、永不衰减」档（decayRate 0），
 * 「收了你的礼物」「传闻·…」这类日常不该占那一档，否则记忆永不消退。
 */
const IMP_TO_IMPORTANCE = [0.3, 0.3, 0.5, 0.7];

/**
 * 投影的本地窗口上限。注意它**不是**提示词预算：
 * 四个消费方各自还会再截一次（人物志 4 条 / 对话 3 条 / 规则模拟 2 条）。
 */
const RECENT = 12;

/** 投影视图：`event` 与 `day` 可信；`imp` 是由 importance 反推的**近似值** */
export interface RecentMemory {
  event: string;
  day: number;
  imp: number;
}

export function importanceOfLegacyImp(imp: number): number {
  const i = Math.max(1, Math.min(3, Math.round(imp) || 1));
  return IMP_TO_IMPORTANCE[i];
}

/** 老分级 → 可见性。secret 必须保住——它是唯一会被传播侧拒绝的档 */
export function visibilityOfLegacyTier(tier?: NpcMemory['tier']): MemoryVisibility {
  return tier === 'secret' ? 'secret' : 'private';
}

/**
 * 某角色最近「记得的事」——展示层与对话上下文专用。
 *
 * 排除「引擎按世界事件自动写下的亲历观测」：它属于**检索与推演**层，
 * 而且与目击者反应写下的那条人际记忆是同一件事的两份措辞
 * （引擎写「你犯下了罪行（theft）」，紧跟着写「恶感·目击罪行」）。
 * 人情往来（addMem 写的人际事件）、传闻与 AI 对话记忆都保留——
 * 那才是「他记得你做过什么」。
 */
export function memOf(id: string, s: WorldState): RecentMemory[] {
  return (s.memories?.[id] ?? [])
    .filter((m) => m.status === 'active' && !(m.source === 'direct_observation' && m.sourceEventId))
    .slice(-RECENT)
    .map((m) => ({
      event: m.content,
      day: m.createdAt,
      imp: Math.max(1, Math.min(3, Math.round(m.importance * 3))),
    }));
}

/**
 * 把历史存档里的老记忆搬进新表，搬成功才从老表移除。
 * 幂等：同「文本 + 那一天」不重复搬；重复调用 / 重复载入都安全。返回搬迁条数。
 */
export function migrateLegacyMemories(s: WorldState): number {
  /* 用**当前**世界日做写入时点：排序按现在算，迁移条目才不会因为
     「写入时点被设成很久以前」而在容量淘汰里天然垫底。记忆本身的发生日回填到 createdAt。 */
  const nowDay = dayOfTick(s.t);
  let moved = 0;
  for (const [id, dy] of Object.entries(s.npcs ?? {})) {
    /* 结构合法但脏的存档（npcs: { lita: null }）能过存档校验，别在这里抛异常 */
    if (!dy || typeof dy !== 'object') continue;
    const legacy = Array.isArray(dy.mem) ? dy.mem : [];
    if (!legacy.length) continue;
    /* 幂等键用「文本 + 那一天」：老表里同文本重复出现是合法常态
       （每轮赠礼都记一条「收了你的…」），折叠成一条会丢掉次数。 */
    const known = new Set(memoriesOf(id, s).map((m) => m.content + '@' + m.createdAt));
    const kept: NpcMemory[] = [];
    for (const old of legacy) {
      if (!old?.event) continue;
      const day = Number.isFinite(old.day) ? old.day : nowDay;
      const key = old.event + '@' + day;
      if (known.has(key)) continue; // 已经在表里（上次搬过）
      known.add(key);
      const m = memoryEngine.create(
        {
          ownerId: id,
          type: old.tier === 'rel' ? 'personal_event' : 'observation',
          content: old.event,
          source: 'system_generated',
          importance: importanceOfLegacyImp(old.imp),
          visibility: visibilityOfLegacyTier(old.tier),
        },
        s,
        nowDay,
      );
      m.createdAt = day; // 记住的那一天按原档回填（衰减要用真实时间）
      /* 表已到容量上限时 putMemory 会当场淘汰最弱的一条——可能正是刚搬进来的这条。
         没落库就不算搬过：留在老表，别让一次迁移把唯一副本抹掉。 */
      if (!findMemory(id, m.id, s)) {
        kept.push(old);
        continue;
      }
      moved++;
    }
    dy.mem = kept;
  }
  return moved;
}
