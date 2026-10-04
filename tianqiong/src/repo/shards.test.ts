/* ============================================================
   存档分片（《剩余工作实施方案》§3 · 第二杠杆）验收
   —— 拆装纯逻辑 + 两条介质通道 + 「只改 npcs → 只写 npcs」+ 旧整档可读 + 单闸门。
   为什么单开一个文件：repo 既有用例覆盖的是「写穿队列 / 错误可见」，
   本文件覆盖的是**写入粒度**——同样的 state，写下去几个字节、几个键。
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { LocalSaveRepository, MemorySaveRepository } from './index';
import { SqliteRepository, type SqlDb } from './sqlite';
import { isShardedMain, mergeShards, splitShards } from '@/world/Shards';
import { newState } from '@/world/WorldState';
import { core } from '@/world/WorldState';
import { save } from '@/world/WorldState';
import { setSavePort } from '@/plugins/PluginInterface';
import type { PortShards, SavePort } from '@/plugins/PluginInterface';
import type { WorldState } from '@/types/world';

/* 存储键（与 repo 实现同源：键名是存储契约，测试里按字面量钉住） */
const K_LEGACY = 'tq2_world_v1'; // 旧整档；分片档四片写全之前，它必须留着当回落源
const K_MAIN = 'tq2_main_v1'; // 分片主档（刻意不复用 K_LEGACY）
const K_NPCS = 'tq2_npcs_v1';
const K_MIND = 'tq2_mind_v1';
const K_KNOW = 'tq2_know_v1';
/** 同代指纹键（审查 §跨代拼接）：记录「这一代四片长什么样」。
 *  它不是数据片，但内容一变就要跟着写——断言「写了几片」时按数据片过滤。 */
const K_META = 'tq2_meta_v1';

const store = new Map<string, string>();
/** 每次 setItem 的键（按顺序），用于断言「写了几片」 */
let writes: string[] = [];

beforeEach(() => {
  store.clear();
  writes = [];
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      writes.push(k);
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size;
    },
  } as unknown as Storage;
});

const fresh = (): WorldState => newState({ name: '分片客', race: 'human', cls: 'warrior' });

describe('存档分片 · 拆装', () => {
  it('split 把五张增长表摘出去，主档里一个都不留', () => {
    const s = fresh();
    const sh = splitShards(s);
    for (const k of ['npcs', 'memories', 'beliefs', 'knowledge', 'cases']) {
      expect(k in (sh.main as unknown as Record<string, unknown>), k + ' 不该留在主档里').toBe(false);
    }
    expect(sh.npcs).toBe(s.npcs);
    expect(sh.knowledge).toBe(s.knowledge);
    expect(sh.main.player, '尺寸恒定的部分仍在主档').toBe(s.player);
  });

  it('merge 把缺失的分片补成空表，而不是 undefined', () => {
    const s = fresh();
    const p: PortShards = { main: splitShards(s).main };
    const back = mergeShards(p);
    expect(back.npcs).toEqual({});
    expect(back.memories).toEqual({});
    expect(back.beliefs).toEqual({});
    expect(back.knowledge).toEqual({});
    expect(back.cases).toEqual([]);
  });

  it('拆装往返恒等（字段一个不少、一个不多）', () => {
    const s = fresh();
    expect(mergeShards(splitShards(s))).toEqual(s);
  });

  it('isShardedMain：旧整档必含 npcs、新主档必无——认错就是把旧档的表清空', () => {
    const s = fresh();
    expect(isShardedMain(s), '旧整档（含 npcs）').toBe(false);
    expect(isShardedMain(splitShards(s).main), '新主档（摘掉 npcs）').toBe(true);
    expect(isShardedMain(null)).toBe(false);
    expect(isShardedMain('x')).toBe(false);
  });
});

