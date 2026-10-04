/* ============================================================
   P1 人设注入（《NPC 立体化与深入对话方案》§4.1）的回归防线。

   守的是「lore 七项必须进 prompt」这条线。
   为什么需要它：P1 之前 lore 全库 0 条进入 prompt，而人物志面板
   一直把这些文字显示给玩家看——所以肉眼验收永远发现不了这个缺口，
   它只能靠断言守住。同理，本文件的第三条守的是"预算裁剪不许切句子"：
   截断过的半句会让模型把残句当成人设的一部分。
   ============================================================ */
import { describe, expect, it } from 'vitest';
import cfg from '@/data/world/context.json';
import { WB } from '@/data/worldBook';
import { personaBlock } from '@/ai/persona';

const FIELDS = [
  ['identity', '身份'],
  ['past', '过往'],
  ['flaw', '弱点'],
  ['personality', '性格'],
  ['appearance', '外貌'],
  ['abilities', '能力'],
  ['belongings', '持有物'],
] as const;

/** 第一个"七项里填了指定字段"的 NPC id */
const pick = (...keys: (typeof FIELDS)[number][0][]): string => {
  const id = Object.keys(WB.npcs).find((k) => keys.every((f) => WB.npcs[k].lore?.[f]));
  if (!id) throw new Error('世界书里没有同时填了 ' + keys.join('/') + ' 的 NPC，测试前提不成立');
  return id;
};

describe('personaBlock · lore 注入（P1）', () => {
  it('七项中已填的都进了人设块', () => {
    const id = pick('identity', 'past', 'flaw', 'belongings');
    const t = personaBlock(id);
    for (const [k, label] of FIELDS) {
      const v = WB.npcs[id].lore?.[k];
      if (v) expect(t, id + ' 的「' + label + '」没进 prompt').toContain(v);
    }
  });

  it('全库核对：填了 identity 的 NPC，人设块里都找得到它', () => {
    let hit = 0;
    for (const id of Object.keys(WB.npcs)) {
      const v = WB.npcs[id].lore?.identity;
      if (!v) continue;
      expect(personaBlock(id), id).toContain(v);
      hit++;
    }
    expect(hit, '109 份档案应大批命中').toBeGreaterThan(50);
  });

  it('超限从尾部整段丢弃，不切断句子', () => {
    const id = pick('identity', 'belongings');
    const full = personaBlock(id);
    const cut = personaBlock(id, 80);
    expect(cut.length).toBeLessThan(full.length);
    /* 判据是「每一段都原样存在于完整文本中」——这直接表达了"整段丢弃、不切句子"，
       而且不用去猜首段（姓名）有没有前缀。 */
    const whole = new Set(full.split('；'));
    for (const seg of cut.split('；')) expect(whole.has(seg), '被切断的残句：' + seg).toBe(true);
  });

  it('优先级：预算紧张时保住身份，先丢持有物', () => {
    const id = pick('identity', 'belongings');
    const t = personaBlock(id, 90);
    expect(t).toContain(WB.npcs[id].lore!.identity!);
    expect(t).not.toContain(WB.npcs[id].lore!.belongings!);
  });

  it('非法 id 返回空串而不是抛错', () => {
    expect(personaBlock('查无此人')).toBe('');
  });

  it('三个通道的上限都在配置里，且 chat ≥ decide', () => {
    expect(cfg.personaChars.chat).toBeGreaterThan(0);
    expect(cfg.personaChars.greet).toBeGreaterThan(0);
    expect(cfg.personaChars.decide).toBeGreaterThan(0);
    expect(cfg.personaChars.chat).toBeGreaterThanOrEqual(cfg.personaChars.decide);
  });
});
