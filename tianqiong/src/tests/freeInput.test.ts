/* ============================================================
   自由输入主通道（弱化专用对话界 · 2026-09）：
   - P0 编织竞态回归：一句 freeText 只开一个编织窗，回显与行动产出同批，
     meta 内部标记不进事实清单；
   - 社交意图 talk / give / request：管线复用（Chat/Bond/Dialogue），
     台词落见闻录、不弹任何浮层，副作用照常落档；
   - 会话焦点：「再问问他」指代上一位交谈对象。
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { bus, core, dispatch, newGame, resetWorld, rng, scheduler } from '@/world';
import { MemorySaveRepository } from '@/repo';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';
import { registerSystemSubscriptions } from '@/plugins/subscriptions';
import { freeAct, parseRegex, parseRegexSteps, resetFreeInputState } from '@/actions/ActionParser';
import { narrationIdle, resetNarrationState } from '@/world/Narration';
import { currentChatId, currentDialogId } from '@/systems/character/Sheet';
import { addItem, itemCount } from '@/systems/character/Gains';
import { need } from '@/world/WorldState';
import { mutate } from '@/world/WorldMutate';
import { advance } from '@/world/WorldClock';
import { WB } from '@/data/worldBook';
import { presentNPCs } from '@/systems/npc/Npcs';

beforeEach(() => {
  core.S = null;
  core.CB = null;
  resetWorld();
  setSavePort(new MemorySaveRepository());
  setAiPort(ruleSim);
  bus.clear();
  rng.seed(42);
  resetNarrationState();
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  registerSystemSubscriptions();
  resetFreeInputState(); // 会话焦点/在飞锁是模块级运行态：不复位会跨用例串味
});

const start = (name = '测试者', race = 'dwarf', cls = 'warrior') => newGame({ name, race, cls });

describe('P0 · 自由输入的编织窗（竞态回归）', () => {
  it('一句话只开一个窗：回显行与行动产出同批织入，meta 不进事实清单', async () => {
    const { gateway } = await import('@/ai/gateway');
    start();
    const calls: string[][] = [];
    gateway.use({
      ...ruleSim,
      /* 意图解析拖 30ms 才回：复现实机竞态——旧实现里 dispatch 出口抢先开窗，
         罩着孤零零的回显行就发走了（玩家输入被织成脑补正文）。 */
      intentAsync: async () => {
        await new Promise((r) => setTimeout(r, 30));
        return { intent: 'askinfo', target: '米露', topic: '是否有人' };
      },
      narrateAsync: async (facts: string[]) => {
        calls.push(facts);
        return '（一段织好的正文。）';
      },
    });
    dispatch({ type: 'freeText', text: '问米露是否有人' });
    await new Promise((r) => setTimeout(r, 60)); // 让 0ms 窗口先到点
    await narrationIdle();
    gateway.use(ruleSim);
    expect(calls.length).toBe(1);
    const all = calls[0].join('\n');
    expect(all).toContain('【玩家提出】问米露是否有人'); // 回显行在同一批，且以「动因」身份进事实（2026-09-29）
    expect(all).toContain('你向米露打听「是否有人」'); // 行动产出也在同一批
    expect(all).not.toContain('〔意图解析'); // 内部标记不是事实
  });

  it('回显与产出被织成一条 ai 条目，原文不再裸露在见闻录里', async () => {
    const { gateway } = await import('@/ai/gateway');
    start();
    gateway.use({
      ...ruleSim,
      intentAsync: async () => {
        await new Promise((r) => setTimeout(r, 30));
        return { intent: 'observe' };
      },
      narrateAsync: async () => '他环顾四周，把这一切收进眼底。',
    });
    dispatch({ type: 'freeText', text: '观察四周' });
    await new Promise((r) => setTimeout(r, 60));
    await narrationIdle();
    gateway.use(ruleSim);
    const aiEntries = core.S!.log.filter((e) => e.cls === 'ai');
    expect(aiEntries.some((e) => e.text === '他环顾四周，把这一切收进眼底。')).toBe(true);
  });

  it('AI 判 unknown：不织正文，玩家原话与「未识别」反馈原样留在见闻录（吞输入事故回归）', async () => {
    const { gateway } = await import('@/ai/gateway');
    start();
    let weaveCalled = 0;
    gateway.use({
      ...ruleSim,
      /* 实机事故（2026-09-29）：LLM 把「祈祷」判成 unknown，唯一的一行反馈被
         编织替换成「走进神殿祈祷」的假叙事——玩家以为去了，引擎什么都没执行。 */
      intentAsync: async () => ({ intent: 'unknown' }),
      narrateAsync: async () => {
        weaveCalled++;
        return '（不该出现的脑补正文。）';
      },
    });
    const seq0 = core.S!.logSeq ?? 0;
    dispatch({ type: 'freeText', text: '祈祷' });
    await new Promise((r) => setTimeout(r, 30));
    await narrationIdle();
    gateway.use(ruleSim);
    expect(weaveCalled).toBe(0); // unknown 轮不开编织窗
    const fresh = core.S!.log.filter((e) => (e.id ?? 0) > seq0);
    expect(fresh.some((e) => e.text.includes('＞ 祈祷'))).toBe(true); // 玩家原话在
    expect(fresh.some((e) => e.cls === 'bad' && e.text.includes('没能落成具体的行动'))).toBe(true); // 明确反馈在
    expect(fresh.some((e) => e.cls === 'ai')).toBe(false); // 没有假叙事
  });

  it('编织落地后玩家回显行仍在：正文在前，原话像聊天记录一样跟在后面', async () => {
    const { gateway } = await import('@/ai/gateway');
    start();
    gateway.use({
      ...ruleSim,
      narrateAsync: async () => '（一段织好的正文。）',
    });
    const seq0 = core.S!.logSeq ?? 0;
    dispatch({ type: 'freeText', text: '观察四周' });
    await new Promise((r) => setTimeout(r, 30));
    await narrationIdle();
    gateway.use(ruleSim);
    const fresh = core.S!.log.filter((e) => (e.id ?? 0) > seq0);
    expect(fresh[0].cls).toBe('say'); // 回显行（未被替换的保留行在最前）
    expect(fresh[0].text.startsWith('＞')).toBe(true);
    const woven = fresh.find((e) => e.cls === 'ai');
    expect(woven).toBeTruthy(); // 正文照常落地
  });
});

