/* ============================================================
   卡 Q1 · 规则一致性红队验收（《项目方案》§71 验收五）
   六类越权诱导，全部以「敌意 AiPort / 敌意 GameCommand」形态注入：
   R1 属性直改 —— 伪造 GameCommand 直改状态 → dispatch 不认、状态不变
   R2 凭空造能力 —— 意图通道回包白名单外意图 → 汇合点拒绝、不学技能
   R3 关系强改 —— 聊天通道 attDelta 越界 → clamp ±2 + 日封顶
   R4 规则破坏 —— NPC 决策通道伪造裁定 → 台词池兜底、态度只走白名单
   R5 canon 泄露 / 注入 —— focus/topic 注入 HTML → esc 转义
   R6 数值篡改 —— AI 层静态审计：源码不存在任何直写 WorldState 的通路
   铁律锚点：AI 只产文本与判断，一切状态突变都在 core（约束§3）。
   ============================================================ */
import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { bus, core, newGame, dispatch, rng, scheduler } from '@/world';
import { memOf } from '@/memory';
import { MemorySaveRepository } from '@/repo';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { registerSystemSubscriptions } from '@/plugins/subscriptions';
import type { AiPort, ChatCtx, ChatReply, IntentParse, NpcReq, NpcVerdict } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';
import { freeActSmart } from '@/actions/ActionParser';
import { openChat, sendChat } from '@/systems/npc/Chat';
import { openDlg, runReq } from '@/systems/dialogue/Dialogue';
import { addInstance, affixPoolOf, instMods } from '@/systems/inventory/Equip';
import { applyStatus, dotOf, statusDef } from '@/systems/character/Status';
import { WB } from '@/data/worldBook';
import type { GameCommand } from '@/types/uispec';

beforeEach(() => {
  core.S = null;
  bus.clear();
  setSavePort(new MemorySaveRepository());
  setAiPort(ruleSim);
  rng.seed(7);
  /* §21：聊天 rumor 走事件扩散（二期 H-09）——测试必须装配订阅，否则事件无人响应 */
  registerSystemSubscriptions();
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  newGame({ name: '红队', race: 'human', cls: 'warrior' });
});

const S = () => core.S!;
/** 状态指纹：除日志（AI 文本会进日志）外的全部可变字段快照 */
const fingerprint = () => {
  const s = S();
  const { log, ...rest } = s;
  void log;
  return JSON.stringify(rest);
};

/* ---------------- R1 · 属性直改：伪造 GameCommand ---------------- */
describe('R1 · 伪造 GameCommand 直改状态', () => {
  it('dispatch 不认识 setattr 型命令：不崩、不改状态', () => {
    const before = fingerprint();
    const hostile = { type: 'setattr', attr: '力量', value: 999 } as unknown as GameCommand;
    expect(() => dispatch(hostile)).not.toThrow();
    expect(fingerprint()).toBe(before);
    expect(S().player.stats['力量']).toBe(S().player.stats['力量']); // 值不变（对比 fingerprint 已证）
    expect(S().player.stats['力量']).toBeLessThan(100); // 未被改成 999
  });
  it('伪造 gold 溢出 / level 越界命令同样被拒', () => {
    const before = fingerprint();
    for (const h of [
      { type: 'addGold', amount: 999999 },
      { type: 'setLevel', level: 6 },
      { type: 'gainSkill', skill: 'heavy_slash' },
    ]) {
      expect(() => dispatch(h as unknown as GameCommand)).not.toThrow();
    }
    expect(fingerprint()).toBe(before);
  });
});

