/* ============================================================
   rule-sim：AI Gateway 的第一版 ModelAdapter（原型 SimAI 全量转写）
   职责：生成叙事文本、NPC 决策判断、组装上下文分层。
   铁律：只读世界书与 WorldState，绝不改写状态（§7）。
   ============================================================ */
import { WB } from '@/data/worldBook';
import { memOf } from '@/memory';
import { rng } from '@/events/EventBus';
import { matchLore, loreLines, persistentCanon } from './retriever';
import type { AiHelpers, AiPort, ChatCtx, ChatReply, NpcReq, NpcVerdict } from '@/plugins/PluginInterface';
import { core } from '@/world/WorldState';
import { periodSeg, shichenOf } from '@/world/WorldClock';
import type { WorldState } from '@/types/world';

const AMBIENT = [
  '风穿过街巷，卷起一角告示。',
  '远处传来圣钟塔的低鸣。',
  '摊贩在吆喝今天的特价货。',
  '几个学徒模样的人说笑着走过。',
  '一只花猫从墙头跳下，又倏地消失。',
];

/* 时段氛围池：与 AMBIENT 同构（地点无关、不含地名），按 periodSeg 的晨/昼/暮夜三段分组。
   ------------------------------------------------------------
   为什么不直接按时段索引 L.desc：geo.json 的 63 个地点里，desc 三段齐全的只有 1 个，
   另有 10 个两句、52 个只有一句——「按时辰换景色」靠 desc 索引只能覆盖一个地点。
   于是取景句走两层：desc 给「这是哪里」，本池给「此刻是什么时辰」。
   拼在 desc 之后，不替换它。 */
export const PERIOD_TEXT: [string[], string[], string[]] = [
  /* 每句都不许指向具体场所（铺子、摊子、塔楼…）：
     本池会出现在**任何**地点里，写了「面包房的炉气」就会在酒馆里漏出来。
     初版正是这么翻车的——所以这里只写光、声、气、人，不写招牌。 */
  /* 0 晨 · 破晓 / 拂晓 / 清晨 / 早晨 */
  [
    '檐角的霜还没化尽，扫街的人把落叶拢成一堆。',
    '湿冷的气味还没散，光先从高处漫了下来。',
    '更夫收了灯往回走，靴底踩过积水，声音传得很远。',
    '光斜着切进来，照出石板缝里一道青苔。',
  ],
  /* 1 昼 · 正午 / 午后 */
  [
    '日头正当顶，影子缩成脚下一小团。',
    '有人蹲在阴凉里啃干粮，一边同路过的人搭话。',
    '日头把窗纸晒得发白，风一过就鼓起来。',
    '绳上晾着的布匹被翻了个面，还挂着水汽。',
  ],
  /* 2 暮夜 · 黄昏 / 入夜 / 夜晚 / 深夜 */
  [
    '灯一盏一盏亮起来，影子被拉得又长又软。',
    '晚钟过后，人明显少了，脚步也快了。',
    '有人在檐下点烟，火折子的光一闪就灭了。',
    '巡夜的灯笼从街口拐过去，脚步声远了。',
  ],
];

/* 聊天降级三档池（卡片6）：态度档驱动语气，warm 才递话头。
   配套两条「小池子不重句」的纪律（实机：问路连问五轮只有两种答法）：
   1) 轮转不随机抽——按 NPC 记游标，整池轮完一圈才回到第一句；
   2) 兴趣模板给三个变体，别让「提一句罢了」一句独挑大梁。 */
const CHAT_POOL: Record<ChatCtx['tier'], string[]> = {
  hostile: ['（冰冷的目光剜了你一下，没有说话。)', '「……滚。」'],
  cold: ['「没什么事的话，我忙着呢。」', '（对方只从鼻子里应了一声。）', '「你跟我说的话，超过三个字了。」'],
  neutral: ['「最近？最近不太平，但也还得过日子。」', '「哦，是你啊。今天还算清静。」', '「有什么想问的，说吧。」'],
  warm: ['「你来啦——正好，我有话想说给你听。」', '「旁人我可不搭这茬。你不一样。」', '「说真的，见到你这一天都亮堂了些。」'],
};

