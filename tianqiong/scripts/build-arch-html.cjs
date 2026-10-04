/* 由扫描结果生成单页架构总览（docs/架构总览.html）。
   数据全部来自仓库：依赖边来自 arch-scan.json，能力表来自 plugins/systems.ts，
   事件分级来自 events/EventSchema.ts，审查发现来自 scripts/review.json。 */
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const scan = JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'arch-scan.json'), 'utf8'));
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

/* ---------- 能力表：直接解析 systems.ts 的 SYSTEM_SPECS ---------- */
const arr = (block, key) => {
  const m = block.match(new RegExp(key + ':\\s*\\[([^\\]]*)\\]'));
  if (!m) return [];
  return m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
};
const sysSrc = read('src/plugins/systems.ts');
const systems = [];
/* 单行与多行写法都要吃下：SYSTEM_SPECS 里两种都有 */
const specRe = /\{\s*id: '([^']+)',\s*version: '([^']+)',([\s\S]*?)\},/g;
let m;
while ((m = specRe.exec(sysSrc))) {
  const block = m[3];
  systems.push({
    id: m[1], version: m[2],
    effects: arr(block, 'effects'),
    pending: arr(block, 'pending'),
    internal: arr(block, 'internal'),
    subscribes: arr(block, 'subscribes'),
  });
}

/* ---------- 事件分级：解析 EventSchema 的 LEVEL_TABLE ---------- */
const evSrc = read('src/events/EventSchema.ts');
const table = evSrc.slice(evSrc.indexOf('const LEVEL_TABLE'), evSrc.indexOf('export const ALL_EVENT_TYPES'));
const levels = [0, 1, 2, 3].map((lv) => {
  const seg = table.split('/*')[lv + 1] || '';
  const types = [...seg.matchAll(/^\s{2}([a-z_]+):\s*\d,/gm)].map((x) => x[1]);
  return { level: lv, types };
});
const LV_DESC = ['内部账目：不进世界史，无人感知', '局部事件：由对应系统自行处理', '跨系统事件：上总线，通知相关系统', '复杂世界事件：进入 World Reasoner'];
for (const l of levels) l.d = LV_DESC[l.level];

/* ---------- 静态说明（人工维护的部分） ---------- */
const flow = [
  { t: '玩家输入', d: '自由文本或行动坞按钮；原文入库，渲染出口才转义', kind: '' },
  { t: 'Intent 解析', d: 'LLM 通道优先，失败降级正则；两通道产出同构 IntentParse', kind: 'cool' },
  { t: 'WorldRuntime.dispatch', d: 'UI → 引擎的唯一入口；一条命令 = 一个 tick', kind: 'hot' },
  { t: '系统执行 + 检定', d: 'DiceEngine.resolveCheck：d20 + 属性 + 天气修正，随机源可注入', kind: '' },
  { t: '改写 WorldState', d: '各系统写自己的数据；AI 层没有任何写通路（静态审计守护）', kind: '' },
  { t: '产生世界事件', d: 'EventSchema：id / type / day / tick / level / actor / target / location / cause / witnesses / data / parentId', kind: 'hot' },
  { t: 'Event Bus 派发', d: '通配订阅者（感知 → 世界史）先跑，再派发具体类型订阅者', kind: 'cool' },
  { t: '推演准入', d: 'L3 无条件；L2 有名有姓者的死/失踪升格；推演产物带 origin=reasoner 不再回流', kind: 'hot' },
  { t: 'Context Builder', d: '最小必要上下文：相关实体 + 认知边界 + 检索记忆 + 信念 + 可执行能力清单', kind: '' },
  { t: 'World Reasoner', d: 'LLM 端口或规则兜底；只产严格 JSON 计划，解析失败即 null', kind: 'cool' },
  { t: 'Rule Validator', d: '形状 → 能力可执行 → 实体存在 → 数值范围 → 重复执行 → 依据齐备；任一不过整份拒绝', kind: 'hot' },
  { t: 'World Executor', d: '因果挂父 → 逐条落地 → 收集执行期新事件', kind: 'hot' },
  { t: '新事件回流总线', d: '闭环完成：世界因这次动作而改变，且改变可向上追溯', kind: 'cool' },
];
const buses = [
  { n: 'bus', d: '引擎 → 界面：changed / toast / check / screen / combat… 只影响呈现' },
  { n: 'worldBus', d: '系统 ↔ 系统：世界已发生的事实。可追溯（parentId）、可推演、防环（幂等 + 限流 + 死信）' },
];
const cognition = [
  { n: 'World Truth', d: 'WorldState：谁活着、谁在哪、谁欠谁钱。AI 永远读不到原始事实' },
  { n: 'Perception', d: 'knowledge：某人**看见了**哪条事实（亲历 / 传闻 + 保真度）。证据的唯一来源' },
  { n: 'Memory', d: 'memories：角色级记忆条目，带置信度、重要度、情绪、衰减；容量 80/人' },
  { n: 'Belief', d: 'beliefs：由记忆聚合出的信念（主体|谓词|客体）。行动动机来自这里，不是世界真相' },
];
const layers = [
  { name: 'ui', dep: '← store / world', match: ['ui'] },
  { name: 'store', dep: '← 任意下层（只做订阅与转发）', match: ['store'] },
  { name: 'repo', dep: '← types', match: ['repo'] },
  { name: 'ai', dep: '← world / events / memory / plugins / execution / data', match: ['ai'] },
  { name: 'systems/*', dep: '← types / data / world / events / dice / memory（同层尽量靠事件）', match: ['systems'] },
  { name: 'memory', dep: '← types / data / events / world', match: ['memory'] },
  { name: 'execution', dep: '← events / validation / types', match: ['execution'] },
  { name: 'plugins', dep: '← 所有业务层（组合根：登记能力、装配订阅、注册处理器）', match: ['plugins'] },
  { name: 'validation', dep: '← types / data / world / plugins / execution', match: ['validation'] },
  { name: 'dice', dep: '← types / world', match: ['dice'] },
  { name: 'actions', dep: '← types / data / world / dice / systems', match: ['actions'] },
  { name: 'events', dep: '← types / data / world', match: ['events'] },
  { name: 'world', dep: '← types / data（门面；WorldClock 仍直调各系统 tick）', match: ['world'] },
  { name: 'data', dep: '← types（静态世界书与数值配置，数值一律配置化）', match: ['data'] },
  { name: 'types', dep: '← 谁都不依赖', match: ['types'] },
];
const subs = [
  { who: 'events/Perception', type: '*', events: '全部', why: '登记目击者（显眼度抽样，走可注入 rng）' },
  { who: 'events/EventStore', type: '*', events: '全部', why: '写入世界事件日志（环形 500，不入档）' },
  { who: 'memory/MemoryEngine', type: '*', events: 'L1+', why: '事件 → 相关角色记忆（目击者取自感知表）' },
  { who: 'ai/WorldReasoner', type: '*', events: 'L3 / 升格', why: '推演准入判定；推演产物不再回流' },
  { who: 'execution/WorldExecutor', type: '*', events: '执行期', why: '收集执行期间产生的世界事件（回合闭环）' },
  { who: 'plugins/witness', type: '具体', events: 'crime_committed · character_died · npc_assassinated', why: '目击者好感下降 + 消息沿关系网扩散' },
  { who: 'quest（订阅）', type: '具体', events: 'character_died', why: '击杀事实推进委托进度（取代原先的直接调用）' },
  { who: 'law（订阅）', type: '具体', events: 'crime_committed', why: '有人目击的罪行自动立案' },
  { who: 'economy（订阅）', type: '具体', events: 'large_trade', why: '大额买卖推动该品类价格指数' },
];

/* ---------- 审查发现 ---------- */
const reviewPath = path.join(root, 'scripts', 'review.json');
const REVIEW = fs.existsSync(reviewPath)
  ? JSON.parse(fs.readFileSync(reviewPath, 'utf8'))
  : { meta: '（待审查结论）', items: [], notes: [], stats: { tests: 0 }, foot: '' };

const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' · 生成自 arch-scan.cjs';
const data = { units: scan.units, edges: scan.edges, systems, levels, flow, buses, cognition, layers, subs, stamp };

const tpl = read('scripts/arch-template.html');
const out = tpl
  .replace('__ARCH_DATA__', JSON.stringify(data))
  .replace('__REVIEW_DATA__', JSON.stringify({ ...REVIEW, meta: REVIEW.meta, stats: { tests: REVIEW.stats ? REVIEW.stats.tests : 0 } }));
fs.writeFileSync(path.join(root, 'docs', '架构总览.html'), out);
console.log('systems=' + systems.length + ' levels=' + levels.map((l) => l.types.length).join('/') + ' html=' + out.length + 'B');
