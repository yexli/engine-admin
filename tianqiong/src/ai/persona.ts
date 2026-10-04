/* ============================================================
   G7 人设锚（personaBlock）：所有 NPC 类 AI 通道（chatAsync /
   npcDecideAsync / greetAsync）共用的人设文本块组装。
   修复 C3：内建 NPC 的 goal/interest/bottomLine 等人设字段
   此前只进人物志展示、从不进 prompt——台词漂移的根因。
   数据源仅世界书（ai 层只读，不碰状态）。

   P1（《NPC 立体化与深入对话方案》· 注入层）：
   lore 七项此前**全库 0 条**进入 prompt。109 份档案把
   identity/past/flaw 等填得满满当当（28.4k 字），人物志面板看得见、
   AI 看不见——这就是"每个人都是一个头衔加一句口头禅"的根因。
   现在按「立体五要素」的顺序填充到字数上限：谁 → 从哪来 → 裂口 →
   怎么说 → 其余；超限时从尾部整段丢弃，不切句子。
   上限配置在 data/world/context.json 的 personaChars。
   ============================================================ */
import { WB } from '@/data/worldBook';
import type { NpcLore } from '@/types/world';

/** 卡 R6 · §119 性格×拒绝方式六型的中文名（供 prompt 与 UI 直出） */
export const REFUSE_LABEL: Record<string, string> = {
  direct: '直率型——直接拒绝，不绕弯',
  stout: '烈性型——拒绝得冲，带着火气',
  smooth: '圆滑型——委婉拒绝，给面子留余地',
  cold: '冷淡型——沉默或极简应答，即为拒绝',
  principled: '原则型——拒绝并引教义或律条为据',
  rational: '理性型——质疑前提，要求先讲清条件',
};

/**
 * 人设锚文本。chars > 0 时按字数上限填充，0 = 不限制。
 * 顺序即优先级——预算不够时，排在后面的字段先让位。
 */
export function personaBlock(npcId: string, chars = 0): string {
  const n = WB.npcs[npcId];
  if (!n) return '';
  const lore = (n.lore || {}) as NpcLore;
  const rows: string[] = [];
  const push = (v: string | undefined | false) => {
    if (v) rows.push(v);
  };
  /* 立体五要素的排序：谁 → 从哪来 → 裂口 → 怎么说 → 其余。
     前三项（身份/过往/弱点）是 P1 补进来的，因此排在最前，
     预算紧张时它们是最后被丢的。 */
  push(n.name + '（' + n.title + '·' + n.race + '）');
  push(!!lore.identity && '身份：' + lore.identity);
  push(!!lore.past && '过往：' + lore.past);
  push(!!n.goal && '志向：' + n.goal);
  push(!!lore.flaw && '弱点：' + lore.flaw);
  push(!!n.bottomLine && '底线：' + n.bottomLine);
  push(!!n.voice && '说话习惯：' + n.voice);
  push(n.priority?.length ? '优先序：' + n.priority.join(' → ') : '');
  push(!!n.refuseStyle && '拒绝方式：' + REFUSE_LABEL[n.refuseStyle]);
  push(!!n.interest && '关切：' + n.interest);
  push(!!lore.personality && '性格：' + lore.personality);
  push(!!lore.appearance && '外貌：' + lore.appearance);
  push(!!lore.abilities && '能力：' + lore.abilities);
  push(!!lore.belongings && '持有物：' + lore.belongings);

  const out: string[] = [];
  let len = 0;
  for (const row of rows) {
    /* 首段（姓名＋头衔）永远保留：它是最小可用的人设锚 */
    const next = out.length === 0 ? row.length : len + 1 + row.length;
    if (chars > 0 && out.length > 0 && next > chars) break;
    out.push(row);
    len = next;
  }
  return out.join('；');
}
