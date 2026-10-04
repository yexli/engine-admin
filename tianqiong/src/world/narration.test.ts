import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus, core, dispatch, newGame, resetWorld, rng, scheduler } from '@/world';
import { MemorySaveRepository } from '@/repo';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';
import { worldBus } from '@/events/EventBus';
import { mutate } from '@/world/WorldMutate';
import { narrationIdle, queueNarration, resetNarrationState } from '@/world/Narration';

/* 叙事编织：规则事实 → AI 写成的小说段。
   这里守的是**降级铁律**——没配模型时见闻必须原样可读，
   以及「一次命令只织一次、只替换这一轮的条目」。 */

const start = () => {
  newGame({ name: '测试者', race: 'dwarf', cls: 'warrior' });
  return core.S!.logSeq ?? 0;
};

beforeEach(() => {
  core.S = null;
  core.CB = null;
  resetWorld();
  setSavePort(new MemorySaveRepository());
  setAiPort(ruleSim); // 规则模拟没有 narrateAsync —— 默认就是「没配模型」的环境
  bus.clear();
  worldBus.reset();
  rng.seed(42);
  resetNarrationState(); // 衔接状态（上一段写在哪个地点）不该跨用例残留
  /* 检定演出走 scheduler：测试里让它同步跑完，否则 observe 的结果进不来 */
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
});
afterEach(() => {
  core.S = null;
  resetWorld();
});

/** 给规则模拟挂一个假的编织端口 */
const withWeave = (fn: (facts: string[], ctx: unknown) => Promise<string | null>) => {
  setAiPort({ ...ruleSim, narrateAsync: fn as never });
};

