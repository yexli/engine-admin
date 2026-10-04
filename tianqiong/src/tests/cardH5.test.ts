/* ============================================================
   卡 H5 · 百年神选事件链：阶段递进 / 报名前置 / 确定性名次 /
   D4 链幂等 / 跨大陆观战 / H6 终局钩子 / 迁移降级
   确定性：种子随机 + 同步调度器 + 内存存档。
   ============================================================ */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { core, rng, scheduler, bus } from '@/world';
import { newGame } from '@/world/WorldRuntime';
import { hydrate } from '@/world/WorldState';
import { MemorySaveRepository } from '@/repo';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';
import {
  THEOSELECT,
  ensureTheoselect,
  enroll,
  enrollBlock,
  evaluate,
  playerRank,
  rewardFor,
  rivalName,
  setAscendHook,
  spectate,
  stageAdvance,
  stageNames,
  standings,
  templeFavor,
  theoselectMenu,
  theoselectTick,
  theoselectView,
} from '@/systems/religion/Theoselect';
import { enterNet } from '@/systems/starnet/StarNet';
import { ALL_EVENTS } from '@/events/EventProcessor';
import { advance } from '@/world/WorldClock';
import { registerDaySettle } from '@/plugins/daySettle';

let offDay: () => void;

beforeEach(() => {
  core.S = null;
  core.CB = null;
  bus.clear();
  setSavePort(new MemorySaveRepository());
  setAiPort(ruleSim);
  rng.seed(97);
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  newGame({ name: 'H5', race: 'human', cls: 'warrior' });
  setAscendHook(null as unknown as (n: string) => boolean); // 每例复位钩子
  /* §27：日边界结算走 new_day 订阅（WorldClock 不再内联日 tick）——
     订阅式装配的固有前提：不装配就没人响应，这里显式补上并逐例退订。 */
  offDay = registerDaySettle();
});

afterEach(() => {
  offDay();
});

const S = () => core.S!;
const TS = () => ensureTheoselect(S());

/** 满足报名条件并开启本届 */
const ready = (temple = 'war') => {
  const s = S();
  s.player.flags.theoselect_open = true;
  s.player.level = 4;
  s.player.gold = 1000;
  s.favor = { war: { favor: 45, rank: '信仰者' }, wisdom: { favor: 45, rank: '信仰者' }, life: { favor: 45, rank: '信仰者' } };
  return enroll(temple);
};

describe('卡 H5 · 神选 canon 数据一致性', () => {
  it('周期 100 年、612 年首届、五神殿与 §4 一致', () => {
    expect(THEOSELECT.cycle).toBe(100);
    expect(THEOSELECT.currentCycle).toBe(612);
    expect(THEOSELECT.temples.map((t) => t.id)).toEqual(['war', 'wisdom', 'life', 'death', 'chaos']);
  });
  it('五阶段顺序与名额对齐 canon：海选100 → 预选10 → 正赛3 → 神战1 → 候补', () => {
    expect(stageNames()).toEqual(['海选', '预选', '正赛', '神战', '候补']);
    const q = Object.fromEntries(THEOSELECT.stages.map((s) => [s.id, s.quota]));
    expect(q['海选']).toBe(100);
    expect(q['预选']).toBe(10);
    expect(q['正赛']).toBe(3);
    expect(q['神战']).toBe(1);
  });
  it('奖励档与 §4 寿命延长对齐（4-8名+300 / 9-16名+200 / 17-50名+100 / 51-100名+50）', () => {
    expect(rewardFor(1)!.lifespan).toBe(800);
    expect(rewardFor(3)!.lifespan).toBe(500);
    expect(rewardFor(5)!.lifespan).toBe(300);
    expect(rewardFor(12)!.lifespan).toBe(200);
    expect(rewardFor(30)!.lifespan).toBe(100);
    expect(rewardFor(80)!.lifespan).toBe(50);
    expect(rewardFor(undefined)).toBeUndefined();
  });
  it('信仰职业路线与 §37 逐字一致', () => {
    const paths = Object.fromEntries(THEOSELECT.temples.map((t) => [t.id, t.path]));
    expect(paths.war).toEqual(['信仰者', '神恩骑士', '圣战使徒', '【神之右臂】']);
    expect(paths.wisdom).toEqual(['信仰者', '神谕祭司', '启示先知', '【真理之眼】']);
    expect(paths.life).toEqual(['信仰者', '神愈圣女', '救赎天使', '【神之悲悯】']);
    expect(paths.death).toEqual(['信仰者', '终焉使者', '轮回看守', '【冥河渡者】']);
    expect(paths.chaos).toEqual(['信仰者', '狂信者', '末日先驱', '【神罚执行者】']);
  });
  it('D4 事件链三条事件定义存在（announce / stage_end / ascend）', () => {
    for (const id of [THEOSELECT.chain.announceEvent, THEOSELECT.chain.stageEndEvent, THEOSELECT.chain.finalEvent])
      expect(ALL_EVENTS.some((e) => e.id === id), id).toBe(true);
  });
});

