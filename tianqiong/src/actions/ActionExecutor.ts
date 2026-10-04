/* ============================================================
   场景行动（原型 §场景行动：go/observe/search/gather/explore/
   rest/drink/pray/heal/steal —— 全部经规则引擎改写 WorldState）
   ============================================================ */
import { WB } from '@/data/worldBook';
import { rng, toast, worldBus } from '@/events/EventBus';
import { makeEvent } from '@/events/EventSchema';
import { maxHp, maxMp, mod } from '@/systems/character/Derived';
import { addRep, addItem, gainGold, itemCount, log, removeItem } from '@/systems/character/Gains';
import { check } from '@/dice/CheckResolver';
import { observeUnlock } from '@/systems/codex/Codex';
import { discoverRuin } from '@/systems/dungeon/Dungeon';
import { formatMoney } from '@/systems/economy/Money';
import { arrest, commitCrime, lawStrictness } from '@/systems/law/Law';
import { addIntelGather, addIntelObserve, doubtMark, guardChance, infoReveal, settleAxes, templeFee, templeServiceOk } from '@/systems/faction/Diplomacy';
import { HOME_TEMPLE, adjRepAxis } from '@/systems/faction/Factions';
import { addMem, adjAtt, npcAt, presentNPCs } from '@/systems/npc/Npcs';
import { canMeet, markMet, passersbyAt } from '@/systems/npc/Passersby';
import { ai } from '@/plugins/PluginInterface';
import { confirmSheet } from '@/systems/character/Sheet';
import { need, sync } from '@/world/WorldState';
import { mutate } from '@/world/WorldMutate';
import { advance, sceneTime, shichenOf, tillMorning } from '@/world/WorldClock';
import { onlineGate } from '@/systems/starnet/StarNet';
import { startCombat } from '@/systems/combat/Combat';
import { addHistory } from '@/events/EventStore';
import { canEnter, continentLockReason, continentOf, enterZone, zonesOf } from '@/systems/travel/Travel';
import { hasAbility } from '@/data/regions';
import type { WorldState } from '@/types/world';

/** 移动（原型 go：行程耗时→夜袭狼→通缉盘查→进入叙事） */
/**
 * 卡 C1 · 定神的统一写入口。
 * 「入网期间本体留守」约束的不是某一个动作，而是**全部现实动作**（§10）。
 * 与其在每个函数里各写一遍，这里给一个守卫：命中就提示并返回 true（=已拦下）。
 */
export function netBlocked(what: string): boolean {
  const why = onlineGate(what);
  if (!why) return false;
  toast('✖ ' + why, 'bad');
  return true;
}