describe('叙事编织（Narration）', () => {
  it('端口没有编织能力时，见闻保持规则原文（没配模型的降级路径）', async () => {
    const seq0 = start();
    mutate.pushLog('你环顾四周，没看出特别之处。', 'nar');
    queueNarration(seq0);
    await narrationIdle();
    const fresh = core.S!.log.filter((e) => (e.id ?? 0) > seq0);
    expect(fresh).toHaveLength(1);
    expect(fresh[0].text).toBe('你环顾四周，没看出特别之处。');
    expect(fresh[0].cls).toBe('nar');
  });

  it('模型织出正文后，这一轮的见闻被合并成一条 ai 条目', async () => {
    const calls: { facts: string[]; ctx: Record<string, unknown> }[] = [];
    withWeave(async (facts, ctx) => {
      calls.push({ facts, ctx: ctx as Record<string, unknown> });
      return '晨光里你转了一圈，石板上只有自己的影子。';
    });
    const seq0 = start();
    mutate.pushLog('你环顾四周，没看出特别之处。', 'nar');
    mutate.pushLog('你获得 2 铜板。', 'gain');
    queueNarration(seq0);
    await narrationIdle();

    const fresh = core.S!.log.filter((e) => (e.id ?? 0) > seq0);
    expect(fresh).toHaveLength(1); // 两条原文合并成一条
    expect(fresh[0].cls).toBe('ai');
    expect(fresh[0].text).toContain('石板上只有自己的影子');
    // 事实按类型标注后交给模型，它才知道哪条是收获
    expect(calls).toHaveLength(1);
    expect(calls[0].facts[0]).toBe('你环顾四周，没看出特别之处。');
    expect(calls[0].facts[1]).toContain('【获得】');
    expect(calls[0].ctx.locName).toBeTruthy();
  });

  it('这一轮没写见闻时一次都不发（纯面板操作不该惊动模型）', async () => {
    let called = 0;
    withWeave(async () => {
      called++;
      return '不该出现';
    });
    const seq0 = start();
    queueNarration(seq0);
    await narrationIdle();
    expect(called).toBe(0);
  });

  it('模型返回 null 时保留规则原文（失败不吞消息）', async () => {
    withWeave(async () => null);
    const seq0 = start();
    mutate.pushLog('你搜了一圈，一无所获。', 'nar');
    queueNarration(seq0);
    await narrationIdle();
    const fresh = core.S!.log.filter((e) => (e.id ?? 0) > seq0);
    expect(fresh).toHaveLength(1);
    expect(fresh[0].text).toBe('你搜了一圈，一无所获。');
  });

  it('模型抛错也不会把这一轮的消息弄丢', async () => {
    withWeave(async () => {
      throw new Error('网络断了');
    });
    const seq0 = start();
    mutate.pushLog('德伦没有看你。', 'nar');
    queueNarration(seq0);
    await narrationIdle();
    expect(core.S!.log.some((e) => e.text === '德伦没有看你。')).toBe(true);
  });

  it('走真实命令链：dispatch 一次操作，见闻当场被织成一段', async () => {
    withWeave(async (facts) => '（AI 织）' + facts.length + ' 条事实汇成的一段。');
    start();
    dispatch({ type: 'sceneAction', k: 'observe' });
    await narrationIdle();
    const woven = core.S!.log.filter((e) => e.cls === 'ai');
    expect(woven).toHaveLength(1);
    expect(woven[0].text).toContain('（AI 织）');
    /* 被织掉的那几条原文不应再单独出现（否则等于说了两遍） */
    expect(core.S!.log.filter((e) => e.cls === 'nar' && e.text.includes('环顾四周'))).toHaveLength(0);
  });

  it('前情里带着上一段已写的正文——否则模型会重写整个场景', async () => {
    let got: { recap?: string[]; continuity?: string[] } | null = null;
    withWeave(async (_facts, ctx) => {
      got = ctx as { recap?: string[] };
      return '第二段。';
    });
    start();
    mutate.pushLog('第一段已经写好的正文。', 'ai');
    const seq1 = core.S!.logSeq ?? 0;
    mutate.pushLog('本轮的事实', 'nar');
    queueNarration(seq1);
    await narrationIdle();
    expect(got!.recap?.[0]).toBe('第一段已经写好的正文。');
  });

  it('首次编织没有前文时 recap 为空，并明确告知「这是第一段」', async () => {
    let got: { recap?: string[]; continuity?: string[] } | null = null;
    withWeave(async (_facts, ctx) => {
      got = ctx as { recap?: string[]; continuity?: string[] };
      return '第一段。';
    });
    const seq0 = start();
    mutate.pushLog('本轮的事实', 'nar');
    queueNarration(seq0);
    await narrationIdle();
    expect(got!.recap).toHaveLength(0);
    expect(got!.continuity?.join('')).toContain('第一段');
  });

  it('近因取自「不是散文」的条目：收获与提示要进上下文，散文不重复进', async () => {
    let got: { events?: string[] } | null = null;
    withWeave(async (_facts, ctx) => {
      got = ctx as { events?: string[] };
      return '织好的。';
    });
    start();
    mutate.pushLog('你环顾四周。', 'nar');
    mutate.pushLog('你获得 12 铜板。', 'gain');
    mutate.pushLog('（看出门道 +1 情报）', 'sys');
    const seq1 = core.S!.logSeq ?? 0;
    mutate.pushLog('本轮的事实', 'nar');
    queueNarration(seq1);
    await narrationIdle();
    expect(got!.events?.join('|')).toContain('获得 12 铜板');
    expect(got!.events?.join('|')).toContain('看出门道');
    expect(got!.events?.join('|')).not.toContain('你环顾四周'); // 散文不该重复进近因
  });

  it('编织期间广播「待书写」，结束后必须解锁（失败也一样）', async () => {
    const marks: (number | null)[] = [];
    bus.on((e) => {
      if (e.type === 'weave') marks.push(e.from);
    });
    withWeave(async () => '织好的');
    const seq0 = start();
    mutate.pushLog('原文', 'nar');
    queueNarration(seq0);
    expect(marks).toEqual([seq0]); // 先标记：界面据此把这一批撤下
    await narrationIdle();
    expect(marks).toEqual([seq0, null]); // 完成后解锁
  });

  it('模型失败也必须解锁——否则那批消息永远藏在界面后面', async () => {
    const marks: (number | null)[] = [];
    bus.on((e) => {
      if (e.type === 'weave') marks.push(e.from);
    });
    withWeave(async () => null);
    const seq0 = start();
    mutate.pushLog('原文', 'nar');
    queueNarration(seq0);
    await narrationIdle();
    expect(marks).toEqual([seq0, null]);
    expect(core.S!.log.some((e) => e.text === '原文')).toBe(true);
  });

  it('没配模型时一次都不广播（原文即时显示，界面不该出现写作占位）', async () => {
    const marks: (number | null)[] = [];
    bus.on((e) => {
      if (e.type === 'weave') marks.push(e.from);
    });
    const seq0 = start();
    mutate.pushLog('原文', 'nar');
    queueNarration(seq0); // 默认端口是规则模拟，没有 narrateAsync
    await narrationIdle();
    expect(marks).toEqual([]);
  });

  it('窗口内晚到的日志会并进同一段（检定演出的回流形态）', async () => {
    let seen: string[] = [];
    withWeave(async (facts) => {
      seen = facts;
      return '织：' + facts.join('|');
    });
    const seq0 = start();
    mutate.pushLog('同步阶段就写好的原文', 'nar');
    queueNarration(seq0);
    /* 这一条模拟 CheckResolver 演出收束（1450ms 后）才写回的收益 */
    mutate.pushLog('演出收束时才到的收益', 'gain');
    await narrationIdle();
    const fresh = core.S!.log.filter((e) => (e.id ?? 0) > seq0);
    expect(fresh).toHaveLength(1); // 两条合成一段，不再是一半被织一半留在外面
    expect(fresh[0].text).toContain('演出收束时才到的收益');
    expect(seen.join('|')).toContain('【获得】演出收束时才到的收益');
  });

  it('织好之后 logSeq 必须往前走，否则界面不会重算', async () => {
    withWeave(async () => '织好的段落。');
    const seq0 = start();
    mutate.pushLog('原文一', 'nar');
    const before = core.S!.logSeq ?? 0;
    queueNarration(seq0);
    await narrationIdle();
    expect(core.S!.logSeq ?? 0).toBeGreaterThan(before);
  });
});
import { buildCondition, fitBudget } from '@/world/NarrativeContext';