describe('社交意图 · talk（攀谈走聊天管线，台词落见闻录）', () => {
  it('「跟米露聊聊」→ 回复以 say 落见闻录，不弹任何浮层，会话照常落档', () => {
    start();
    freeAct('跟米露聊聊');
    expect(core.S!.log.some((l) => l.text === '〔意图解析〕攀谈·米露')).toBe(true);
    expect(core.S!.log.some((l) => l.cls === 'say' && l.text.includes('米露'))).toBe(true);
    /* 副作用与深谈同一套：会话历史入 s.chats（玩家句 + NPC 句） */
    const turns = core.S!.chats?.mia || [];
    expect(turns.length).toBeGreaterThanOrEqual(2);
    /* 不弹浮层：聊天窗与对话框都没开 */
    expect(currentChatId()).toBeNull();
    expect(currentDialogId()).toBeNull();
  });

  it('「问米露……」打听也走同一管线：不再出现三句罐头', () => {
    start();
    freeAct('问米露最近怎么样');
    expect(core.S!.log.some((l) => l.text.includes('你向米露打听「最近怎么样」'))).toBe(true);
    expect(core.S!.log.some((l) => l.text === '“没什么特别的。”对方摇摇头。')).toBe(false);
    expect(core.S!.log.some((l) => l.cls === 'say')).toBe(true);
  });

  it('路人搭话仍是一句罐头：不建会话、不入关系', () => {
    start();
    /* 观察先生成当日路人名单，「跟他打个招呼」指代兜底到首位在场——
       这里直接对路人名攀谈：resolveTarget 认当日见过的路人 */
    freeAct('观察四周');
    const roster = (core.S!.log.map((l) => l.text).join('\n'));
    expect(roster.length).toBeGreaterThan(0); // 冒烟：观察路径不受本次改动影响
  });
});

describe('社交意图 · give / request', () => {
  it('「把面包给米露」→ 赠礼管线落地：行囊少一件，反应句入见闻录', () => {
    start();
    addItem('bread', 2);
    const before = itemCount('bread');
    expect(before).toBeGreaterThan(0);
    freeAct('把面包给米露');
    expect(core.S!.log.some((l) => l.text === '〔意图解析〕赠礼·米露')).toBe(true);
    expect(itemCount('bread')).toBe(before - 1);
    expect(core.S!.log.some((l) => l.cls === 'say' && l.text.includes('面包'))).toBe(true);
  });

  it('行囊里没有的东西给不出去：如实反馈且不误扣', () => {
    start();
    addItem('bread', 1);
    freeAct('把屠龙宝刀给米露');
    expect(core.S!.log.some((l) => l.text.includes('找不到「屠龙宝刀」'))).toBe(true);
    expect(itemCount('bread')).toBe(1); // 别误扣
  });

  it('「拜托米露借点钱」→ 请求走 npcDecide 权衡，台词与结论落见闻录', () => {
    start();
    freeAct('拜托米露借点钱');
    expect(core.S!.log.some((l) => l.text === '〔意图解析〕请求·米露')).toBe(true);
    expect(core.S!.log.some((l) => l.text.includes('权衡了你的请求'))).toBe(true);
    expect(core.S!.log.some((l) => l.cls === 'say')).toBe(true);
    expect(currentDialogId()).toBeNull(); // 不弹浮层
  });
});

