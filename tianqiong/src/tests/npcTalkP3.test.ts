/* ============================================================
   P3 深谈（《NPC 立体化与深入对话方案》§4.3）的回归防线。
   守四条主张（每一条都曾经是错的，靠肉眼看不出来，只能断言）：

   ① 进展落档：问过几次记在状态里（talkProg），**不随对话窗口裁剪而回退**——
      窗口有 CAP_TURNS=20 封顶，从窗口里数会在满窗之后掉头向下，深水区当场退回表层；
   ② 谈透才解锁：图鉴 lore_unlocked 只在话题首次进到第 3 层时发一次
      （此前每轮交谈都发，「深谈解锁」的门形同虚设）；
   ③ 深水区带代价（用户 2026-09-27 裁决）：基线是逼问一次好感 -1，且**只付一次**；
   ④ 层数现算、次数单调：关系回落时「他这次不肯说了」，但计数不倒退。
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { bus, core, newGame, resetWorld, rng, scheduler } from '@/world';
import { worldBus } from '@/events/EventBus';
import { MemorySaveRepository } from '@/repo';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { registerSystemSubscriptions } from '@/plugins/subscriptions';
import { ruleSim } from '@/ai/ruleSim';
import { chatChips, sendChat } from '@/systems/npc/Chat';
import { TALK_MAX_KEYS, markAsked } from '@/systems/npc/Talk';
import { loadTalk, talkOf } from '@/data/talk';
import { npcAt } from '@/systems/npc/Npcs';
import { mutate } from '@/world/WorldMutate';

const NPC = 'kael';
const labelOf = () => talkOf(NPC)[0].l;
const attNow = () => core.S!.npcs[NPC].att;
const progOf = () => core.S!.npcs[NPC].talkProg ?? {};
const deepOf = () => core.S!.npcs[NPC].talkDeep ?? [];

/** 玩家跟着他走：每 3 轮交谈会推进 1 刻，时辰一变位置就变——不跟着就发不出话 */
function say(text: string): void {
  const where = npcAt(NPC, core.S!);
  if (where) core.S!.player.loc = where;
  sendChat(NPC, text);
}

beforeEach(async () => {
  core.S = null;
  core.CB = null;
  resetWorld();
  setSavePort(new MemorySaveRepository());
  setAiPort(ruleSim);
  bus.clear();
  rng.seed(21);
  /* 谈透要走 worldBus 的 lore_unlocked → 订阅式装配的固有前提：不装配就没人响应 */
  registerSystemSubscriptions();
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  newGame({ name: '深谈者', race: 'human', cls: 'mage' });
  await loadTalk(NPC);
  mutate.npcAtt(NPC, 50); // 凯尔的卡 gate.att 全是 45：先把好感推过门槛
});

describe('P3 · 落档与层进', () => {
  it('三次问同一话题：次数记在状态里，第三次进深水区并留下谈透记录', () => {
    say(labelOf());
    expect(progOf()[labelOf()], '第一次问就要落档').toBe(1);
    say(labelOf());
    say(labelOf());
    expect(progOf()[labelOf()]).toBe(3);
    expect(deepOf(), '过了 gate 的第三次应当谈透').toContain(labelOf());
  });

  it('窗口写满也不回退：连问 25 次后标记仍在，且该标签不再回到追问 chips', () => {
    for (let i = 0; i < 25; i++) say(labelOf());
    expect(progOf()[labelOf()], '次数只增不减——这正是「不能从窗口里数」的理由').toBe(25);
    expect(deepOf()).toContain(labelOf());
    expect(chatChips(NPC), '问过的话题不该重新冒出来').not.toContain(labelOf());
  });

  it('关系回落 → 他这次不肯说（层数现算），但次数不倒退', () => {
    say(labelOf());
    say(labelOf());
    say(labelOf());
    expect(deepOf()).toContain(labelOf());
    mutate.npcAtt(NPC, -50); // att 50 → 0：gate.att 45 不再满足
    const before = progOf()[labelOf()];
    say(labelOf());
    expect(progOf()[labelOf()], '次数是单调的').toBe(before + 1);
    expect(deepOf().filter((x) => x === labelOf()).length, '谈透记录不重复、也不倒退').toBe(1);
  });
});

describe('P3 · 谈透才解锁 · 代价只付一次', () => {
  it('图鉴解锁发一次；基线代价 -1 好感也只付一次', () => {
    /* 用零 attDelta 的假 port：把「聊天本身的好感增益」摘掉，
       只剩谈透的代价——否则日封顶与 ruleSim 的 +1 会糊在一起，断言说不清是哪一条生效。 */
    setAiPort({ ...ruleSim, chat: () => ({ line: '（他沉默了一下。）' }) });
    let unlocks = 0;
    const off = worldBus.on('lore_unlocked', () => {
      unlocks++;
    });
    const a0 = attNow();
    say(labelOf());
    say(labelOf());
    say(labelOf());
    expect(unlocks, '谈透一次 → 解锁一次').toBe(1);
    expect(attNow(), '基线代价：逼问一次 -1').toBe(a0 - 1);
    expect(
      core.S!.log.some((l) => l.cls === 'ai' && l.text.includes('谈到了底')),
      '谈透入见闻录：对话进故事正史（编织→前情），不只活在浮层里',
    ).toBe(true);
    say(labelOf()); // 第 4 次：仍然说得到深水区，但不重复结算
    expect(unlocks, '同一个话题只解锁一次').toBe(1);
    expect(attNow(), '代价只付一次').toBe(a0 - 1);
    off();
  });

  it('没过 gate 就不解锁图鉴（旧的「每轮都发」已废）', () => {
    let unlocks = 0;
    const off = worldBus.on('lore_unlocked', () => {
      unlocks++;
    });
    mutate.npcAtt(NPC, -60); // att 50 → -10
    say(labelOf());
    say(labelOf());
    say(labelOf());
    expect(unlocks, 'gate 不过就停在 inner，谈不透自然不解锁').toBe(0);
    expect(deepOf()).not.toContain(labelOf());
    off();
  });
});

describe('P3 · 落档键数封顶', () => {
  it('talkProg 最多 8 键：超了先丢问得最少的那条（并列按字典序，保持确定性）', () => {
    const s = core.S!;
    for (let i = 0; i < 9; i++) markAsked(s, NPC, '标签' + i);
    const keys = Object.keys(s.npcs[NPC].talkProg!);
    expect(keys.length).toBe(TALK_MAX_KEYS);
    expect(keys.includes('标签0'), '最冷的那条（只问过一次、字典序最前）该被挤掉').toBe(false);
  });
});
