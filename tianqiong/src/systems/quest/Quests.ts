/* ============================================================
   任务引擎（原型 §任务：giveQuest/canTurnIn/progKill/turnIn）
   ============================================================ */
import { WB } from '@/data/worldBook';
import { toast, worldBus } from '@/events/EventBus';
import { makeEvent } from '@/events/EventSchema';
import { sceneTime } from '@/world/WorldClock';
import { trustOk } from '@/systems/faction/Diplomacy';
import { guildFee } from '@/systems/quest/Guild';
import { adjRepAxis } from '@/systems/faction/Factions';
import { addRep, gainExp, gainGold, addItem, removeItem, itemCount, log } from '@/systems/character/Gains';
import { adjAtt } from '@/systems/npc/Npcs';
import { mutate } from '@/world/WorldMutate';
import { need, sync } from '@/world/WorldState';
import { addHistory, fireEv } from '@/events/EventStore';

export function giveQuest(id: string) {
  const s = need();
  if (s.player.quests[id]) return;
  const q = WB.quests[id];
  // 卡 F：信任门槛——对方还不够信你，这单委托不交给你
  if (q.reqTrust && !trustOk(q.reqTrust.faction, q.reqTrust.min, s)) {
    toast('「' + q.name + '」尚未对你开放——需先赢得' + (WB.factions[q.reqTrust.faction] || q.reqTrust.faction) + '的信任', 'bad');
    return;
  }
  s.player.quests[id] = { stage: 'go' };
  toast('✦ 接受任务：' + q.name, 'gain');
  log('【任务】' + q.name + '——' + q.desc, 'sys');
}

export function canTurnIn(id: string): boolean {
  const s = need();
  const q = WB.quests[id];
  const st = s.player.quests[id];
  if (!st || st.stage === 'fin') return false;
  if (q.type === 'kill') return (st.count || 0) >= (q.count || 0);
  if (q.type === 'item') return itemCount(q.target || '') >= (q.count || 0);
  return st.stage === 'done';
}

/** 击杀进度（战斗胜利后由 combat 调用） */
export function progKill(mid: string) {
  const s = need();
  for (const qid in s.player.quests) {
    const q = WB.quests[qid];
    const st = s.player.quests[qid];
    if (q.type === 'kill' && q.target === mid && st.stage === 'go') {
      st.count = (st.count || 0) + 1;
      toast('任务进度：' + q.name + ' ' + st.count + '/' + q.count, 'gain');
      if (st.count >= (q.count || 0)) {
        st.stage = 'done';
        toast('✦ ' + q.name + '：目标达成，可复命', 'gain');
      }
    }
  }
}

export function turnIn(id: string) {
  const s = need();
  const q = WB.quests[id];
  if (!canTurnIn(id)) return;
  if (q.type === 'item') removeItem(q.target || '', q.count || 0);
  s.player.quests[id].stage = 'fin';
  const r = q.reward;
  /* 卡 R5 · §23：经公会分账的委托抽 10%（quests[].guildCut=true）。
     悬赏类不抽——那笔钱是雇主直接出的（§91 特权③「悬赏所得归自己」）。 */
  if (r.gold) {
    const cut = (q as unknown as { guildCut?: boolean }).guildCut ? guildFee(r.gold, 'commission') : 0;
    gainGold(r.gold - cut);
    if (cut > 0) log('公会抽成 ' + cut + ' 铜（10%）——规矩如此，柜台后的戈林连眼皮都没抬。', 'sys', s);
  }
  if (r.rep) for (const k in r.rep) { addRep(k, r.rep[k]); adjRepAxis(k, 'trust', 3, s); } // 卡 F：完成任务累积该势力信任
  if (r.att) for (const k in r.att) adjAtt(k, r.att[k], q.name);
  if (r.items) for (const k in r.items) addItem(k, r.items[k]);
  if (r.flag) mutate.playerFlag(r.flag);
  gainExp(r.exp || 20);
  log('【任务完成】' + q.name, 'gain');
  addHistory('任务完成：' + q.name, '奖励已结算', 2);
  /* §22/§34：委托交付完成是跨系统事实（势力/任务/关系都可能响应） */
  worldBus.emit(
    makeEvent({
      type: 'quest_completed',
      day: sceneTime(s).day,
      tick: s.t,
      actor: 'player',
      target: id,
      location: s.player.loc,
      cause: q.name,
      data: { quest: id, name: q.name },
    }),
  );
  if (id === 'q_caravan') {
    s.econ.herb = 1;
    s.qf.caravan_ok = true;
    fireEv('price_back', '药价回落：失而复得的药材重新上架', '奥托商路恢复，市价回归', 2);
    log('隔日，东市药价就落了回来。奥托逢人便说城里有个靠谱的冒险者。', 'sys');
  }
  if (id === 'q_shard')
    log('范德尔捧着星枢残片的手在发抖：“六芒星纹……七塔同源。孩子，你带回来的可能不止一块金属——是星渊的一角。”', 'nar');
  sync();
}

/** 任务面板展示用：状态标签（原型 panelQuest 的 label 逻辑） */
export function questLabel(stage: string): string {
  return stage === 'fin' ? '已完成' : stage === 'done' ? '可复命' : stage !== 'go' ? '线索·' + stage : '进行中';
}
