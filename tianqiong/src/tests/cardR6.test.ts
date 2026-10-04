/* ============================================================
   卡 R6 · NPC 独立性（世界书 §118–§121）
   三字段数据契约 / 十档判定 / 性格化拒绝 / 人设注入
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { WB } from '@/data/worldBook';
import { core, newState } from '@/world/WorldState';
import { bus, rng, scheduler } from '@/events/EventBus';
import { ruleSim } from '@/ai/ruleSim';
import { npcDyn } from '@/systems/npc/Npcs';
import { personaBlock, REFUSE_LABEL } from '@/ai/persona';

beforeEach(() => {
  core.S = null;
  core.CB = null;
  bus.clear();
  rng.seed(17);
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  core.S = newState({ name: 'R6', race: 'human', cls: 'warrior' });
});

describe('卡 R6 · 三字段数据契约（§119–§120）', () => {
  it('每个 NPC 都有 voice / priority / refuseStyle', () => {
    for (const [id, n] of Object.entries(WB.npcs)) {
      expect(n.voice, id + '.voice').toBeTruthy();
      expect(n.priority?.length, id + '.priority').toBeGreaterThanOrEqual(2);
      expect(n.refuseStyle, id + '.refuseStyle').toBeTruthy();
    }
  });

  it('拒绝风格全部落在 §119 的六型之内', () => {
    const allowed = ['direct', 'stout', 'smooth', 'cold', 'principled', 'rational'];
    for (const [id, n] of Object.entries(WB.npcs)) {
      expect(allowed, id).toContain(n.refuseStyle);
    }
  });

  it('六型至少各有一人（性格光谱不塌成一种）', () => {
    const styles = new Set(Object.values(WB.npcs).map((n) => n.refuseStyle));
    for (const s of ['direct', 'stout', 'smooth', 'cold', 'principled', 'rational']) {
      expect([...styles], '缺风格 ' + s).toContain(s);
    }
  });

  it('六型都有中文标签（供 prompt 与 UI 直出）', () => {
    for (const s of ['direct', 'stout', 'smooth', 'cold', 'principled', 'rational']) {
      expect(REFUSE_LABEL[s], s).toBeTruthy();
    }
  });
});

describe('卡 R6 · 十档判定（§118）', () => {
  const decide = (id: string, req: { interest: number; violate?: boolean; risk?: number }) =>
    ruleSim.npcDecide(id, req).verdict;
  /* 态度写入必须走 npcDyn（WorldState.npcs 是懒初始化的动态表，直接点属性会 undefined） */
  const setAtt = (id: string, v: number) => {
    npcDyn(id, core.S!).att = v;
  };

  it('利益足够 → 答应（确定性：同输入同结果）', () => {
    const a = decide('lita', { interest: 3 });
    const b = decide('lita', { interest: 3 });
    expect(a).toBe('答应');
    expect(b).toBe(a);
  });

  it('利益中等 → 有条件是 sc=1；反提议是 sc=0（分数 = 利益×2 + 态度档 − 风险）', () => {
    /* 探针：把三档的实际取值打出来，便于失败时定位（而不是靠猜换算） */
    setAtt('lita', 0);
    const v2 = decide('lita', { interest: 1 }); // 期望 sc=2
    setAtt('lita', -30);
    const v1 = decide('lita', { interest: 1 }); // 期望 sc=1
    setAtt('lita', 0);
    const v0 = decide('lita', { interest: 0 }); // 期望 sc=0
    expect([v2, v1, v0], 'sc=2/1/0 实得：' + [v2, v1, v0].join(',')).toEqual(['答应', '有条件答应', '反提议']);
  });

  it('轻微不利 → 圆滑者给替代方案，其他人先拖一拖', () => {
    /* interest=-0.5 时 sc = -1：落在 [-1,0) 区间 */
    expect(decide('selina', { interest: -0.5, risk: 0 })).toBe('拒绝并替代'); // smooth
    expect(decide('lita', { interest: -0.5, risk: 0 })).toBe('延迟回答'); // stout
  });

  it('明显不利 → 拒绝并解释；极不利 → 沉默', () => {
    setAtt('lita', 0);
    const d = decide('lita', { interest: -1 }); // 期望 sc=-2（态度中性）
    const q = decide('lita', { interest: -9 }); // 期望 sc=-18
    expect([d, q], 'sc=-2/-18 实得：' + [d, q].join(',')).toEqual(['拒绝并解释', '沉默']);
  });

  it('触底线时按性格给不同形态的拒绝（§119 六型）', () => {
    expect(decide('reno', { interest: 5, violate: true })).toBe('反问'); // principled
    expect(decide('vandel', { interest: 5, violate: true })).toBe('质疑'); // rational
    expect(decide('ash', { interest: 5, violate: true })).toBe('沉默'); // cold
    expect(decide('lita', { interest: 5, violate: true })).toBe('拒绝'); // stout
  });

  it('十档可达：扫过全部 NPC × 三档态度，十种回答类型都取得到', () => {
    const seen = new Set<string>();
    for (const id of Object.keys(WB.npcs)) {
      for (const att of [30, 0, -30]) {
        setAtt(id, att);
        for (const interest of [3, 1, 0.5, 0, -0.5, -1, -3, -9]) {
          seen.add(decide(id, { interest }));
        }
        seen.add(decide(id, { interest: 5, violate: true }));
        seen.add(decide(id, { interest: 0, risk: 3 }));
      }
    }
    /* 十种（§118）：扫完仍缺的必须报出来，否则"十档"只是文档里的说法 */
    const missing = ['答应', '有条件答应', '延迟回答', '反提议', '拒绝', '拒绝并解释', '拒绝并替代', '沉默', '反问', '质疑'].filter(
      (v) => !seen.has(v),
    );
    expect(missing, '缺失档位：' + missing.join('/')).toEqual([]);
  });

  it('判定带出 W（利益/违规/风险/态度），供上层叙事引用', () => {
    const r = ruleSim.npcDecide('galon', { interest: 2, risk: 1 });
    expect(r.W.interest).toBe(2);
    expect(r.W.risk).toBe(1);
    expect(typeof r.W.att).toBe('number');
  });
});

describe('卡 R6 · 人设注入（§120 五要素）', () => {
  it('personaBlock 含志向/关切/底线/说话习惯/优先序/拒绝方式', () => {
    const b = personaBlock('lita');
    expect(b).toContain('志向：');
    expect(b).toContain('说话习惯：');
    expect(b).toContain('优先序：');
    expect(b).toContain('拒绝方式：');
  });

  it('不同 NPC 的人设块互不相同（不是同一套模板）', () => {
    const ids = Object.keys(WB.npcs);
    const blocks = ids.map((id) => personaBlock(id));
    expect(new Set(blocks).size).toBe(ids.length);
  });
});
