/* ============================================================
   聊天窗口（卡片6）单元测试
   覆盖：门禁（敌意拒开/不在场）· 话题分级 · 双日封顶 · LLM 通道
   attDelta 白名单 · 传闻 spreadRumor 传播 · 轮次计时 · 旧档 hydrate · 降级同构
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { bus, core, dispatch, importState, newGame, resetWorld, rng, scheduler } from '@/world';
import { memOf } from '@/memory';
import { MemorySaveRepository } from '@/repo';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { registerSystemSubscriptions } from '@/plugins/subscriptions';
import { ruleSim } from '@/ai/ruleSim';
import { gateway } from '@/ai/gateway';
import { chatChips, chatTier, openChat, sendChat } from '@/systems/npc/Chat';
import { go } from '@/actions/ActionExecutor';
import type { SheetDesc } from '@/types/uispec';

let sheet: SheetDesc | null | 'unset' = 'unset';

beforeEach(() => {
  core.S = null;
  core.CB = null;
  resetWorld();
  setSavePort(new MemorySaveRepository());
  setAiPort(ruleSim);
  bus.clear();
  sheet = 'unset';
  bus.on((e) => {
    if (e.type === 'sheet') sheet = e.desc;
  });
  rng.seed(7);
  /* §21：传闻扩散与深谈解锁走 worldBus 事件（二期 H-09 把 Chat 的直调改成 emit）——
     订阅式装配的固有前提：不装配就没人响应。 */
  registerSystemSubscriptions();
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
});

const start = (name = '闲谈者') => newGame({ name, race: 'human', cls: 'mage' });
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('聊天窗口·门禁与分级', () => {
  it('chatTier 四档边界', () => {
    expect(chatTier(-60)).toBe('hostile');
    expect(chatTier(10)).toBe('cold');
    expect(chatTier(30)).toBe('neutral');
    expect(chatTier(50)).toBe('warm');
  });
  it('开窗产出 chat 描述符；warm 私密话题在普通好感下隐藏', () => {
    start();
    openChat('mia');
    expect(sheet !== 'unset' && sheet !== null && sheet.kind === 'chat').toBe(true);
    const chips = (sheet as Extract<SheetDesc, { kind: 'chat' }>).chips;
    expect(chips.length).toBeGreaterThanOrEqual(2);
    expect(chips.includes('弟弟的病')).toBe(false);
    expect(chips.includes('报纸头条')).toBe(true);
  });
  it('友好档解锁私密话题 chips', () => {
    start();
    core.S!.npcs.mia = { att: 50, mem: [], met: true };
    expect(chatChips('mia').includes('弟弟的病')).toBe(true);
  });
  it('敌意档拒开：回 dialog 拒绝文本，不产 chat 窗口', () => {
    start();
    core.S!.npcs.mia = { att: -60, mem: [], met: true };
    openChat('mia');
    const d = sheet as Extract<SheetDesc, { kind: 'dialog' }>;
    expect(d.kind).toBe('dialog');
    expect(d.text.includes('背过身去')).toBe(true);
  });
  it('NPC 不在场拒开', () => {
    start();
    openChat('ash'); // 灰烬在深巷且需 needFlag，广场够不着
    const d = sheet as Extract<SheetDesc, { kind: 'dialog' }>;
    expect(d.kind).toBe('dialog');
    expect(d.text.includes('不在你能找到的地方')).toBe(true);
  });
});

describe('聊天窗口·会话经济', () => {
  it('发言产出双气泡入档；neutral 档规则池不涨好感（无 farm）', () => {
    start();
    openChat('mia');
    for (let i = 0; i < 5; i++) sendChat('mia', '你好' + i);
    expect(core.S!.chats!.mia.length).toBe(10);
    expect(core.S!.chats!.mia[0].who).toBe('p');
    expect(core.S!.npcs.mia.att).toBe(0);
  });
  it('warm 档好感日封顶 +2（连聊 5 次不越界）', () => {
    start();
    core.S!.npcs.mia = { att: 50, mem: [], met: true };
    openChat('mia');
    for (let i = 0; i < 5; i++) sendChat('mia', '闲聊' + i);
    expect(core.S!.npcs.mia.att).toBeLessThanOrEqual(52);
  });
  it('每 3 轮玩家发言推进 1 刻', () => {
    start();
    openChat('mia');
    const t0 = core.S!.t;
    sendChat('mia', 'a');
    sendChat('mia', 'b');
    expect(core.S!.t).toBe(t0); // 2 轮不耗时
    sendChat('mia', 'c');
    expect(core.S!.t).toBeGreaterThan(t0); // 第 3 轮 +1 刻
  });
  it('LLM 通道：attDelta 越界钳制到 +2，台词入档', async () => {
    start();
    core.S!.npcs.mia = { att: 50, mem: [], met: true };
    gateway.use({ ...ruleSim, chatAsync: async () => ({ line: '测试台词', attDelta: 9 }) });
    openChat('mia');
    sendChat('mia', '在吗');
    await flush();
    expect(core.S!.chats!.mia.some((t) => t.text === '测试台词')).toBe(true);
    expect(core.S!.npcs.mia.att).toBe(52); // 9→clamp 2
    gateway.use(ruleSim);
  });
  it('LLM 失败降级规则池（busy 收束且有回应）', async () => {
    start();
    gateway.use({ ...ruleSim, chatAsync: async () => null });
    openChat('mia');
    sendChat('mia', '随便聊聊');
    await flush();
    expect(core.S!.chats!.mia.length).toBe(2);
    gateway.use(ruleSim);
  });
  it('rumor 沿 rels 关系网一跳传播（joe→lita debtor 边）', async () => {
    start();
    core.S!.t = 32; // 卯正→辰时 8：老乔在酒馆
    go('tavern');
    core.S!.npcs.joe = { att: 50, mem: [], met: true };
    gateway.use({ ...ruleSim, chatAsync: async () => ({ line: '嗝。', rumor: '他被人看见在深巷张望' }) });
    openChat('joe');
    sendChat('joe', '最近怎样');
    await flush();
    expect(memOf('lita', core.S!).some((m) => m.event.includes('传闻'))).toBe(true);
    gateway.use(ruleSim);
  });
});