export function go(loc: string) {
  if (netBlocked('离城远行或换地方')) return;
  const s = need();
  settleAxes(s); // 卡 I4：场景行动边界先把已发生的战功/情报落地
  /* 卡 J5：locked 不再是永久锁。此前这里是它的唯一消费点且永远返回，
     没有任何解除路径（注释写着「E3 跨大陆交通后再解锁」，而 E3 早已完工）。
     现在它只表示「这里归某块待开拓的大陆管」，判定交给数据驱动的大陆解锁条件。 */
  if (!canEnter(loc, s)) {
    const c = continentOf(loc);
    const why = (c && continentLockReason(c, s)) || '那是待开拓的大陆';
    /* 落见闻录而不只 toast：toast 两秒即逝，回看时只剩回显行（可玩性实测抓到） */
    log('通往「' + (WB.locations[loc]?.name ?? loc) + '」的路还没开——' + why, 'nar');
    return;
  }
  const cost = WB.travel[s.player.loc] && WB.travel[s.player.loc][loc];
  if (cost == null) {
    /* bad 而不是 nar（2026-09-29）：「没走成」是负面结果，正文的润色必须如实交代
       （提示词钉了「结算不得反转」），但它得先知道这是失败——事实清单里要带标。 */
    log('那里目前无法直接前往——你还在原地。城里得沿街巷走，先到相邻的街区再转。', 'bad');
    return;
  }
  advance(cost);
  mutate.playerLoc(loc);
  const h = shichenOf(s.t);
  /* 地区规整：问能力，不问地名。新增野外地区只要标 wilderness 就自动获得夜间风险。 */
  if (hasAbility(loc, 'wilderness') && (h >= 10 || h < 4) && rng.d(20) >= 16) {
    log('夜色里的旷野传来狼嚎——你撞上了一头灰纹狼。', 'nar');
    startCombat(['wolf']);
    sync();
    return;
  }
  // 卡 F：通缉或高帝国敌意都会被城卫盯上，概率随二者上升
  const watch = s.player.wanted > 0 || guardChance(s) > 0.3;
  /* 城卫盘查的范围由地点能力决定，而不是写死地区名——「帝国辖区」是一个可标注的属性，
     不是这座城独有的代码分支。 */
  if (watch && hasAbility(loc, 'patrolled') && rng.chance(guardChance(s))) {
    guardStop();
    sync();
    return;
  }
  /* 卡 N1 · 违禁品：禁货在有人盘查的地方走一趟，是要付代价的。
     与上面那条通缉盘查分开判——通缉是「人被抓到了」，违禁品是「包被翻开了」；
     两件事的应对方式不同（前者靠口才，后者靠藏），合成一条玩家就分不清自己在躲什么。 */
  if (hasAbility(loc, 'patrolled') && rng.chance(contrabandChance(s))) {
    contrabandStop();
    sync();
    return;
  }
  // 卡 F 下游：被逐出圣光者踏入神殿 → 圣殿守卫当场拿下
  if (hasAbility(loc, 'sacred') && s.player.flags.heretic) {
    log('圣殿守卫的银甲在彩窗下泛起寒光——「异端！」长戟封住了出口。', 'bad');
    startCombat(['templar']);
    sync();
    return;
  }
  log('（' + cost + '刻后）' + ai().narrative('enter', { loc }), 'nar');
  const ps = presentNPCs(loc);
  if (ps.length) log('你注意到 ' + ps.map((n) => n.title.split('·')[0] + '·' + n.name).join('、') + ' 在这里。', 'nar');
  sync();
}

/** 通缉状态下的城卫盘查（原型 guardStop） */
export function guardStop() {
  const s = need();
  log('一名城卫拦住去路——他的目光落在你脸上，又对照了腰间的画像。', 'bad');
  check(
    '城卫盘查·周旋',
    '魅力',
    12 + s.player.wanted * 2,
    (r) => {
      if (r.ok) log('你面不改色地编了个赶集理由。城卫挥手放行——但眼神仍带怀疑。', 'nar');
      else {
        log('「就是你！」哨声尖锐响起。你被押进了岗哨。', 'bad');
        arrest();
      }
      sync();
    },
    '兽人在帝国律下受额外盘查（世界书·法律）',
  );
}

/* ---------------- 卡 N1 · 违禁品 ---------------- */

/** 行囊里的违禁品（illegal 标记的那些） */
export const contrabandOf = (s: WorldState = need()): string[] =>
  s.player.bag.filter((x) => WB.items[x.id]?.illegal).map((x) => x.id);

/**
 * 被翻出来的概率：治安越严越藏不住，带得越多越容易露。
 *
 * 治安档取自 lawStrictness（大陆的 1–5 档）——与罚金、引渡用的是同一套地理口径，
 * 不为违禁品另立一份。上限 0.85：永远留一线运气，否则「带着禁货过城门」
 * 就成了一道必然的墙，玩家能做的只剩绕路。
 */
export function contrabandChance(s: WorldState = need()): number {
  const n = contrabandOf(s).length;
  if (!n) return 0;
  const strict = lawStrictness(continentOf(s.player.loc) ?? '');
  return Math.min(0.85, 0.1 + strict * 0.07 + Math.min(3, n) * 0.06);
}