describe('卡 H5 · 保底开启与报名前置', () => {
  it('首届第 1 日保底开启，并广播 announce 事件（幂等）', () => {
    const s = S();
    s.t = 47; // 下一 tick 即跨日
    theoselectTick(s);
    expect(s.player.flags.theoselect_open).toBe(true);
    expect(s.events.some((e) => e.id === THEOSELECT.chain.announceEvent)).toBe(true);
    const n = s.events.length;
    theoselectTick(s);
    expect(s.events.length).toBe(n); // 幂等：不重复广播
  });
  it('境界不足 / 神明偏好不足 / 金币不足 三档拒绝', () => {
    const s = S();
    s.player.flags.theoselect_open = true;
    s.player.level = 1;
    expect(enrollBlock('war', s)).toContain('境界不足');
    s.player.level = 4;
    s.favor = {};
    expect(enrollBlock('war', s)).toContain('香火不足');
    s.favor = { war: { favor: 50, rank: '信仰者' } };
    s.player.gold = 0;
    expect(enrollBlock('war', s)).toContain('金币');
    s.player.gold = 1000;
    expect(enrollBlock('war', s)).toBe('');
  });
  it('报名期外拒绝；未开启时拒绝', () => {
    const s = S();
    s.player.level = 4;
    s.player.gold = 1000;
    s.favor = { war: { favor: 50, rank: '信仰者' } };
    expect(enrollBlock('war', s)).toContain('尚未开启');
    s.player.flags.theoselect_open = true;
    TS().stage = '神战';
    expect(enrollBlock('war', s)).toContain('报名期已过');
  });
  it('报名成功：扣金币、入名册、评分落库、入历史；重复报名被拒', () => {
    const s = S();
    s.player.flags.theoselect_open = true;
    s.player.level = 4;
    s.player.gold = 700;
    s.favor = { war: { favor: 45, rank: '信仰者' } };
    expect(enroll('war')).toBe(true);
    expect(s.player.gold).toBe(700 - THEOSELECT.enroll.costGold);
    expect(TS().enrolled).toBe(true);
    expect(TS().temple).toBe('war');
    expect(TS().candidates!.some((c) => c.npcId === 'player')).toBe(true);
    expect(s.history.some((h) => h.c.includes('报名百年神选'))).toBe(true);
    expect(ready('life')).toBe(false);
    expect(enrollBlock('life', s)).toContain('名册上');
  });
  it('templeFavor 读 H6 deity 域（H6 未落地时为 0，不崩）', () => {
    const s = S();
    expect(templeFavor('war', s)).toBe(0);
    s.favor = { war: { favor: 33, rank: '信仰者' } };
    expect(templeFavor('war', s)).toBe(33);
    expect(templeFavor('nope', s)).toBe(0);
  });
});

