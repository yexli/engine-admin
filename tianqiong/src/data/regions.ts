/* ============================================================
   地区与地点能力查询（阶段 J · 地区规整）
   —— 把「这个地点能做什么」从代码里的地名比较，提升为数据上的能力标签。

   规整前的样子（ActionParser / ActionExecutor 里的十余处）：
     if (loc === 'tavern') restAt('tavern');
     else if (loc === 'wild') restAt('wild');
     if (watch && WB.locations[loc].area === '圣辉城' && ...)
   每加一个地区都要回来改这些分支——地区和机制焊死在一起，新地区只能靠复制粘贴。
   现在：地点在 geo.json 里标好 abilities，引擎只问能力、不问名字。

   本模块是 data 层的纯查询：零依赖、零副作用、引擎与 UI 共用。

   ── 新增一个地区的完整步骤（照做即可，代码零改动） ──
     1. geo.json 的 locations 里加地点，每个地点必须带齐：
        name / sv（地图单字）/ color / area（地区名）/ continent / danger / desc
        **area 不许与 continent 同名**：那等于这一级不存在。地图按「大陆 → 地区 →
        地点」分栏，同名的结果是一级里套着一级同名项（2026 修过一次：六块外大陆
        的 area 都等于大陆名，进二级看到的还是「中央大陆」）。
        地区名取 lore 里已经写实的地理条目（圣辉平原 / 帝国山脉 / 翠风群岛 …）。
     2. **abilities 是关键**：它决定这个地点能做什么，缺了就等于一间空屋子。
        可选值见下方 LOCATION_ABILITIES；新增取值时必须在这里登记名字。
        惯用组合：
          · 城镇街区：["urban","patrolled"]
          · 酒馆：    ["urban","patrolled","rest_lodging","drink"]
          · 集市：    ["urban","patrolled","shop"]（并在 people.json 声明该 loc 的商店）
          · 神殿：    ["urban","patrolled","sacred","pray"]
          · 暗巷：    ["urban","patrolled","backstreet"]
          · 野外：    ["rest_camping","wilderness","explore_wild"]
          · 洞窟：    ["explore_cave"]
     3. geo.json 的 travel 补本地区内部的步行连边（跨地区走 routes.json 的远行路线）
        —— 这张表是**有向图**，且只写相邻边。地图会自己算多跳可达
        （systems/travel/Travel.ts 的 routeBetween / reach），
        所以不必为了让玩家「能回城」而加直连边：城门是必经之路，那是地理设定。
     4. 要有人：people.json 的 npcs 加 NPC，schedule 里给时段与地点
     5. **地图不用改**：大陆/地区/地点三级由本模块从 continent + area 派生
        （orderedContinents / areasIn / sitesIn），新地点会自动落到对应层级下。
        map-layers.test.ts 守着「没有空白层」与「没有孤儿地点」两条不变量。
     6. 跑 npm test —— regions.test.ts 会检查：每个地点都标了能力、能力名都已登记、
        标了 shop 的地点真有商店、玩家至少有一处能休息、area 不与大陆同名
     7. 文案里的地区名走 regionOf(loc)，不要在代码里写死地名
   ============================================================ */
import { WB } from './worldBook';

/**
 * 地点能力的取值域与语义。
 * 新增能力时**必须**在这里登记名字——守卫用例会检查数据里用到的能力都已登记，
 * 拼错的标签会被抓出来，而不是静默地什么都不做。
 */
export const LOCATION_ABILITIES = [
  'urban', // 城内（文明区：有商铺酒馆与人流）
  'patrolled', // 有帝国城卫：盘查、查房、判决执行
  'rest_lodging', // 可付费过夜（全恢复；通缉时可能被查房）
  'rest_camping', // 可露宿（半恢复；有夜间风险）
  'drink', // 可饮酒
  'pray', // 可祈祷（有祭坛）
  'shop', // 有商铺
  'explore_wild', // 可野外探索
  'wilderness', // 野外无遮蔽：夜间遇袭、天气直击
  'explore_cave', // 可洞窟探索
  'backstreet', // 暗巷：蹲点、遇袭
  'sacred', // 圣地：异端踏入会被当场拿下
  /* —— 卡 P3：行动坞数据化时补的能力（原先这些按钮由 SceneView 里的 if (loc === '…') 硬编码） —— */
  'gossip', // 有人流可打听消息（§I4 情报轴来源）
  'heal', // 有医者：付钱治伤
  'theoselect', // 百年神选报名处（§H5）
  'starnet', // 星枢塔所在：可墨入符心入网（§9 一塔一城）
  'pay_fine', // 可缴罚金销案（§90 通缉）
  'pickpocket', // 人流稠密、可下手（顺手牵羊）
  'exchange', // 星枢兑换所所在：网内所得可在此落成铜（§10 的地面例外通道，七大陆各一家）
] as const;

