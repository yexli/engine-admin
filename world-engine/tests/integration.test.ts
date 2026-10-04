/* 集成：完整命令链 + 存档往返 + 因果追溯 + 架构不变量 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { worldBus, causality } from '../src/events/WorldEventBus';
import { resetEventSeq, setEventSeq, eventSeq, traceChain } from '../src/events/EventSchema';
import { createWorld } from '../src/api/WorldAPI';
import { InMemoryWorldStorage } from '../src/state/storage';
import { rng } from '../src/rng';
import type { EngineWorldState, WorldEvent } from '../src';

beforeEach(() => {
  worldBus.reset();
  causality.reset();
  resetEventSeq();
});

describe('完整链路（方案 §34）', () => {
  it('Command → API → Runtime → Rule → Mutation → State → Event 一条不断', () => {
    const world = createWorld<EngineWorldState>({ worldId: 'chain' });
    const all: WorldEvent[] = [];
    worldBus.on('*', (e) => all.push(e));

    world.executeCommand({ type: 'spawn_entity', payload: { id: 'goblin', name: '哥布林', kind: 'npc' } });
    const r = world.executeCommand({ type: 'attack', actorId: 'player', targetId: 'goblin', amount: 5 });

    expect(r.ok).toBe(true);
    expect(r.events.length).toBe(1);
    expect(world.query.get_entities()).toContain('goblin');
    const ev = world.getEvents().find((e) => e.type === 'attack_succeeded');
    expect(ev?.target).toBe('goblin');
    expect(ev?.data?.damage).toBe(5);
  });

  it('因果链：后果事件挂到触发事件之下，可向上追溯', () => {
    const world = createWorld<EngineWorldState>({ worldId: 'chain' });
    const all: WorldEvent[] = [];
    worldBus.on('*', (e) => all.push(e));

    /* V2.4-02 不变量：先建档再改态度（不存在实体不可被修改） */
    world.executeCommand({ type: 'create_entity', payload: { id: 'otto', name: '奥托', kind: 'npc' } });
    const root = world.emitEvent({ type: 'caravan_ambush' });
    causality.withParent(root.id, () => {
      world.executeCommand({ type: 'set_attitude', targetId: 'otto', amount: -25 });
    });
    const leaf = all.find((e) => e.type === 'npc_attitude_shift')!;
    const chain = traceChain(all, leaf.id);
    expect(chain.map((e) => e.type)).toEqual(['npc_attitude_shift', 'caravan_ambush']);
  });

  it('存档往返：命令 → 落盘 → 读回 → 事件序号续接不回退', () => {
    const store = new InMemoryWorldStorage<EngineWorldState>();
    const world = createWorld<EngineWorldState>({ worldId: 'w-001', savePort: store });
    world.executeCommand({ type: 'move', targetId: 'tavern' });
    world.container.save();
    const savedSeq = eventSeq();
    setEventSeq(savedSeq);

    /* 模拟重启：新进程读档 */
    const restored = store.load()!;
    expect(restored.player.loc).toBe('tavern');
    expect(restored.evtSeq).toBe(savedSeq);
    setEventSeq(Math.max(eventSeq(), restored.evtSeq ?? 0));
    expect(eventSeq()).toBeGreaterThanOrEqual(savedSeq);
  });

  it('确定性：同种子同序列 → 同结果（世界模拟可复现）', () => {
    const run = () => {
      rng.seed(1234);
      const world = createWorld<EngineWorldState>({ worldId: 'det' });
      const s = world.getState()!;
      s.seed = Math.floor(rng.next() * 4294967296) >>> 0;
      world.executeCommand({ type: 'move', targetId: 'forest' });
      world.advanceTime(5);
      return { seed: s.seed, t: s.t, loc: s.player.loc };
    };
    expect(run()).toEqual(run());
  });
});

/* ---------------- 架构不变量（方案 §35，源码扫描固化） ---------------- */

const SRC = join(dirname(fileURLToPath(import.meta.url)), '../src');

describe('架构不变量', () => {
  const forbidden: [RegExp, string][] = [
    [/from\s+['"]react/, 'Core 不得依赖 React（不变量 3）'],
    [/from\s+['"]react-dom/, 'Core 不得依赖 React（不变量 3）'],
    [/from\s+['"]zustand/, 'Core 不得依赖 store（不变量 2）'],
    [/@\/(world|systems|data|plugins|ai|memory|ui|store|events|actions|dice|validation|execution)/, 'Core 不得依赖天穹（不变量 5）'],
    [/tianqiong/i, 'Core 不应该知道天穹存在（执行纪律第三条）'],
    [/openai|deepseek|qwen|anthropic|gemini/i, 'Core 不得依赖具体 LLM（不变量 4）'],
    [/import\.meta\.hot/, 'Core 不得依赖 Vite HMR（引擎须独立于宿主构建器）'],
    [/localStorage|document\.|window\./, 'Core 不得触碰 DOM / 浏览器存储（不变量 2：不依赖 UI）'],
  ];

  it('引擎源码零禁用依赖（不变量 1–5 的机器可查形式）', async () => {
    const { readdir } = await import('node:fs/promises');
    const files: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const n of await readdir(dir, { withFileTypes: true })) {
        const p = join(dir, n.name);
        if (n.isDirectory()) await walk(p);
        else if (n.name.endsWith('.ts')) files.push(p);
      }
    };
    await walk(SRC);
    expect(files.length, '扫描器读到了引擎源码').toBeGreaterThan(10);

    /* 只查代码不查注释：注释里提到「天穹」「localStorage」是设计说明，不是依赖 */
    const stripComments = (src: string): string =>
      src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');

    const hits: string[] = [];
    for (const f of files) {
      const code = stripComments(await readFile(f, 'utf8'));
      for (const [re, why] of forbidden) {
        if (re.test(code)) hits.push(f.replace(SRC, 'src') + ' → ' + why);
      }
    }
    expect(hits).toEqual([]);
  });

  it('V1.0 · 内核禁止依赖 AI 层包（gateway / memory，§11 扩展）', async () => {
    const { readdir } = await import('node:fs/promises');
    const files: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const n of await readdir(dir, { withFileTypes: true })) {
        const p = join(dir, n.name);
        if (n.isDirectory()) await walk(p);
        else if (n.name.endsWith('.ts')) files.push(p);
      }
    };
    await walk(SRC);
    const strip = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const hits: string[] = [];
    for (const f of files) {
      const code = strip(await readFile(f, 'utf8'));
      if (/(from\s+['"](.*[\/])?(gateway|memory)([\/'"]|$))|(['"]world-(gateway|memory)['"])/.test(code)) {
        hits.push(f.replace(SRC, 'src') + ' → 依赖 AI 层包');
      }
    }
    expect(hits, '内核不得依赖 gateway/memory（§16 单向数据流）').toEqual([]);
  });

  it('V1.0 · Core 规则与运行时不含 RPG 语义（§11：quest/inventory 等）', async () => {
    const strip = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const rel of ['rules/coreRules.ts', 'runtime/WorldRuntime.ts']) {
      const code = strip(await readFile(join(SRC, rel), 'utf8'));
      expect(code, rel).not.toMatch(/\b(attack|talk|quest|inventory|reputation|craft)\b/i);
    }
  });
});
