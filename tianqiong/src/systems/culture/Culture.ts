/* ============================================================
   卡 N4 · 文化判定（世界书 §94–§98）
   —— 禁忌是判定类内容（触犯 → 声望/好感），其余（饮食/服饰/婚丧/娱乐）供叙事与面板直读。
   事件：taboo_violated（→ 各势力/关系系统自行决定怎么反应）。
   ============================================================ */
import raw from '@/data/world/culture.json';
import { WB } from '@/data/worldBook';
import type { WorldState } from '@/types/world';
import { toast, worldBus } from '@/events/EventBus';
import { makeEvent } from '@/events/EventSchema';
import { addRep, log } from '@/systems/character/Gains';
import { confirmSheet } from '@/systems/character/Sheet';
import { sceneTime } from '@/world/WorldClock';
import { need } from '@/world/WorldState';
import { addHistory } from '@/events/EventStore';

interface TabooDef { id: string; continent: string; text: string; penalty: { rep?: Record<string, number> } }
const CFG = raw as unknown as {
  food: Record<string, { staple: string; specialty: string; utensil: string }>;
  attires: { id: string; name: string; tag: string; note: string }[];
  taboos: TabooDef[];
  games: { id: string; name: string; impl: string; done: boolean }[];
};

export const foodOf = (continent: string) => CFG.food?.[continent];
export const attires = () => (CFG.attires ?? []).slice();
export const taboos = (): TabooDef[] => CFG.taboos ?? [];
export const games = () => (CFG.games ?? []).slice();
/** 某大陆的禁忌清单 */
export const taboosOf = (continent: string): TabooDef[] => taboos().filter((t) => t.continent === continent);

/** 玩家所在地的饮食/服饰（面板与叙事直读） */
export function cultureHere(s: WorldState = need()) {
  const cont = WB.locations[s.player.loc]?.continent ?? '';
  return { continent: cont, food: foodOf(cont), taboos: taboosOf(cont) };
}

/** 触犯禁忌：扣声望 + 发事件（各系统自行订阅反应） */
export function violateTaboo(tabooId: string, s: WorldState = need()): boolean {
  const t = taboos().find((x) => x.id === tabooId);
  if (!t) return false;
  const cont = WB.locations[s.player.loc]?.continent ?? '';
  if (cont && t.continent !== cont) {
    toast('这条禁忌属于' + t.continent + '——你现在不在这里。', 'bad');
    return false;
  }
  for (const [f, dv] of Object.entries(t.penalty.rep ?? {})) addRep(f, dv);
  worldBus.emit(
    makeEvent({
      type: 'taboo_violated',
      day: sceneTime(s).day,
      tick: s.t,
      actor: 'player',
      location: s.player.loc,
      cause: t.text,
      level: 1,
      data: { taboo: t.id, continent: t.continent },
    }),
  );
  log('你做了不该做的事：' + t.text + '——周围的人静了一瞬。', 'bad', s);
  addHistory('触犯禁忌：' + t.text, t.continent, 2);
  return true;
}

/* ============================================================
   卡 K3-UI · 风土面板
   禁忌是判定（触犯要扣声望），饮食/服饰/娱乐是叙事素材——两者此前都没有入口，
   玩家只能从 AI 的随机描述里偶然瞥见一鳞半爪。
   ============================================================ */

export function cultureMenu(): void {
  const s = need();
  const v = cultureView(s);
  const food = v.food ? '主食 ' + v.food.staple + '　特产 ' + v.food.specialty + '　餐具 ' + v.food.utensil : '（此地的吃食还没人写过）';
  const dress = v.attires.map((a) => a.name).join('、') || '（未载）';
  const play = v.games.map((g) => g.name).join('、') || '（未载）';
  const btns: { l: string; a: string; id?: string; dg?: boolean }[] = v.taboos.map((t) => ({
    l: '（明知故犯）' + t.text,
    a: 'cu_taboo',
    id: t.id,
    dg: true,
  }));
  btns.push({ l: '（退开）', a: 'close' });
  confirmSheet(
    '风土 · ' + (v.continent || '此地'),
    food + '<br>常见服饰：' + dress + '<br>见得到的玩法：' + play + '<br><br>此地禁忌 ' + v.taboos.length + ' 条——下面每一条都是明知故犯，会当场扣声望。',
    btns,
  );
}

export interface CultureView { continent: string; food: ReturnType<typeof foodOf>; taboos: TabooDef[]; attires: ReturnType<typeof attires>; games: ReturnType<typeof games> }
export function cultureView(s: WorldState = need()): CultureView {
  const h = cultureHere(s);
  return { continent: h.continent, food: h.food, taboos: h.taboos, attires: attires(), games: games() };
}
