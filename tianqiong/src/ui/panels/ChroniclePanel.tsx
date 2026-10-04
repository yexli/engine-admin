import { useMemo, useState } from 'react';
import { codexStats, world, type WorldEvent } from '@/world';
import { useGame } from '@/store/useGame';
import { eventLabel } from '@/data/eventLabels';
import { entityName, locLabel } from '@/data/entityNames';

/* ============================================================
   世界档案（《天穹纪元2.0-后续开发方案-阶段J》卡 J1）
   —— 把 worldEventLog 的**运行时因果链**接到玩家眼前。

   此前玩家能看到的因果是「一步的、静态的」：NewsPanel 的「⟵ 因果」读的是
   events.json 里剧本的 trigger.afterEvent 名字（这段剧情设计上接在哪件事后面），
   不是这一局实际发生的链。世界史本身（附 id/parentId/sourceId 的事实流）
   一直只活在内存与存档里，没有任何 UI 消费。

   本面板三个只读视图：
     · 世界史 —— 最近 N 条事实，按级别着色，标注参与者与地点
     · 因果链 —— 点开任一事实，沿 parentId 向上追溯到根源
     · 检定留痕 —— 「这一下是怎么判出来的」：骰值 / 难度 / 属性 / 成败

   落盘（丁·照影）：从前是四张卡纵向堆叠；现在是三块网格——
   世界史（两列）/ 检定留痕（一列）/ 典籍与图鉴（整行）。
   **世界史只上屏最近 14 条**：一屏看得完才叫"历史"，剩下 46 条仍在缓冲里，
   点条目沿因果链追溯即可，不必靠滚。

   扩展方式：新增视图 = 写一个内容块塞进 <Section>，不改既有块；
   事件类型的新增只改 data/eventLabels.ts。这里不写任何判定逻辑。
   ============================================================ */

/** 级别徽记：与 EventSchema 的四级一一对应 */
const LEVEL_META: Record<number, { tag: string; color: string; hint: string }> = {
  0: { tag: '内', color: 'var(--ink3)', hint: '内部账目' },
  1: { tag: '局', color: 'var(--ink2)', hint: '局部事件' },
  2: { tag: '跨', color: 'var(--gold2)', hint: '跨系统事件' },
  3: { tag: '世', color: 'var(--crimson)', hint: '复杂世界事件' },
};

const metaOf = (lv: number) => LEVEL_META[lv] ?? LEVEL_META[1];

/** 一屏放得下的世界史条数；再多就靠因果链点开，而不是滚过去 */
const HISTORY_ON_SCREEN = 14;
const CHECKS_ON_SCREEN = 6;

/** 事件参与者一行摘要（actor → target @location）。
 *  此前直接落内部 id（「player → brendan @market」「→ threat」），玩家读不懂；
 *  统一走 entityName / locLabel 翻译，查不到的原样显示（不猜）。 */
function partyLine(e: WorldEvent): string {
  const pname = world.query.get_world_state()?.player.name ?? '玩家';
  const bits: string[] = [];
  if (e.actor) bits.push(entityName(e.actor, pname));
  if (e.target) bits.push('→ ' + entityName(e.target, pname));
  const head = bits.join(' ');
  const loc = locLabel(e.location);
  return loc ? (head ? head + '　@' + loc : '@' + loc) : head;
}

/** 通用区块壳：新增视图只写内容，不重复布局约定 */
function Section({
  title,
  hint,
  w,
  children,
}: {
  title: string;
  hint?: string;
  w?: number;
  children: React.ReactNode;
}) {
  return (
    <section className="pnl-sec" data-w={w ?? 1}>
      <h6>
        {title}
        {hint ? <em>{hint}</em> : null}
      </h6>
      {children}
    </section>
  );
}

