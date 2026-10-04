/* ============================================================
   表现层契约（Core → UI 的「呈现数据」，均为纯数据、无 DOM）
   原型中由引擎直接拼 HTML/调用 DOM，落地版改为此处描述符，
   React 组件按其 1:1 还原原型的 DOM 结构与类名。
   ============================================================ */

/** 对话/选项按钮的载荷（对应原型 data-a/data-id/data-n/data-i/data-k/data-t/data-p） */
export interface OptPayload {
  /** 双页翻页：'now' 此刻 / 'timeline' 深谈（dlgPage 命令用） */
  page?: 'now' | 'timeline';
  a?: string;
  id?: string;
  uid?: string; // 卡 I1：实例装备的精确取件键
  n?: string;
  i?: number;
  k?: string;
  t?: string;
  p?: number;
  loc?: string;
}

export interface OptDesc {
  l: string; // 标签（纯文本）
  a: string; // 动作（路由到 dialogChoice / dialogReq）
  n?: string; // 所属 NPC
  i?: number; // dreq 序号
  t?: string; // 附带目标（如 msg_to 的对象）
  h?: string; // 副标题 hint（纯文本）
  cls?: string; // 'q' | 'dg' | ''
  dis?: boolean;
}

export interface DialogSheet {
  kind: 'dialog';
  npcId: string;
  text: string; // 可含 <br><span> 的原型叙事 HTML
  extra?: string; // 位于正文与选项之间的 HTML（如内心权衡卡）
  opts: OptDesc[];
  /* —— 卡 I3：显式情绪 tag（补 H 缺口 2；缺省时 UI 保留旧的关键词推导作降级） —— */
  mood?: '怒' | '喜' | '惊' | '疑' | '冷';
  /* 开场白 AI 化：正文待生成。接了真实模型时**不预填固定台词**
     （先闪一句再被替换比等一下更伤体验），这里只渲染中性等待态。 */
  busy?: boolean;
  /* —— 双页（星穹剧场）：'now' 此刻（立绘 + 这一句 + 一级动作）／
     'timeline' 深谈（双方会话时间线 + 追问） —— */
  page?: 'now' | 'timeline';
  /** 深谈页的会话流（本 NPC 最近若干轮，旧→新）；正文那一句由 UI 追加为末条 */
  turns?: { who: 'p' | 'n'; text: string; day: number; id?: string }[];
  /** 深谈页的追问入口（core 判过门槛的话题，点击即进入聊天窗口发问） */
  chips?: string[];
  /* —— 排版两则（core 判定，UI 只画）——
     句首舞台指示（如「（打铁声重了几分）」）不是台词：小字另起一行，与正文分开渲染。 */
  stage?: string;
  /** 正文首字是否可作下沉字（只认汉字；标点／引号开头不下沉）。text 已不含 stage。 */
  dropCap?: boolean;
}
export interface ConfirmSheet {
  kind: 'confirm';
  title: string;
  text: string; // HTML
  btns: { l: string; a: string; dg?: boolean; id?: string; n?: string; uid?: string }[]; // uid：实例装备的精确取件键（寄售实例用）
}
export interface ShopSheet {
  kind: 'shop';
  shopId: string;
}
export interface CombatItemSheet {
  kind: 'combatItems';
}
/** 聊天窗口（第四通道）：气泡历史 + 话题 chips + 输入胶囊；busy=沉吟演出中 */
export interface ChatSheet {
  kind: 'chat';
  npcId: string;
  turns: { who: 'p' | 'n'; text: string; day: number; id?: string }[]; // id：稳定 key（窗口有 20 条裁剪，下标会串位）
  chips: string[];
  busy: boolean;
}
/** 卡 I2 · 技艺工坊浮层（纯数据：station 决定渲染哪一站） */
export interface CraftSheet {
  kind: 'craft';
  station: string;
}
/** 卡 I5 · 文献图鉴浮层（cat=当前分类，空串为全部） */
export interface CodexSheet {
  kind: 'codex';
  cat: string;
}
/** 卡 K3-UI · 通讯·写信浮层：收件地只读，正文玩家写，确认后按所选手段扣费寄出。
 *  BUG-001（2026-09-29 实测）：此前点目的地=立即寄出硬编码「口信」，写信界面从未存在。 */
export interface CommSheet {
  kind: 'comm';
  toLoc: string; // 收件地 id（世界书地点）
  toName: string; // 收件地名（只读展示）
  wayId: string; // 自动挑好的最便宜可用手段
  wayName: string;
  cost: number; // 铜币
  days: number; // 时效（0 = 即达）
}
export type SheetDesc = DialogSheet | ConfirmSheet | ShopSheet | CombatItemSheet | ChatSheet | CraftSheet | CodexSheet | CommSheet;