describe('卡 H5 · 阶段递进（海选→预选→正赛→神战→候补）', () => {
  it('阶段按序推进，候补阶段定局后不再推进', () => {
    const s = S();
    ready('war');
    const seen = [TS().stage];
    for (let i = 0; i < 5; i++) {
      s.t += 200;
      TS().stageEndsAt = s.t - 1;
      stageAdvance(s);
      seen.push(TS().stage);
    }
    expect(seen.slice(0, 5)).toEqual(['海选', '预选', '正赛', '神战', '候补']);
    expect(TS().stage).toBe('候补');
    expect(stageAdvance(s)).toBe(false); // 已定局
  });
  it('幂等：同刻只结算一次', () => {
    const s = S();
    ready('war');
    s.t += 200;
    TS().stageEndsAt = s.t - 1;
    expect(stageAdvance(s)).toBe(true);
    const st = TS().stage;
    expect(stageAdvance(s)).toBe(false);
    expect(TS().stage).toBe(st);
  });
  it('未到期不推进', () => {
    const s = S();
    ready('war');
    TS().stageEndsAt = s.t + 1000;
    expect(stageAdvance(s)).toBe(false);
  });
  it('海选走分数线：低于 cut 落选并 disqualify', () => {
    const s = S();
    ready('war');
    TS().score = 0; // 低于 cut=30
    s.t += 200;
    TS().stageEndsAt = s.t - 1;
    stageAdvance(s);
    expect(TS().disqualified).toBe(true);
    expect(TS().stage).toBe('预选'); // 世界照常推进，只是你出局
    expect(s.theoselect!.candidates!.some((c) => c.npcId === 'player')).toBe(false);
    expect(enrollBlock('war', s)).toContain('出局');
  });
  it('神战终局：名次落库 + 奖励入历史 + 前 3 名受封候补神 flag', () => {
    const s = S();
    ready('war');
    TS().score = 9999; // 稳居第一
    for (let i = 0; i < 4; i++) {
      s.t += 200;
      TS().stageEndsAt = s.t - 1;
      stageAdvance(s);
    }
    expect(TS().stage).toBe('候补');
    expect(TS().rank).toBe(1);
    expect(s.player.flags.theoselect_champion).toBe(true);
    expect(s.player.flags.theoselect_candidate_god).toBe(true);
    expect(s.history.some((h) => h.c.includes('百年神选定座次'))).toBe(true);
    expect(TS().champion).toBe('player');
  });
});

describe('卡 H5 · 评分与名次确定性', () => {
  it('同 seed 同结果；评分随地下城深度 / 声望 / 神明偏好单调不降', () => {
    const s = S();
    s.theoselect = { enrolled: true, temple: 'war', stage: '海选', score: 0 };
    ensureTheoselect(s); // 先让候选池播种完成，再固定随机序列
    rng.seed(4242);
    const a = evaluate(s);
    rng.seed(4242);
    expect(evaluate(s)).toBe(a);
    s.dungeon = { floor: 0, best: 90, inRun: false };
    rng.seed(4242);
    expect(evaluate(s)).toBeGreaterThan(a);
    s.rep.war = 0;
    s.rep.temple = 80;
    s.favor = { war: { favor: 100, rank: '信仰者' } };
    rng.seed(4242);
    expect(evaluate(s)).toBeGreaterThan(a);
  });
  it('名次盘：按分数降序，同分按 id 稳定排序（确定性）', () => {
    const s = S();
    const t = ensureTheoselect(s);
    t.candidates = [
      { npcId: 'b', temple: 'war', score: 10 },
      { npcId: 'a', temple: 'war', score: 10 },
      { npcId: 'c', temple: 'war', score: 30 },
    ];
    expect(standings(s).map((c) => c.npcId)).toEqual(['c', 'a', 'b']);
    expect(standings(s).map((c) => c.npcId)).toEqual(standings(s).map((c) => c.npcId));
  });
  it('玩家不在册时 playerRank 返回 undefined；在册时反映真实名次', () => {
    const s = S();
    expect(playerRank(s)).toBeUndefined();
    ready('war');
    TS().score = 0;
    const r = playerRank(s)!;
    expect(r).toBeGreaterThanOrEqual(1);
    TS().score = 99999;
    expect(playerRank(s)).toBe(1);
  });
  it('rivalName 命中世界书 NPC 名；玩家显示为（你）', () => {
    expect(rivalName('lita')).toBeTruthy();
    expect(rivalName('lita')).not.toBe('lita');
    expect(rivalName('player')).toBe('（你）');
    expect(rivalName('unknown_x')).toBe('unknown_x');
  });
});