/** 因果链：从叶子事实沿 parentId 向上追溯（带宿环保护与深度上限，见 traceChain） */
function ChainView({ id }: { id: string }) {
  /* 依赖里带 rev（独立审查 L-3）：链是历史事实，但 500 条缓冲会 shift()，
     世界继续推进时缓存可能展示已经滚出的条目——重算一次的成本可以忽略。 */
  const rev = useGame((s) => s.rev);
  const chain = useMemo(() => world.query.trace_event(id, 12), [id, rev]);
  if (!chain.length) return <div className="pnl-row note"><b>这条事实已滚出世界史缓冲（上限 500 条）</b></div>;
  return (
    <div className="pnl-chain">
      {chain.map((e, i) => {
        const m = metaOf(e.level);
        return (
          <div key={e.id}>
            <span style={{ color: m.color, marginRight: 6 }}>{i === 0 ? '●' : '↑'}</span>
            <span style={{ opacity: 0.55 }}>第{e.day}日</span>{' '}
            <span style={{ color: i === 0 ? 'var(--gold2)' : 'inherit' }}>{eventLabel(e.type)}</span>
            {partyLine(e) ? <span style={{ opacity: 0.6 }}>　{partyLine(e)}</span> : null}
            {i === chain.length - 1 && chain.length > 1 ? (
              <span style={{ opacity: 0.5 }}>　（根源）</span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function ChroniclePanel() {
  const cmd = useGame((s) => s.cmd);
  const [pick, setPick] = useState<string | null>(null);
  const log = world.query.get_world_log(60);
  const checks = world.query.get_recent_checks(8);
  const cs = codexStats(world.query.get_world_state()!);

  /* 新的在前——世界史读的是"刚发生什么"，所以显式拷贝再反转
     （不依赖 get_world_log 返回新数组这一实现细节），再截一屏。 */
  const recent = [...log].reverse().slice(0, HISTORY_ON_SCREEN);
  const recentChecks = [...checks].reverse().slice(0, CHECKS_ON_SCREEN);

  return (
    <>
      <Section
        title="世界史"
        w={2}
        hint={
          log.length
            ? `最近 ${recent.length} 条 / 共 ${log.length} 条 · 点条目看因果`
            : undefined
        }
      >
        {recent.length ? (
          recent.map((e) => {
            const m = metaOf(e.level);
            const chained = !!(e.parentId || e.sourceId);
            const on = pick === e.id;
            return (
              <div key={e.id}>
                <div className="pnl-row">
                  <span>
                    <i style={{ fontStyle: 'normal', color: m.color, marginRight: 7 }} title={m.hint}>
                      {m.tag}
                    </i>
                    第{e.day}日
                  </span>
                  <b
                    style={{ cursor: chained ? 'pointer' : 'default',
                      borderBottom: chained ? '1px dotted #ffffff33' : 'none' }}
                    onClick={() => chained && setPick(on ? null : e.id)}
                    title={chained ? '点开因果链' : '无因果父（根源事实）'}
                  >
                    {eventLabel(e.type)}
                  </b>
                </div>
                {partyLine(e) ? (
                  <div className="pnl-row note">
                    <b>{partyLine(e)}</b>
                  </div>
                ) : null}
                {on ? <ChainView id={e.id} /> : null}
              </div>
            );
          })
        ) : (
          <div className="pnl-row note"><b>世界史尚空——世界事件是运行时事实，做点什么就会留下记录。</b></div>
        )}
      </Section>

      <Section title="检定留痕" hint={checks.length ? `最近 ${recentChecks.length} 次` : undefined}>
        {recentChecks.length ? (
          recentChecks.map((c, i) => (
            <div key={i}>
              <div className="pnl-row">
                <span>第{c.day}日 · {c.label}</span>
                <b style={{ color: c.ok ? 'var(--gold2)' : 'var(--crimson)' }}>
                  {c.ok ? '成功' : '失败'}
                  {c.crit ? ' ★' : ''}
                </b>
              </div>
              <div className="pnl-row note">
                <b>
                  {c.stat} d20={c.roll}
                  {c.mod >= 0 ? '+' : ''}
                  {c.mod} = {c.total} vs DC {c.dc}
                </b>
              </div>
            </div>
          ))
        ) : (
          <div className="pnl-row note"><b>还没有需要掷骰的场面。</b></div>
        )}
      </Section>

      {/* 藏书阁与图鉴：都是"点开别处"的入口，合成一块整行的典籍区。
          档案收的是**世界知识**，藏书与图鉴、大事记同类；场景动作区只留"此刻能做的事"。 */}
      <Section title="典籍 · 图鉴" w={3} hint={`藏书已收录 ${cs.unlocked}/${cs.total}`}>
        <button className="pnl-act" onClick={() => cmd({ type: 'sceneAction', k: 'codex_open' })}>
          翻阅藏书
          <b>文献图鉴 · 按类目展开</b>
        </button>
        <button className="pnl-act" onClick={() => cmd({ type: 'ui', a: 'bestiary', p: {} })}>
          魔物图鉴
          <b>五类来源 / 六档等级 / 食物链</b>
        </button>
      </Section>
    </>
  );
}
