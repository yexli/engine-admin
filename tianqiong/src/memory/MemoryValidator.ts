/* ============================================================
   记忆提案验证闸（《Memory Engine 记忆系统设计方案》§37）
   —— 铁律：AI 只能**提出**记忆，不能直接写库、不能把推测写成事实、不能越权。
   所有外部来源（AI / 脚本）的记忆写入都必须先过这里。
   ============================================================ */
import { WB } from '@/data/worldBook';
import type { MemorySource, MemoryType, MemoryVisibility } from '@/types/world';

const TYPES = new Set<string>([
  'personal_event', 'relationship', 'observation', 'knowledge', 'belief', 'rumor', 'secret',
  'evidence', 'experience', 'preference', 'goal', 'important_event', 'conversation',
  'location_memory', 'faction_memory',
]);
const SOURCES = new Set<string>([
  'direct_observation', 'conversation', 'received_information', 'inference',
  'rumor', 'system_generated', 'document', 'quest', 'combat',
]);
const VISIBILITIES = new Set<string>(['private', 'public', 'faction', 'party', 'secret', 'restricted']);

export interface MemoryProposal {
  ownerId: string;
  type: MemoryType;
  content: string;
  source: MemorySource;
  confidence?: number;
  importance?: number;
  visibility?: MemoryVisibility;
  entities?: string[];
  sourceEventId?: string;
}

export type ProposalVerdict = { ok: true; value: MemoryProposal } | { ok: false; error: string };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const unit = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;

export function validateMemoryProposal(raw: unknown): ProposalVerdict {
  if (!isObj(raw)) return { ok: false, error: '提案不是对象' };
  const ownerId = raw.ownerId;
  if (typeof ownerId !== 'string' || !ownerId) return { ok: false, error: '缺少 ownerId' };
  if (ownerId !== 'player' && !WB.npcs[ownerId]) return { ok: false, error: '记忆归属者不存在：' + ownerId };

  const content = raw.content;
  if (typeof content !== 'string' || content.trim().length < 2) return { ok: false, error: '内容为空' };
  if (content.length > 400) return { ok: false, error: '内容超长（>400）' };

  if (typeof raw.type !== 'string' || !TYPES.has(raw.type)) return { ok: false, error: '记忆类型非法：' + String(raw.type) };
  if (typeof raw.source !== 'string' || !SOURCES.has(raw.source)) return { ok: false, error: '来源非法：' + String(raw.source) };
  if (raw.visibility !== undefined && (typeof raw.visibility !== 'string' || !VISIBILITIES.has(raw.visibility))) {
    return { ok: false, error: '可见性非法' };
  }
  if (raw.confidence !== undefined && !unit(raw.confidence)) return { ok: false, error: 'confidence 越界' };
  if (raw.importance !== undefined && !unit(raw.importance)) return { ok: false, error: 'importance 越界' };
  if (raw.entities !== undefined && (!Array.isArray(raw.entities) || !raw.entities.every((e) => typeof e === 'string'))) {
    return { ok: false, error: 'entities 非法' };
  }

  /* §37 核心约束：推测不得冒充事实（推测的置信度上限 0.5，边界同样拒） */
  const conf = typeof raw.confidence === 'number' ? raw.confidence : undefined;
  if (raw.source === 'inference' && conf !== undefined && conf >= 0.5) {
    return { ok: false, error: '推测不得以高置信度写入（§37）' };
  }
  /* 亲眼所见必须指得出是哪件事：没有来源事件的「亲身经历」只是自述 */
  if (raw.source === 'direct_observation' && !raw.sourceEventId) {
    return { ok: false, error: '亲历记忆必须带 sourceEventId（§6 来源链）' };
  }
  /* 秘密不该同时声明为公开——两者相加等于「守口如瓶地广而告之」 */
  if (raw.type === 'secret' && raw.visibility === 'public') {
    return { ok: false, error: '秘密不得公开（§36）' };
  }

  return {
    ok: true,
    value: {
      ownerId,
      type: raw.type as MemoryType,
      content: content.trim(),
      source: raw.source as MemorySource,
      confidence: conf,
      importance: raw.importance as number | undefined,
      visibility: raw.visibility as MemoryVisibility | undefined,
      entities: raw.entities as string[] | undefined,
      sourceEventId: typeof raw.sourceEventId === 'string' ? raw.sourceEventId : undefined,
    },
  };
}
