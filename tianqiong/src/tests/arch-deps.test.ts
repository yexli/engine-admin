/* ============================================================
   跨系统依赖冻结门禁（《天穹纪元2.0-后续开发方案-阶段J》卡 J4）
   —— 阶段 J 审计实测：18 个系统之间有 89 条文件级直接 import 边，
      其中 9 个系统（character / codex / economy / faction / inventory /
      law / npc / relationship / reputation）构成一个强连通环。
   eslint 只守垂直方向（引擎层禁 React/Zustand/UI），对水平方向零约束——
   探针实证：在 systems/quest 下同时 import systems/npc 与 systems/combat，
   eslint 零报错；只有 import store/useGame 被拦。

   本卡**不清理存量**：拆掉那个环要重排 9 个系统的构造顺序，风险远超收益。
   本卡只做一件事——把它冻成「只减不增」。

   为什么用守卫测试而不是 eslint：flat config 要做到「禁止 A 系统 import
   除自己以外的任何系统」需要 18×18 的文件覆盖组合，不可维护；守卫测试
   只需一张基线表，且能在失败信息里直接报出是哪条新边、从哪个文件来。

   扫描用 TypeScript AST（独立审查 M-5 整改）：正则只认 from '...'，
   会漏掉动态 import() 与副作用导入（import 'x'），还会把 import type
   误计成运行时耦合。AST 三种写法全覆盖，且类型边可单独归类。
   ============================================================ */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';

/**
 * 内核模块白名单：它们是「事实上的标准库」——写入原语 / 派生数值 / 浮层描述符 /
 * 货币格式化 / LOD 判据单一源。被 16 个以上的系统依赖是**设计预期**，不是耦合。
 * 用**前缀匹配**（审查 L-4）：内核模块一旦拆成目录（Gains.ts → Gains/index.ts），
 * 精确匹配会让白名单静默失效并炸出一片假阳性。
 * 扩展方式：只有当某模块的全部消费者都把它当纯工具用（不存在带业务语义的反向
 * 依赖）时才加进来。加进来等于承认它属于内核层——那也应该伴随着目录归位。
 */
const KERNEL: string[] = [
  'systems/character/Gains',
  'systems/character/Derived',
  'systems/character/Sheet',
  'systems/economy/Money',
  'systems/npc/Lod',
  /* 2026-09 · NPC 分级：上下文档位与关系筛选。
     加进来的理由与 Lod 同类——**纯判据，无业务反向依赖**：
       · resolveContextProfile / resolveBudget 只读 data/world/context.json，纯函数；
       · selectRelevantRelations 只做排序与截断，不写状态、不读 WorldState。
     消费者横跨三层（ai/ContextBuilder 的推演上下文、systems/npc/Chat 的对话、
     systems/dialogue/Dialogue 的 NPC 权衡），三条链路问的是同一个问题
     「这一次给他多少上下文」——判据若有两份实现，两份迟早给出不同的答案。 */
  'systems/npc/ContextProfile',
];
const isKernel = (to: string): boolean => KERNEL.some((k) => to === k || to.startsWith(k + '/'));

/**
 * 冻结基线：阶段 J 审计实测的存量跨系统边（89 条减去 44 条指向内核的）。
 *
 * 本清单**只减不增**，三条使用约定：
 *   1. 确需新增一条跨系统调用 → 在此加一行，并在提交说明里写清为什么不能走
 *      事件总线（plugins/subscriptions.ts）或内核层；
 *   2. 某条边被清理掉 → **删掉那一行**（清单必须与代码同步，否则它会变成谎话，
 *      而谎话比没有门禁更糟）；
 *   3. 新增一个系统不会自动获得豁免——新系统的跨系统引用同样要登记。
 *
 * 重新生成：node scripts/deps-baseline.mjs（与本文用同一套 AST 扫描）
 */
