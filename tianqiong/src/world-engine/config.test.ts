/* ============================================================
   外部引擎开关配置测试（Phase 9 · 默认翻转后的语义）
   ============================================================ */
import { describe, expect, it } from 'vitest';
import { DEFAULT_BASE_URL, DEFAULT_ENABLED, DEFAULT_WORLD_ID, readExternalEngineConfig } from './config';

/** 极简 Storage 桩（只实现本模块用到的两个方法） */
function memoryStorage(entries: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(entries));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
}

describe('readExternalEngineConfig（Phase 9 默认翻转）', () => {
  it('缺省：外部会话宿主形态（enabled=true），指向本机游戏宿主', () => {
    const c = readExternalEngineConfig({}, undefined);
    expect(DEFAULT_ENABLED).toBe(true);
    expect(c.enabled).toBe(true);
    expect(c.baseUrl).toBe(DEFAULT_BASE_URL);
    expect(c.worldId).toBe(DEFAULT_WORLD_ID);
  });

  it('逃生门：env 显式 false/0 关闭（默认开之后的必要出口）', () => {
    expect(readExternalEngineConfig({ VITE_TIANQIONG_EXTERNAL_WORLD_ENGINE: 'false' }, undefined).enabled).toBe(false);
    expect(readExternalEngineConfig({ VITE_TIANQIONG_EXTERNAL_WORLD_ENGINE: '0' }, undefined).enabled).toBe(false);
    expect(readExternalEngineConfig({ VITE_TIANQIONG_EXTERNAL_WORLD_ENGINE: 'true' }, undefined).enabled).toBe(true);
  });

  it('localStorage 显式 enabled 布尔生效；env 优先', () => {
    const off = memoryStorage({ tq2_ext_engine_v1: JSON.stringify({ enabled: false }) });
    expect(readExternalEngineConfig({}, off).enabled).toBe(false);
    expect(
      readExternalEngineConfig({ VITE_TIANQIONG_EXTERNAL_WORLD_ENGINE: 'true' }, off).enabled,
    ).toBe(true);

    const on = memoryStorage({ tq2_ext_engine_v1: JSON.stringify({ enabled: true }) });
    expect(readExternalEngineConfig({ VITE_TIANQIONG_EXTERNAL_WORLD_ENGINE: 'false' }, on).enabled).toBe(false);
  });

  it('兼容旧判定：键存在（无 enabled 字段）= 开', () => {
    const ls = memoryStorage({ tq2_ext_engine_v1: JSON.stringify({ baseUrl: 'http://192.168.1.9:8797' }) });
    expect(readExternalEngineConfig({}, ls).enabled).toBe(true);
  });

  it('localStorage 覆盖端点与世界 id；baseUrl 去尾斜杠', () => {
    const ls = memoryStorage({
      tq2_ext_engine_v1: JSON.stringify({ baseUrl: 'http://192.168.1.9:8797/', worldId: 'tianqiong-dev' }),
    });
    const c = readExternalEngineConfig({}, ls);
    expect(c.baseUrl).toBe('http://192.168.1.9:8797');
    expect(c.worldId).toBe('tianqiong-dev');
  });

  it('localStorage 里的坏 JSON 不致命（回落缺省）', () => {
    const ls = memoryStorage({ tq2_ext_engine_v1: '{oops' });
    const c = readExternalEngineConfig({}, ls);
    expect(c.baseUrl).toBe(DEFAULT_BASE_URL);
  });

  it('env 携带 apiKey 时透传', () => {
    const c = readExternalEngineConfig({ VITE_WORLD_ENGINE_KEY: 'secret' }, undefined);
    expect(c.apiKey).toBe('secret');
  });
});
