/* ============================================================
   GameCore 单元测试（确定性断言：种子随机 + 同步调度器 + 内存存档）
   运行：npm test
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { bus, core, dispatch, rng, scheduler, newGame, importState, resetWorld } from '@/world';
import { MemorySaveRepository } from '@/repo';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';
import { registerSystemSubscriptions } from '@/plugins/subscriptions';
import { canTurnIn, giveQuest, progKill, turnIn } from '@/systems/quest/Quests';
import { wantedLv, arrest, payFine } from '@/systems/law/Law';
import { WB } from '@/data/worldBook';
import { questIncome } from '@/systems/quest/Guild';
import { go } from '@/actions/ActionExecutor';
import { startCombat, playerAct } from '@/systems/combat/Combat';
import { freeAct } from '@/actions/ActionParser';
import { gainGold, addItem, removeItem, itemCount } from '@/systems/character/Gains';

let restoreRng: () => void = () => {};

beforeEach(() => {
  core.S = null;
  core.CB = null;
  resetWorld();
  setSavePort(new MemorySaveRepository());
  setAiPort(ruleSim);
  bus.clear();
  restoreRng?.();
  restoreRng = rng.seed(42);
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  /* §21/§34：击杀推进委托等跨系统响应已改为事件驱动 —— 未装配订阅层的测试
     会看到「事件发出了但没人响应」，故此处与组合根保持一致地装配订阅。 */
  registerSystemSubscriptions();
});

const start = (name = '测试者', race = 'dwarf', cls = 'warrior') => newGame({ name, race, cls });

describe('新角色与派生数值', () => {
  it('矮人战士：力量 10+1(种族)+2(职业)=13，HP/MP 满值', () => {
    start();
    const s = core.S!;
    expect(s.player.stats['力量']).toBe(13);
    expect(s.player.stats['体质']).toBe(14);
    expect(s.player.hp).toBeGreaterThan(0);
    expect(s.player.level).toBe(1);
    expect(s.player.gold).toBe(5000); // 卡 T3：起始资金 600 → 5000
  });
  it('职业初始技能与装备来自世界书 gear/skill 字段', () => {
    start('测试者', 'human', 'mage');
    const s = core.S!;
    expect(s.player.skills).toEqual(['firebolt']);
    expect(s.player.equip.wpn).toBe('staff_appr');
  });
});

describe('时间与世界日历', () => {
  it('推进 48 刻进入第 2 日：商队被袭事件 → 药价 1.5 → flag 生效', () => {
    start();
    const s = core.S!;
    for (let i = 0; i < 48; i++) dispatch({ type: 'sceneAction', k: 'observe' });
    // observe 每次 +1 刻（检定同步跑完）
    expect(Math.floor(s.t / 48) + 1).toBeGreaterThanOrEqual(2);
    expect(s.events.some((e) => e.id === 'caravan_evt')).toBe(true);
    expect(s.econ.herb).toBe(1.5);
    expect(s.player.flags.caravan_evt).toBe(true);
  });
});

describe('移动与规则校验', () => {
  it('不可直达的目的地被拒绝且不动状态', () => {
    start();
    const before = core.S!.player.loc;
    go('cave3');
    expect(core.S!.player.loc).toBe(before);
  });
  it('广场→酒馆耗时 1 刻', () => {
    start();
    const t0 = core.S!.t;
    go('tavern');
    expect(core.S!.t).toBe(t0 + 1);
    expect(core.S!.player.loc).toBe('tavern');
  });
});

describe('任务链', () => {
  it('猎兔令：击杀 3 只角兔后可复命，奖励入账', () => {
    start();
    giveQuest('q_rabbit');
    expect(canTurnIn('q_rabbit')).toBe(false);
    progKill('rabbit');
    progKill('rabbit');
    expect(core.S!.player.quests.q_rabbit.stage).toBe('go');
    progKill('rabbit');
    expect(core.S!.player.quests.q_rabbit.stage).toBe('done');
    expect(canTurnIn('q_rabbit')).toBe(true);
    const g0 = core.S!.player.gold;
    turnIn('q_rabbit');
    expect(core.S!.player.quests.q_rabbit.stage).toBe('fin');
    /* 卡 T3：奖励数额从数据读——价格/奖励调标定时不该把测试再改一遍。
       卡 R5：经公会分账的委托抽 10%，实收走同一函数（两处算法不许各写一份）。 */
    expect(core.S!.player.gold).toBe(g0 + questIncome(WB.quests.q_rabbit.reward!.gold as number, 'q_rabbit'));
    expect(core.S!.rep.guild).toBe(10);
  });
});