/**
 * 藏货：一次魅力检定对抗盘查。
 *
 * 成则过关（东西还在，但城卫记住了你的手），败则**全部起获 + 倒卖禁货立案**
 * （law.json 的 smuggling，B 级，入档即累加通缉）。
 * 为什么不是「没收一件」：违禁品真正的代价是案底，不是那点铜——
 * 只没收东西的话，玩家会把它当成一次失败的交易而不是一次犯罪。
 */
export function contrabandStop(): void {
  const s = need();
  const ids = contrabandOf(s);
  if (!ids.length) return;
  const names = ids.map((id) => WB.items[id].name).join('、');
  log('城卫的目光在你行李上停了停——「把包打开。」', 'bad');
  check(
    '城卫盘查·藏货',
    '魅力',
    12 + ids.length * 2,
    (r) => {
      if (r.ok) log('你把包翻得又慢又稳，那点东西始终压在最底下。城卫挥手让你走——眼神却没离开你的手。', 'nar');
      else {
        for (const id of ids) removeItem(id, itemCount(id, s));
        log('他的手探进去，摸出了' + names + '。「这东西，你从哪儿来的？」', 'bad');
        commitCrime('smuggling', s.player.loc);
      }
      sync();
    },
    '帝国律下携带禁货者，盘查加倍（世界书·法律）',
  );
}

/** 观察环境（原型 observe：感知检定→地点专属情报） */
export function observe() {
  const s = need();
  settleAxes(s); // 卡 I4：场景行动边界先把已发生的战功/情报落地
  advance(1);
  const loc = s.player.loc;
  check('观察环境', '感知', 11, (r) => {
    if (r.ok) {
      const x: Record<string, string> = {
        plaza: '告示栏上新贴了悬赏；一个报童正朝你张望。',
        tavern: '柜台后莉安正拨算盘，眉头微皱——似乎为一笔账发愁。',
        market: '铁匠铺火星四溅；布伦丹打成一半的剑坯在铁砧上泛着暗光。',
        temple: '年轻的艾德里安在祭坛前整理烛台，袖口沾着蜡油。',
        guild: '任务板最显眼处钉着猎兔令，墨迹还很新。',
        gate: '队长雷诺正在核对通缉画像，目光不时扫过行人。',
        alley: '阴影里有个兜帽身影靠墙站着，像在等人——又像在等你。',
        wild: '麦田边有小兽窜过的痕迹；坡地零星开着几丛药草。',
        cave: '岩壁上有爪痕，深而新。附近应有哥布林出没。',
        cave2: '碎石下露出一角古代砌道，砌缝工艺远非今人所及。',
        cave3: '祭坛基座刻着六芒星纹——与神殿圣徽同源，却扭曲了。',
      };
      log(x[loc] || '一切如常。', 'nar');
      addIntelObserve(s); // 卡 I4：观察成功 → 情报 +1（日上限 2）
      /* 卡 I5：观察所得命中 lore 关键词 → 解锁图鉴（每地点每日上限由 codex 内部门禁） */
      observeUnlock((x[loc] || '') + ' ' + loc + ' ' + (WB.locations[loc] ? WB.locations[loc].name : ''), loc, s);
      // 卡 H3：城中人多处偶遇一名路人——由命名生成器署名（族风稳定，不现编）
      /* 三个约束，缺一个这段就会变成噪音：
         ① 只在**城内**地点（问能力不问危险度——此前用 danger≤2，野外也会冒出「路口」）；
         ② 每地点每日有上限（观察是高频动作，不设限会刷成走马灯）；
         ③ 名字取自当日名单，且文本一律是**别人喊他**、**他走了**——
            路人不进 NpcDynamic，叙事就不该把他写成能搭话的对象。 */
      if (hasAbility(loc, 'urban') && rng.chance(0.45) && canMeet(loc, sceneTime(s).day)) {
        const day = sceneTime(s).day;
        const list = passersbyAt(loc, day);
        const p = rng.pick(list);
        markMet(loc, day);
        log(
          rng.pick([
            '一个' + p.race + '旅人从你身边走过，同伴喊他「' + p.name + '」，他没回头。',
            '卖水的摊前有人招呼熟客——「' + p.name + '，还是老样子？」',
            /* UX-004（2026-09-29 二轮实测）：旧句「路过的人喊他『名』」读起来像路人
               在给补鞋匠改名——名字必须是路人自己的。 */
            '补鞋匠支着摊子在路口坐着，「' + p.name + '」打他摊前经过，两人点头之交，各自赶路。',
          ]),
          'nar',
        );
      }
      // 卡 F：与公会情报网达标 → 额外揭示（此刻在场者与传闻）
      if (infoReveal('guild', s)) {
        const ps = presentNPCs(loc);
        const extra = ps.length ? '（公会线人提醒：此刻此地有 ' + ps.map((n) => n.name).join('、') + '）' : '（线人摇头：这里没有你需要的消息）';
        log('你多留了个心眼，把人群记在心里。' + extra, 'gain');
      }
    } else log(rng.pick(['你环顾四周，没看出特别之处。', ai().narrativeAmbient()]), 'nar');
    sync();
  });
}

