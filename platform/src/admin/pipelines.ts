/* ============================================================
   管线描述存储（M2.3 · 只读 + 有界试跑，编辑器明确不做）
   ------------------------------------------------------------
   管线 spec 数据化在 gateway V0.7 已定（PipelineSpec = 节点 DAG），
   但它此前是纯库 API——没有任何配置存储持有 spec。本存储给运营一个
   事实来源：data/pipelines.json（PLATFORM_PIPELINES_FILE），手工或
   脚本维护；管理台只读展示 + 有界试跑（POST .../test），没有写端点
   ——不做 DAG 编辑器（方案 §27 出界项）。

   校验复用 gateway 的 parsePipelineSpec（fail-fast），避免两处漂移。
   文件损坏/单条 spec 非法 → 整体抛错（诚实暴露，不做静默降级）；
   文件不存在 → 空清单（特性未启用是合法状态）。
   ============================================================ */
import { existsSync, readFileSync } from 'node:fs';
import { parsePipelineSpec, PipelineSpecError } from 'world-gateway';
import type { PipelineSpec } from 'world-gateway';

export interface PipelineDoc {
  /** 与 spec.id 一致（路由键） */
  id: string;
  description?: string;
  /** false = 只展示、拒绝试跑 */
  enabled: boolean;
  spec: PipelineSpec;
}

export class PipelineStoreError extends Error {
  constructor(message: string, public readonly issues: string[]) {
    super(message);
  }
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export class PipelineStore {
  constructor(private readonly filePath: string) {}

  list(): PipelineDoc[] {
    return this.load();
  }

  get(id: string): PipelineDoc | null {
    return this.load().find((d) => d.id === id) ?? null;
  }

  private load(): PipelineDoc[] {
    if (!existsSync(this.filePath)) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
    } catch (e) {
      throw new PipelineStoreError('管线描述文件不是合法 JSON', [
        `${this.filePath}: ${e instanceof Error ? e.message : String(e)}`,
      ]);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new PipelineStoreError('管线描述文件必须是一个对象 { version: 1, pipelines: [...] }', []);
    }
    const root = parsed as Record<string, unknown>;
    if (root['version'] !== 1) {
      throw new PipelineStoreError('管线描述文件 version 必须是 1', []);
    }
    if (!Array.isArray(root['pipelines'])) {
      throw new PipelineStoreError('pipelines 必须是数组', []);
    }

    const issues: string[] = [];
    const docs: PipelineDoc[] = [];
    const rawList = root['pipelines'] as unknown[];
    rawList.forEach((raw, i) => {
      const label = `pipelines[${i}]`;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        issues.push(`${label} 必须是对象`);
        return;
      }
      const b = raw as Record<string, unknown>;
      const id = typeof b['id'] === 'string' && ID_RE.test(b['id']) ? b['id'] : null;
      if (!id) {
        issues.push(`${label}.id 必须是 1-64 位 [A-Za-z0-9_-]`);
        return;
      }
      if (b['enabled'] !== undefined && typeof b['enabled'] !== 'boolean') {
        issues.push(`${label}.enabled 必须是布尔（缺省 true）`);
        return;
      }
      if (b['description'] !== undefined && (typeof b['description'] !== 'string' || b['description'].length > 200)) {
        issues.push(`${label}.description 必须是 ≤200 字符的字符串`);
        return;
      }
      let spec: PipelineSpec;
      try {
        spec = parsePipelineSpec(b['spec']);
      } catch (e) {
        issues.push(`${label}.spec：${e instanceof PipelineSpecError ? e.message : String(e)}`);
        return;
      }
      if (spec.id !== id) {
        issues.push(`${label}：外层 id '${id}' 与 spec.id '${spec.id}' 不一致`);
        return;
      }
      const doc: PipelineDoc = { id, enabled: b['enabled'] === undefined ? true : (b['enabled'] as boolean), spec };
      if (typeof b['description'] === 'string') doc.description = b['description'];
      docs.push(doc);
    });

    if (issues.length > 0) {
      throw new PipelineStoreError(`管线描述文件校验失败（${this.filePath}）`, issues);
    }
    const ids = new Set(docs.map((d) => d.id));
    if (ids.size !== docs.length) {
      throw new PipelineStoreError('管线描述文件存在重复 id', []);
    }
    return docs;
  }
}
