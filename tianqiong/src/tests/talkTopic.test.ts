/* ============================================================
   P2 话题层（《NPC 立体化与深入对话方案》§4.2）的回归防线。
   守三条主张：
   ① 命中是**确定性**的——点 chip 必中，乱说不会误中；
   ② 层进由「问过几次 + 好感门槛」决定，不掷随机；
   ③ 谈过的话题换成追问钩子，追问链才长得出来。
   这三条都无法靠肉眼验收（要连点三次并盯住文本变化），只能断言。
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { bus, core, rng, scheduler } from '@/world';
import { newGame } from '@/world/WorldRuntime';
import { MemorySaveRepository } from '@/repo';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';
import { hasTalk, loadTalk, talkOf } from '@/data/talk';
import { chatChips, matchTopic, sendChat, topicDepth } from '@/systems/npc/Chat';
import { npcAt } from '@/systems/npc/Npcs';
import type { ChatCtx } from '@/plugins/PluginInterface';
import type { NpcTopicCard } from '@/types/world';

const NPC = 'kael';

beforeEach(async () => {
  core.S = null;
  core.CB = null;
  bus.clear();
  setSavePort(new MemorySaveRepository());
  setAiPort(ruleSim);
  rng.seed(11);
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  newGame({ name: '话题', race: 'human', cls: 'warrior' });
  await loadTalk(NPC);
});

describe('话题卡（懒加载）', () => {
  it('kael 有卡，且每张都至少有一层应答', () => {
    expect(hasTalk(NPC)).toBe(true);
    const cards = talkOf(NPC);
    expect(cards.length).toBeGreaterThan(0);
    for (const c of cards) expect(c.say.trim().length, c.l).toBeGreaterThan(4);
  });

  it('没有卡的 NPC 返回空表而不是抛错', async () => {
    expect(await loadTalk('查无此人')).toEqual([]);
  });
});

describe('命中规则（确定性，不掷随机）', () => {
  it('点 chip = 标签精确匹配', () => {
    const l = talkOf(NPC)[0].l;
    expect(matchTopic(NPC, l)?.l).toBe(l);
  });

  it('自然语句命中标签关键词', () => {
    expect(matchTopic(NPC, '皇权与殿权这事，你怎么看')?.l).toBe('皇权与殿权');
  });

  it('风马牛不相及的话不误中', () => {
    expect(matchTopic(NPC, '今天天气不错啊')).toBeNull();
  });
});

describe('层进：问几次说多深', () => {
  const card = { l: 'x', say: 'A', inner: 'B', core: 'C', gate: { att: 45 } } as unknown as NpcTopicCard;

  it('第一次 say → 第二次 inner → 第三次且过 gate 才 core', () => {
    expect(topicDepth(card, 1, 0)).toBe(0);
    expect(topicDepth(card, 2, 0)).toBe(1);
    expect(topicDepth(card, 3, 44)).toBe(1); // 好感不够，卡在 inner
    expect(topicDepth(card, 3, 45)).toBe(2); // 过门槛
  });
});

describe('追问链', () => {
  it('谈过的话题不再出标签，改出它的 next 钩子', () => {
    const first = talkOf(NPC)[0];
    expect(chatChips(NPC)).toContain(first.l);
    /* P3：判据从「扫对话窗口里玩家说过的话」改成「落档计数」（see systems/npc/Talk.ts）——
       窗口有 CAP_TURNS 封顶，满窗之后最老的提问会被丢掉、问过的标签会重新冒出来。
       所以这里走真实路径问一次（sendChat → matchTopic → markAsked），而不是往窗口里塞一条。 */
    const s = core.S!;
    const where = npcAt(NPC, s);
    if (!where) throw new Error('测试前提：' + NPC + ' 此刻不在任何地点，无法验证追问链');
    s.player.loc = where;
    sendChat(NPC, first.l);
    const after = chatChips(NPC);
    expect(after).not.toContain(first.l);
    for (const n of first.next ?? []) expect(after, '追问钩子 ' + n + ' 没出现').toContain(n);
  });
});

/* ============================================================
   P2 有模型路径：话题卡要从「定稿文本」降级为「素材 + 边界」喂给 AI。
   这条路径在无模型环境**跑不到**（chatAsync 不会被调用），所以用假 port 把
   ChatCtx 截出来——否则 facts/edge 到底有没有传出去，永远没人知道。
   ============================================================ */
describe('话题素材进 prompt（有模型路径）', () => {
  it('命中话题时 ctx.topic 带上 facts 与 edge；层号随追问推进', async () => {
    const s = core.S!;
    /* 在场是 sendChat 的前置条件：把玩家挪到这名 NPC 此刻所在的地方 */
    const where = npcAt(NPC, s);
    if (!where) throw new Error('测试前提：' + NPC + ' 此刻不在任何地点，无法验证 talk 路径');
    s.player.loc = where;

    const seen: ChatCtx[] = [];
    setAiPort({
      ...ruleSim,
      chatAsync: (_id: string, ctx: ChatCtx) => {
        seen.push(ctx);
        return Promise.resolve({ line: '（AI 措辞）' });
      },
    } as unknown as typeof ruleSim);

    const label = talkOf(NPC)[0].l;
    sendChat(NPC, label);
    await Promise.resolve();
    await Promise.resolve();

    expect(seen.length, 'chatAsync 没被调用——命中话题后应当交给 AI 措辞').toBeGreaterThan(0);
    const t = seen[0].topic;
    expect(t?.l).toBe(label);
    expect(t?.layer).toBe(0);
    expect(t?.facts && t.facts.length, 'facts 没传出去，AI 就没有展开范围').toBeGreaterThan(2);
    expect(t?.edge, 'edge 没传出去，AI 就不知道边界在哪').toBeTruthy();

    /* 再问一次同一个话题：层号应当推进到 1，且「已说过的」里带上第一层 */
    sendChat(NPC, label);
    await Promise.resolve();
    await Promise.resolve();
    const t2 = seen[seen.length - 1].topic;
    expect(t2?.layer).toBe(1);
    expect(t2?.said).toContain(talkOf(NPC)[0].say);
  });
});

