/* ============================================================
   目击者反应插件（《插件化世界模拟架构方案》§8 / §21 / §34）
   —— 「一个事件 → 多系统响应」的最小实例：
      罪案 / 命案被目击后，目击者对肇事者好感下降，消息沿关系网扩散。
   依据全部来自感知层（谁真的看见了），不做无依据的因果（§26）。
   注册顺序约束：必须在 attachPerception 之后注册——它依赖感知表已记录目击者。
   ============================================================ */
import { WB } from '@/data/worldBook';
import { plugins } from './PluginRegistry';
import { perception, spreadPerception } from '@/events/Perception';
import { adjAtt, npcDyn } from '@/systems/npc/Npcs';
import { core } from '@/world/WorldState';
import { isNamedPerson } from '@/events/EventSchema';
import type { WorldEvent } from '@/events/EventSchema';

/** 目击后的好感惩罚（刻意低于 toast 阈值 -5：多目击者时不刷屏，但记忆照记） */
const REPULSION = 4;
/** 每个目击者最多告诉几个关系人（§8 消息扩散的收敛阀） */
const TELL = 2;

export const WITNESS_EVENTS = ['crime_committed', 'character_died', 'npc_assassinated'];

export function registerWitnessPlugin(): void {
  plugins.register({
    id: 'witness',
    version: '1.0.0',
    capabilities: ['bear_witness'],
    subscribes: WITNESS_EVENTS,
    handleEvent: (e: WorldEvent) => {
      const s = core.S;
      if (!s || e.actor !== 'player') return;
      /* 命案反应只对「人」成立：玩家砍翻一头野狼不算命案，
         在场的 NPC 不该为此记恨（与推演门槛用同一套人物判定）。 */
      if (e.type !== 'crime_committed' && !isNamedPerson(e.target, s.npcs)) return;
      const knowers = perception.knowers(e.id);
      if (!knowers.length) return;
      const reason = e.type === 'crime_committed' ? '目击罪行' : '目击命案';
      for (const npcId of knowers) {
        /* 存在性看世界书而不是运行时表：尚未交互过的 NPC 还没有 NpcDynamic，
           而他们恰恰是绝大多数目击者的常态（adjAtt 会按需建立动态记录）。 */
        if (!WB.npcs[npcId]) continue;
        adjAtt(npcId, -REPULSION, reason);
        /* 消息沿关系网扩散：每传一手保真度衰减，越传越模糊 */
        const ties = npcDyn(npcId, s).rels ?? {};
        for (const other of Object.keys(ties).slice(0, TELL)) {
          spreadPerception(e.id, npcId, other, 0.5);
        }
      }
    },
  });
}