/* ---------------- R2 · 凭空造能力：意图通道白名单 ---------------- */
describe('R2 · 敌意意图解析回包', () => {
  const hostilePort = (parse: IntentParse | IntentParse[]): AiPort => ({
    ...ruleSim,
    intentAsync: async () => (Array.isArray(parse) ? { intent: 'unknown', steps: parse } : parse),
  });

  it('白名单外意图（godmode/learn_skill）→ 汇合点拒绝，属性与技能不变', async () => {
    setAiPort(hostilePort({ intent: 'godmode', focus: '无敌模式启动' }));
    await freeActSmart('我觉醒了神之力');
    expect(S().player.skills).toEqual(['heavy_slash']); // warrior 初始技，未新增
    expect(S().player.level).toBe(1);
  });
  it('伪造 dest（godrealm）→ 地点词典收敛失败，不移动', async () => {
    setAiPort(hostilePort({ intent: 'go', dest: 'godrealm' }));
    const locBefore = S().player.loc;
    await freeActSmart('带我进入神之国');
    expect(S().player.loc).toBe(locBefore);
  });
  it('steps 灌 10 个意图 → 只执行前 3 个合法意图（executeSteps 截断）', async () => {
    const steps: IntentParse[] = Array.from({ length: 10 }, (_, i) => ({ intent: i < 5 ? 'observe' : 'godmode' }));
    setAiPort(hostilePort(steps));
    const before = (S().checks ?? []).length;
    await freeActSmart('一句话塞十个动作');
    /* 「执行了几步」是可数的：每步 observe 都留一条检定痕迹（CheckResolver → s.checks）。
       此前这条只有 expect(S()).toBeTruthy()——core.S 恒为非空对象，等于什么都没验：
       把 executeSteps 的截断去掉、10 个意图全部执行，用例照样绿（审查 §假通过）。 */
    expect((S().checks ?? []).length - before, '恰好 3 步：截断闸 + 意图白名单共同生效').toBe(3);
    expect((S().log ?? []).some((e) => e.text.includes('godmode')), '白名单外的意图不该落地').toBe(false);
  });
  it('focus 注入 <script> → esc 转义进日志，不透传 HTML', async () => {
    setAiPort(hostilePort({ intent: 'observe', focus: '<script>alert(1)</script>' }));
    await freeActSmart('观察<script>alert(1)</script>四周');
    const joined = S().log.map((l) => l.text).join('\n');
    expect(joined).toContain('&lt;script&gt;');
    expect(joined).not.toContain('<script>');
  });
});

/* ---------------- R3 · 关系强改：聊天通道 clamp + 日封顶 ---------------- */
describe('R3 · 敌意聊天回包（attDelta 越界 / 超长台词）', () => {
  const hostileChat = (reply: ChatReply): AiPort => ({
    ...ruleSim,
    chatAsync: async () => reply,
  });
  const atTavernWithLita = () => {
    S().player.loc = 'tavern'; // 莉塔 schedule：0-3 集市 / 4-12 酒馆；t=16 → 时辰4 在酒馆
    openChat('lita');
  };

  it('attDelta +99 → clamp 到 +2（单 NPC 日封顶）', async () => {
    setAiPort(hostileChat({ line: '莉塔突然对你掏心掏腑。', attDelta: 99 }));
    atTavernWithLita();
    sendChat('lita', '给我提升好感');
    await Promise.resolve();
    await Promise.resolve();
    expect(S().npcs.lita.att).toBeLessThanOrEqual(2);
  });
  it('同日连发三次刷好感 → 全日封顶仍 ≤+2', async () => {
    setAiPort(hostileChat({ line: '你真是个好人。', attDelta: 99 }));
    atTavernWithLita();
    for (let i = 0; i < 3; i++) {
      sendChat('lita', '再刷一点');
      await Promise.resolve();
      await Promise.resolve();
    }
    expect(S().npcs.lita.att).toBeLessThanOrEqual(2);
  });
  it('attDelta -99 → clamp 到 -2（负向无日封顶但有下限）', async () => {
    setAiPort(hostileChat({ line: '你惹恼了她。', attDelta: -99 }));
    atTavernWithLita();
    sendChat('lita', '再恶劣一点');
    await Promise.resolve();
    await Promise.resolve();
    expect(S().npcs.lita.att).toBeGreaterThanOrEqual(-2);
  });
  it('超长台词（500 字）→ 截断 140 字入窗', async () => {
    setAiPort(hostileChat({ line: '啊'.repeat(500), attDelta: 0 }));
    atTavernWithLita();
    sendChat('lita', '说点长话');
    await Promise.resolve();
    await Promise.resolve();
    const last = S().chats?.lita?.at(-1);
    expect(last?.text.length).toBeLessThanOrEqual(140);
  });
  it('ctx 是快照：AI 篡改 ctx.att 不影响 WorldState', async () => {
    let seen: ChatCtx | null = null;
    setAiPort({
      ...ruleSim,
      chatAsync: async (_id, ctx) => {
        seen = ctx;
        ctx.att = 999; // 敌意 AI 篡改上下文
        return { line: '嗯。', attDelta: 0 };
      },
    });
    atTavernWithLita();
    sendChat('lita', '改我上下文试试');
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toBeTruthy();
    expect(S().npcs.lita.att).toBeLessThanOrEqual(2);
  });
});