/** 打听消息（卡 I4 · 情报来源）：城门 / 酒馆 / 集市可打听，d20+感知，成功 +1 情报（日上限 3）
 *  回包文本先经 core 的 doubtMark 比对 lore 事实卡——AI 只产文本，标「·存疑」的判定在这里。 */
export function gatherIntel() {
  if (netBlocked('在城里打听消息')) return;
  const s = need();
  settleAxes(s); // 卡 I4：场景行动边界先把已发生的战功/情报落地
  const loc = s.player.loc;
  const pools: Record<string, string[]> = {
    gate: [
      '换岗的守卒压着嗓子说：城西关卡昨夜加了两道拒马，走货的都得排队等放行。',
      '一个押车的脚夫叹气：前线抽了两百人走，如今城里的兵比上月少了一半。',
      '过路的佣兵提了句「血吼」——近来商道上多了他们的旗子，护送的价钱也跟着涨了。',
    ],
    tavern: [
      '邻桌的商贩赌咒：神殿其实供着七位主神，那位坐镇评议会的不过是资历最老的。',
      '有人说浅层洞窟三层新塌了一段，公会的老手这半个月都不肯下去。',
      '酒客压低声音：城卫这几日查得凶，是因为上面丢了东西。',
    ],
    market: [
      '卖符纸的老头凑过来：老辈人讲，海上还有第八块大陆，只是没人回得来。',
      '肉铺的伙计边剁骨头边说：药材再这么涨下去，穷人生病就只能硬扛。',
      '布伦丹的学徒嘀咕：铺子里的精钢剑坯，近来总有人来问价却不买。',
    ],
  };
  const pool = pools[loc];
  if (!pool) {
    toast('此地人多眼杂，问不出什么——要打听，得去城门、酒馆或集市');
    return;
  }
  advance(1);
  check('打听消息', '感知', 12, (r) => {
    if (r.ok) {
      log(doubtMark(rng.pick(pool), s), 'nar');
      addIntelGather(s);
    } else {
      log(rng.pick(['你把话头递出去，对方只笑了笑，端着碗走开了。', '闲话绕了三个弯，一句也没落到正事上。', '有人打量了你一眼，把嘴闭上了。']), 'nar');
    }
    sync();
  });
}