describe('玩家处境（buildCondition）', () => {
  const base = { hp: 74, hpMax: 74, mp: 46, mpMax: 46, effects: [], wanted: 0, titles: [], level: 1 };

  it('完好时不产出任何一句——没伤就别提醒它受伤', () => {
    expect(buildCondition(base)).toHaveLength(0);
  });

  it('按比例说伤情，且只给叙事短语不给数值', () => {
    const light = buildCondition({ ...base, hp: 60 });
    const heavy = buildCondition({ ...base, hp: 40 });
    const dying = buildCondition({ ...base, hp: 12 });
    expect(light.join('')).toContain('擦伤');
    expect(heavy.join('')).toContain('带着伤');
    expect(dying.join('')).toContain('很重');
    for (const line of [light, heavy, dying].flat()) {
      expect(line).not.toMatch(/\d+\s*\/\s*\d+/); // 不该出现 32/74 这种
    }
  });

  it('异常状态、通缉、身份各自成句', () => {
    const out = buildCondition({
      ...base,
      effects: [{ id: 'poison', left: 6 }],
      wanted: 2,
      titles: ['破晓者'],
    });
    const text = out.join('');
    expect(text).toContain('poison');
    expect(text).toContain('还剩 6 刻');
    expect(text).toContain('悬赏');
    expect(text).toContain('破晓者');
  });
});

