/* ============================================================
   卡 H2 · 星渊暗线（lore §13）：star6 入口 + 五级魔气渗入 + 三方阴谋链
   - leak 0–5 全数据驱动（abyss.json.leakLevels）；abyssTick 挂 time.newDay
   - leak≥openAtLeak：星渊入口开放（engine 路由 abyss_menu；入口立于深井城的星枢六塔 · 卡 C2）
   - leak≥crisisAtLeak：置 flag leak_3 → D4 事件引擎级联 abyss_crisis
     （events.json：abyss_leak_1 → abyss_probe → study↔shadow 敌意激化 → crisis）
   - 封印：消耗封魔符压低 leak（神殿/古研会声望上升），可反复拉锯
   铁律：后果全在 core；AI 只拿 loreRef(s13) canon 润色，不创设定。
   ============================================================ */
import raw from '@/data/world/abyss.json';
import { WB } from '@/data/worldBook';
import type { WorldState } from '@/types/world';
import { rng, toast, worldBus } from '@/events/EventBus';
import { makeEvent } from '@/events/EventSchema';
import { startCombat } from '@/systems/combat/Combat';
import { entryAt } from '@/systems/dungeon/Dungeon';
import { towerLocalGate } from '@/systems/starnet/Towers';
import { addRep, addItem, log, removeItem } from '@/systems/character/Gains';
import { confirmSheet } from '@/systems/character/Sheet';
import { mutate } from '@/world/WorldMutate';
import { need, sync } from '@/world/WorldState';
import { advance, sceneTime } from '@/world/WorldClock';
import { addHistory } from '@/events/EventStore';

interface AbyssCfg {
  leakLevels: { id: number; name: string; desc: string }[];
  dailyLeakChance: { base: number; active: number; sealedRelief: number };
  probe: { costTicks: number; combatChance: number; marrowChance: number };
  seal: { needItem: string; leakCut: number; rep: Record<string, number>; minLeak: number };
  openAtLeak: number;
  crisisAtLeak: number;
}
const CFG = raw as unknown as AbyssCfg;

export const ensureAbyss = (s: WorldState) => {
  if (!s.abyss) s.abyss = { leak: 0, sealed: 0 };
  return s.abyss;
};
export const leakLevel = (s: WorldState = need()): number => ensureAbyss(s).leak;
export const leakName = (lv: number): string => CFG.leakLevels[Math.min(5, Math.max(0, lv))]?.name ?? '未知';
export const leakDesc = (lv: number): string => CFG.leakLevels[Math.min(5, Math.max(0, lv))]?.desc ?? '';
/** star6 入口是否开放（leak≥openAtLeak） */
export const isOpen = (s: WorldState = need()): boolean => leakLevel(s) >= CFG.openAtLeak;

/** 每日魔气 tick（time.newDay 调用；seed 确定性）：leak 缓慢爬升，封印可压制 */
export function abyssTick(s: WorldState): void {
  const a = ensureAbyss(s);
  if (a.leak >= 5) return; // 裂隙已开：封顶（终局内容，阶段 I 处理）
  const c = CFG.dailyLeakChance;
  const chance = a.sealed > 0 && rng.chance(c.sealedRelief) ? 0 : a.leak >= 1 ? c.active : c.base;
  if (chance > 0 && rng.chance(chance)) {
    a.leak++;
    if (a.leak === 1) log('夜半，星枢六塔的方向泛起一线黑雾。你腕上的星符微微发烫。', 'ai', s);
    else if (a.leak === CFG.crisisAtLeak) {
      mutate.playerFlag('leak_3'); // D4：abyss_crisis 触发门
      log('星渊魔气已侵蚀成患——裂隙的轮廓在六塔深处隐现。', 'bad', s);
      /* §12 Level 3：裂隙临界是复杂世界事件——进入 World Reasoner 推演，而非由任何单个系统处理。
         leak 单调递增，故本条只会在跨过阈值的那一天触发一次。 */
      worldBus.emit(
        makeEvent({
          type: 'abyss_breach',
          day: sceneTime(s).day,
          tick: s.t,
          location: s.player.loc,
          cause: 'leak_crisis',
          data: { leak: a.leak, threshold: CFG.crisisAtLeak },
        }),
      );
    } else log('星渊的魔气又浓了一分（' + leakName(a.leak) + '）。', 'sys', s);
  }
}