/** 调查现场（原型 search：窃案线索链 market→alley，其余泛化） */
export function search() {
  if (netBlocked('搜索现场')) return;
  const s = need();
  settleAxes(s); // 卡 I4：场景行动边界先把已发生的战功/情报落地
  advance(2);
  check('调查现场', '感知', 13, (r) => {
    const q = s.player.quests.q_theft;
    if (s.player.loc === 'market' && q && q.stage === 'go') {
      if (r.ok) {
        log(
          '铁砧后留着一串小而深的脚印，通向集市边缘暗巷。有摊贩回忆，昨夜矮人铺子方向有动静——“那脚步声轻得不像人”。',
          'nar',
        );
        q.stage = 'trail';
        toast('线索更新：脚印通向深巷', 'gain');
      } else log('你翻找了半天，只闻到一炉铁锈味。', 'nar');
    } else if (s.player.loc === 'alley' && q && q.stage === 'trail') {
      if (r.ok) {
        log(
          '巷子深处的矮墙下有新鲜擦痕和半枚锡质徽记——黑市销赃的记号。兜帽下的「灰烬」一直看着你做这一切。',
          'nar',
        );
        q.stage = 'confront';
        toast('线索更新：可以与灰烬对质了', 'gain');
      } else log('巷中只有滴水声。有些东西，得用别的方式问出来。', 'nar');
    } else {
      log(
        r.ok
          ? '你仔细搜索了周围：' + rng.pick(['没什么值钱东西，但你对这里更熟悉了。', '发现一枚不知谁掉的铜币。'])
          : '你搜了一圈，一无所获。',
        'nar',
      );
      if (r.ok && s.player.loc === 'wild') gainGold(1);
    }
    sync();
  });
}

/** 采集药草（原型 gather：旷野限定，角兔袭击） */
export function gather() {
  if (netBlocked('采集')) return;
  const s = need();
  settleAxes(s); // 卡 I4：场景行动边界先把已发生的战功/情报落地
  if (s.player.loc !== 'wild') {
    toast('这里无从采集');
    return;
  }
  advance(2);
  check('采集药草', '感知', 10, (r) => {
    if (r.ok && rng.chance(0.65)) {
      addItem('moonherb');
      log('你循着药草气味拨开草浪，一株月见草在指间轻轻摇曳。', 'nar');
    } else log('你弯腰找了半天，只收获了一裤脚的草籽。', 'nar');
    if (rng.chance(0.25)) {
      log('草丛里突然窜出一头暴走角兔，把你当成了入侵者！', 'nar');
      startCombat(['rabbit']);
    } else sync();
  });
}

/** 旷野探索（原型 exploreWild：商队营地事件 + 三分支遭遇表） */
export function exploreWild() {
  if (netBlocked('在旷野探索')) return;
  const s = need();
  settleAxes(s); // 卡 I4：场景行动边界先把已发生的战功/情报落地
  advance(2);
  const q = s.player.quests.q_caravan;
  if (q && q.stage === 'go' && !s.qf.caravan_ok) {
    log('你循着车辙与血迹，在丘陵背风处找到劫掠者营地——两人，篝火，还有堆成小山的药材货箱。', 'nar');
    confirmSheet('劫掠者营地', '趁其不备突袭，夺回货物。', [
      { l: '突袭！', a: 'cbt_caravan' },
      { l: '先撤退', a: 'close' },
    ]);
    return;
  }
  /* 卡 G3：所在大陆若有险区（§73 六星制），旷野里走着走着就可能踏进去。
     enterZone 早就写好（掷遭遇→开战），此前**没有任何地方调它**——险区等于不存在。 */
  const zones = zonesOf(WB.locations[s.player.loc]?.continent ?? '');
  if (zones.length && rng.chance(0.25)) {
    const z = rng.pick(zones);
    const r = enterZone(z.id);
    if (r.triggered) return; // 已经开打，这一趟探索到此为止
    sync();
    return;
  }
  const roll = rng.d(20) + mod('感知');
  if (roll <= 8) {
    log(ai().narrativeAmbient(), 'nar');
    if (rng.chance(0.5)) {
      log('草浪里传来窸窣声——一头角兔竖着耳朵瞪你。', 'nar');
      startCombat(['rabbit']);
    } else sync();
  } else if (roll <= 14) {
    if (rng.chance(0.5)) {
      addItem('moonherb');
      log('你在背阴坡地发现一小片月见草。', 'nar');
    } else {
      gainGold(rng.R(10, 40));
      log('你撞见一支补给商队，帮着搬了半刻钟的货，得了点辛苦钱。', 'nar');
    }
    sync();
  } else {
    log('你循着兽径深入丘陵，惊起一阵腥风——', 'nar');
    startCombat([rng.chance(0.5) ? 'wolf' : 'rabbit']);
  }
}