describe('聊天窗口·异步回包不重开（F-17）', () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('发送后立刻关窗：延迟回包不得弹回窗口，好感与记忆仍落地', async () => {
    start();
    core.S!.npcs.mia = { att: 50, mem: [], met: true };
    gateway.use({
      ...ruleSim,
      chatAsync: async () => {
        await wait(40);
        return { line: '迟到的回话', attDelta: 1, mem: '你问过他弟弟的近况' };
      },
    });
    openChat('mia');
    sendChat('mia', '在吗');
    dispatch({ type: 'ui', a: 'close', p: {} }); // 走引擎的真实关闭路径
    sheet = 'unset';
    await wait(90);
    expect(sheet).toBe('unset'); // 回包没有重开窗口
    expect(core.S!.npcs.mia.att).toBe(51);
    expect(memOf('mia', core.S!).some((m) => m.event.includes('近况'))).toBe(true);
    gateway.use(ruleSim);
  });

  it('NPC 已离场：回包只落记忆与好感，不写对话轮次、不重开窗', async () => {
    start();
    core.S!.npcs.mia = { att: 50, mem: [], met: true };
    gateway.use({
      ...ruleSim,
      chatAsync: async () => {
        await wait(30);
        return { line: '嗯。', attDelta: 1, mem: '离场后的回包' };
      },
    });
    openChat('mia');
    sendChat('mia', '在吗');
    const before = core.S!.chats!.mia.length;
    core.S!.player.loc = 'wild'; // 玩家走远，NPC 不在场
    sheet = 'unset';
    await wait(70);
    expect(core.S!.chats!.mia.length).toBe(before);
    expect(memOf('mia', core.S!).some((m) => m.event === '离场后的回包')).toBe(true);
    expect(sheet).toBe('unset');
    gateway.use(ruleSim);
  });

  it('窗口仍开着：回包正常刷新（不能把功能改死）', async () => {
    start();
    core.S!.npcs.mia = { att: 50, mem: [], met: true };
    gateway.use({ ...ruleSim, chatAsync: async () => ({ line: '正常的回话', attDelta: 1 }) });
    openChat('mia');
    sendChat('mia', '在吗');
    await flush();
    expect(core.S!.chats!.mia.some((t) => t.text === '正常的回话')).toBe(true);
    expect(sheet !== 'unset' && sheet !== null && sheet.kind === 'chat').toBe(true);
    expect((sheet as Extract<SheetDesc, { kind: 'chat' }>).busy).toBe(false);
    gateway.use(ruleSim);
  });
});

describe('聊天窗口·存档', () => {
  it('旧档（无 chats/bondDay）导入后聊天可用，hydrate 懒补默认', () => {
    start();
    const s0 = JSON.parse(JSON.stringify(core.S!)) as Record<string, unknown>;
    delete s0.chats;
    delete s0.bondDay;
    resetWorld();
    core.S = null;
    expect(importState(JSON.stringify(s0))).toBe(true);
    openChat('mia');
    sendChat('mia', '回来了');
    expect(core.S!.chats!.mia.length).toBe(2);
  });
  it('窗口历史封顶 20 轮（超出丢最旧）', () => {
    start();
    openChat('mia');
    for (let i = 0; i < 12; i++) sendChat('mia', '话' + i); // 24 条
    expect(core.S!.chats!.mia.length).toBe(20);
    expect(core.S!.chats!.mia[0].text).not.toBe('话0');
  });
});
