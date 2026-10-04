/* AI 层使用的 core 只读查询助手（避免适配器各自拼装） */
import type { AiHelpers } from '@/plugins/PluginInterface';
import {
  attOf,
  attWord,
  clsName,
  hasIllegalStr,
  maxHp,
  maxMp,
  presentNPCs,
  raceName,
  rankName,
  seasonName,
  shichenOf,
} from '@/world';

export const aiHelpers: AiHelpers = {
  shichenOf,
  seasonName,
  presentNPCs: (s, loc) => presentNPCs(loc, s),
  attOf: (s, id) => attOf(id, s),
  attWord,
  raceName,
  clsName,
  rankName,
  maxHp,
  maxMp,
  hasIllegalStr,
  lastLogs: (s) => s.log,
};
