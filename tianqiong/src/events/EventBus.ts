/* ============================================================
   Core 基础设施：事件总线 + 可注入随机源 + 定时器抽象
   —— core 层不触碰任何 DOM；一切对外影响通过事件呈现。
   ------------------------------------------------------------
   【World Engine 抽取】本文件的**世界机制**已抽入独立引擎：
     · rng / scheduler / clamp      → world-engine/src/rng.ts、scheduler.ts
     · worldBus / causality / 配额   → world-engine/src/events/WorldEventBus.ts
       （天穹的运行日志经 setWorldBusLogger 注入——引擎不认识 RunLog）
   留在这里的是**天穹的表现信号**：bus（引擎 → 界面）、toast、
   esc/rich（受限富文本出口）。导入面保持不变，全仓引用零改动。
   ============================================================ */
import type { CoreEvent } from '@/types/uispec';
import { runLog } from '@/devlog/RunLog';
import { setWorldBusLogger } from 'world-engine';
import './EventSchema'; // 天穹分级/通道表注册进引擎（worldBus 的 channelOf / makeEvent 的 levelOf 消费它们）

/* ---------------- 世界机制：来自 World Engine 包（同一实例，全仓共享） ---------------- */
export { rng, clamp, scheduler } from 'world-engine';
export {
  worldBus,
  causality,
  withReasonerOrigin,
  isReasonerOrigin,
  MAX_EVENTS_PER_TICK,
  MAX_CHAIN_DEPTH,
  MAX_CRITICAL_PER_TICK,
} from 'world-engine';
export type { EventDeliveryResult } from 'world-engine';

/* 引擎的日志钩子接到运行日志：worldBus 的延后重投留痕与从前逐字一致 */
setWorldBusLogger({
  info: (msg, data) => runLog.info('event', msg, data),
});

/* ---------------- 表现信号：天穹自有 ---------------- */

type Listener = (e: CoreEvent) => void;
const listeners = new Set<Listener>();

export const bus = {
  emit(e: CoreEvent) {
    for (const fn of listeners) fn(e);
  },
  on(fn: Listener): () => void {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  /** 测试/离屏渲染时清空订阅 */
  clear() {
    listeners.clear();
  },
};

/** 常用事件快捷通道 */
export const emitChanged = () => bus.emit({ type: 'changed' });
export const toast = (text: string, cls: 'gain' | 'bad' | 'gold' | '' = '') => bus.emit({ type: 'toast', text, cls });
/* closeSheet 已迁至 sheet.ts（浮层开关需同时维护"当前聊天窗"记录，见 F-17） */

/** HTML 转义（与原型 esc 一致；富文本走 desc 的 text 字段原样透传） */
export function esc(s: unknown): string {
  return String(s == null ? '' : s).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string,
  );
}

/* ---------------- 受限富文本出口（F-01：唯一允许产出 HTML 的地方） ----------------
   策略：先 esc() 全量转义，再把**白名单内的**标签与属性还原成真标签，
   其余一切（script/img/a/事件属性…）以实体文本原样呈现，浏览器不作解析。
   白名单按既有 core 富文本实码确定（<br>、<b>/<i>/<em>、<span class|style>、
   <div class>、<small>），保证世界书与引擎既有排版零回归。
   属性只放行 class/style，且 style 内禁用 url()/expression()/javascript:/@import，
   以及 font(-family/style)/letter-spacing（字体统一，见 RICH_STYLE_BAD 处注）。
   注意：本函数只应在「文本组装的出口处」调用一次（UI 侧直接渲染结果），
   重复调用会把已还原的 & 二次转义成 &amp;。 */
const RICH_TAG = /&lt;(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[a-zA-Z-]+=&quot;[^&]*&quot;)*)\s*(\/?)&gt;/g;
const RICH_TAG_OK = new Set(['br', 'b', 'i', 'em', 'span', 'div', 'small']);
const RICH_ATTR_OK = new Set(['class', 'style']);
const RICH_ATTR = /([a-zA-Z-]+)=&quot;([^&]*)&quot;/g;
/* 字体统一（2026-09）：font-family / font（简写含字族）/ font-style / letter-spacing 一并拒绝——
   AI 自带的字体与字距会让段落局部"换脸"；字体由 --serif 令牌统一，
   强调只许字重（font-weight 不在拒绝之列）与颜色。 */
const RICH_STYLE_BAD = /url\s*\(|expression\s*\(|javascript:|@import|font\s*-?(family|style)?\s*:|letter-spacing\s*:/i;

export function rich(s: unknown): string {
  return esc(s).replace(RICH_TAG, (whole: string, close: string, tag: string, attrs: string) => {
    const name = tag.toLowerCase();
    if (!RICH_TAG_OK.has(name)) return whole;
    const pairs: string[] = [];
    RICH_ATTR.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = RICH_ATTR.exec(attrs)) !== null) {
      const key = m[1].toLowerCase();
      if (!RICH_ATTR_OK.has(key)) return whole; // 未知属性（onerror/href/src…）→ 整标签保持转义
      if (key === 'style' && RICH_STYLE_BAD.test(m[2])) return whole;
      pairs.push(key + '="' + m[2] + '"');
    }
    if (name === 'br') return '<br>';
    if (close) return '</' + name + '>';
    return '<' + name + (pairs.length ? ' ' + pairs.join(' ') : '') + '>';
  });
}
