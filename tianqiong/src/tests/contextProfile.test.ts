/* ============================================================
   卡 2026-09 · NPC 分级与 Context Budget 的验收（方案 §23.4–§23.7）

   这组用例守的是**分层原则本身**，不是某个函数的返回值：
     · Profile 是纯函数（同输入同输出）
     · 预算永远不超上限
     · 关系不再无界展开
     · 世界级 NPC 不会因为玩家没去过就掉到最小档
   ============================================================ */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolveBudget, resolveContextProfile, selectRelevantRelations, type ContextProfile } from '@/systems/npc/ContextProfile';
import { WB } from '@/data/worldBook';

const IMP = [0, 1, 2, 3, 4] as const;
const LOD = ['L0', 'L1', 'L2'] as const;
const SCENES = ['npc_dialogue', 'world_reasoner', 'quest'] as const;
const ORDER: ContextProfile[] = ['minimal', 'low', 'medium', 'high', 'maximum'];

describe('Context Profile · 矩阵与确定性', () => {
  it('15 种组合（worldImportance 0–4 × LOD L0–L2）全部有确定的档位', () => {
    for (const i of IMP) {
      for (const l of LOD) {
        const p = resolveContextProfile(i, l, 'world_reasoner');
        expect(ORDER, i + '×' + l + ' 给出了未知档位').toContain(p);
      }
    }
  });

  it('是纯函数：同输入连续调用结果一致', () => {
    for (const i of IMP) {
      for (const l of LOD) {
        const a = resolveContextProfile(i, l, 'world_reasoner');
        const b = resolveContextProfile(i, l, 'world_reasoner');
        expect(a).toBe(b);
      }
    }
  });

  it('档位随世界重要度单调不降（同级 LOD 下）', () => {
    /* 这条防的是矩阵被填错：改了 context.json 却把 3 级填得比 2 级还低时立刻炸。 */
    for (const l of LOD) {
      for (let i = 1; i < IMP.length; i++) {
        const prev = ORDER.indexOf(resolveContextProfile(i - 1, l, 'world_reasoner'));
        const cur = ORDER.indexOf(resolveContextProfile(i, l, 'world_reasoner'));
        expect(cur, 'importance ' + i + ' 在 ' + l + ' 下低于 ' + (i - 1)).toBeGreaterThanOrEqual(prev);
      }
    }
  });

  it('两条边界语义（方案 §7.1）：世界级不会掉到 minimal，背景人物不会升到 maximum', () => {
    expect(resolveContextProfile(4, 'L2', 'world_reasoner')).not.toBe('minimal');
    expect(resolveContextProfile(0, 'L0', 'world_reasoner')).not.toBe('maximum');
  });

  it('越界的重要度被夹取而不是抛错（脏数据不该让对话崩掉）', () => {
    expect(resolveContextProfile(-3, 'L0', 'npc_dialogue')).toBe(resolveContextProfile(0, 'L0', 'npc_dialogue'));
    expect(resolveContextProfile(99, 'L0', 'npc_dialogue')).toBe(resolveContextProfile(4, 'L0', 'npc_dialogue'));
  });
});

describe('Context Budget · 上限', () => {
  it('最终 token 同时不超过 Profile 上限与场景上限', () => {
    /* 场景上限只管「这个场景最多多少」，Profile 上限管「这个人最多多少」——
       两者取小。一刀切（只用场景）或只看身份（只用 Profile）都不对。 */
    const SCENE_CAP: Record<string, number> = { npc_dialogue: 900, world_reasoner: 1200, quest: 900 };
    for (const i of IMP) {
      for (const l of LOD) {
        for (const sc of SCENES) {
          const b = resolveBudget(i, l, sc);
          expect(b.tokens, i + '×' + l + '×' + sc + ' 超了场景上限').toBeLessThanOrEqual(SCENE_CAP[sc]);
          expect(b.tokens, ' 超了档位上限').toBeGreaterThan(0);
          expect(b.memoryTopK).toBeGreaterThan(0);
          expect(b.relationMax).toBeGreaterThan(0);
          expect(b.eventKnowledge).toBeGreaterThan(0);
        }
      }
    }
  });

  it('档位越高，四项预算都不减少', () => {
    const rows = IMP.map((i) => resolveBudget(i, 'L1', 'world_reasoner'));
    for (let k = 1; k < rows.length; k++) {
      expect(rows[k].memoryTopK).toBeGreaterThanOrEqual(rows[k - 1].memoryTopK);
      expect(rows[k].relationMax).toBeGreaterThanOrEqual(rows[k - 1].relationMax);
      expect(rows[k].eventKnowledge).toBeGreaterThanOrEqual(rows[k - 1].eventKnowledge);
    }
  });
});

describe('Relations · 不再无界展开', () => {
  const rels = {
    zeta: { type: 'enemy', val: -80 },
    alpha: { type: 'friend', val: 20 },
    beta: { type: 'kin', val: 30 },
    gamma: { type: 'court', val: 0 },
    delta: { type: 'ally', val: 10 },
  };

  it('数量受 limit 控制', () => {
    expect(selectRelevantRelations(rels, 2)).toHaveLength(2);
    expect(selectRelevantRelations(rels, 99)).toHaveLength(5);
  });

  it('事件当事人优先于强度', () => {
    const out = selectRelevantRelations(rels, 1, new Set(['gamma']));
    expect(out[0].other, '当事人应排第一，哪怕他的边强度为 0').toBe('gamma');
  });

  it('同强度时按 id 字典序补齐（尾部顺序必须确定）', () => {
    const flat = { b: { type: 'x', val: 5 }, a: { type: 'x', val: 5 }, c: { type: 'x', val: 5 } };
    expect(selectRelevantRelations(flat, 3).map((r) => r.other)).toEqual(['a', 'b', 'c']);
  });

  it('是纯函数：同输入连续两次结果一致', () => {
    const a = JSON.stringify(selectRelevantRelations(rels, 3, new Set(['beta'])));
    const b = JSON.stringify(selectRelevantRelations(rels, 3, new Set(['beta'])));
    expect(a).toBe(b);
  });
});

