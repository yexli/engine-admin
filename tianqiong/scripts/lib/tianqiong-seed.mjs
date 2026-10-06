/* ============================================================
   天穹世界书 → GameWorldSeed（宿主侧实现）
   ------------------------------------------------------------
   与 src/world-engine/adapter/tianqiongSeed.ts 是同一份映射的
   宿主镜像（Node 直跑不能 import src 的 TS/JSON 模块链），两边由
   src/world-engine/adapter/tianqiongSeed.test.ts 的 parity 断言
   钉死一致——改任何一边都必须同步另一边，否则测试红。
   ============================================================ */
import { readFileSync } from 'node:fs';

const readJson = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));

export function locationTypeOf(name) {
  return /野|林|原/.test(name ?? '') ? 'wilderness' : 'urban';
}

export function buildTianqiongWorldSeed() {
  const geo = readJson('../../src/data/world/geo.json');
  const people = readJson('../../src/data/world/people.json');

  const locations = Object.entries(geo.locations).map(([id, l]) => ({
    id,
    name: l.name ?? id,
    type: locationTypeOf(l.name),
    attributes: { area: l.area ?? '', continent: l.continent ?? '' },
  }));

  const npcs = Object.entries(people.npcs).map(([id, n]) => ({
    id,
    name: n.name ?? id,
    loc: n.loc ?? locations[0]?.id ?? 'plaza',
    data: { title: n.title ?? '', race: n.race ?? '' },
  }));

  const relations = Object.entries(people.npcs).flatMap(([id, n]) =>
    Object.entries(n.rels ?? {}).flatMap(([target, rel]) =>
      rel && typeof rel === 'object'
        ? [
            {
              source: id,
              target,
              type: rel.type ?? 'acquaintance',
              ...(typeof rel.val === 'number' ? { value: rel.val } : {}),
            },
          ]
        : [],
    ),
  );

  const facts = Object.entries(people.npcs).map(([id, n]) => ({
    type: 'npc_identity',
    actor: id,
    data: { identity: String(n.lore?.identity ?? '').slice(0, 200) },
  }));

  return {
    worldId: 'tianqiong-main',
    name: '天穹纪元 · 圣辉城',
    description: '天穹 2.0 世界书在剥离引擎上的常驻世界（TianqiongAdapter）',
    ownerGame: 'tianqiong',
    startLoc: locations[0]?.id,
    locations,
    npcs,
    relations,
    facts,
  };
}
