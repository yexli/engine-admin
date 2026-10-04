import { describe, expect, it } from 'vitest';
import { mixHex, silKindOf, silhouetteFor } from './silhouette';
import { WB } from '@/data/worldBook';

describe('silKindOf（地点名优先，area 兜底）', () => {
  it('地点名命中特征词', () => {
    expect(silKindOf('浅层洞窟·一层', '帝国山脉')).toBe('cave');
    expect(silKindOf('龙脊界碑', '守界之地')).toBe('mountain');
    expect(silKindOf('城外旷野', '圣辉城')).toBe('hills'); // 名字优先于地区名的「城」
    expect(silKindOf('银鸥酒馆', '圣辉城')).toBe('city');
    expect(silKindOf('冥府', '亡者归处')).toBe('cave');
    expect(silKindOf('白桦林', '某地')).toBe('forest');
    expect(silKindOf('金砂滩', '金砂绿洲')).toBe('desert');
  });

  it('地点名无特征词时看地区名', () => {
    expect(silKindOf('无名地', '帝国山脉')).toBe('mountain');
    expect(silKindOf('无名地', '金砂绿洲')).toBe('desert');
    expect(silKindOf('无名地', '魔界荒原')).toBe('hills');
  });

  it('全部真实地点都能得到一个类型（不抛错、不为空）', () => {
    for (const [id, L] of Object.entries(WB.locations)) {
      const kind = silKindOf(L.name ?? '', L.area ?? '');
      expect(['city', 'mountain', 'forest', 'cave', 'desert', 'hills']).toContain(kind);
      expect(id.length).toBeGreaterThan(0);
    }
  });
});

describe('mixHex', () => {
  it('t=0 得 a，t=1 得 b，中点取均', () => {
    expect(mixHex('#ff0000', '#0000ff', 0)).toBe('#ff0000');
    expect(mixHex('#ff0000', '#0000ff', 1)).toBe('#0000ff');
    expect(mixHex('#ff0000', '#0000ff', 0.5)).toBe('#800080');
  });
});

describe('silhouetteFor', () => {
  it('产出可直接喂给 backgroundImage 的 url() 包裹 SVG data URI（两条 path）', () => {
    const s = silhouetteFor('tavern', '银鸥酒馆', '圣辉城', '#b4695f');
    expect(s.image.startsWith('url("data:image/svg+xml')).toBe(true);
    const svg = decodeURIComponent(s.image);
    expect(svg.match(/<path /g)?.length).toBe(2);
  });

  it('同一地点命中缓存（引用相等），颜色变了重新生成', () => {
    const a = silhouetteFor('tavern', '银鸥酒馆', '圣辉城', '#b4695f');
    const b = silhouetteFor('tavern', '银鸥酒馆', '圣辉城', '#b4695f');
    expect(b).toBe(a);
    const c = silhouetteFor('tavern', '银鸥酒馆', '圣辉城', '#3f7d5f');
    expect(c).not.toBe(a);
  });
});