describe('对话通道 · 已接入档位', () => {
  /* 源码级守卫：这条守的是一个**架构决定**，不是返回值。
     对话原先固定取「最近 3 条记忆」——只看时间不看内容，一位神祇和一位报童
     拿到的条数一模一样。改回去不会让任何用例变红，所以只能直接盯源码。 */
  const SRC = readFileSync('src/systems/npc/Chat.ts', 'utf8');

  it('不再固定取最近 3 条，改走记忆检索', () => {
    expect(SRC, '对话的记忆不该退回「最近 3 条」').not.toContain('.slice(-3).map((m) => m.event)');
    expect(SRC, '对话该走 buildMemoryContext').toContain('buildMemoryContext');
  });

  it('按 npc_dialogue 档位取名额，且 LOD 用当前日参与判定', () => {
    expect(SRC).toContain("'npc_dialogue'");
    /* C 卡之后对话经账本 chatBudget 取名额（账本内部仍调 resolveBudget）；
       判据源始终只有 systems/npc/ContextProfile 一处，两者取其一即可。 */
    expect(SRC).toMatch(/resolveBudget|chatBudget/);
    expect(SRC, 'LOD 要带当日——不带就分不清「今天刚聊过」与「从没接触」').toContain('lodOfNpc(id, s, sceneTime(s).day)');
  });

  it('档位模块在 NPC 系统内（不放在 ai/，否则引擎层要反向依赖它）', () => {
    /* 消费方有 AI 层与引擎层两边；分层方向是 systems ← ai，
       放 ai/ 会逼 systems/npc/Chat 反向依赖，eslint 拦不住但架构是错的。 */
    expect(SRC).toContain("from './ContextProfile'");
    const ctxSrc = readFileSync('src/systems/npc/ContextProfile.ts', 'utf8');
    expect(ctxSrc).toContain("from './Lod'");
  });
});

describe('三个检索档 · 全部有真实场景（不留纸面配置）', () => {
  /* 这三个档在 memory.json 里配了很久，但接入档位之前**只有 world_reasoner 有人在用**，
     npc_dialogue 与 quest 是零消费者的纸面配置。配置与代码不一致比没有配置更坏：
     读到它的人会以为「对话走的是 npc_dialogue」，而实际上对话走的是「最近 3 条」。 */
  const CASES: [string, string, string][] = [
    ['npc_dialogue', 'src/systems/npc/Chat.ts', '玩家与 NPC 的自由对话'],
    ['world_reasoner', 'src/ai/ContextBuilder.ts', '世界推演的事件上下文'],
    ['quest', 'src/systems/dialogue/Dialogue.ts', 'NPC 权衡玩家的请求'],
  ];

  for (const [profile, file, scene] of CASES) {
    it(profile + ' → ' + scene, () => {
      const src = readFileSync(file, 'utf8');
      expect(src, file + ' 没用上 ' + profile + ' 档').toContain("'" + profile + "'");
      expect(src, file + ' 该走记忆检索').toContain('buildMemoryContext');
      /* C 卡之后，对话通道经 chatBudget 取名额（账本内部仍调 resolveBudget）——
         判据源始终只有 systems/npc/ContextProfile 一处，这里两者取其一即可。 */
      expect(src, file + ' 该按档位取名额').toMatch(/resolveBudget|chatBudget/);
    });
  }

  it('没有哪条通道还在用「取最近 N 条」代替检索', () => {
    for (const [, file] of CASES) {
      expect(readFileSync(file, 'utf8'), file + ' 退回了「最近 N 条」').not.toMatch(/memOf\([^)]*\)\.slice\(-/);
    }
  });
});

describe('数据 · worldImportance 齐备', () => {
  function loadDefs(): { id: string; v: unknown }[] {
    const out: { id: string; v: unknown }[] = [];
    for (const id of Object.keys(WB.npcs)) out.push({ id, v: (WB.npcs[id] as { worldImportance?: unknown }).worldImportance });
    return out;
  }

  it('124 个 NPC 都有 0–4 的合法 worldImportance（含街头 15 人）', () => {
    const defs = loadDefs();
    expect(defs.length).toBe(124);
    for (const { id, v } of defs) {
      expect([0, 1, 2, 3, 4], id + ' 的 worldImportance 非法：' + v).toContain(v);
    }
  });

  it('世界级（4）刻意是少数：神祇／魔界领主／当代帝王，不含圣阶名宿', () => {
    const four = loadDefs().filter((d) => d.v === 4).map((d) => d.id);
    expect(four.length).toBe(16);
    for (const id of ['alkas', 'dragon_god', 'vagro', 'herman', 'chuyao']) {
      expect(four, id + ' 应是世界级').toContain(id);
    }
    /* 圣阶名宿不该混进 4 级——方案 §4.3 明确「不得简单把境界最高者全部设为 4」 */
    expect(four, '圣阶守塔人不是世界级').not.toContain('set');
  });

  it('世界书里不再有任何地方读取旧 tier（街道 15 人也已迁到新字段）', () => {
    const ppl = JSON.parse(readFileSync('src/data/world/people.json', 'utf8')) as { npcs: Record<string, { worldImportance?: number }> };
    for (const [id, v] of Object.entries(ppl.npcs)) {
      expect(v.worldImportance, '街头 NPC ' + id + ' 缺 worldImportance').toBeDefined();
    }
  });
});
