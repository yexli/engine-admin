/* ============================================================
   系统设置存储（M3.4 · 平台配置子集持久化）
   ------------------------------------------------------------
   白名单目录（key → 名称/分组/类型/缺省/校验）由本模块持有，
   值持久化 data/settings.json；目录即真实契约（GET 返回整表，
   PUT 按 key 校验类型与范围）。

   诚实边界：M3 交付的是「持久化」。当前所有键都是管理台账/前端
   偏好——平台运行时行为（出站超时、访问日志等）由环境变量决定，
   需重启并在部署层接线后才随设置生效；各项 description 注明口径，
   不假装运行时效果。
   ============================================================ */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const STORE_VERSION = 1;

export interface SettingSpec {
  key: string;
  name: string;
  type: 'string' | 'number' | 'boolean';
  group: string;
  description: string;
  default: string | number | boolean;
  /** string 的可选枚举；number 的 [min, max] */
  enum?: readonly string[];
  range?: readonly [number, number];
  /** number 是否必须为整数 */
  int?: boolean;
}

export const SETTING_SPECS: readonly SettingSpec[] = [
  { key: 'platform.name', name: '平台名称', type: 'string', group: 'general', description: '管理台账：控制台展示名（界面标题当前取构建配置）', default: 'World Driving Engine Admin', range: undefined },
  { key: 'platform.language', name: '界面语言', type: 'string', group: 'general', description: '管理后台语言（当前界面文案以中文为主，切换为前端预留）', default: 'zh-CN', enum: ['zh-CN', 'en'] },
  { key: 'world.maxWorlds', name: '最大世界数', type: 'number', group: 'world', description: '管理台账：允许并存的世界上限目标值（引擎注册表当前不限，M4/M5 接线）', default: 16, range: [1, 1024], int: true },
  { key: 'world.autoPause', name: '空闲自动暂停', type: 'boolean', group: 'world', description: '管理台账：引擎当前无暂停语义（G1，M4 评审），本项暂不生效', default: false },
  { key: 'gateway.requestTimeoutMs', name: 'AI 请求超时（毫秒）', type: 'number', group: 'gateway', description: '管理台账：平台出站超时当前由 PLATFORM_UPSTREAM_TIMEOUT_MS 决定（重启生效）', default: 60000, range: [1000, 600000], int: true },
  { key: 'gateway.dailyBudgetUsd', name: 'AI 日预算上限（USD）', type: 'number', group: 'gateway', description: '管理台账：预算强制执行属平台 Phase 2（出界项），当前不拦截', default: 20, range: [0, 1_000_000] },
  { key: 'memory.retrievalTopK', name: '检索默认 Top-K', type: 'number', group: 'memory', description: '管理台账：记忆检索调试页的默认返回条数目标值', default: 5, range: [1, 50], int: true },
  { key: 'observability.logRetentionDays', name: '日志保留天数', type: 'number', group: 'observability', description: '管理台账：日志清退策略随 M4/M5 可观测聚合接线', default: 30, range: [1, 365], int: true },
];

export interface SettingRow {
  key: string;
  name: string;
  value: string | number | boolean;
  type: 'string' | 'number' | 'boolean';
  group: string;
  description: string;
}

export class SettingsStore {
  private values = new Map<string, string | number | boolean>();
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    let parsed: { version?: number; values?: Record<string, string | number | boolean> };
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
    } catch {
      throw new Error(`设置文件损坏，无法解析：${this.filePath}`);
    }
    if (parsed.version === STORE_VERSION && parsed.values && typeof parsed.values === 'object') {
      for (const spec of SETTING_SPECS) {
        const v = (parsed.values as Record<string, unknown>)[spec.key];
        if (v !== undefined && this.validate(spec, v) === null) this.values.set(spec.key, v as string | number | boolean);
      }
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const values = Object.fromEntries(this.values);
    writeFileSync(this.filePath, `${JSON.stringify({ version: STORE_VERSION, values }, null, 2)}\n`, 'utf8');
  }

  /** 校验：合法 → null；非法 → 错误消息 */
  validate(spec: SettingSpec, value: unknown): string | null {
    if (spec.type === 'boolean') {
      return typeof value === 'boolean' ? null : `${spec.name} 必须是布尔`;
    }
    if (spec.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) return `${spec.name} 必须是数字`;
      if (spec.int && !Number.isInteger(value)) return `${spec.name} 必须是整数`;
      if (spec.range && (value < spec.range[0] || value > spec.range[1])) {
        return `${spec.name} 必须在 ${spec.range[0]} - ${spec.range[1]} 之间`;
      }
      return null;
    }
    if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
      return `${spec.name} 必须是 1-128 字符的字符串`;
    }
    if (spec.enum && !spec.enum.includes(value)) {
      return `${spec.name} 只接受：${spec.enum.join(' / ')}`;
    }
    return null;
  }

  list(): { list: SettingRow[]; total: number } {
    const list = SETTING_SPECS.map((spec) => ({
      key: spec.key,
      name: spec.name,
      value: this.values.has(spec.key) ? this.values.get(spec.key)! : spec.default,
      type: spec.type,
      group: spec.group,
      description: spec.description,
    }));
    return { list, total: list.length };
  }

  /** 更新：非法值抛错且不落盘 */
  set(key: string, value: unknown): SettingRow {
    const spec = SETTING_SPECS.find((s) => s.key === key);
    if (!spec) {
      const known = SETTING_SPECS.map((s) => s.key).join(', ');
      throw new Error(`未知设置项 '${key}'（可用：${known}）`);
    }
    const err = this.validate(spec, value);
    if (err) throw new Error(err);
    this.values.set(key, value as string | number | boolean);
    this.persist();
    const row = this.list().list.find((r) => r.key === key)!;
    return row;
  }
}