describe('上下文预算（fitBudget）', () => {
  it('超预算整条丢弃，不切句子', () => {
    const items = ['甲'.repeat(30), '乙'.repeat(30), '丙'.repeat(30)];
    expect(fitBudget(items, 70)).toEqual([items[0], items[1]]);
  });
  it('第一条就超预算时仍然保留它——总比空手好', () => {
    expect(fitBudget(['x'.repeat(200)], 50)).toHaveLength(1);
  });
});

describe('编织的替换区间（审查 C1 · 实机暴露）', () => {
  it('weaveLogs 只替换本批区间，之后的条目原样留着', () => {
    const seq0 = start();
    mutate.pushLog('甲', 'nar');
    mutate.pushLog('乙', 'nar');
    const end = core.S!.logSeq ?? 0; // 本批的右边界（发起时的快照）
    mutate.pushLog('丙', 'nar'); // 属于下一批，绝不能被动到
    mutate.weaveLogs(seq0, end, '织好的。');
    const texts = core.S!.log.map((e) => e.text);
    expect(texts).toContain('织好的。');
    expect(texts).toContain('丙');
    expect(texts).not.toContain('甲');
    expect(texts).not.toContain('乙');
  });

  it('区间为空时不动日志（并发下同一批被处理两次的情况）', () => {
    start();
    mutate.pushLog('甲', 'nar');
    const end = core.S!.logSeq ?? 0;
    expect(mutate.weaveLogs(end + 1, end + 2, '不该写入')).toBe(false);
    expect(core.S!.log.some((e) => e.text === '甲')).toBe(true);
    expect(core.S!.log.some((e) => e.text === '不该写入')).toBe(false);
  });
});

describe('掷骰轮的窗口（实机定位到的根因）', () => {
  it('掷过骰的操作即使此刻没有新见闻，也照样开窗口', async () => {
    let calls = 0;
    setAiPort({ ...ruleSim, narrateAsync: async () => { calls++; return '织好的。'; }, summarizeAsync: async () => null } as never);
    const marks: (number | null)[] = [];
    bus.on((e) => { if (e.type === 'weave') marks.push(e.from); });
    const seq0 = start();
    /* 关键：此刻一条见闻都没写——这正是检定演出还没收束时的真实状态，
       收益要等 1450ms 才回来。旧实现会在这里直接 return，整轮被漏掉。 */
    queueNarration(seq0, true);
    expect(marks).toEqual([seq0]); // 窗口必须开
    mutate.pushLog('（看出门道 +1 情报）', 'sys'); // 窗口期间收益才写回
    await narrationIdle();
    expect(calls).toBe(1);
    expect(core.S!.log.some((e) => e.text.includes('织好的'))).toBe(true);
  });

  it('没掷骰又没写见闻的操作不开窗（面板操作不该惊动模型）', () => {
    const marks: (number | null)[] = [];
    bus.on((e) => { if (e.type === 'weave') marks.push(e.from); });
    const seq0 = start();
    queueNarration(seq0, false);
    expect(marks).toEqual([]);
  });
});

describe('自由行动的异步解析（实机定位到的第二处缺口）', () => {
  it('异步解析完成后要自己叫一次编织，否则永远停在规则原文', async () => {
    let calls = 0;
    setAiPort({
      ...ruleSim,
      /* 正则通道认不出这句、LLM 通道认得——走的正是异步那条 */
      intentAsync: async () => ({ intent: 'observe' }),
      narrateAsync: async () => {
        calls++;
        return '织好的正文。';
      },
      summarizeAsync: async () => null,
    } as never);
    const marks: (number | null)[] = [];
    bus.on((e) => {
      if (e.type === 'weave') marks.push(e.from);
    });
    start();
    dispatch({ type: 'freeText', text: '我看看四周有什么' });
    /* dispatch 是同步返回的，解析与执行在后台——等它跑完 */
    await new Promise((r) => setTimeout(r, 80));
    await narrationIdle();
    expect(calls).toBeGreaterThan(0);
    expect(marks.filter((x) => x !== null).length).toBeGreaterThan(0);
    expect(core.S!.log.some((e) => e.text.includes('织好的正文'))).toBe(true);
  });
});

