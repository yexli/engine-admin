/* ============================================================
   地图分层与可达性（卡 E2）

   两组不变量：
     ① 分层——每个大陆要有地区、每个地区要有地点、每个地点都要被找得到。
        这一组防的是「加了大陆忘了加地点」导致地图上出现空白层。
     ② 可达性——travel 是有向图，而 go() 只认相邻边。界面此前只判断相邻，
        把「两跳可达」和「根本去不了」渲染成同一句话。这一组钉住三态语义。
   ============================================================ */
import { describe, expect, it } from 'vitest';
import { WB } from '@/data/worldBook';
import { areasIn, areaKind, continentOf, orderedContinents, sitesIn } from '@/data/regions';
import { neighborsOf, reach, routeBetween } from '@/systems/travel/Travel';

describe('地理分层（大陆 → 地区 → 地点）', () => {
  it('每个大陆都有地区，每个地区都有地点（防空白层）', () => {
    for (const c of orderedContinents()) {
      const areas = areasIn(c);
      expect(areas.length, c + ' 下面一个地区都没有——地图第二层会是空的').toBeGreaterThan(0);
      for (const a of areas) {
        expect(sitesIn(c, a).length, c + ' › ' + a + ' 下面一个地点都没有').toBeGreaterThan(0);
      }
    }
  });

  it('分层不丢地点：每个地点都能沿「大陆 → 地区」找到', () => {
    const found = new Set<string>();
    for (const c of orderedContinents()) {
      for (const a of areasIn(c)) {
        for (const id of sitesIn(c, a)) found.add(id);
      }
    }
    for (const id of Object.keys(WB.locations)) {
      expect(found.has(id), id + ' 不在任何大陆/地区下——地图上找不到它').toBe(true);
    }
  });

  it('大陆列表带兜底：未登记的大陆排在最后，而不是消失', () => {
    const cs = orderedContinents();
    expect(cs.length).toBeGreaterThanOrEqual(WB.continents.order.length);
    for (const c of WB.continents.order) expect(cs).toContain(c);
  });

  it('地区分型由能力决定，不靠地名', () => {
    expect(continentOf('tavern')).toBe('中央大陆');
    expect(areaKind('中央大陆', '圣辉城')).toBe('城镇'); // 有 urban 地点
    expect(areaKind('中央大陆', '帝国山脉')).toBe('野外'); // 没有
  });
});

describe('可达性（travel 是有向图，go() 只认相邻边）', () => {
  it('直达：相邻地点给刻数', () => {
    expect(reach('plaza', 'tavern')).toEqual({ kind: 'direct', cost: 1 });
  });

  it('这里：from === to', () => {
    expect(reach('plaza', 'plaza').kind).toBe('here');
  });

  it('需中转：从野外回城是「经城门」，不是「去不了」', () => {
    const r = reach('wild', 'plaza');
    expect(r.kind, 'wild → plaza 走不通的话，玩家会被永久困在城外').toBe('via');
    if (r.kind === 'via') {
      expect(r.path[0]).toBe('wild');
      expect(r.path[r.path.length - 1]).toBe('plaza');
      expect(r.path).toContain('gate');
      expect(r.cost).toBe(5); // wild→gate 3 + gate→plaza 2
    }
  });

  it('routeBetween 取的是刻数最小的那条', () => {
    const r = routeBetween('wild', 'plaza');
    expect(r).not.toBeNull();
    expect(r!.cost).toBe(5);
    expect(r!.path.length).toBe(3);
  });

  it('外大陆不在步行图里 → unreachable（它们的通行走 routes.json 的远行）', () => {
    expect(reach('plaza', 'frosthold').kind).toBe('unreachable');
  });

  it('据点内的步行图处处可达（不许有死胡同）', () => {
    const local = Object.keys(WB.locations).filter((id) => !WB.locations[id].locked);
    for (const a of local) {
      for (const b of local) {
        if (a === b) continue;
        expect(reach(a, b).kind, a + ' → ' + b + ' 走不通：据点内的路不该有死角').not.toBe('unreachable');
      }
    }
  });

  it('neighborsOf 只取出边，刻数为正；没连边的地点返回空数组', () => {
    for (const n of neighborsOf('wild')) expect(n.cost).toBeGreaterThan(0);
    /* 没连边的地点：异界三块（神界／魔界／往昔之地）不在步行图里，走特殊通道。 */
    expect(neighborsOf('pantheon_hall')).toEqual([]);
  });

  it('走不到时 routeBetween 返回 null，reach 不会给出半截路径', () => {
    expect(routeBetween('plaza', 'frosthold')).toBeNull();
    const r = reach('plaza', 'skycap');
    expect(r.kind).toBe('unreachable');
  });
});