/** 卡 H4 · 地下城爬层视图（core → UI 的纯数据描述符，UI 只渲染） */
export interface DungeonView {
  inRun: boolean; // 是否正在层中（且人在入口地）
  floor: number; // 当前层（未在层中为 0）
  best: number; // 历史抵达最深
  next: number; // 下一层（封顶 100）
  themeId: string;
  themeName: string;
  themeDesc: string;
  tier: number;
  floorName: string;
  isBoss: boolean;
  seed: string;
  escapes: number;
  corrupted: boolean; // 深层魔气侵蚀区
  atAbyss: boolean; // 已抵最深（100 层）
  /* —— 入口（按玩家当前所在地点推导） —— */
  canEnter: boolean; // 当前地点有地下城入口
  entryName: string;
  entryStart: number;
  entryOk: boolean; // 入口是否已解锁
  entryLock: string; // 未解锁原因（已解锁为空串）
}

/** 检定演出卡（原型 #chk 的 .cc 结构） */
export interface CheckDesc {
  label: string;
  statName: string;
  mod: number;
  dc: number;
  roll: number;
  total: number;
  ok: boolean;
  crit: boolean; // nat20
  note?: string;
}

export interface ToastDesc {
  id: number;
  text: string; // HTML（原型 toast 支持内联标记）
  cls: 'gain' | 'bad' | 'gold' | '';
}

/* ---------------- Core → UI 事件总线 ---------------- */

export type CoreEvent =
  | { type: 'changed' } // WorldState 任何变化 → UI 重渲染
  | { type: 'toast'; text: string; cls: ToastDesc['cls'] }
  | { type: 'sheet'; desc: SheetDesc | null }
  | { type: 'check'; desc: CheckDesc | null } // null=收起检定卡
  | { type: 'combat'; open: boolean } // 战斗全屏开关
  | { type: 'combatChanged' } // CB.log/hp 等变化
  | { type: 'foeHit'; index: number }
  | { type: 'freeBusy'; busy: boolean } // 自由行动意图解析中（F-14：core 侧 in-flight 状态同步给 UI）
  /* 自由输入的攀谈：对方正在斟酌回话（沉吟）。name=null = 回话已落地。
     只喂输入框的占位提示，不参与任何状态——台词由 chatAsync 的返回值落地。 */
  | { type: 'npcMusing'; name: string | null }
  /* 叙事编织：from = 待润色的起始 seq（这批先不显示，等 AI 织好再出现）；
     from = null 表示编织结束（成功=正文已就位，失败=原文照常显示）——
     无论成败都必须发这一条，否则界面会永远藏着那几条消息 */
  | { type: 'weave'; from: number | null }
  /* AI 流式草稿：模型正在吐字时的半截文本（只在「流式输出」开启时才有）。
     它只喂「正在书写 / 沉吟着」那一处显示，**不参与任何状态**：
     最终文本仍由各通道的返回值落地，草稿丢了最多少个逐字效果。
     channel 用 string 而不是 PromptChannel：types 层零依赖，不许反向 import ai/。 */
  | { type: 'aidraft'; channel: string | null; npcId?: string; text: string; done?: boolean }
  | { type: 'screen'; to: 'title' | 'create' | 'game' };

/* ---------------- GameCommand（§42：一切状态改写必须经命令→规则校验） ---------------- */

export type GameCommand =
  | { type: 'newGame'; name: string; race: string; cls: string; gender?: 'male' | 'female' }
  | { type: 'continueSave' }
  | { type: 'travel'; loc: string }
  | { type: 'sceneAction'; k: string } // 行动坞（observe/search/drink/...）
  | { type: 'wait'; ticks: number } // 原地等待 N 刻（自动流逝按刻提交）
  | { type: 'npcTalk'; id: string }
  | { type: 'dialogChoice'; n: string; a: string; t?: string }
  | { type: 'dialogReq'; n: string; i: number }
  | { type: 'shopBuy'; id: string; p: number }
  | { type: 'shopSell'; id: string; uid?: string } // uid=卡 I1 实例装备精确回收
  | { type: 'combat'; k: 'atk' | 'skill' | 'item' | 'flee' | 'useitem'; key?: string; id?: string }
  | { type: 'freeText'; text: string }
  | { type: 'chatOpen'; id: string } // 聊天窗口：打开
  | { type: 'chatSend'; id: string; text: string } // 聊天窗口：发言/点话题 chip
  | { type: 'equipItem'; id: string; uid?: string } // uid=卡 I1 实例装备精确穿戴
  | { type: 'useItem'; id: string }
  | { type: 'ui'; a: string; p: OptPayload } // 兜底路由：原型 data-a 直通
  | { type: 'importState'; json: string }
  | { type: 'resetWorld' };