describe('卡 H5 · 跨大陆观战（星枢五塔 · 星斗台）', () => {
  it('未入网拒绝观战', () => {
    const s = S();
    s.player.flags.theoselect_open = true;
    expect(spectate()).toBe(false);
  });
  it('入网 + 星币足够：扣星币、出见闻（含前十评分盘）、入历史', () => {
    const s = S();
    s.player.flags.theoselect_open = true;
    enterNet();
    s.net!.starcoin = 50;
    expect(spectate()).toBe(true);
    expect(s.net!.starcoin).toBe(50 - THEOSELECT.spectate.costStarcoin);
    expect(s.log.some((x) => x.text.includes('星斗台的观战席'))).toBe(true);
    expect(s.history.some((h) => h.c.includes('星符观战'))).toBe(true);
  });
  it('星币不足拒绝且不扣款', () => {
    const s = S();
    s.player.flags.theoselect_open = true;
    enterNet();
    s.net!.starcoin = 1;
    expect(spectate()).toBe(false);
    expect(s.net!.starcoin).toBe(1);
  });
  it('本届未开启时拒绝观战', () => {
    const s = S();
    enterNet();
    s.net!.starcoin = 100;
    expect(spectate()).toBe(false);
  });
});

describe('卡 H5 · H6 终局钩子与视图', () => {
  it('ascendCandidate 钩子被神战终局调用（H6 就位时）', () => {
    const s = S();
    const called: string[] = [];
    setAscendHook((id) => {
      called.push(id);
      return true;
    });
    ready('war');
    TS().score = 9999;
    for (let i = 0; i < 4; i++) {
      s.t += 200;
      TS().stageEndsAt = s.t - 1;
      stageAdvance(s);
    }
    expect(called.length).toBe(1);
    expect(called[0]).toBe('player');
  });
  it('钩子缺失/抛错时走保底 flag，不崩（H6 未落地也成立）', () => {
    const s = S();
    setAscendHook(() => {
      throw new Error('H6 未就位');
    });
    ready('war');
    TS().score = 9999;
    for (let i = 0; i < 4; i++) {
      s.t += 200;
      TS().stageEndsAt = s.t - 1;
      expect(() => stageAdvance(s)).not.toThrow();
    }
    expect(s.player.flags.theoselect_ascended).toBe(true);
  });
  it('theoselectView 是纯数据：字段齐备、倒计时非负、排名盘有前十', () => {
    const s = S();
    ready('war');
    const v = theoselectView(s);
    expect(v.open).toBe(true);
    expect(v.stage).toBe('海选');
    expect(v.enrolled).toBe(true);
    expect(v.templeName).toBe('战争神殿');
    expect(v.daysLeft).toBeGreaterThanOrEqual(0);
    expect(v.top.length).toBeGreaterThan(0);
    expect(v.top.every((x) => x.rank >= 1 && typeof x.name === 'string')).toBe(true);
    expect(() => theoselectMenu()).not.toThrow();
  });
  it('菜单在未开启 / 已出局 / 已报名三态下均可渲染', () => {
    const s = S();
    expect(() => theoselectMenu()).not.toThrow();
    s.player.flags.theoselect_open = true;
    expect(() => theoselectMenu()).not.toThrow();
    ready('war');
    expect(() => theoselectMenu()).not.toThrow();
    TS().disqualified = true;
    TS().enrolled = true;
    expect(() => theoselectMenu()).not.toThrow();
  });
  it('关 AI 成立：所有 seed 化文本无未替换占位符', () => {
    const s = S();
    ready('war');
    stageAdvance(s);
    for (const e of s.log) expect(e.text).not.toContain('{');
    for (const ev of ALL_EVENTS.filter((x) => x.id.startsWith('theoselect'))) expect(ev.seed).not.toContain('{');
  });
});