describe('会话焦点（指代解析）', () => {
  it('「再问问他」指向上一位交谈对象', () => {
    start();
    freeAct('跟米露聊聊');
    freeAct('再问问他');
    expect(core.S!.log.filter((l) => l.text === '〔意图解析〕打听·米露').length).toBe(1);
  });
});

describe('沉吟广播（自由输入攀谈的等待反馈）', () => {
  it('异步回包期间广播「对方沉吟」，落地后清场', async () => {
    const { gateway } = await import('@/ai/gateway');
    start();
    const musing: (string | null)[] = [];
    bus.on((e) => {
      if (e.type === 'npcMusing') musing.push(e.name);
    });
    gateway.use({
      ...ruleSim,
      chatAsync: async () => {
        await new Promise((r) => setTimeout(r, 20));
        return { line: '今天风大。' };
      },
    });
    freeAct('跟米露聊聊');
    await new Promise((r) => setTimeout(r, 60));
    gateway.use(ruleSim);
    expect(musing[0], '回包前先报沉吟').toBe('米露');
    expect(musing[musing.length - 1], '落地后清场').toBeNull();
    expect(core.S!.log.some((l) => l.cls === 'say' && l.text.includes('米露：「今天风大。」'))).toBe(true);
  });
});

/* ============================================================
   误指人修复（2026-09）：无点名不猜人 + 焦点有时效
   ------------------------------------------------------------
   旧行为：无点名静默回落「首位在场」+ 焦点永不过期 → 出生点名册第一位
   成了所有含糊输入的默认接话人，且一次攀谈后每次意图解析都带着
   「上文正与米露交谈」，模型把后续输入全往「继续跟她聊」上判。
   新三级：唯一在场自动指他 / 多人续有效焦点 / 多人无焦点问一句。
   ============================================================ */
describe('误指人修复 · 无点名不猜人', () => {
  it('多人在场无点名「打听消息」：问一句，不产出台词、不推进时间', () => {
    start();
    const t0 = core.S!.t;
    freeAct('打听消息');
    const texts = core.S!.log.map((l) => l.text);
    expect(texts.some((x) => x.startsWith('你要找谁打听？') && x.includes('米露'))).toBe(true);
    expect(texts.some((x) => x.startsWith('你向'))).toBe(false);
    expect(core.S!.log.some((l) => l.cls === 'say')).toBe(false);
    expect(core.S!.t).toBe(t0); // 什么都没发生，时钟不走
  });

  it('单人在场无点名：自动指唯一的人', () => {
    start();
    /* npcAt 是 (npc, state) 的纯函数：扫出一个「恰有一人在场」的(时刻, 地点)
       即为确定的前提，不依赖运气。直接改 t / mutate.playerLoc 造景。 */
    const s = need();
    let solo: string | null = null;
    for (let t = s.t; t <= s.t + 240 && !solo; t++) {
      s.t = t;
      for (const id of Object.keys(WB.locations)) {
        if (presentNPCs(id).length === 1) {
          solo = id;
          break;
        }
      }
    }
    expect(solo, '世界里应存在单人在场的时刻×地点').toBeTruthy();
    mutate.playerLoc(solo!); // 直接挪人：不走 go() 的路费与途中盘查，保持单变量
    const name = presentNPCs(solo!)[0].name;
    freeAct('打听消息');
    expect(core.S!.log.some((l) => l.text === '〔意图解析〕打听·' + name)).toBe(true);
    expect(core.S!.log.some((l) => l.cls === 'say')).toBe(true);
  });

  it('「问路」仍是打听；「这个问题的答案」不是（裸「问」不再命中）', () => {
    start();
    freeAct('问路');
    expect(core.S!.log.some((l) => l.text === '〔意图解析〕打听')).toBe(true);
    freeAct('这个问题的答案');
    expect(core.S!.log.some((l) => l.text === '〔意图解析〕未能识别')).toBe(true);
  });
});

