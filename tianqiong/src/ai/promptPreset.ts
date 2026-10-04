/* ============================================================
   提示词预设（系统面板 · 提示词）
   ------------------------------------------------------------
   YG 要的四件事，都在这里定义、都由玩家在系统面板里改：
     1. 系统提示词    —— 附加在所有通道最前的自定义指令
     2. 叙事人称      —— 第一 / 第二 / 第三人称
     3. 嵌入性提示词  —— 可增删、带权重、可限定通道（参考酒馆预设的条目式注入）
   另有「剧情推进选项」：玩家自定义的快捷指令，供主界面底部使用。

   组装成**一段纯文本**追加到各通道的 system 之后（openaiCompat.complete 统一注入），
   因此任何通道都不需要知道这个模块的存在。
   enabled 关掉、或组装结果为空串时，注入点跳过 —— 行为与没有本功能时逐字节相同。
   ============================================================ */

/** AI 通道：嵌入条目可只对其中几个生效 */
export type PromptChannel = 'narrative' | 'chat' | 'intent' | 'decide' | 'greet' | 'reason' | 'weave' | 'recap';

export const CHANNEL_LABEL: Record<PromptChannel, string> = {
  narrative: '场景叙事',
  chat: '自由对话',
  intent: '意图解析',
  decide: 'NPC 权衡',
  greet: '开场白',
  reason: '世界推演',
  weave: '叙事编织',
  recap: '章级前情',
};

export type NarrativePerson = 'first' | 'second' | 'third';

/** 嵌入性提示词：一条 = 一段可开关的文本，weight 越大越靠前 */
export interface EmbedPrompt {
  id: string;
  /** 名称（列表里识别用，不进 prompt） */
  name: string;
  /** 正文（进 prompt 的就是它） */
  text: string;
  /** 权重 0-100：只决定注入顺序，不改变内容；同权重按列表顺序 */
  weight: number;
  enabled: boolean;
  /** 生效通道；'all' = 全部 */
  channels: PromptChannel[] | 'all';
}

/** 剧情推进选项：主界面底部的自定义快捷指令 */
export interface PlotOption {
  id: string;
  /** 按钮上显示的字 */
  label: string;
  /** 点击后提交给自由行动的那句话 */
  text: string;
}

export interface PromptConfig {
  /** 总开关：关掉 = 一段都不注入（与内置提示词逐字相同的行为） */
  enabled: boolean;
  /** 附加系统提示词（留空 = 只用内置；不会替换内置，避免一填就跑偏） */
  systemPrompt: string;
  person: NarrativePerson;
  embeds: EmbedPrompt[];
  options: PlotOption[];
}

const PERSON_TEXT: Record<NarrativePerson, string> = {
  first: '叙事人称：第一人称，以玩家的口吻叙述，称玩家为「我」。',
  second: '叙事人称：第二人称，直接称呼玩家为「你」。',
  third: '叙事人称：第三人称，称玩家为「他」或角色名。',
};

/** 人称只对「讲故事」的通道有意义：解析器与权衡通道输出的是 JSON，不需要人称 */
const PERSON_CHANNELS: PromptChannel[] = ['narrative', 'chat', 'greet', 'weave', 'recap'];

/**
 * 默认嵌入条目：给玩家一个可改的起点，而不是空列表。
 * 冻结到底（含每个元素）：这些对象会被 `{ ...DEFAULT_PROMPT, ...saved }` 浅展开复用，
 * 谁若图省事来个 `cfg.prompts.embeds.push(...)`，就会永久污染默认值、且本会话内没有复位路径。
 * 冻结让这种写法当场抛错（ES module 是严格模式），比悄悄多一份拷贝更容易发现。
 */
export const DEFAULT_EMBEDS = Object.freeze([
  {
    id: 'tone',
    name: '文风基调',
    text: '文风：克制、冷峻、有质感；不堆形容词，不用感叹号，不用现代网络词。',
    weight: 80,
    enabled: true,
    channels: 'all',
  },
  {
    id: 'no-meta',
    name: '禁止出戏',
    text: '不要提及规则、数值、面板、选项；不要向玩家提问，也不要解释自己在扮演。',
    weight: 90,
    enabled: true,
    channels: ['narrative', 'chat', 'greet'],
  },
  {
    id: 'consequence',
    name: '因果要落在人身上',
    text: '你的叙述要让人感到后果落在具体的人身上：谁失去了什么、谁记住了什么。',
    weight: 50,
    enabled: true,
    channels: ['narrative', 'chat'],
  },
].map((e) => Object.freeze(e))) as unknown as EmbedPrompt[];

/** 见 DEFAULT_EMBEDS 的注释：整体冻结，防止被就地改写 */
export const DEFAULT_PROMPT: PromptConfig = Object.freeze({
  enabled: true,
  systemPrompt: '',
  person: 'second',
  /* 默认**不带**任何嵌入条目：注入的只有叙事方式与人称两项，
     而它们与内置提示词的既有风格同义（内置本就是「文学化克制笔调 + 第二人称」），
     所以开箱行为几乎无变化；示例条目留给面板里的「载入示例」按钮。 */
  embeds: Object.freeze([]) as unknown as EmbedPrompt[],
  options: Object.freeze([]) as unknown as PlotOption[],
}) as PromptConfig;

/**
 * 组装某个通道的用户提示词块。**空配置返回空串**（调用方据此跳过注入）。
 * 顺序即优先级：系统提示词 → 叙事方式 → 人称 → 嵌入条目（权重降序）。
 */
export function buildPromptBlock(cfg: PromptConfig | undefined, channel: PromptChannel, budget = 1200): string {
  if (!cfg || cfg.enabled === false) return '';
  const parts: string[] = [];
  const sys = (cfg.systemPrompt || '').trim();
  if (sys) parts.push(sys);
  if (PERSON_CHANNELS.includes(channel)) parts.push(PERSON_TEXT[cfg.person]);
  const embeds = (cfg.embeds || [])
    .filter((e) => e && e.enabled && (e.text || '').trim() && (e.channels === 'all' || (e.channels || []).includes(channel)))
    .slice()
    .sort((a, b) => (b.weight || 0) - (a.weight || 0));
  for (const e of embeds) parts.push(e.text.trim());
  /* 预算：超限从**尾部**整条丢弃（后进的是低优先级条目），不切句子 */
  const kept: string[] = [];
  let used = 0;
  for (const p of parts) {
    if (used + p.length > budget && kept.length) break;
    kept.push(p);
    used += p.length;
  }
  return kept.join('\n');
}

/** 新条目的 id（面板里随手加一条也能拿到稳定 id） */
export const newEmbedId = (): string => 'e' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
export const newOptionId = (): string => 'o' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
