import { useState } from 'react';
import { STAT_NAMES, WB } from '@/data/worldBook';
import { raceAllowsClass, raceEff, lineageOf } from '@/systems/character/Race';
import { artPath, ArtImage } from './art/ArtImage';
import { useGame } from '@/store/useGame';

/* ============================================================
   角色创建（方案 B 定稿 · DOM 与类名对齐原型 #scr-create）
   ------------------------------------------------------------
   原型是四步（称呼 / 血统 / 道路 / 落定）；落地版多一步**性别**——
   卡 L3 §96 的婚龄分男女两档，创角时必须定下来，否则那条规则没有输入。

   除版式外，功能一行没减：种族强绑定过滤、职业亲和倍率、
   卡 R1 的绑定类型与所属大陆，都原样保留（放在 .op 的次级行里）。

   ★ 按钮文案必须留「踏入世界」：scripts/ 下约 35 个自检脚本
     （shot / verify-* / probe-*）都按这五个字点按钮。原型的「踏 入」
     是字距排版，用 CSS letter-spacing 就能做到，不必改文案去换。
   ============================================================ */
export function CreateScreen() {
  const cSel = useGame((s) => s.cSel);
  const setCSel = useGame((s) => s.setCSel);
  const setScreen = useGame((s) => s.setScreen);
  const cmd = useGame((s) => s.cmd);
  const [name, setName] = useState('');
  /* 卡 L3 · §96：婚龄分男女两档，故创角时定下性别。缺省男（与旧档一致） */
  const [gender, setGender] = useState<'male' | 'female'>('male');

  const rc = WB.races[cSel.race];
  const cl = WB.classes[cSel.cls];
  const stats: Record<string, number> = { 力量: 10, 体质: 10, 敏捷: 10, 智力: 10, 感知: 10, 魅力: 10 };
  const mods = rc.mods as Record<string, number>;
  const clsStats = cl.stats as Record<string, number>;
  for (const k in mods) stats[k] += mods[k];
  for (const k in clsStats) stats[k] += clsStats[k];

  const races = Object.keys(WB.races).filter((k) => WB.races[k].playable !== false);
  /* 卡 R1：强绑定的专属线只对**该种族**开放——矮人的生产三线、精灵的巫女、
     巨人的重装。其余种族在创角页直接看不到（不是灰显：看不见＝这个世界里不存在这条路）。 */
  const classes = Object.keys(WB.classes).filter((k) => !WB.classes[k].locked && raceAllowsClass(cSel.race, k));

  return (
    <>
      <div className="bg">
        <ArtImage src={artPath('loc', 'cave3')} />
      </div>
      <div className="inner">
        <div className="step-n">S T E P &nbsp;0 1 &nbsp;/&nbsp; 0 5</div>
        <h2>你从哪一段里醒来</h2>
        <p className="lead">
          名册只记几样：你怎么称呼自己、生作什么、走哪条路。
          <br />
          其余的部分，由你在往后的日子里自己填。
        </p>

        <div className="q">
          <div className="lb">
            <b>01</b>称呼
          </div>
          <input
            id="inp-name"
            maxLength={8}
            placeholder="如：叶澜"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div className="q">
          <div className="lb">
            <b>02</b>性别
          </div>
          <div className="opts">
            {([
              ['male', '男', '婚龄三十二'],
              ['female', '女', '婚龄二十八'],
            ] as const).map(([k, label, note]) => (
              <button key={k} className={'op' + (gender === k ? ' sel' : '')} onClick={() => setGender(k)}>
                <h4>{label}</h4>
                <div className="md">§ 9 6 · 婚 龄</div>
                <p>{note}。这一条不影响战力，只决定这个世界几岁开始催你成家。</p>
              </button>
            ))}
          </div>
        </div>

        <div className="q">
          <div className="lb">
            <b>03</b>血里带着什么
          </div>
          <div className="opts">
            {races.map((k) => {
              const r = WB.races[k];
              return (
                <button key={k} className={'op' + (cSel.race === k ? ' sel' : '')} onClick={() => setCSel({ race: k })}>
                  <h4>{r.name}</h4>
                  <div className="md">
                    {Object.entries(r.mods as Record<string, number>)
                      .map(([m, v]) => m + (v > 0 ? '+' : '') + v)
                      .join(' · ')}
                  </div>
                  <p>{r.desc}</p>
                  {r.bind && (
                    <p className="sub">
                      {r.bind === 'strong' ? '强绑定' : '软绑定'}
                      {r.affinityNote ? ' · ' + r.affinityNote : ''}
                    </p>
                  )}
                  {r.continent && (
                    <p className="sub">
                      {r.continent}
                      {r.homeland ? '（' + r.homeland + '）' : ''}
                      {r.social ? ' · ' + r.social : ''}
                    </p>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <div className="q">
          <div className="lb">
            <b>04</b>靠什么活着
          </div>
          <div className="opts">
            {classes.map((k) => {
              const c = WB.classes[k];
              const eff = raceEff(cSel.race, lineageOf(k));
              return (
                <button key={k} className={'op' + (cSel.cls === k ? ' sel' : '')} onClick={() => setCSel({ cls: k })}>
                  <h4>{c.name}</h4>
                  <div className="md">
                    {c.lineage ? c.lineage + '·' : ''}主属性 {c.main}
                    {eff !== 1 ? ' · ' + (eff > 1 ? '亲和 ×' + eff : '生疏 ×' + eff) : ''}
                  </div>
                  <p>{c.desc}</p>
                </button>
              );
            })}
          </div>
        </div>

        <div className="q" style={{ marginBottom: 22 }}>
          <div className="lb">
            <b>05</b>落定的六维
          </div>
          <div className="st">
            {STAT_NAMES.map((n) => {
              const d = stats[n] - 10;
              return (
                <div className="st-i" key={n}>
                  <div className="n">{n}</div>
                  <div className="v">{stats[n]}</div>
                  <div className={'d' + (d < 0 ? ' dn' : '')}>{d > 0 ? '+' + d : d < 0 ? d : ''}</div>
                </div>
              );
            })}
          </div>
        </div>

        <button
          className="btn-next"
          onClick={() => cmd({ type: 'newGame', name: name.trim() || '无名旅人', race: cSel.race, cls: cSel.cls, gender })}
        >
          踏入世界
        </button>
        <button className="btn-back" onClick={() => setScreen('title')}>
          返回
        </button>
      </div>
    </>
  );
}