describe('世界世代（重置后的在途响应）', () => {
  it('旧世代在途的响应不得写进新局的日志，也不得替新局解锁', async () => {
    let release!: (v: string) => void;
    const gate = new Promise<string>((r) => {
      release = r;
    });
    let calls = 0;
    setAiPort({
      ...ruleSim,
      narrateAsync: async () => {
        calls++;
        return calls === 1 ? gate : '新局的正文。';
      },
      summarizeAsync: async () => null,
    } as never);
    const marks: (number | null)[] = [];
    bus.on((e) => {
      if (e.type === 'weave') marks.push(e.from);
    });

    const seq0 = start();
    mutate.pushLog('旧局的事实', 'nar');
    queueNarration(seq0);
    await new Promise((r) => setTimeout(r, 30)); // 请求发出并挂住

    resetWorld(); // 世界换代
    const seq1 = start();
    mutate.pushLog('新局的事实', 'nar');
    queueNarration(seq1);

    release('旧局的正文。'); // 旧局的响应现在才回来
    await narrationIdle();

    const texts = core.S!.log.map((e) => e.text).join('|');
    expect(texts).not.toContain('旧局的正文'); // 不能污染新局
    expect(texts).toContain('新局的正文'); // 新局自己那一批照常
  });
});

describe('章级归档（recapArchive）', () => {
  /** 造 n 段"已织好的正文" */
  const weaveN = (n: number, tag = '') => {
    for (let i = 0; i < n; i++) mutate.pushLog(tag + '第 ' + i + ' 段正文。', 'ai');
  };
  const withSummary = (fn: (texts: string[]) => Promise<string | null>, sink: { asked: string[] }) => {
    setAiPort({
      ...ruleSim,
      narrateAsync: async () => null, // 这一轮只考归档，正文不织
      summarizeAsync: async (texts: string[]) => {
        sink.asked = texts;
        return fn(texts);
      },
    } as never);
  };

  it('攒够一批就归档：摘要进 s.recap，水位推到该批最后一条', async () => {
    const sink = { asked: [] as string[] };
    withSummary(async () => '前情摘要。', sink);
    const seq0 = start();
    weaveN(4);
    queueNarration(seq0);
    await narrationIdle();
    expect(sink.asked).toHaveLength(4);
    expect(core.S!.recap).toEqual(['前情摘要。']);
    const water = core.S!.recapSeq ?? 0;
    expect(water).toBe(Math.max(...core.S!.log.filter((e) => e.cls === 'ai').map((e) => e.id ?? 0)));
  });

  it('不满一批不动模型（归档是慢活，别为两段就发一次）', async () => {
    const sink = { asked: [] as string[] };
    withSummary(async () => '不该被调用', sink);
    const seq0 = start();
    weaveN(2);
    queueNarration(seq0);
    await narrationIdle();
    expect(sink.asked).toHaveLength(0);
    /* 可选字段在新开局里是 undefined，消费方一律 ?? 兜底（hydrate 只在读档时补） */
    expect(core.S!.recap ?? []).toEqual([]);
  });

  it('摘要失败不推进水位——下一批连本批一起再试', async () => {
    const sink = { asked: [] as string[] };
    withSummary(async () => null, sink);
    const seq0 = start();
    weaveN(4);
    queueNarration(seq0);
    await narrationIdle();
    expect(core.S!.recap ?? []).toEqual([]);
    expect(core.S!.recapSeq ?? 0).toBe(0); // 水位没动，这 4 段还在队列里
  });

  it('水位不重复：第二次归档只带新段落', async () => {
    const sink = { asked: [] as string[] };
    withSummary(async () => '摘要', sink);
    const seq0 = start();
    weaveN(4, '甲');
    queueNarration(seq0);
    await narrationIdle();
    expect(sink.asked).toHaveLength(4);
    /* 再攒四段：应当只送新的那四段，不把甲组重发一遍 */
    const seq1 = core.S!.logSeq ?? 0;
    weaveN(4, '乙');
    queueNarration(seq1);
    await narrationIdle();
    expect(sink.asked).toHaveLength(4);
    expect(sink.asked.join('')).toContain('乙');
    expect(sink.asked.join('')).not.toContain('甲');
    expect(core.S!.recap).toEqual(['摘要', '摘要']);
  });
});

