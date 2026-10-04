/* ============================================================
   NPC 名册聚合器 —— 唯一的「装订」处

   一 NPC 一文件夹（<板块>/<id>/npc.json），本文件把它们扫成一张名册，
   交给 worldBook 挂进 WB.npcs。游戏里到处写的 WB.npcs['herman'] 认的就是它。

   加一个 NPC = 加一个文件夹，**本文件不用动**。

   为什么必须排序：Object.keys(WB.npcs) 是婚配候选（Rites）、神选名册
   （Theoselect）、位置索引重建（Npcs）的遍历基准，而随机抽样挂在遍历顺序上。
   glob 返回的顺序由构建工具的目录遍历决定，不保证跨版本稳定——
   按路径字典序钉死，顺序就成了常量而不是运气。
   ============================================================ */
import type { NpcDef } from '@/types/world';

/** 档案条目 = NpcDef + 自己的 id。
    NpcDef 本身没有 id 字段（id 是名册的键），但档案文件里必须写着它——
    否则聚合器只能靠路径猜人是谁，而路径是可以被改的。 */
interface ArchiveEntry extends NpcDef {
  id: string;
}

const FILES = import.meta.glob<{ default: ArchiveEntry }>('./*/*/npc.json', { eager: true });

export const NPC_ARCHIVE: Record<string, NpcDef> = (() => {
  const out: Record<string, NpcDef> = {};
  for (const [path, mod] of Object.entries(FILES).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const d = mod?.default;
    if (!d) throw new Error('NPC 档案读取失败：' + path);
    if (!d.id) throw new Error('NPC 档案缺 id 字段：' + path);
    if (out[d.id]) throw new Error('NPC id 重复：' + d.id + '（' + path + '）');
    out[d.id] = d;
  }
  return out;
})();

/** 名册人数（供测试与审计；不参与判定） */
export const npcArchiveSize = (): number => Object.keys(NPC_ARCHIVE).length;