describe('误指人修复 · 焦点有时效', () => {
  it('未过期时「打听消息」续着上一位交谈对象（焦点锚点取代「首位在场」）', () => {
    start();
    freeAct('跟米露聊聊');
    freeAct('打听消息');
    expect(core.S!.log.filter((l) => l.text === '〔意图解析〕打听·米露').length).toBe(1);
  });

  it('过期后「再问问他」不再指旧对象', () => {
    start();
    freeAct('跟米露聊聊');
    advance(9); // TALK_FOCUS_TICKS=8 + 1：聊过之后又推了几件事，焦点到期
    freeAct('再问问他');
    expect(core.S!.log.some((l) => l.text === '〔意图解析〕打听·米露')).toBe(false);
  });

  it('威胁不吃焦点锚点：刚聊过的人不该挨无点名的威胁（实机二次现场）', () => {
    start();
    freeAct('跟米露聊聊'); // 建立新鲜焦点
    freeAct('威胁'); // 没点名：不许顺延到焦点对象
    expect(core.S!.log.some((l) => l.text === '〔意图解析〕威胁·米露')).toBe(false);
    expect(core.S!.log.some((l) => l.text.includes('发出了威胁'))).toBe(false);
    expect(core.S!.log.some((l) => l.text.startsWith('你要找谁发出警告？'))).toBe(true);
    expect(core.S!.log.some((l) => l.text.includes('仇，结下了'))).toBe(false);
  });

  it('换地点后意图提示词不再携带旧焦点（LLM 棘轮断路）', async () => {
    const { gateway } = await import('@/ai/gateway');
    start();
    dispatch({ type: 'freeText', text: '跟米露聊聊' });
    const seen: (string | undefined)[] = [];
    gateway.use({
      ...ruleSim,
      intentAsync: async (_t: string, c: { lastTalk?: { name: string } }) => {
        seen.push(c.lastTalk?.name);
        return null; // 落回正则通道，世界照常走
      },
    });
    dispatch({ type: 'freeText', text: '随便看看' });
    mutate.playerLoc('tavern'); // 直接挪人：人离场即焦点失效
    dispatch({ type: 'freeText', text: '随便看看' });
    gateway.use(ruleSim);
    await narrationIdle();
    expect(seen[0]).toBe('米露');
    expect(seen[1]).toBeUndefined();
  });
});

describe('可玩性实测补漏 · 自然说法与名字匹配', () => {
  it('「喝一杯」「睡一觉」命中吃喝与休息；「去酒馆」的「去」走词典兜底', () => {
    start();
    freeAct('去酒馆');
    expect(core.S!.player.loc).toBe('tavern');
    freeAct('喝一杯');
    expect(core.S!.log.some((l) => l.text === '〔意图解析〕喝酒')).toBe(true);
    freeAct('睡一觉');
    expect(core.S!.log.some((l) => l.text === '〔意图解析〕休息')).toBe(true);
  });

  it('引号名可以裸称：「跟灰烬聊聊」解析出目标', () => {
    start();
    const p = parseRegex('跟灰烬聊聊');
    expect(p.intent).toBe('talk');
    expect(p.target).toBe('「灰烬」');
  });

  it('裸方位词不当焦点：「观察环境」没有「凝神分辨」，具体焦点照常回响', () => {
    start();
    freeAct('观察环境');
    expect(core.S!.log.some((l) => l.text.includes('凝神分辨'))).toBe(false);
    expect(parseRegex('观察告示栏').focus).toBe('告示栏');
  });

  it('不可直达的移动落见闻录，而不只是转瞬即逝的 toast', () => {
    start();
    freeAct('去深巷'); // 广场 → 深巷 相邻
    expect(core.S!.player.loc).toBe('alley');
    freeAct('去冒险者公会'); // 深巷 → 公会 不相邻
    expect(core.S!.log.some((l) => l.text.includes('无法直接前往'))).toBe(true);
  });

  it('「去圣辉神殿祈祷」连动句拆成移动+祈祷两步，不再原地默诵', () => {
    start();
    freeAct('去圣辉神殿祈祷');
    expect(core.S!.player.loc).toBe('temple');
    expect(core.S!.log.some((l) => l.text === '〔意图解析〕祈祷')).toBe(true);
    expect(core.S!.log.some((l) => l.text.includes('没有祭坛'))).toBe(false);
  });

  it('连动句拆步只认「移动在前+后续意图」：普通句子与纯移动不受影响', () => {
    expect(parseRegexSteps('去东市看看行情').map((s) => s.intent)).toEqual(['go', 'observe']);
    expect(parseRegexSteps('去东市看看行情')[0].dest).toBe('market');
    expect(parseRegexSteps('去酒馆').map((s) => s.intent)).toEqual(['go']);
    expect(parseRegexSteps('打听去酒馆的路').map((s) => s.intent)).toEqual(['askinfo']);
  });

  it('追问的纯指代不当话题：「再问问他」只落意图不编话题', () => {
    start();
    freeAct('跟米露聊聊');
    freeAct('再问问他');
    expect(core.S!.log.some((l) => l.text.includes('打听「问他」'))).toBe(false);
    expect(core.S!.log.some((l) => l.text === '〔意图解析〕打听·米露')).toBe(true);
    expect(parseRegex('问米露最近怎么样').topic).toBe('最近怎么样'); // 真话题不受影响
  });
});