const FROZEN_BASELINE: string[] = [
  /* 卡 R3 登记两条（2026-09-22）：实战领悟与技能书通道都要经「角色成长」这一层，
     而 systems/character/* 是各系统的**公共底层**（Derived/Gains/Status 早已被 Combat、
     Dialogue 等大量引用）。走事件总线在这里反而是错的方向：
       · 授技是同步、幂等的状态变更（不是"通知"，没有别的消费者）；
       · 事件总线适合「一个事实、多个系统各自反应」，授技只有一个归属地。
     两条边都不构成环（Learn 只依赖 data/world、events、types 与 character 内部）。 */
  /* 卡 A1 登记两条：师徒制要授技（Learn）与调关系（Npcs），
     两者都是"角色成长"这条链上的既有公共底层，走事件总线反而绕远——
     授技/调好感都是同步、幂等、无第二消费者的事。Growth 不构成环。 */
  'systems/academy/Academy -> systems/timeslip/Lifespan',
  'systems/academy/Growth -> systems/character/Learn',
  'systems/academy/Growth -> systems/npc/Npcs',
  'systems/codex/Codex -> systems/character/Learn',
  'systems/combat/Combat -> systems/character/Learn',
  'systems/character/Derived -> systems/inventory/Equip',
  'systems/character/Gains -> systems/npc/Npcs',
  'systems/combat/Combat -> systems/character/Status',
  'systems/combat/Combat -> systems/faction/Diplomacy',
  'systems/combat/Combat -> systems/inventory/Equip',
  'systems/dialogue/Dialogue -> systems/academy/Academy',
  'systems/dialogue/Dialogue -> systems/economy/Shop',
  'systems/dialogue/Dialogue -> systems/inventory/Craft',
  'systems/dialogue/Dialogue -> systems/law/Law',
  'systems/dialogue/Dialogue -> systems/npc/Chat',
  'systems/dialogue/Dialogue -> systems/npc/Npcs',
  'systems/dialogue/Dialogue -> systems/quest/Quests',
  'systems/dialogue/Dialogue -> systems/relationship/Bond',
  'systems/dialogue/Dialogue -> systems/reputation/Title',
  'systems/dungeon/Abyss -> systems/combat/Combat',
  'systems/dungeon/Abyss -> systems/starnet/Towers',
  'systems/dungeon/Dungeon -> systems/codex/Codex',
  'systems/dungeon/Dungeon -> systems/combat/Combat',
  'systems/dungeon/Dungeon -> systems/naming/Naming',
  'systems/dungeon/Dungeon -> systems/npc/Npcs',
  'systems/economy/Shop -> systems/faction/Diplomacy',
  'systems/economy/Shop -> systems/faction/Factions',
  'systems/economy/Shop -> systems/inventory/Equip',
  'systems/economy/Shop -> systems/relationship/Bond',
  'systems/economy/Shop -> systems/reputation/Title',
  'systems/inventory/Craft -> systems/law/Law',
  'systems/inventory/Equip -> systems/economy/Economy',
  'systems/inventory/Equip -> systems/naming/Naming',
  'systems/law/Law -> systems/faction/Diplomacy',
  'systems/law/Law -> systems/faction/Factions',
  'systems/npc/Chat -> systems/faction/Factions',
  'systems/npc/Chat -> systems/relationship/Bond',
  'systems/npc/Chat -> systems/relationship/Relations',
  'systems/npc/Npcs -> systems/naming/Naming',
  'systems/quest/Quests -> systems/faction/Diplomacy',
  'systems/quest/Quests -> systems/faction/Factions',
  'systems/quest/Quests -> systems/npc/Npcs',
  'systems/relationship/Bond -> systems/npc/Npcs',
  /* 卡 L3：婚丧嫁娶。婚龄取自卡 L1 的年龄（同一个 birthTick），配偶与继承人取自 NPC
     好感表——前者是数值同源，后者是关系判定，都不是世界事实广播，故不走事件总线。 */
  'systems/rites/Rites -> systems/npc/Npcs',
  'systems/rites/Rites -> systems/timeslip/Lifespan',
  'systems/relationship/Relations -> systems/npc/Npcs',
  'systems/religion/Theoselect -> systems/naming/Naming',
  /* 卡 L1：神选座次的「寿元 +N 年」要落到寿命系统的 lifeBonus 上，
     并回报延后的上限（日志里那句"寿数上限延至 X 年"）。这是发奖方 → 数值方的直接依赖，
     不是世界事实广播，走事件总线反而要把同一个数再传一遍。 */
  'systems/religion/Theoselect -> systems/timeslip/Lifespan',
  'systems/reputation/Title -> systems/codex/Codex',
  'systems/reputation/Title -> systems/faction/Factions',
  'systems/reputation/Title -> systems/inventory/Craft',
  'systems/starnet/StarNet -> systems/combat/Combat',
  'systems/starnet/StarNet -> systems/dungeon/Abyss',
  'systems/starnet/StarNet -> systems/dungeon/Dungeon',
  /* 寄售实例（审查 §寄售）：星市要按「实例价」折算并精确移除那一件，而实例计价
     （品质档 × 词缀）与实例移除在 inventory/Equip 是单一实现点——在这里重写一份
     就是第二份价格口径，迟早与商店卖出不一致。同步调用、无第二消费者，故不走事件总线。 */
  'systems/starnet/StarNet -> systems/inventory/Equip',
  /* 冒险账本显示「这一趟值不值」时要拿玩家当前认证等级名，而等级字母 → 等级名是
     Guild.GUILD_RANKS 的权威映射：此前 Adventuring 手抄了一份且抄错（S 映成「圣徒级」，
     于是 S 级玩家看到 A 级的投入产出参照）。同步读一个纯映射表，没有第二消费者。 */
  'systems/adventuring/Adventuring -> systems/quest/Guild',
  'systems/travel/Travel -> systems/combat/Combat',
];

