/* ============================================================
   lore 事实卡加载器（内容权威层 · 零逻辑）
   settings（121）常驻主包；person（109）走动态 import 懒加载，
   首帧后由 main.tsx 触发 loadPersonLore()，避免人物 canon 撑爆移动端主包。
   seed = 关 AI 时的一句话事实兜底；canon = 蒸馏后的设定正文（AI 上下文用）。
   ============================================================ */
import lore from './lore/lore.json';

export interface LoreCard {
  id: string;
  kind: 'setting' | 'person';
  num: number;
  topic: string;
  name: string;
  keywords: string[];
  constant: boolean;
  seed: string;
  canon: string;
}

export const LORE: LoreCard[] = lore as unknown as LoreCard[];

/** 人物 canon（懒加载后填充；检索层合并读取）。 */
export let PERSON_LORE: LoreCard[] = [];
let personLoading: Promise<void> | null = null;

/** 幂等：首次调用动态载入 lore-person.json，之后复用。 */
export function loadPersonLore(): Promise<void> {
  if (personLoading) return personLoading;
  personLoading = import('./lore/lore-person.json')
    .then((m) => {
      PERSON_LORE = (m.default ?? m) as LoreCard[];
    })
    .catch(() => {
      PERSON_LORE = [];
    });
  return personLoading;
}