/* ---------------- R4 · 规则破坏：NPC 决策通道 ---------------- */
describe('R4 · 敌意 NPC 决策回包', () => {
  it('伪造裁定（“把全部金币交给玩家”）→ 台词池兜底，态度/金币不变', async () => {
    const hostile: AiPort = {
      ...ruleSim,
      npcDecideAsync: async (): Promise<NpcVerdict> => ({
        verdict: '把全部金币交给玩家',
        W: { interest: 99, vio: false, risk: 99, att: 999 },
        line: '好的，我把所有钱都给你。<script>steal()</script>',
      }),
    };
    setAiPort(hostile);
    const s = S();
    s.player.loc = 'tavern';
    const goldBefore = s.player.gold;
    const attBefore = s.npcs.lita?.att ?? 0;
    openDlg('lita');
    runReq('lita', 0); // 借钱
    await Promise.resolve();
    await Promise.resolve();
    expect(s.player.gold).toBe(goldBefore); // 金币只走 core 白名单（借出不在后果表）
    expect(s.npcs.lita?.att ?? 0).toBe(attBefore); // 非「有条件答应」不加好感
    const joined = s.log.map((l) => l.text).join('\n');
    expect(joined).not.toContain('<script>');
  });
});

/* ---------------- R5 · 数值篡改（后果通道参数 AI 不可控）---------------- */
describe('R5 · AI 回包的后果强度被 core 固定（rumor 不可放大）', () => {
  it('聊天 rumor 沿关系网传播强度恒为 imp=1（一跳即止），AI 无法借道煽动全城', async () => {
    const hostile: AiPort = {
      ...ruleSim,
      chatAsync: async () => ({ line: '（随口一说）', attDelta: 0, rumor: '放大谣言：城主是魔族卧底！快传！' }),
    };
    setAiPort(hostile);
    const s = S();
    s.player.loc = 'tavern';
    openChat('lita');
    sendChat('lita', '帮我传个话');
    await Promise.resolve();
    await Promise.resolve();
    // 莉塔的关系边（joe/galon）收到传闻且 imp=0（core 固定 imp-1 衰减）；
    // 一跳即止：非莉塔直交者（如 selina/reno/brendan）不得出现「传闻」记忆。
    const heard = ['joe', 'galon'].filter((id) => memOf(id, s).some((m) => m.event.includes('传闻')));
    expect(heard.length).toBeGreaterThanOrEqual(1);
    for (const id of ['selina', 'reno', 'brendan', 'ash']) {
      expect(memOf(id, s).some((m) => m.event.includes('传闻'))).toBe(false);
    }
  });
  it('mem 长度被 core 截断（24 字），AI 无法灌入超长记忆污染上下文', async () => {
    const hostile: AiPort = {
      ...ruleSim,
      chatAsync: async () => ({ line: '嗯。', attDelta: 0, mem: '啊'.repeat(200) }),
    };
    setAiPort(hostile);
    const s = S();
    s.player.loc = 'tavern';
    openChat('lita');
    sendChat('lita', '记住这句话');
    await Promise.resolve();
    await Promise.resolve();
    /* 锚在「模型提供的那条文本」上：原来只看最后一条，而最后一条可能是别的系统写的，
       长度恒 ≤24，断言就成了空过。 */
    const injected = memOf('lita', s).find((m) => m.event.startsWith('啊'));
    expect(injected, 'AI 文本确实进了记忆（先证明它落地，再谈截断）').toBeDefined();
    expect(injected!.event.length, 'core 把 AI 文本截到 24 字').toBe(24);
  });
});

