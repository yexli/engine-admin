/* ============================================================
   能力路由（Phase 1 · 方案 §13「Capability → Router → Selected Model」）
   ------------------------------------------------------------
   · 路由表来自文件配置（platform/data/router.json）——运营可改，
     客户端无感；
   · 健康冷却：模型调用失败后冷却 30s，期间直接走 fallback；
     冷却期满自动恢复尝试（内存态，Phase 9 接 Redis）；
   · 未配置 primary → 明确 503 no_model_configured，不假装可用。
   ============================================================ */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Capability, CapabilityRoute, RouterConfig } from '../types.ts';

const COOLDOWN_MS = 30_000;

/** Gateway 六通道（§65）作为缺省路由目标；运营按需改 router.json */
export const DEFAULT_ROUTES: Record<Capability, CapabilityRoute> = {
  roleplay: { primary: 'npc', fallback: 'narrative' },
  narrative: { primary: 'narrative', fallback: 'npc' },
  reasoning: { primary: 'reasoning', fallback: 'narrative' },
  fast: { primary: 'npc', fallback: 'narrative' },
  cheap: { primary: 'npc', fallback: 'narrative' },
  memory: { primary: 'memory', fallback: 'narrative' },
  /* —— P8 · 方案 §十一 新增能力（缺省路由对齐网关标准角色；未配置 → 如实 503/404）—— */
  intent: { primary: 'fast', fallback: 'narrative' },
  world_reasoning: { primary: 'reasoning', fallback: 'narrative' },
  evolution: { primary: 'reasoning', fallback: 'narrative' },
  npc_behavior: { primary: 'npc', fallback: 'narrative' },
  embedding: { primary: 'embedding', fallback: null },
  long_context: { primary: 'reasoning', fallback: 'narrative' },
  structured_output: { primary: 'reasoning', fallback: 'narrative' },
};

export class ModelRouter {
  private routes: Record<Capability, CapabilityRoute>;
  /** model → 冷却截止时间（ms 纪元） */
  private cooldown = new Map<string, number>();

  constructor(
    filePath: string | null,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.routes = { ...DEFAULT_ROUTES };
    if (filePath && existsSync(filePath)) {
      try {
        const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as RouterConfig;
        if (parsed.version === 1 && parsed.routes && typeof parsed.routes === 'object') {
          this.routes = { ...this.routes, ...parsed.routes };
        }
      } catch {
        /* 路由文件损坏不致命：退回内置缺省并保持只读，避免启动失败 */
      }
    }
  }

  /** 写出缺省路由文件（初始化用；已存在则不动） */
  static seedDefault(filePath: string): void {
    if (existsSync(filePath)) return;
    mkdirSync(dirname(filePath), { recursive: true });
    const config: RouterConfig = { version: 1, routes: { ...DEFAULT_ROUTES } };
    writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  }

  route(capability: Capability): CapabilityRoute {
    return this.routes[capability] ?? { primary: null, fallback: null };
  }

  /**
   * 托管模式热替换：整体换掉六能力路由（物理模型 ID 视图），
   * 并清除不再被引用模型的冷却——配置已由运营改写，旧冷却状态
   * 对新快照没有意义（被移除/变更的 ID 不应带着旧失败记录）。
   */
  replaceRoutes(routes: Partial<Record<Capability, CapabilityRoute>>): void {
    this.routes = { ...DEFAULT_ROUTES, ...this.routes, ...routes };
    const referenced = new Set<string>();
    for (const cap of Object.keys(this.routes) as Capability[]) {
      const r = this.routes[cap];
      if (r?.primary) referenced.add(r.primary);
      if (r?.fallback) referenced.add(r.fallback);
    }
    for (const id of [...this.cooldown.keys()]) {
      if (!referenced.has(id)) this.cooldown.delete(id);
    }
  }

  /** 标记模型本次调用失败 → 进入冷却 */
  markFailed(model: string): void {
    this.cooldown.set(model, this.now() + COOLDOWN_MS);
  }

  /** 显式标记成功（清冷却） */
  markHealthy(model: string): void {
    this.cooldown.delete(model);
  }

  isCoolingDown(model: string): boolean {
    const until = this.cooldown.get(model);
    return until !== undefined && until > this.now();
  }

  /**
   * 选择本次使用的模型：
   * primary 可用（存在且不在冷却）→ primary；否则 fallback；都不可用 → null。
   */
  select(capability: Capability): { model: string; usedFallback: boolean } | null {
    const { primary, fallback } = this.route(capability);
    if (primary && !this.isCoolingDown(primary)) {
      return { model: primary, usedFallback: false };
    }
    if (fallback && !this.isCoolingDown(fallback)) {
      return { model: fallback, usedFallback: true };
    }
    return null;
  }
}