const CHAT_TPLS: ((x: string) => string)[] = [
  (x) => '「……' + x + '，提一句罢了。你可别到处说。」',
  (x) => '「' + x + '——这话你就当没听过。」',
  (x) => '「' + x + '。你要是往外说，我可不认账。」',
];

const poolCursor = new Map<string, number>();

export const ruleSim: AiPort = {
  provider: 'rule-sim v0.2（规则模拟 · 经 AI Gateway 注册 · 预留真实模型接口）',

  narrative(kind: string, p: { loc: string }): string {
    const s = core.S as WorldState;
    if (kind === 'enter') {
      /* L 必须判空（审查 §rng.pick）：p.loc 是运行时值，传送、临时地点都可能传进来，
         直接取 L.desc 会在非法地点上抛 TypeError 把整条叙事通道打崩。
         两处都来自世界书，用 pickOr 让「文案暂时缺项」退化成空串而不是崩溃。 */
      const L = WB.locations[p.loc];
      const seg = periodSeg(s ? shichenOf(s.t) : 4);
      /* 取景句分两种地点（见 PERIOD_TEXT 的注释）：
         · desc 已有三段（如 plaza 的晨光 / 白昼 / 鲸油灯）——它自己就是分时段的，按时段取固定句；
         · 其余地点——随机取一句 desc，再补一层时段氛围句。 */
      let t =
        L?.desc && L.desc.length >= 3
          ? (L.desc[seg] ?? rng.pickOr(L.desc, ''))
          : rng.pickOr(L?.desc, '') + rng.pickOr(PERIOD_TEXT[seg], '');
      if (s && s.weather !== '晴' && shichenOf(s.t) < 10) t += rng.pickOr(WB.weatherText[s.weather], '');
      return t;
    }
    return rng.pick(AMBIENT);
  },

  narrativeAmbient(): string {
    return rng.pick(AMBIENT);
  },

  /** 原型 SimAI.npcDecide：利益/底线/风险/关系 → 决策档位 */
  npcDecide(npcId: string, req: NpcReq): NpcVerdict {
    const s = core.S as WorldState;
    const att = s.npcs[npcId] ? s.npcs[npcId].att : 0;
    const W = { interest: req.interest, vio: !!req.violate, risk: req.risk || 0, att };
    /* 卡 R6 · 十档判定（世界书 §118「回答类型多样化 10 种」）。
       原实现六档（答应/有条件答应/反提议/拒绝并解释/沉默/拒绝），缺的四类——
       延迟回答、拒绝+替代、反问、质疑——正是"NPC 有独立判断"最像人的表现，
       本卡补上；拒绝的具体形态再按 §119 的性格六型分派。 */
    const style = (WB.npcs[npcId] as { refuseStyle?: string } | undefined)?.refuseStyle ?? 'direct';
    const sc = req.interest * 2 + (att >= 25 ? 1 : att <= -25 ? -1 : 0) - (req.risk || 0);
    let verdict: string;
    if (req.violate) {
      /* 触底线：按性格给不同形态的拒绝——冷淡型沉默、原则型反问、理性型质疑 */
      verdict = style === 'cold' ? '沉默' : style === 'principled' ? '反问' : style === 'rational' ? '质疑' : '拒绝';
    } else if (sc >= 2) verdict = '答应';
    else if (sc >= 1) verdict = '有条件答应';
    else if (sc >= 0) verdict = '反提议';
    else if (sc >= -1) {
      /* 轻微不利：圆滑者给替代方案，其他人把话头拖一拖 */
      verdict = style === 'smooth' ? '拒绝并替代' : '延迟回答';
    } else if (sc >= -3) verdict = '拒绝并解释';
    else verdict = '沉默';
    return { verdict, W };
  },

  /** 聊天窗口降级路径（G2 同构）：三档池整池轮转 + interest/goal 模板变体插入 +
     上句去重——无 LLM 环境也做到"不重句、关系感知"；attDelta 仅 warm 档 +1
     （core 再套日封顶）。去重比对上一条 NPC 句（玩家句会稀释历史，真机验证暴露） */
  chat(npcId: string, ctx: ChatCtx): ChatReply {
    const n = WB.npcs[npcId];
    const pool = CHAT_POOL[ctx.tier];
    const lastN = [...ctx.history].reverse().find((h) => h.who === 'n');
    const seeds = [n?.interest, n?.goal].filter(Boolean) as string[];
    /* 模板句 50% 优先插话（与上一句相同则让位给池句）；不消耗轮转游标，
       池句仍会逐句轮到。 */
    if (ctx.tier !== 'hostile' && seeds.length && rng.chance(0.5)) {
      const tpl = CHAT_TPLS[rng.d(CHAT_TPLS.length) - 1](String(rng.pick(seeds)));
      if (!lastN || lastN.text !== tpl) return { line: tpl, attDelta: ctx.tier === 'warm' ? 1 : 0 };
    }
    const i = poolCursor.get(npcId) ?? 0;
    poolCursor.set(npcId, i + 1);
    return { line: pool[i % pool.length], attDelta: ctx.tier === 'warm' ? 1 : 0 };
  },

  /** 原型 SimAI.contextLayers：§51 八层动态上下文 */
  contextLayers(s: WorldState, h: AiHelpers): [string, string[]][] {
    const loc = s.player.loc;
    const ps = h.presentNPCs(s, loc);
    const L = WB.locations[loc];
    const lore = loreLines(matchLore({ area: L?.area, locName: L?.name, npcNames: ps.map((n) => n.name) }, { max: 6 }));
    /* 卡 R7：常驻准则层。此前这里只有四条硬编码规则；现在由 constant 卡供内容，
       硬编码四条退为**兜底**（数据缺失时仍有一层底线规则，不至于裸奔）。 */
    const persist = persistentCanon(900);
    return [
      ['Layer 0 · 世界书 canon（须一致）', lore.length ? lore : ['（本场景无特别设定）']],
      [
        'Layer 1 · 常驻准则（恒真，优先级最高）',
        persist.lines.length
          ? persist.lines
          : ['第三纪元 612 年', '货币：铜/银/金/白金', '力量双轴：灵魂(法)·肉体(武)', '神明只经信仰影响人间'],
      ],
      /* 大陆名取自数据的 continent，不是写死的「中央大陆」——
         2026 补：这里原本硬编码，任何外大陆的 AI 上下文都会被喂成「中央大陆 · …」。 */
      ['Layer 2 · 大陆/地区', [(L?.continent ?? '') + ' · ' + (L?.area ?? ''), '季节：' + h.seasonName(s) + '　天气：' + s.weather]],
      ['Layer 3 · 当前地点', [WB.locations[loc].name + '　危险度 ' + '★'.repeat(WB.locations[loc].danger || 0)]],
      ['Layer 4 · 当前 NPC', ps.length ? ps.map((n) => n.name + '（' + h.attWord(h.attOf(s, n.id)) + '）') : ['（无人在场）']],
      [
        'Layer 5 · NPC 记忆',
        ps
          .flatMap((n) => memOf(n.id, s).slice(-2).map((m) => n.name + '：' + m.event))
          .concat(['（仅检索相关记忆）']),
      ],
      ['Layer 6 · 当前事件', s.events.length ? s.events.slice(-3).map((e) => e.name) : ['（暂无）']],
      [
        'Layer 7 · 玩家状态',
        [
          s.player.name + ' · ' + h.raceName(s) + ' ' + h.clsName(s) + ' · ' + h.rankName(s),
          'HP ' + s.player.hp + '/' + h.maxHp(s) + '　MP ' + s.player.mp + '/' + h.maxMp(s),
          '携带违禁品：' + h.hasIllegalStr(s),
        ],
      ],
      ['Layer 8 · 最近对话', s.log.slice(-3).map((l) => l.text.slice(0, 16) + '…')],
    ];
  },
};