/** 洞窟探索（原型 exploreCave：三层 BOSS + 分层遭遇表） */
export function exploreCave() {
  if (netBlocked('下洞窟探索')) return;
  const s = need();
  settleAxes(s); // 卡 I4：场景行动边界先把已发生的战功/情报落地
  advance(2);
  const loc = s.player.loc;
  if (loc === 'cave3' && !s.qf.boss_dead) {
    log(
      '火光尽头，古代祭坛的轮廓渐渐清晰。坛前立着一道枯瘦身影——它缓缓转身，眼窝里燃着两点鬼火。',
      'nar',
    );
    startCombat(['ghoul'], { boss: true });
    return;
  }
  const tbMap: Record<string, [string, number][]> = {
    cave: [
      ['goblin', 0.4],
      ['bat', 0.3],
      ['loot', 0.2],
      ['none', 0.1],
    ],
    cave2: [
      ['spider', 0.3],
      ['skeleton', 0.3],
      ['loot', 0.2],
      /* 卡 G2：越往下越可能撞见前代的遗迹（§106/§107/§117 一次消费） */
      ['ruin', 0.1],
      ['none', 0.1],
    ],
    cave3: [
      ['skeleton', 0.4],
      ['loot', 0.35],
      ['ruin', 0.15],
      ['none', 0.1],
    ],
  };
  const tb = tbMap[loc] || [['none', 1]];
  let r = rng.next();
  let ev = 'none';
  for (const kv of tb) {
    if (r < kv[1]) {
      ev = kv[0];
      break;
    }
    r -= kv[1];
  }
  if (ev === 'loot') {
    addItem(loc === 'cave' ? rng.pick(['bread', 'herb_paste']) : rng.pick(['herb_paste', 'potion_moon']));
    gainGold(rng.R(30, 90));
    log('你在塌陷的壁龛里翻出前人遗落的行囊——食物、药膏，还有一小袋铜币。', 'nar');
    sync();
  } else if (ev === 'ruin') {
    discoverRuin();
  } else if (ev === 'none') {
    log(rng.pick(['甬道在此拐弯，只剩你自己的脚步声。', '一滴水从穹顶落下，砸在脚边石面上。']), 'nar');
    sync();
  } else startCombat([ev]);
}

/**
 * 休息（原型 restAt）。
 * 参数是**休息方式**而不是地点名（地区规整）：'lodging' 付钱睡到天亮、'camping' 露宿半恢复。
 * 调用方按地点能力选方式（rest_lodging / rest_camping），因此新增地区不必回来改这里。
 * 注：文案里的"阁楼""背风处"仍带原地区色彩，属于后续内容化时要一并数据化的部分。
 */
export function restAt(place: 'lodging' | 'camping') {
  if (netBlocked('落脚歇息')) return;
  const s = need();
  settleAxes(s); // 卡 I4：场景行动边界先把已发生的战功/情报落地
  if (place === 'lodging') {
    if (s.player.flags.free_inn || s.player.gold >= 20) {
      const c = s.player.flags.free_inn ? 0 : 20;
      if (c) gainGold(-c);
      log((c ? '你付了 ' + formatMoney(20) + '，' : '莉安免了你的房钱。') + '在阁楼的稻草床上沉沉睡去。', 'nar');
      tillMorning();
      mutate.playerHp(maxHp());
      mutate.playerMp(maxMp());
      log('一觉醒来，浑身酸痛尽消。楼下飘起烤面包的香气。', 'nar');
      if (s.player.wanted > 0 && rng.chance(0.2)) {
        log('半夜有城卫来查房——好在莉安说你是她远房表亲。', 'sys');
        adjAtt('lita', 2, '掩护');
      }
    } else {
      toast('付不起房钱（' + formatMoney(20) + '）');
      return;
    }
  } else {
    advance(16);
    mutate.playerHp(s.player.hp + Math.ceil(maxHp() * 0.5), maxHp());
    mutate.playerMp(s.player.mp + Math.ceil(maxMp() * 0.5), maxMp());
    log('你裹紧斗篷，在背风处打了几个小时的盹。寒气浸骨，伤势将养了一半。', 'nar');
    if (rng.chance(0.4)) {
      log('半夜，你被一声狼嚎惊醒——', 'nar');
      startCombat(['wolf']);
      return;
    }
  }
  sync();
}