describe('跨天归档', () => {
  it('跨天时即使不满一批也归档一次（章边界与天对齐）', async () => {
    const sink = { asked: [] as string[] };
    setAiPort({
      ...ruleSim,
      narrateAsync: async () => null,
      summarizeAsync: async (texts: string[]) => {
        sink.asked = texts;
        return '跨天前情。';
      },
    } as never);
    const seq0 = start();
    core.S!.log.push({ t: '新芽月1日·辰时', text: '第一天的一段正文。', cls: 'ai', id: (core.S!.logSeq = (core.S!.logSeq ?? 0) + 1) });
    queueNarration(seq0);
    await narrationIdle();
    expect(sink.asked).toHaveLength(0); // 只有一段，不满一批

    /* 推进到第二天：跨天检测必须在这时生效 */
    core.S!.t += 200;
    const seq1 = core.S!.logSeq ?? 0;
    core.S!.log.push({ t: '新芽月2日·辰时', text: '第二天的一段正文。', cls: 'ai', id: (core.S!.logSeq = (core.S!.logSeq ?? 0) + 1) });
    queueNarration(seq1);
    await narrationIdle();
    expect(sink.asked.length).toBeGreaterThan(0);
    expect(core.S!.recap ?? []).toEqual(['跨天前情。']);
  });
});

describe('链的健壮性（审查发现）', () => {
  it('端口同步抛错：不污染链，后续操作照常能织，且界面一定解锁', async () => {
    let calls = 0;
    setAiPort({
      ...ruleSim,
      narrateAsync: (() => {
        calls++;
        if (calls === 1) throw new Error('同步炸了'); // 不是 reject，是同步 throw
        return Promise.resolve('第二次织出来的正文。');
      }) as never,
      summarizeAsync: async () => null,
    } as never);
    const seq0 = start();
    mutate.pushLog('第一次的事实', 'nar');
    queueNarration(seq0);
    await narrationIdle();
    expect(calls).toBe(1);
    expect(core.S!.log.some((e) => e.text === '第一次的事实')).toBe(true); // 失败保留原文

    const seq1 = core.S!.logSeq ?? 0;
    mutate.pushLog('第二次的事实', 'nar');
    queueNarration(seq1);
    await narrationIdle();
    /* 链一旦被污染，这里就再也拿不到正文了 */
    expect(core.S!.log.some((e) => e.text.includes('第二次织出来的正文'))).toBe(true);
  });
});

describe('合并窗口的真实时序（用假定时器，不走 narrationIdle 这条测试专用路径）', () => {
  it('掷过骰的这一轮会等满窗口才发请求——异步回流 1450ms 后才写回', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      setAiPort({ ...ruleSim, narrateAsync: async () => { calls++; return '织好的。'; } } as never);
      const seq0 = start();
      mutate.pushLog('观察的原文', 'nar');
      queueNarration(seq0, true); // rolled=true：这一轮掷了骰
      await vi.advanceTimersByTimeAsync(1500);
      expect(calls).toBe(0); // 还没到窗口，一次都不能发
      await vi.advanceTimersByTimeAsync(200);
      expect(calls).toBe(1); // 窗口合上才发
    } finally {
      vi.useRealTimers();
    }
  });

  it('没掷骰的这一轮当场就织，不让玩家白等一秒半', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      setAiPort({ ...ruleSim, narrateAsync: async () => { calls++; return '织好的。'; } } as never);
      const seq0 = start();
      mutate.pushLog('打听的原文', 'nar');
      queueNarration(seq0, false);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