describe('卡 H5 · 迁移与降级', () => {
  it('旧档缺 theoselect：hydrate 补默认、不崩', () => {
    const s = S();
    delete (s as unknown as Record<string, unknown>).theoselect;
    hydrate(s);
    expect(s.theoselect).toBeTruthy();
    expect(s.theoselect!.enrolled).toBe(false);
    expect(s.theoselect!.stage).toBe('海选');
    expect(() => theoselectView()).not.toThrow();
  });
  it('旧档 theoselect 缺 candidates/cycle：ensureTheoselect 懒初始化', () => {
    const s = S();
    s.theoselect = { enrolled: false, stage: '海选', score: 0 };
    const t = ensureTheoselect(s);
    expect(t.cycle).toBe(612);
    expect(Array.isArray(t.candidates)).toBe(true);
    expect(t.candidates!.length).toBeGreaterThan(0);
  });
  it('阶段 id 非法时回落海选（手改档防御）', () => {
    const s = S();
    s.theoselect = { enrolled: false, stage: '不存在', score: 0 };
    expect(ensureTheoselect(s).stage).toBe('海选');
  });
});

describe('卡 H5 · 链事件只由阶段推进主动触发（F-05）', () => {
  const chainCount = () =>
    S().events.filter((e) => e.id.startsWith('theoselect_stage_end') || e.id.startsWith('theoselect_ascend')).length;

  it('开幕后连续推进数日：链事件实例不累积，声望不逐日上涨', () => {
    const s = S();
    advance(48 * 2); // 第 1 日开启本届（theoselect_open）
    expect(s.player.flags.theoselect_open).toBe(true);
    expect(chainCount()).toBe(0); // manual 触发：World Director 不再扫这两条
    const rep0 = s.rep.temple;
    const day0 = chainCount();
    advance(48 * 5);
    expect(chainCount()).toBe(0);
    expect(day0).toBe(0);
    expect(s.rep.temple).toBe(rep0); // 不再每天白送声望
  });

  it('stageAdvance 主动调用仍能触发一次且幂等（功能没被改死）', () => {
    const s = S();
    const t = TS();
    advance(48 * 2);
    s.player.flags.theoselect_open = true;
    t.stageEndsAt = s.t; // 到期即结算
    expect(stageAdvance(s)).toBe(true);
    expect(s.events.filter((e) => e.id === 'theoselect_stage_end').length).toBe(1);
    advance(1); // 换一刻——同刻只结算一次是既有幂等门，不是缺陷
    t.stageEndsAt = s.t;
    expect(stageAdvance(s)).toBe(true);
    expect(s.events.filter((e) => e.id === 'theoselect_stage_end').length).toBe(1); // 事件自身仍幂等
  });
});

describe('卡 H5 · 阶段地点为可展示中文（F-29）', () => {
  it('stageLocName 非内部代号，且五个阶段全部可读', () => {
    const s = S();
    const ids = ['海选', '预选', '正赛', '神战', '候补'];
    for (const id of ids) {
      s.theoselect = { enrolled: false, stage: id, score: 0 };
      const v = theoselectView(s);
      expect(v.stageLocName, id).toBeTruthy();
      expect(v.stageLocName, id).not.toMatch(/^[a-z0-9_]+$/); // 不是 dungeon_deep / star5 这类内部 id
      expect(v.stageLocName, id).toMatch(/[\u4e00-\u9fa5]/);
    }
  });
});