/** 喝酒听闲话（原型 drink：情报随剧情日进展变化） */
export function drink() {
  if (netBlocked('喝酒')) return;
  const s = need();
  settleAxes(s); // 卡 I4：场景行动边界先把已发生的战功/情报落地
  if (s.player.gold < 5) {
    toast('连杯麦酒的钱都不够了');
    return;
  }
  gainGold(-5);
  advance(1);
  const rs: string[] = [];
  const day = sceneTime(s).day;
  if (day === 2) rs.push('“听说了吗？奥托的商队被劫了，整批药材啊……”');
  if (day >= 2) rs.push('“药价涨成这样，穷人生病只能硬扛。”');
  rs.push('“城门那张榜——百年神选。啧，跟我们小人物有什么关系。”');
  if (!s.npcs.ash || !s.npcs.ash.met) rs.push('“要买『特殊货』，得入夜后去集市后面的深巷找……”（话到这儿，那人闭了嘴）');
  if (day >= 4) rs.push('“城卫查得紧，这几天别乱来。”');
  rs.push('“听说浅层洞窟三层闹邪物，公会的老手都不敢下去。”');
  rs.push('“范德尔老头又念叨星枢七塔，痴了快一辈子喽。”');
  log('你要了一杯麦酒。邻桌的闲话随风飘进耳朵——', 'nar');
  log('「' + rng.pick(rs) + '」', 'say');
  sync();
}

/** 祈祷（原型 pray：法力全满 + 圣光回应彩蛋） */
export function pray() {
  const s = need();
  settleAxes(s); // 卡 I4：场景行动边界先把已发生的战功/情报落地
  if (!templeServiceOk(s)) {
    log('神殿的门槛在你面前合上——神官认出了你，"亵渎者不配跪在此处。"', 'bad');
    sync();
    return;
  }
  advance(1);
  mutate.playerMp(maxMp());
  adjRepAxis(HOME_TEMPLE, 'religion', 3, s); // 卡 F：虔敬累积信仰
  if (rng.chance(0.4)) addRep(HOME_TEMPLE, 1);
  log('你在祭坛前跪下，烛火在祷词里轻轻摇曳。疲惫的心神被熨平了。（法力全满）', 'nar');
  if ((s.rep[HOME_TEMPLE] || 0) >= 5 && !s.player.flags.blessed) {
    mutate.playerFlag('blessed');
    log('长明烛忽然亮了一瞬。艾德里安惊讶地看着你：“圣光回应了你——这很少见。”', 'nar');
    addRep(HOME_TEMPLE, 3);
    adjAtt('adrian', 5, '祈祷');
  }
  sync();
}

