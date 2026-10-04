/* ============================================================
   浮层描述符（原型的 sheet()/confirmSheet() 直改 DOM → 事件流）
   + 浮层开关的 core 侧收口（F-17）：core 记住"当前打开的聊天窗是谁"，
     异步回包据此判断要不要重新开窗——窗口是玩家关的，AI 不能替他打开。
   F-01：所有进 innerHTML 的文本在此唯一净化（UI 只渲染本模块的产物）。
   ============================================================ */
import { bus, rich } from '@/events/EventBus';
import type { ChatSheet, DialogSheet, SheetDesc } from '@/types/uispec';

/** 当前打开的聊天窗 NPC id（打开其它浮层 / 关闭浮层时清空） */
let openChatId: string | null = null;
export const currentChatId = (): string | null => openChatId;

/** 当前对话框的 NPC id（开场白 AI 回包据此判断：窗还是不是这个人的） */
let openDialogId: string | null = null;
export const currentDialogId = (): string | null => openDialogId;

/**
 * 对话框当前停在那一页。放在这里而不是 Dialogue 里，是为了让 **Chat 也能读**——
 * 深谈页要直接承接对话（气泡留在原地，不再弹聊天浮层），判定「该不该回流」
 * 必须两边都看得到同一个页号。Chat ← Dialogue 是既有的单向依赖，反向查询会成环。
 */
let openDialogPage: 'now' | 'timeline' = 'now';
export const currentDialogPage = (): 'now' | 'timeline' => openDialogPage;

export function openSheet(desc: SheetDesc) {
  openChatId = desc.kind === 'chat' ? desc.npcId : null;
  openDialogId = desc.kind === 'dialog' ? desc.npcId : null;
  /* 页号跟随这一次渲染的描述符（不是由谁额外同步）：Chat 正是靠它判断
     「回复该落在深谈页，还是该弹聊天浮层」。描述符里没有 page = 此刻。 */
  openDialogPage = desc.kind === 'dialog' ? desc.page || 'now' : 'now';
  bus.emit({ type: 'sheet', desc });
}

/** 关闭浮层（core 侧唯一出口：同时清空聊天窗与对话框记录） */
export function closeSheet() {
  openChatId = null;
  openDialogId = null;
  openDialogPage = 'now';
  bus.emit({ type: 'sheet', desc: null });
}

export function openDialog(desc: Omit<DialogSheet, 'kind'>) {
  /* F-01：text/extra 可含 LLM 台词与玩家姓名等不可信片段——在唯一出口净化，
     下游 UI 只渲染本函数的产物（不得二次净化，否则 & 会被重复转义）。 */
  openSheet({ kind: 'dialog', ...desc, text: rich(desc.text), extra: rich(desc.extra) });
}

/** 聊天窗口描述符（core 组装，UI 只渲染） */
export function openChatSheet(desc: Omit<ChatSheet, 'kind'>) {
  openSheet({ kind: 'chat', ...desc });
}

/** 原型 confirmSheet：标题 + 正文 HTML + 按钮组（n=附带 NPC，供赠礼选择器路由） */
export function confirmSheet(
  title: string,
  text: string,
  btns: { l: string; a: string; dg?: boolean; id?: string; n?: string; uid?: string }[],
) {
  openSheet({ kind: 'confirm', title, text: rich(text), btns });
}