export type LocationAbility = (typeof LOCATION_ABILITIES)[number];

/** 取地点的能力集合（缺数据返回空数组——不猜、不回落） */
export function abilitiesOf(loc: string): string[] {
  return WB.locations[loc]?.abilities ?? [];
}

/** 该地点是否具备某项能力 */
export function hasAbility(loc: string, a: LocationAbility): boolean {
  return abilitiesOf(loc).includes(a);
}

/** 取地点所属地区名（area）——用于文案与 lore 检索上下文 */
export function regionOf(loc: string): string {
  return WB.locations[loc]?.area ?? '';
}

/** 列出某地区下的全部地点 id（地图分区、内容盘点用） */
export function locationsIn(region: string): string[] {
  return Object.keys(WB.locations).filter((id) => WB.locations[id].area === region);
}

/**
 * 某地点上的商店（取 WB.shops 里 loc 相符的）。
 * 为什么由查询推导而不是在代码里写商店 id：商店是内容，地点是机制——
 * 换个地区做内容时，新商店只要在 people.json 声明自己的 loc 就自动可用。
 */
export function shopsAt(loc: string): { id: string; name: string }[] {
  return Object.entries(WB.shops)
    .filter(([, sh]) => (sh as { loc?: string }).loc === loc)
    .map(([id, sh]) => ({ id, name: (sh as { name?: string }).name ?? id }));
}

/** 全部地区名（按地点声明顺序去重；地图与审计用） */
export function allRegions(): string[] {
  const seen: string[] = [];
  for (const id of Object.keys(WB.locations)) {
    const a = WB.locations[id].area;
    if (a && !seen.includes(a)) seen.push(a);
  }
  return seen;
}

/* ============================================================
   地理分层（地图三级：大陆 → 地区 → 地点）

   地图此前把这些派生散在 MapPanel 里自己算，于是「新增一块大陆」既要改数据
   又要确保组件里的分组逻辑跟得上。挪到 data 层之后：
     · 加地点的完整步骤仍然是 geo.json 加一条（见文件头），地图自动跟上；
     · 任何界面（横滑、列式、树形）都用同一套分层，不会各算各的；
     · 可以单测——现在有一组用例守着「加了大陆却没加地区」这类空层。

   注意这里读的是 location 上的 continent / area 两个字段，不另设一份
   层级数据：层级是地点的属性，不是平行于地点的另一棵树。
   ============================================================ */

/**
 * 取地点所属大陆。
 * 与 Travel.ts 的同名函数语义一致（都以地点上的 continent 字段为权威），
 * 这里放一份是为了让 data 层的分层查询不必反向依赖 systems 层。
 */
export const continentOf = (loc: string): string => WB.locations[loc]?.continent ?? '';

/**
 * 大陆的有序列表：数据里的 order 优先。
 * 未在 continents.json 登记的大陆排到最后，而不是被藏起来——
 * 漏登记一个条目不该让一块大陆从地图上消失。
 */
export function orderedContinents(): string[] {
  const order = WB.continents.order;
  const seen: string[] = [...order];
  for (const id of Object.keys(WB.locations)) {
    const c = continentOf(id);
    if (c && !seen.includes(c)) seen.push(c);
  }
  return seen;
}

/** 某大陆下的地区名（按地点声明顺序去重——顺序即内容，不另排序） */
export function areasIn(cont: string): string[] {
  const seen: string[] = [];
  for (const id of Object.keys(WB.locations)) {
    const L = WB.locations[id];
    if (continentOf(id) !== cont) continue;
    if (L.area && !seen.includes(L.area)) seen.push(L.area);
  }
  return seen;
}

/** 某地区下的地点 id */
export function sitesIn(cont: string, area: string): string[] {
  return Object.keys(WB.locations).filter((id) => continentOf(id) === cont && WB.locations[id].area === area);
}

/**
 * 地区分型：城镇还是野外。
 * 判据是「有没有城内地点」——用能力问，不用地名问，所以新增地区不必回来登记。
 */
export function areaKind(cont: string, area: string): '城镇' | '野外' {
  return sitesIn(cont, area).some((id) => hasAbility(id, 'urban')) ? '城镇' : '野外';
}
