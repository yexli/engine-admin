/* ============================================================
   卡 C1 · 星枢定神 / 星阶八档 / 星符三类（世界书 §9–§13）
   本卡的核心是「定神」：入网期间本体留守，现实动作一律被拒。
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { core, newState } from '@/world/WorldState';
import { bus, rng, scheduler, worldBus } from '@/events/EventBus';
import { enterNet, exitNet, isOnline, onlineGate, sealAllowsCouncil, starRank, starRanks, starSeals } from '@/systems/starnet/StarNet';
import { go } from '@/actions/ActionExecutor';
import { npcDyn } from '@/systems/npc/Npcs';
import { setAiPort } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';

beforeEach(() => {
  core.S = null;
  core.CB = null;
  bus.clear();
  worldBus.reset();
  /* go() 内部要问 AiPort 要一句场景描述——不注册就会在门禁之后抛错 */
  setAiPort(ruleSim);
  rng.seed(41);
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  core.S = newState({ name: 'C1', race: 'human', cls: 'warrior' });
});

describe('卡 C1 · 星阶八档与星符（§11）', () => {
  it('星阶八档齐备且门槛递增', () => {
    const r = starRanks();
    expect(r.map((x) => x.name)).toEqual(['信徒', '见习', '正式', '主教', '圣徒', '神官级', '神将级', '神王级']);
    for (let i = 1; i < r.length; i++) expect(r[i].minRealLevel).toBeGreaterThan(r[i - 1].minRealLevel);
  });

  it('星阶随现实境界映射：Lv.1→信徒、Lv.3→正式、Lv.6→神官级', () => {
    const s = core.S!;
    s.player.level = 1;
    expect(starRank(s).name).toBe('信徒');
    s.player.level = 3;
    expect(starRank(s).name).toBe('正式');
    s.player.level = 6;
    expect(starRank(s).name).toBe('神官级');
  });

  it('星符三类齐备，无名星符有使用限制（不可入星殿）', () => {
    expect(starSeals().map((x) => x.id)).toEqual(['anonymous', 'named', 'ancient']);
    expect(starSeals().find((x) => x.id === 'anonymous')!.limit).toBeTruthy();
    expect(starSeals().find((x) => x.id === 'ancient')!.effect).toMatch(/一息真觉/);
  });

  it('持无名星符时入不了星殿（限制生效）', () => {
    const s = core.S!;
    expect(sealAllowsCouncil(s)).toBe(true); // 缺省连名
    (s.player as { starSeal?: string }).starSeal = 'anonymous';
    expect(sealAllowsCouncil(s)).toBe(false);
  });
});

describe('卡 C1 · 定神（§10）：入网期间本体留守', () => {
  it('未入网时门禁放行、isOnline 为假', () => {
    expect(isOnline(core.S!)).toBe(false);
    expect(onlineGate('走动')).toBeNull();
  });

  it('入网后 isOnline 为真，且门禁给出可读原因', () => {
    const s = core.S!;
    expect(enterNet()).toBe(true);
    expect(isOnline(s)).toBe(true);
    const why = onlineGate('离城远行');
    expect(why).toBeTruthy();
    expect(why).toMatch(/定神|出网/);
  });

  it('入网期间走不动：go() 被拒且位置不变', () => {
    const s = core.S!;
    expect(enterNet()).toBe(true);
    const before = s.player.loc;
    go('market');
    expect(s.player.loc).toBe(before);
  });

  it('出网后恢复行动', () => {
    const s = core.S!;
    enterNet();
    exitNet();
    expect(isOnline(s)).toBe(false);
    /* 探针：把门禁结果与位置一起报出来，失败时不必猜是哪一层挡的 */
    const why = onlineGate('走动');
    go('market');
    expect([s.player.loc, why], 'loc=' + s.player.loc + ' gate=' + String(why)).toEqual(['market', null]);
  });

  it('入网/出网各发一条世界事实（net_entered / net_exited）', () => {
    const seen: string[] = [];
    worldBus.on('net_entered', () => seen.push('in'), 'test-c1');
    worldBus.on('net_exited', () => seen.push('out'), 'test-c1');
    enterNet();
    exitNet();
    expect(seen).toEqual(['in', 'out']);
  });

  it('入网不改真身：hp/gold/位置都不动（§10 比斗无伤的精神）', () => {
    const s = core.S!;
    const snap = { hp: s.player.hp, gold: s.player.gold, loc: s.player.loc };
    enterNet();
    expect(s.player.hp).toBe(snap.hp);
    expect(s.player.gold).toBe(snap.gold);
    expect(s.player.loc).toBe(snap.loc);
  });

  it('出网禁期内再入网被拒（§10：魂念被斥出网，三日之禁）', () => {
    const s = core.S!;
    enterNet();
    exitNet();
    /* 手工制造禁期：魂念未复时再入网应被挡 */
    s.net!.exitLockUntil = s.t + 3 * 48;
    expect(enterNet()).toBe(false);
  });

  it('禁入判定：通缉过高者不许入网（§10 的精神：律法延伸入网）', () => {
    const s = core.S!;
    s.player.wanted = 3;
    expect(enterNet()).toBe(false);
  });

  it('现实 NPC 不受影响：入网不动 npc 好感与位置（定神只管本体）', () => {
    const s = core.S!;
    npcDyn('lita', s).att = 10;
    enterNet();
    expect(npcDyn('lita', s).att).toBe(10);
  });
});
