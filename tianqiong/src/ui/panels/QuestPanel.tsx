import { WB } from '@/data/worldBook';
import { world, itemCount, questLabel } from '@/world';

/* ============================================================
   委托页（落盘 · 丁·照影）
   ------------------------------------------------------------
   从前是卡片堆叠；现在拆成三块固定骨架：可复命 / 进行中 / 已完成。
   骨架**常驻**——没委托时每块显示一行「空」，这正是接入点：
   接了委托它自己会填进来，不必再回来改版式。

   一条委托占两行：名字 + 状态（右对齐），描述跟在下面一行（note 行，可换行）。
   进度不再画条，直接落在状态位上（18 / 20）——三列里没有画条的地方。
   ============================================================ */

/** 一条委托在页面上的样子 */
function QuestBlock({ title, w, rows }: { title: string; w?: number; rows: React.ReactNode[] }) {
  return (
    <section className="pnl-sec" data-w={w ?? 1}>
      <h6>{title}</h6>
      {rows.length ? rows : <div className="pnl-row"><span>（空）</span><b>—</b></div>}
    </section>
  );
}

export function QuestPanel() {
  const S = world.query.get_world_state()!;
  const qs = Object.keys(S.player.quests);

  const items = qs
    .map((qid) => {
      const q = WB.quests[qid];
      /* 存档里可能残留世界书已删掉的 qid（改过任务之后读旧档必至）。
         缺这一行，下面的 q.name 会抛错 → ErrorBoundary 接管 → 整棵界面树被替换，
         连顶栏一起消失。跳过即可：这条委托在世界书里本就不存在了。 */
      if (!q) return null;
      const st = S.player.quests[qid];
      /* 进度只说「还差多少」，不说「已完成 0 / 20」那种看着像失败的写法 */
      const prog =
        st.stage === 'fin'
          ? questLabel(st.stage)
          : q.type === 'kill'
            ? `进度 ${st.count || 0} / ${q.count}`
            : q.type === 'item'
              ? `持有 ${itemCount(q.target || '', S)} / ${q.count}`
              : questLabel(st.stage);
      return { qid, q, st, prog };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  const of = (stage: string) => items.filter((x) => x.st.stage === stage);

  const rowOf = (x: (typeof items)[number]) => (
    <div key={x.qid}>
      <div className="pnl-row">
        <span>{x.q.name}</span>
        <b>{x.prog}</b>
      </div>
      {x.q.desc && (
        <div className="pnl-row note">
          <b>{x.q.desc}</b>
        </div>
      )}
      {x.st.stage === 'go' && x.q.hint && (
        <div className="pnl-row note">
          <span>提示</span>
          <b>{x.q.hint}</b>
        </div>
      )}
    </div>
  );

  return (
    <>
      <QuestBlock title="进行中" w={2} rows={of('go').map(rowOf)} />
      <QuestBlock title="可复命" rows={of('done').map(rowOf)} />
      <QuestBlock title="已完成" w={3} rows={of('fin').map(rowOf)} />
    </>
  );
}