const SRC = 'src';

/** 仓库内路径规范化：去掉 src/ 前缀与扩展名，统一正斜杠 */
function rel(p: string): string {
  return p.replace(/\\/g, '/').replace(/^src\//, '').replace(/\.tsx?$/, '');
}

/** 取路径所属系统（systems/<id>/... → systems/<id>）；非系统路径返回 null */
function systemOf(p: string): string | null {
  const m = p.match(/^systems\/([^/]+)\//);
  return m ? 'systems/' + m[1] : null;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = dir + '/' + n;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

/** 把 import 说明符解成仓库内路径（去扩展名、去 src/ 前缀）；外部包返回 null */
function resolveSpec(fromFile: string, spec: string): string | null {
  if (spec.startsWith('@/')) return spec.slice(2).replace(/\.tsx?$/, '');
  if (spec.startsWith('.')) return rel(relative(process.cwd(), resolve(dirname(fromFile), spec)));
  return null;
}

interface Spec { spec: string; typeOnly: boolean }

/** 一个文件里的全部导入说明符：静态 import / re-export / 动态 import() / 副作用 import */
function specsOf(file: string, src: string): Spec[] {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kind);
  const out: Spec[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const m = node.moduleSpecifier;
      if (m && ts.isStringLiteral(m)) {
        const typeOnly = ts.isImportDeclaration(node) ? !!node.importClause?.isTypeOnly : !!node.isTypeOnly;
        out.push({ spec: m.text, typeOnly });
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const a = node.arguments[0];
      if (a && ts.isStringLiteral(a)) out.push({ spec: a.text, typeOnly: false });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/**
 * 扫出「A 系统 → B 系统」的直接导入边（A ≠ B，目标不在内核白名单）。
 * includeTypeOnly = false（默认）只算运行时边：类型导入是编译期擦除，不构成运行时耦合，
 * 把它计进基线会稀释清单的价值、并逼人去改基线。
 */
export function crossSystemEdges(includeTypeOnly = false): string[] {
  const set = new Set<string>();
  for (const file of walk(SRC + '/systems')) {
    const src = readFileSync(file, 'utf8');
    const from = rel(file);
    for (const { spec, typeOnly } of specsOf(file, src)) {
      if (typeOnly && !includeTypeOnly) continue;
      const to = resolveSpec(file, spec);
      if (!to) continue;
      const a = systemOf(from);
      const b = systemOf(to);
      if (!a || !b || a === b) continue;
      if (isKernel(to)) continue;
      set.add(from + ' -> ' + to);
    }
  }
  return [...set].sort();
}

describe('§45 · 跨系统依赖冻结（卡 J4）', () => {
  it('扫描器真的读到了文件（防空数组假绿）', () => {
    /* 这条不是凑数：如果 walk 的路径写错、或 systems 改名，扫描会返回空数组，
       而「没有新增边」的断言会**永远通过**——门禁变成摆设却毫无提示。 */
    const actual = crossSystemEdges();
    expect(actual.length, '扫描结果为空 = 路径失效，不是「没有依赖」').toBeGreaterThan(0);
    expect(actual.length, '现存边不该少于冻结基线（减少是允许的，这行只防扫描残缺）')
      .toBeGreaterThanOrEqual(FROZEN_BASELINE.length - 5);
  });

  it('不得新增跨系统 import 边', () => {
    const added = crossSystemEdges().filter((e) => !FROZEN_BASELINE.includes(e));
    expect(
      added,
      '新增了跨系统直接依赖。若确有必要，请在 FROZEN_BASELINE 登记并说明为何不能走事件总线。',
    ).toEqual([]);
  });

  it('基线清单必须与代码同步（不许留已经消失的边）', () => {
    /* 清理存量是好消息，但清单要跟着删——否则「只减不增」的白名单会慢慢腐烂，
       下一个读它的人就无法判断哪些边还活着。 */
    const actual = new Set(crossSystemEdges());
    const stale = FROZEN_BASELINE.filter((e) => !actual.has(e));
    expect(stale, '这些边已经不存在了，请从 FROZEN_BASELINE 里删掉（清理存量不该有阻力）').toEqual([]);
  });

  it('扫描器覆盖动态 import() 与副作用 import（审查 M-5 的绕过路径）', () => {
    /* 这一条守的是扫描器自身：正则版只认 from '...'，这两种写法都会逃逸。 */
    const dyn = specsOf('probe.ts', "const m = await import('@/systems/npc/Npcs');");
    expect(dyn.map((s) => s.spec), '动态导入没被扫到').toContain('@/systems/npc/Npcs');
    const side = specsOf('probe.ts', "import '@/systems/npc/Npcs';");
    expect(side.map((s) => s.spec), '副作用导入没被扫到').toContain('@/systems/npc/Npcs');
    const t = specsOf('probe.ts', "import type { X } from '@/systems/npc/Npcs';");
    expect(t[0]?.typeOnly, 'import type 应被标为仅类型').toBe(true);
  });

  it('world/WorldState 的业务系统依赖已冻结（环根不许扩大）', () => {
    /* 阶段 J 审计：WorldState → Economy（initVendors）/ Factions（initPlayerRep），
       而这两个系统又 import need ← WorldState，形成文件级环。
       正解是把初始化改成注册式（挂进 plugins/bootstrap.ts），但那是独立的一刀，
       本卡不合并。这里只钉住「别再加第三个」——环越大越难拆。 */
    const f = 'src/world/WorldState.ts';
    const src = readFileSync(f, 'utf8');
    const targets = specsOf(f, src)
      .map(({ spec }) => resolveSpec(f, spec))
      .filter((t): t is string => !!t && t.startsWith('systems/'))
      .sort();
    expect(targets).toEqual(['systems/economy/Economy', 'systems/faction/Factions']);
  });
});
