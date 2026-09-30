/* ============================================================
   World Definition（V1.0 · 方案 §八）
   ------------------------------------------------------------
   「应用提供世界，引擎让世界运行。」
   创建世界时由应用注入 World Definition：实体 / 地点 / 关系 /
   变量 / 元数据。内核只知道 id / type / attributes——不知道
   这些东西叫什么名字、来自哪个故事、有什么剧情。

   数据化、可序列化：World Definition 是纯 JSON 形状。
   ============================================================ */
import type { EngineWorldState } from '../types.ts';

export interface WorldDefinitionEntity {
  /** 实体 id（唯一；'player' 为保留 id，跳过） */
  id: string;
  /** 实体类型（character / building / vehicle…由宿主定义） */
  type?: string;
  /** 显示名（落入 attributes.name） */
  name?: string;
  /** 初始属性（一层基本类型；location 单列） */
  attributes?: Record<string, unknown>;
  /** 初始所在地点 id */
  location?: string;
}

export interface WorldDefinitionLocation {
  id: string;
  type?: string;
  attributes?: Record<string, unknown>;
}

export interface WorldDefinitionRelation {
  source: string;
  target: string;
  type: string;
  value?: number;
  metadata?: Record<string, unknown>;
}

export interface WorldDefinition {
  entities?: WorldDefinitionEntity[];
  locations?: WorldDefinitionLocation[];
  relations?: WorldDefinitionRelation[];
  variables?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/**
 * 把世界定义物化进状态：locations / entities(→npcs) / relations /
 * variables / metadata。幂等安全：重复 id 跳过、'player' 保留 id 跳过。
 */
export function applyDefinition<W extends EngineWorldState>(state: W, def: WorldDefinition): void {
  if (def.locations?.length) {
    const l = (state.locations = state.locations ?? {});
    for (const d of def.locations) {
      if (!d.id || l[d.id]) continue;
      l[d.id] = {
        id: d.id,
        ...(d.type !== undefined ? { type: d.type } : {}),
        ...(d.attributes ? { attributes: d.attributes } : {}),
      };
    }
  }

  if (def.entities?.length) {
    for (const e of def.entities) {
      if (!e.id || e.id === 'player' || state.npcs[e.id]) continue;
      const attrs: Record<string, unknown> = {};
      if (e.name !== undefined) attrs['name'] = e.name;
      if (e.attributes) Object.assign(attrs, e.attributes);
      if (e.location !== undefined) attrs['location'] = e.location;
      state.npcs[e.id] = {
        att: 0,
        mem: [],
        met: false,
        ...(e.type !== undefined ? { type: e.type } : {}),
        ...(Object.keys(attrs).length ? { attributes: attrs } : {}),
      };
    }
  }

  if (def.relations?.length) {
    const r = (state.relations = state.relations ?? []);
    for (const d of def.relations) {
      if (!d.source || !d.target || !d.type) continue;
      r.push({
        source: d.source,
        target: d.target,
        type: d.type,
        ...(d.value !== undefined ? { value: d.value } : {}),
        ...(d.metadata ? { metadata: d.metadata } : {}),
      });
    }
  }

  if (def.variables) state.variables = { ...(state.variables ?? {}), ...def.variables };
  if (def.metadata) state.metadata = { ...(state.metadata ?? {}), ...def.metadata };
}