describe('法律与通缉', () => {
  it('通缉等级封顶 3 级；逮捕后押至城门、罚金递增、案底+1', () => {
    start();
    wantedLv(2, '当街行凶');
    wantedLv(2, '再犯');
    expect(core.S!.player.wanted).toBe(3);
    const gold0 = core.S!.player.gold;
    arrest();
    const s = core.S!;
    expect(s.player.wanted).toBe(0);
    expect(s.player.crimes).toBe(5); // wantedLv 两次各+2 与案底累计 + arrest 自增 1
    expect(s.player.gold).toBeLessThanOrEqual(gold0);
    expect(s.player.loc).toBe('gate');
  });
  it('缴罚金销案', () => {
    start();
    wantedLv(1, '集市行窃');
    expect(payFine()).toBe(true);
    expect(core.S!.player.wanted).toBe(0);
  });
});

describe('战斗引擎', () => {
  it('击杀狼后：经验入账、killed 计数、任务进度联动', () => {
    start();
    giveQuest('q_rabbit');
    startCombat(['rabbit']);
    const CB = core.CB!;
    CB.foes[0].hp = 1; // 加速击杀路径
    /* Phase 2 之后随机流长度变了（目击抽样不再消耗它），「第几个值」不再稳定；
       这里显式固定流，让「命中即杀」与流的位置无关。 */
    const restoreHit = rng.inject(() => 0.99);
    playerAct('atk'); // 命中即杀；同步调度器下 endPhase/victory 连跑
    restoreHit();
    expect(CB.over || core.CB === null).toBe(true);
    expect(core.S!.killed.rabbit).toBe(1);
    expect(core.S!.player.quests.q_rabbit.count).toBe(1);
    expect(core.S!.player.exp).toBeGreaterThanOrEqual(8);
  });
});

describe('经济背包', () => {
  it('金币不为负；道具堆叠与移除', () => {
    start();
    gainGold(-100000);
    expect(core.S!.player.gold).toBe(0);
    addItem('bread', 2);
    expect(itemCount('bread')).toBe(2);
    addItem('bread');
    expect(itemCount('bread')).toBe(3);
    removeItem('bread', 3);
    expect(itemCount('bread')).toBe(0);
  });
});

