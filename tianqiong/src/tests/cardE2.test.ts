/* ============================================================
   卡 E2 · 七大陆地理骨架（世界书 §8/§9）
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { bus, core, rng, scheduler, newGame } from '@/world';
import { MemorySaveRepository } from '@/repo';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';
import { WB } from '@/data/worldBook';
import { go } from '@/actions/ActionExecutor';

beforeEach(() => {
  core.S = null;
  bus.clear();
  setSavePort(new MemorySaveRepository());
  setAiPort(ruleSim);
  const r = rng.seed(13);
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  return r;
});
const start = () => newGame({ name: 'E2', race: 'human', cls: 'warrior' });

describe('卡 E2 · 大陆骨架', () => {
  it('中央大陆 19 处 + 外大陆各 5 处 + 异界 14 处（共 63 地点），每地点都归属某大陆', () => {
    /* 63 = 中央 11+8 · 冻土/群岛/荒野/深渊各 1+4 · 沙漠 1+5 · 浮岛 1+3 · 异界 14。
       NPC 规模化把每个据点从「一个点」铺成「一处据点 + 四五个去处」——
       原先六块外大陆各 1 个地点，要塞进 4–6 个人。 */
    expect(Object.keys(WB.locations).length).toBe(63);
    for (const id of Object.keys(WB.locations)) expect(WB.locations[id].continent).toBeTruthy();
    const hubs = ['frosthold', 'windport', 'goldveil', 'bloodhold', 'deepwell', 'skycap'];
    for (const h of hubs) expect(WB.locations[h].locked).toBe(true);
  });
  it('中央大陆 11 地点未锁，可正常通行', () => {
    expect(WB.locations.plaza.locked).toBeFalsy();
    expect(WB.locations.wild.locked).toBeFalsy();
  });
  it('go() 拒绝前往待开拓大陆，位置不变', () => {
    start();
    const before = core.S!.player.loc;
    go('frosthold');
    expect(core.S!.player.loc).toBe(before);
  });
  it('旧可达路径不破：广场→酒馆仍耗时 1 刻', () => {
    start();
    const t0 = core.S!.t;
    go('tavern');
    expect(core.S!.player.loc).toBe('tavern');
    expect(core.S!.t).toBe(t0 + 1);
  });
});