describe('存档分片 · localStorage 通道', () => {
  it('分片往返：写下去四片，读回来的是完整档', () => {
    const repo = new LocalSaveRepository();
    const s = fresh();
    s.npcs.lita = { att: 12, mem: [], met: true };
    repo.saveShards(splitShards(s));
    expect(writes.sort()).toEqual([K_KNOW, K_MAIN, K_MIND, K_NPCS, K_META].sort());
    expect(repo.load()).toEqual(s);
  });

  it('只改 npcs → 只写 npcs 一片（这条通道存在的全部理由）', () => {
    const repo = new LocalSaveRepository();
    const s = fresh();
    repo.saveShards(splitShards(s));
    writes = [];
    s.npcs.lita = { att: 12, mem: [], met: true };
    repo.saveShards(splitShards(s));
    /* 指纹键是元数据（专为「四片是否同代」而写），过滤掉它，断言的仍是原意 */
    expect(writes.filter((w) => w !== K_META), '记忆与感知没动，就不该跟着重写').toEqual([K_NPCS]);
  });

  it('什么都不改 → 一个键都不写（内容指纹而不是对象引用）', () => {
    const repo = new LocalSaveRepository();
    const s = fresh();
    repo.saveShards(splitShards(s));
    writes = [];
    s.player.gold += 0; // 就地改一下但值不变
    repo.saveShards(splitShards(s));
    expect(writes).toEqual([]);
  });

  it('主档变了但三张表没变 → 只写主档', () => {
    const repo = new LocalSaveRepository();
    const s = fresh();
    repo.saveShards(splitShards(s));
    writes = [];
    s.player.gold += 100;
    repo.saveShards(splitShards(s));
    expect(writes.filter((w) => w !== K_META), '数据片只该写主档').toEqual([K_MAIN]);
  });

  it('旧整档（含 npcs 的整档）仍可读，且不被当成「分片缺失」清空', () => {
    const repo = new LocalSaveRepository();
    const s = fresh();
    s.npcs.lita = { att: 12, mem: [], met: true };
    repo.save(s); // 旧格式：一次写完整档
    expect(store.get(K_NPCS), '整档不该顺手写出分片键').toBeUndefined();
    expect(store.get(K_MAIN), '整档路径也不该占分片主档的键').toBeUndefined();
    expect(repo.load()?.npcs).toEqual(s.npcs);
  });

  it('缺片（上一批没写完）→ 回落到旧整档，而不是把缺的表当成空表', () => {
    const repo = new LocalSaveRepository();
    const s = fresh();
    s.npcs.lita = { att: 12, mem: [], met: true };
    repo.save(s); // 旧的完整整档在位
    const sh = splitShards(s);
    store.set(K_MAIN, JSON.stringify(sh.main));
    store.set(K_NPCS, JSON.stringify(sh.npcs));
    store.set(K_MIND, JSON.stringify({ memories: sh.memories, beliefs: sh.beliefs }));
    /* know 缺席：模拟「第 4 次写入没成功」 */
    expect(repo.loadShards(), '缺一片就不该认这份分片档').toBeNull();
    expect(repo.load()?.npcs, '四片不全时必须退回旧整档——把缺的表当空表就是丢数据').toEqual(s.npcs);
  });

  it('配额写满导致只写了一半：旧整档必须留着（它是唯一的回落源）', () => {
    let budget = 2; // 只放过 2 次 setItem，第 3 次起抛配额错
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (budget-- <= 0) throw new Error('QuotaExceededError');
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
      clear: () => store.clear(),
      key: () => null,
      get length() {
        return store.size;
      },
    } as unknown as Storage;
    const repo = new LocalSaveRepository();
    const s = fresh();
    repo.save(s); // 旧整档先落下来
    budget = 2;
    repo.saveShards(splitShards(s)); // 配额只放过两格：前两片（附表先写、主档最后写）
    expect(store.has(K_LEGACY), '四片没写全，旧整档不许删').toBe(true);
    /* 顺序即协议（2026-09 改序）：附表先写、主档与指纹最后写。
       配额只放过两格时，写进去的是 npcs 与 mind——主档还停在上一代的完整值上。 */
    expect(store.has(K_NPCS) && store.has(K_MIND) && !store.has(K_MAIN), '只写进了两张附表，主档没轮到').toBe(true);
    expect(store.has(K_META), '这一代没写完，指纹不许留在盘上').toBe(false);
    /* 核心保证（审查 §跨代拼接）：写了一半的档**不许**被当成完整档读回来。
       此刻四片的键都在原地（npcs 还是旧值），只看「键齐不齐」就会拼出半新半旧的档。 */
    expect(repo.loadShards(), '指纹与四片不符 → 整份分片档作废').toBeNull();
    expect(repo.load()?.npcs, '此刻唯一可信的是旧整档').toEqual(s.npcs);
  });

  it('配额写满之后的读回：抹指纹 + 主档最后写 → 盘上仍是自洽的上一代', () => {
    /* 真实现场：记忆表涨到几 MB 后 localStorage 什么都写不进去。
       旧实现「指纹先行」留下的是「新指纹 + 旧四片」——读取侧按跨代判废，
       而整档早在首代就被删了，于是启动只剩一句「没有可用的存档」。
       现在：附表先写、主档与指纹最后写，任何一片写失败都抹掉指纹，
       盘上回到「上一代四片齐全且同代」，读得回来。 */
    const repo = new LocalSaveRepository();
    const first = fresh();
    first.player.gold = 1111;
    repo.saveShards(splitShards(first)); // 第一代：四片 + 指纹齐
    expect(store.has(K_LEGACY), '分片读得回来才删旧整档').toBe(false);
    expect(repo.load()?.player.gold).toBe(1111);

    const real = (globalThis as unknown as { localStorage: Storage }).localStorage;
    let budget = 1; // 这一代只放得下一次写入
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (budget-- <= 0) throw new Error('QuotaExceededError');
        store.set(k, v);
      },
      removeItem: (k: string) => store.delete(k),
      clear: () => store.clear(),
      key: () => null,
      get length() {
        return store.size;
      },
    } as unknown as Storage;
    const next = fresh();
    next.player.gold = 2222;
    /* 让附表也变：不变的片会被「内容没变就跳过」滤掉，不消耗这一代的写入预算 */
    next.npcs.lita = { att: 5, mem: [], met: true };
    next.memories = { ...(next.memories ?? {}), player: [{ id: 'm_1', status: 'active', createdAt: 1 } as never] };
    repo.saveShards(splitShards(next));
    (globalThis as unknown as { localStorage: Storage }).localStorage = real;

    expect(repo.errorState(), '写失败要留痕').not.toBeNull();
    expect(store.has(K_META), '这一代没写成就不能留指纹').toBe(false);
    const back = repo.load();
    expect(back, '写失败不该把上一代一起带走').not.toBeNull();
    expect(back!.player.gold, '读回来的必须是上一代（1111），不是半新档').toBe(1111);
  });

  it('单个分片损坏 → 该表归零，整档不报废（hydrate 会再兜一遍）', () => {
    const repo = new LocalSaveRepository();
    const s = fresh();
    s.npcs.lita = { att: 12, mem: [], met: true };
    repo.saveShards(splitShards(s));
    store.set(K_NPCS, '{ 这不是 JSON');
    const back = repo.load();
    expect(back, '不能因为一片坏掉就交出半成品当「没有存档」').not.toBeNull();
    expect(back!.npcs).toEqual({});
    expect(back!.player).toEqual(s.player);
  });

  it('跨代拼接（主档已更新、npcs 停在上代）→ 不认这份分片档', () => {
    const repo = new LocalSaveRepository();
    const s = fresh();
    s.npcs.lita = { att: 10, mem: [], met: true };
    repo.save(s); // 旧整档在位
    repo.saveShards(splitShards(s)); // 第一代：四片 + 指纹齐 → 旧整档按设计被清
    expect(store.get(K_LEGACY), '四片写全后旧整档会被清（既有设计）').toBeUndefined();
    /* 手工造一份「第二代的半成品」：主档换成了新内容，npcs 还停在上代，指纹也停在上代——
       这正是「分批写、中途被杀」的现场（键全在，所以旧判据看不见它）。 */
    const next = fresh();
    next.player.gold = 7777;
    store.set(K_MAIN, JSON.stringify(splitShards(next).main));
    expect(repo.loadShards(), '键齐全但不同代 → 不认').toBeNull();
    expect(repo.load(), '没有整档可回落时只能报「无存档」，不许交出半新档').toBeNull();
  });

  it('分片拼出来的坏档仍被唯一闸门拦下（分片层不另开校验）', () => {
    const repo = new LocalSaveRepository();
    const s = fresh();
    repo.saveShards(splitShards(s));
    store.set(K_NPCS, JSON.stringify({ bad: { att: '不是数', mem: [], met: false } }));
    expect(repo.load(), '好感是字符串的 NPC 必须被拒').toBeNull();
  });

  it('clear 一起清分片键：否则新局第一次 save 之前会读回上一局的 npcs', () => {
    const repo = new LocalSaveRepository();
    repo.saveShards(splitShards(fresh()));
    repo.clear();
    expect(store.get(K_MAIN)).toBeUndefined();
    expect(store.get(K_NPCS)).toBeUndefined();
    expect(store.get(K_MIND)).toBeUndefined();
    expect(store.get(K_KNOW)).toBeUndefined();
  });

  it('四片写全之后才清旧整档（删早了就没有回落源了）', () => {
    const repo = new LocalSaveRepository();
    const s = fresh();
    repo.save(s);
    expect(store.has(K_LEGACY)).toBe(true);
    repo.saveShards(splitShards(s));
    expect(store.has(K_LEGACY), '四片齐了，旧整档可以走了').toBe(false);
  });
});