describe('意图解析器', () => {
  it('「看看有没有人盯着我」→ 观察意图入日志', () => {
    start();
    freeAct('看看有没有人盯着我');
    expect(core.S!.log.some((l) => l.text === '〔意图解析〕观察')).toBe(true);
  });
  it('无法识别时回提示且不改变位置', () => {
    start();
    const loc = core.S!.player.loc;
    freeAct('对着月亮唱赞歌');
    expect(core.S!.player.loc).toBe(loc);
    expect(core.S!.log.some((l) => l.text.startsWith('〔意图解析〕'))).toBe(true);
  });
  it('LLM 意图通道优先，命中则标注 ·LLM', async () => {
    const { gateway } = await import('@/ai/gateway');
    const { ruleSim } = await import('@/ai/ruleSim');
    const { freeActSmart } = await import('@/actions/ActionParser');
    start();
    gateway.use({ ...ruleSim, intentAsync: async () => ({ intent: 'observe' }) });
    await freeActSmart('随便说点什么话');
    gateway.use(ruleSim);
    expect(core.S!.log.some((l) => l.text === '〔意图解析·LLM〕观察')).toBe(true);
  });
  /* —— 自由行动 2a：参数包 + go 意图（G1-G6）—— */
  it('2a 降级同构：正则通道「走进酒馆」真移动且 chip 挂目的地', () => {
    start();
    freeAct('走进酒馆');
    expect(core.S!.player.loc).toBe('tavern');
    expect(core.S!.log.some((l) => l.text === '〔意图解析〕前往→银鸥酒馆')).toBe(true);
  });
  it('2a 降级同构：正则通道「问米露……」点名对象并回响话题', () => {
    start();
    freeAct('问米露报纸多少钱');
    expect(core.S!.log.some((l) => l.text === '〔意图解析〕打听·米露')).toBe(true);
    expect(core.S!.log.some((l) => l.text.includes('你向米露打听「报纸多少钱」'))).toBe(true);
  });
  it('2a target 缺席反馈：不回落首位在场', async () => {
    const { gateway } = await import('@/ai/gateway');
    const { ruleSim } = await import('@/ai/ruleSim');
    const { freeActSmart } = await import('@/actions/ActionParser');
    start();
    gateway.use({ ...ruleSim, intentAsync: async () => ({ intent: 'askinfo', target: '布伦丹' }) });
    await freeActSmart('向布伦丹打听消息'); // 广场：布伦丹不在场（在场仅米露）
    gateway.use(ruleSim);
    expect(core.S!.log.some((l) => l.text.includes('「布伦丹」不在这里'))).toBe(true);
    expect(core.S!.log.some((l) => l.text.includes('你向米露'))).toBe(false);
  });
  it('2a dest 越界（LLM 伪造不存在地点）→ 不移动', async () => {
    const { gateway } = await import('@/ai/gateway');
    const { ruleSim } = await import('@/ai/ruleSim');
    const { freeActSmart } = await import('@/actions/ActionParser');
    start();
    gateway.use({ ...ruleSim, intentAsync: async () => ({ intent: 'go', dest: '不存在之地' }) });
    await freeActSmart('去不存在之地');
    gateway.use(ruleSim);
    expect(core.S!.player.loc).toBe('plaza');
    expect(core.S!.log.some((l) => l.text.includes('不在街巷图里'))).toBe(true);
  });
  it('2a focus 回响：观察焦点入叙事', () => {
    start();
    freeAct('观察有没有人盯着我');
    expect(core.S!.log.some((l) => l.text === '你凝神分辨：「有没有人盯着我」。')).toBe(true);
  });
  /* —— 自由行动 2b：顺序分解 steps≤3 —— */
  it('2b 复合句正则切段：「走进酒馆，观察有没有人盯着我」两步顺序执行', () => {
    start();
    freeAct('我走进酒馆，观察有没有人盯着我');
    expect(core.S!.player.loc).toBe('tavern'); // step1 真移动
    expect(core.S!.log.some((l) => l.text === '〔意图解析〕前往→银鸥酒馆')).toBe(true);
    expect(core.S!.log.some((l) => l.text === '〔意图解析〕观察')).toBe(true); // step2 在新地点观察
    expect(core.S!.log.some((l) => l.text === '你凝神分辨：「有没有人盯着我」。')).toBe(true);
  });
  it('2b LLM steps 通道：逐步执行各标 ·LLM', async () => {
    const { gateway } = await import('@/ai/gateway');
    const { ruleSim } = await import('@/ai/ruleSim');
    const { freeActSmart } = await import('@/actions/ActionParser');
    start();
    gateway.use({
      ...ruleSim,
      intentAsync: async () => ({
        intent: 'go',
        dest: 'tavern',
        steps: [{ intent: 'go', dest: 'tavern' }, { intent: 'observe', focus: '有没有人盯着我' }],
      }),
    });
    await freeActSmart('走进酒馆观察一下');
    gateway.use(ruleSim);
    expect(core.S!.player.loc).toBe('tavern');
    expect(core.S!.log.some((l) => l.text === '〔意图解析·LLM〕前往→银鸥酒馆')).toBe(true);
    expect(core.S!.log.some((l) => l.text === '〔意图解析·LLM〕观察')).toBe(true);
  });
  it('2b steps 越界伪造：非法步丢弃，只执行合法首步', async () => {
    const { gateway } = await import('@/ai/gateway');
    const { ruleSim } = await import('@/ai/ruleSim');
    const { freeActSmart } = await import('@/actions/ActionParser');
    start();
    gateway.use({
      ...ruleSim,
      intentAsync: async () => ({
        intent: 'observe',
        steps: [{ intent: 'observe' }, { intent: 'hack_the_game' }], // 第二步越界
      }),
    });
    await freeActSmart('观察四周');
    gateway.use(ruleSim);
    expect(core.S!.player.loc).toBe('plaza'); // 越界步未产生任何移动/后果
    expect(core.S!.log.filter((l) => l.text.startsWith('〔意图解析·LLM〕')).length).toBe(1);
  });
});

describe('存档管线', () => {
  it('newGame→save→load→importState 往返一致', () => {
    start('存档人');
    const s0 = JSON.parse(JSON.stringify(core.S!));
    resetWorld();
    core.S = null;
    expect(importState(JSON.stringify(s0))).toBe(true);
    expect(core.S!.player.name).toBe('存档人');
  });
});