/** 神殿治疗（原型 healSvc；卡 F：信仰过低被拒，虔诚信徒打折） */
export function healSvc() {
  if (netBlocked('接受治疗')) return;
  const s = need();
  settleAxes(s); // 卡 I4：场景行动边界先把已发生的战功/情报落地
  if (!templeServiceOk(s)) {
    log('艾德里安别过脸去：“圣光不照无信之人。走吧。”', 'bad');
    return;
  }
  const fee = templeFee(100, s);
  if (s.player.gold < fee) {
    toast('治疗需要 ' + formatMoney(fee));
    return;
  }
  gainGold(-fee);
  advance(1);
  mutate.playerHp(maxHp());
  adjRepAxis(HOME_TEMPLE, 'religion', 5, s); // 卡 F：蒙治愈者更亲近神殿
  log(fee < 100 ? '艾德里安认出你是虔敬之人，只收了 ' + formatMoney(fee) + '。温热光流渗入四肢。' : '艾德里安将手掌覆在你额前，温热光流缓缓渗入四肢。伤痛退潮般散去。', 'nar');
  adjAtt('adrian', 1, '治疗');
  sync();
}

/** 行窃/扒窃（原型 steal：摊贩目标 / NPC 目标两套检定） */
export function steal(text: string) {
  if (netBlocked('行窃')) return;
  const s = need();
  settleAxes(s); // 卡 I4：场景行动边界先把已发生的战功/情报落地
  advance(2);
  const loc = s.player.loc;
  const ps = presentNPCs(loc);
  const tgt = ps.find((n) => text.includes(n.name)) || (loc === 'alley' && npcAt('ash') ? { id: 'ash' } : null);
  if (loc === 'market' && !tgt) {
    check(
      '顺走摊上的货',
      '敏捷',
      14,
      (r) => {
        if (r.ok) {
          const g = rng.pick(['bread', 'herb_paste']);
          addItem(g);
          log('你借着人流打了个趔趄，掌心多了一份' + WB.items[g].name + '。', 'nar');
          addHistory('集市行窃得手', '获得' + WB.items[g].name, 1);
          /* §8：行窃是**已发生的事实**，谁看见了由感知层按显眼度判定——
             「没人注意到」不该由一句文案替世界宣布（感知层没机会介入的分叉）。 */
          worldBus.emit(
            makeEvent({
              type: 'item_stolen',
              day: sceneTime(s).day,
              tick: s.t,
              actor: 'player',
              location: loc,
              cause: 'market_theft',
              data: { item: g },
            }),
          );
        } else {
          log('摊贩猛地攥住你的手腕，扯着嗓子喊起来。人群哗然——城卫来了。', 'bad');
          commitCrime('petty_theft', s.player.loc);
          arrest();
        }
        sync();
      },
      '失败＝当场被捕（法律系统）',
    );
    return;
  }
  if (!tgt) {
    log('这里没有值得下手（或值得冒险）的对象。', 'nar');
    sync();
    return;
  }
  const tid = tgt.id;
  check('扒窃·' + WB.npcs[tid].name, '敏捷', 15 - (shichenOf(s.t) >= 10 ? 3 : 0), (r) => {
    if (r.ok) {
      gainGold(rng.R(20, 60));
      log('你擦身而过，' + WB.npcs[tid].name + '的钱袋轻了一些。', 'nar');
      addHistory('扒窃' + WB.npcs[tid].name + '得手', '少量铜币', 1);
      /* 同上：得手也是事实。受害者本人必然知情（他在场），旁人则看显眼度。 */
      worldBus.emit(
        makeEvent({
          type: 'item_stolen',
          day: sceneTime(s).day,
          tick: s.t,
          actor: 'player',
          target: tid,
          location: loc,
          cause: 'pickpocket',
          witnesses: [tid],
          data: { gold: true }, // 与集市那支的 data.item（物品 id）区分：这里丢的是钱
        }),
      );
    } else {
      log(WB.npcs[tid].name + '的目光猛地钉在你手上。“做什么？！”', 'bad');
      adjAtt(tid, -25, '扒窃被抓');
      addMem(tid, '试图偷窃被当场抓住', 3);
      if (WB.locations[loc].danger < 2) {
        commitCrime('petty_theft', s.player.loc);
        arrest();
      } else {
        log('深巷里没人报官——但那双兜帽下的眼睛，记住你了。', 'nar');
        addRep('shadow', -3);
      }
    }
    sync();
  });
}