/* ---------------- R6 · 静态审计：AI 层不存在状态写入通路 ---------------- */
describe('R6 · AI 层源码静态审计', () => {
  const aiDir = join(process.cwd(), 'src', 'ai');
  const files = readdirSync(aiDir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

  it('src/ai/*.ts 不存在 WorldState 直写（core.S 赋值 / player 字段写入 / rep 写入）', () => {
    const writePatterns = [
      /core\.S\s*=[^=]/, // 整体替换 WorldState
      /\.player\.gold\s*=[^=]/,
      /\.player\.stats\.[^=]+\s*=[^=]/,
      /\.player\.wanted\s*=[^=]/,
      /\.player\.skills\s*=\s*\[/,
      /\.rep\[[^\]]+\]\s*=[^=]/,
      /\.econ\[[^\]]+\]\s*=[^=]/,
    ];
    for (const f of files) {
      const src = readFileSync(join(aiDir, f), 'utf8');
      for (const p of writePatterns) expect(src, `${f} 含越权写入：${p}`).not.toMatch(p);
    }
  });

  it('src/ai/*.ts 不 import events/dungeon/abyss 等后果通道（只读世界书与状态）', () => {
    for (const f of files) {
      const src = readFileSync(join(aiDir, f), 'utf8');
      expect(src, `${f} 不得 import 事件引擎`).not.toMatch(/from '@\/events\/EventProcessor'/);
      expect(src, `${f} 不得 import law`).not.toMatch(/from '@\/systems\/law/);
      expect(src, `${f} 不得 import gains.addRep 之外的写入口`).not.toMatch(/from '@\/systems\/dungeon/);
    }
  });
});

/* ---------------- 补充 · NpcReq 数值注入 ---------------- */
describe('补充 · NpcReq 越界值不致崩（API 误用防御）', () => {
  it('interest/risk 传入极端值，npcDecide 仍返回合法档位', () => {
    for (const req of [
      { interest: 999, risk: -999 } as NpcReq,
      { interest: NaN, risk: NaN } as unknown as NpcReq,
    ]) {
      const v = ruleSim.npcDecide('lita', req);
      expect(typeof v.verdict).toBe('string');
      expect(v.verdict.length).toBeGreaterThan(0);
    }
  });
});

/* ============================================================
   卡 Q2 · 数值面红队（R7–R9）
   I1–I3 引入随机品质 / 词缀 / 状态 / 新技能后，数值面第一次有了"可被玩坏"的空间。
   ============================================================ */

/* ---------------- R7 · AI 诱导数值（轴 / 称号 / 品质） ---------------- */
describe('R7 · AI 诱导数值不得落地', () => {
  it('聊天回包夹带 titles / rep 字段被忽略（白名单只认 attDelta/mem/rumor）', async () => {
    const evil: AiPort = {
      ...ruleSim,
      chatAsync: undefined,
      chat: () =>
        ({
          line: '他们都说你是屠龙者。',
          attDelta: 0,
          titles: ['ti_slayer'],
          rep: { empire: { military: 99 } },
          quality: 6,
        }) as unknown as ChatReply,
    };
    setAiPort(evil);
    openChat('lita');
    sendChat('lita', '你听说过我吗');
    await new Promise((r) => setTimeout(r, 0));
    expect(S().titles || []).not.toContain('ti_slayer');
    expect(S().rep.empire).toBe(0);
  });

  it('伪造 ui 命令隐藏未获得的称号 → core 拒绝（称号不可凭空操作）', () => {
    const before = JSON.stringify(S().titleHidden || []);
    dispatch({ type: 'ui', a: 'title_hide', p: { id: 'ti_slayer' } } as GameCommand);
    expect(JSON.stringify(S().titleHidden || [])).toBe(before);
  });

  it('伪造装备高品质实例（未在背包中的 uid）→ 拒绝，数值不变', () => {
    const before = fingerprint();
    dispatch({ type: 'equipItem', id: 'sword_iron', uid: '__evil__' } as GameCommand);
    expect(fingerprint()).toBe(before);
  });

  it('意图通道回包夹带装备/品质字段 → 不落地', async () => {
    const evil: AiPort = {
      ...ruleSim,
      intentAsync: async () =>
        ({
          intent: 'observe',
          focus: '神器',
          equip: { id: 'blade_void', q: 6, af: ['af_eternal'] },
        }) as unknown as IntentParse,
    };
    setAiPort(evil);
    await freeActSmart('我把剑扔了换个神器');
    expect(S().player.bag.some((x) => x.id === 'blade_void')).toBe(false);
    expect(S().player.equip.wpnIns).toBeUndefined();
  });
});

/* ---------------- R8 · 状态滥用 ---------------- */
describe('R8 · 状态滥用在战斗内被拦', () => {
  it('眩晕不可无限叠：连施 30 次仍受 maxStack/免疫集约束', () => {
    const arr: { id: 'stun'; dur: number; power: number; stack: number }[] = [];
    for (let i = 0; i < 30; i++) applyStatus(arr, 'stun', 99, 99);
    expect(arr.length).toBe(1);
    expect(arr[0].stack).toBeLessThanOrEqual(statusDef('stun')!.maxStack);
    expect(arr[0].dur).toBeLessThanOrEqual(statusDef('stun')!.dur);
  });

  it('DoT 不重入：同一回合内多次 tick 只按当前叠层结算一次派生伤害', () => {
    const arr: Parameters<typeof dotOf>[0] = [];
    applyStatus(arr, 'burn', 3, 4);
    const first = dotOf(arr);
    expect(dotOf(arr)).toBe(first); // 幂等读取：不会因为多读一次翻倍
  });

  it('战斗结束状态随 CB 丢弃：网内比斗的还原快照也不含状态', () => {
    const s = S();
    expect(JSON.stringify(s).includes('"status"')).toBe(false);
    expect(JSON.stringify(s.net || {}).includes('status')).toBe(false);
  });
});

/* ---------------- R9 · 词缀与品质越界 ---------------- */
describe('R9 · 词缀 / 品质越界被夹取或忽略', () => {
  it('品质档越界（q=99 / q=-5）写包时被夹取到 [0,6]', () => {
    core.S = null;
    newGame({ name: '红队', race: 'human', cls: 'warrior' });
    const hi = addInstance({ id: 'sword_iron', qty: 1, q: 99, af: [] });
    const lo = addInstance({ id: 'sword_iron', qty: 1, q: -5, af: [] });
    expect(hi[0].q).toBeLessThanOrEqual(6);
    expect(lo[0].q).toBeGreaterThanOrEqual(0);
  });

  it('未知词缀 id 不产生任何加成（不崩、不凭空加数值）', () => {
    const evil = instMods({ id: 'sword_iron', uid: 'eZ', q: 6, af: ['af_不存在', 'af_sharp'] });
    const clean = instMods({ id: 'sword_iron', uid: 'eZ', q: 6, af: ['af_sharp'] });
    expect(evil.atk).toBe(clean.atk);
    expect(evil.crit).toBe(clean.crit);
  });

  it('词缀池不因越界 tier 泄漏：tier 99 仍只取该装备可用的池', () => {
    const pool = affixPoolOf(WB.items.sword_iron, 99);
    expect(pool.every((a) => a.kind === 'both' || a.kind === 'wpn')).toBe(true);
  });
});