/* ---------------- 演出与交互（复用 ConfirmSheet，零新增 React 组件） ---------------- */

/** 星渊入口菜单（engine 路由 sn_abyss / abyss_menu） */
export function abyssMenu(): void {
  const s = need();
  /* 卡 C2 七塔分置：星渊是「星枢六塔深处的隐藏层」（§13），塔的功能各归其城——
     面板只在深井城开。网只传心念不传实物（§10），意识投影到不了塔的地下层。 */
  const far = towerLocalGate('abyss', s);
  if (far) {
    toast(far, 'bad');
    return;
  }
  if (!isOpen(s)) {
    toast('封印之下的低语隐约可闻……但星渊之门尚未开启。', 'bad');
    return;
  }
  const lv = leakLevel(s);
  const btns: { l: string; a: string; dg?: boolean }[] = [
    { l: '深入探查（' + CFG.probe.costTicks + ' 刻 · 有遭遇风险）', a: 'abyss_probe' },
  ];
  if (lv >= CFG.seal.minLeak) {
    const has = s.player.bag.some((x) => x.id === CFG.seal.needItem);
    btns.push({ l: '尝试封印（需' + WB.items[CFG.seal.needItem].name + (has ? '·已备' : '·未备') + '）', a: 'abyss_seal', dg: !has });
  }
  /* 卡 C2：星渊之门就立在星枢六塔（深井城）之底（§9）——它不再是虚拟入口，
     要亲身走到那儿才能踏入；此处只负责把通路摆出来。 */
  const gate = entryAt('deepwell');
  if (gate && s.player.flags.star6_unlocked) {
    btns.push({ l: '踏入星渊之门（自第 ' + gate.startFloor + ' 层切入）', a: 'abyss_gate' });
  } else if (gate) {
    log('星渊之门的轮廓在六塔之底隐现——但门还未真正开启。', 'sys', s);
  }
  btns.push({ l: '（退开）', a: 'close' });
  confirmSheet(
    '星枢六塔 · 星渊（' + leakName(lv) + '）',
    leakDesc(lv) + '<br>魔气浓度：' + lv + ' / 5' + (lv >= CFG.crisisAtLeak ? '　·　<span class="no">裂隙临界</span>' : ''),
    btns,
  );
}

/** 深入探查：耗刻推进 + 概率遭遇深渊裔 / 拾获星髓 */
export function probeAbyss(): void {
  const s = need();
  if (!isOpen(s)) return;
  const a = ensureAbyss(s);
  advance(CFG.probe.costTicks);
  if (rng.chance(CFG.probe.combatChance) || a.leak >= 4) {
    log('六塔最深处的黑暗里，有东西醒了——深渊裔扑面而来！', 'bad', s);
    sync();
    startCombat(['abyss_spawn']);
    return;
  }
  if (rng.chance(CFG.probe.marrowChance)) {
    addItem('star_marrow');
    log('你在地脉的裂缝边缘剥下一块微光流转的晶髓——星髓。', 'gain', s);
    addHistory('探查星渊', '获得星髓', 2);
  } else {
    log('你在六塔的回廊里搜索了半日。黑气无声流动，除了满手的寒意，一无所获。', 'nar', s);
  }
  sync();
}

/** 封印：消耗封魔符，leak 压低一档；神殿与古研会声望上升 */
export function sealAbyss(): void {
  const s = need();
  const a = ensureAbyss(s);
  if (a.leak < CFG.seal.minLeak) {
    toast('魔气未至侵蚀，无须浪费封印。', '');
    return;
  }
  if (!removeItem(CFG.seal.needItem)) {
    toast('缺少' + WB.items[CFG.seal.needItem].name + '——神殿圣物台或有售。', 'bad');
    return;
  }
  a.sealed++;
  a.leak = Math.max(0, a.leak - CFG.seal.leakCut);
  for (const f in CFG.seal.rep) addRep(f, CFG.seal.rep[f]);
  log('封魔符在裂隙前燃成金色的灰。黑气退了半分——但这只是拉锯的开始。', 'gain', s);
  addHistory('封印星渊（第 ' + a.sealed + ' 次）', '魔气浓度回落至 ' + a.leak, 4);
  sync();
}