/* ---------------- SQLite 通道 ---------------- */

function shardDb() {
  const rows = new Map<string, string>();
  const exec: { sql: string; args: unknown[] }[] = [];
  const db: SqlDb = {
    execute: async (sql, args) => {
      exec.push({ sql, args: args ?? [] });
      if (sql.startsWith('INSERT INTO save_shards')) rows.set(String(args![0]), String(args![1]));
      if (sql.startsWith('DELETE FROM save_shards')) rows.clear();
      if (sql.startsWith('DELETE FROM saves')) rows.delete('saves');
    },
    select: async <T,>(sql: string) => {
      if (sql.includes('save_shards')) {
        return [...rows.entries()].map(([id, payload]) => ({ id, payload })) as unknown as T;
      }
      return [] as unknown as T;
    },
  };
  return { db, rows, exec };
}

describe('存档分片 · SQLite 通道', () => {
  it('分片行不全 → 不认这份分片档（缺的表会被 merge 成空表 = 丢数据）', async () => {
    const rows = new Map<string, string>();
    const db: SqlDb = {
      execute: async () => undefined,
      select: async <T,>() => [] as unknown as T,
    };
    const s = fresh();
    rows.set('main', JSON.stringify(splitShards(s).main));
    rows.set('npcs', JSON.stringify({}));
    /* 只查 save_shards 里的行：prefetchShards 是私有方法，而 open() 需要 Tauri 运行时，
       这里直接驱动那一步（同文件测试，强转访问私有成员）。 */
    const repo = new SqliteRepository(db);
    (repo as unknown as { shardStored: Record<string, string> }).shardStored = Object.fromEntries(rows);
    const done = await (repo as unknown as { prefetchShards(): Promise<boolean> }).prefetchShards();
    expect(done, '四片缺两片 → 判为没有可用的分片档').toBe(false);
    expect(repo.load()).toBeNull();
  });

  it('分片往返：镜像即时可读，落库后可从分片重新拼出完整档', async () => {
    const { db } = shardDb();
    const repo = new SqliteRepository(db);
    const s = fresh();
    s.npcs.lita = { att: 12, mem: [], met: true };
    repo.saveShards(splitShards(s));
    expect(repo.load(), '同步契约：saveShards 之后 load() 立刻能读到').toEqual(s);
    await repo.flush();
    expect(repo.loadShards()?.npcs).toEqual(s.npcs);
  });

  it('只改 npcs → 只 UPSERT npcs 一行', async () => {
    const { db, exec } = shardDb();
    const repo = new SqliteRepository(db);
    const s = fresh();
    repo.saveShards(splitShards(s));
    await repo.flush();
    exec.length = 0;
    s.npcs.lita = { att: 12, mem: [], met: true };
    repo.saveShards(splitShards(s));
    await repo.flush();
    const inserts = exec.filter((e) => e.sql.startsWith('INSERT INTO save_shards'));
    expect(inserts).toHaveLength(1);
    expect(inserts[0].args[0]).toBe('npcs');
  });

  it('写失败不吞脏数据：分片留在待写队列里，下一次 flush 自动重试', async () => {
    const rows = new Map<string, string>();
    let broken = false;
    const db: SqlDb = {
      execute: async (sql, args) => {
        if (broken && sql.startsWith('INSERT INTO save_shards')) throw new Error('disk full');
        if (sql.startsWith('INSERT INTO save_shards')) rows.set(String(args![0]), String(args![1]));
      },
      select: async <T,>() => [...rows.entries()].map(([id, payload]) => ({ id, payload })) as unknown as T,
    };
    const repo = new SqliteRepository(db);
    const s = fresh();
    broken = true;
    repo.saveShards(splitShards(s));
    await repo.flush();
    expect(repo.errorState()).toContain('disk full');
    broken = false;
    await repo.flush();
    expect(repo.errorState()).toBeNull();
    expect(rows.size, '重试之后四片齐全').toBe(4);
  });

  it('在途写窗口里的 saveShards 不会被吞（内存与落库不许静默分叉）', async () => {
    const rows = new Map<string, string>();
    let hook: (() => void) | null = null;
    const db: SqlDb = {
      execute: async (sql, args) => {
        if (!sql.startsWith('INSERT INTO save_shards')) return;
        const h = hook;
        hook = null;
        if (h) h();
        rows.set(String(args![0]), String(args![1]));
      },
      select: async <T,>() => [] as unknown as T,
    };
    const repo = new SqliteRepository(db);
    const s0 = fresh();
    s0.npcs.alpha = { att: 0, mem: [], met: true };
    repo.saveShards(splitShards(s0));
    await repo.flush();

    /* 写 npcs 的 await 窗口里又发生了一次 saveShards（内容回到 s0）。
       若「内容没变」的判定只看已落库值，这一次会被吞掉，介质停在更旧的那一份。 */
    const s1 = { ...s0, npcs: { alpha: { att: 50, mem: [], met: true } } } as WorldState;
    hook = () => repo.saveShards(splitShards(s0));
    repo.saveShards(splitShards(s1));
    await repo.flush();
    expect(JSON.parse(String(rows.get('npcs'))).alpha.att, '落库的必须是最后一次写入的值').toBe(0);
  });

  it('重置世界与写失败交错：上一局的脏分片不会被回填进新局', async () => {
    const rows = new Map<string, string>();
    let hook: (() => void) | null = null;
    let failNext = 1;
    const db: SqlDb = {
      execute: async (sql, args) => {
        if (sql.startsWith('INSERT INTO save_shards')) {
          const h = hook;
          hook = null;
          if (h) h();
          if (failNext-- > 0) throw new Error('disk full');
          rows.set(String(args![0]), String(args![1]));
          return;
        }
        if (sql.startsWith('DELETE FROM save_shards')) rows.clear();
      },
      select: async <T,>() => [] as unknown as T,
    };
    const repo = new SqliteRepository(db);
    const s = fresh();
    s.npcs.alpha = { att: 1, mem: [], met: true };
    hook = () => repo.clear(); // 「新开局」恰好发生在写失败那一刻
    repo.saveShards(splitShards(s));
    await repo.flush();
    await repo.flush();
    expect(rows.size, '重置后介质里不该还剩上一局的分片').toBe(0);

    /* 新局照常写得进去，且不带旧数据 */
    const s2 = fresh();
    s2.npcs.beta = { att: 2, mem: [], met: true };
    repo.saveShards(splitShards(s2));
    await repo.flush();
    expect(JSON.parse(String(rows.get('npcs'))).alpha, '上一局的 NPC 不该回魂').toBeUndefined();
    expect(JSON.parse(String(rows.get('npcs'))).beta.att).toBe(2);
  });

  it('分片表建不起来：静默退化为整档写入，不无限重试一个不存在的表', async () => {
    const exec: { sql: string; args: unknown[] }[] = [];
    const db: SqlDb = {
      execute: async (sql, args) => {
        exec.push({ sql, args: args ?? [] });
        if (sql.startsWith('CREATE TABLE') && sql.includes('save_shards')) throw new Error('readonly db');
      },
      select: async <T,>() => [] as unknown as T,
    };
    const repo = new SqliteRepository(db);
    await repo.ensureShardTable();
    exec.length = 0;
    repo.saveShards(splitShards(fresh()));
    await repo.flush();
    expect(exec.some((e) => e.sql.startsWith('INSERT INTO saves')), '退化路径要真的写整档').toBe(true);
    expect(exec.some((e) => e.sql.startsWith('INSERT INTO save_shards')), '不存在的表不该被反复重试').toBe(false);
  });

  it('分片写成功后清掉旧整档行（留着等于存档体积翻倍）', async () => {
    const { db, exec } = shardDb();
    const repo = new SqliteRepository(db);
    repo.saveShards(splitShards(fresh()));
    await repo.flush();
    expect(exec.some((e) => e.sql.startsWith('DELETE FROM saves'))).toBe(true);
  });
});

/* ---------------- 分发与降级 ---------------- */

describe('存档分片 · 分发', () => {
  it('介质实现分片通道 → save() 走分片；不实现 → 退化为整档', () => {
    const calls: string[] = [];
    const base: SavePort = {
      medium: 'memory',
      load: () => null,
      save: () => calls.push('save'),
      clear: () => undefined,
    };
    const shardPort: SavePort = { ...base, saveShards: () => calls.push('saveShards') };
    core.S = fresh();
    setSavePort(shardPort);
    save();
    expect(calls).toEqual(['saveShards']);

    calls.length = 0;
    setSavePort(base);
    save();
    expect(calls, '内存介质 / 测试桩没有分片通道，必须安静地退回整档').toEqual(['save']);
    core.S = null;
    setSavePort(new MemorySaveRepository());
  });
});
